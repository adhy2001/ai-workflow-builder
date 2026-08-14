// =========================================================
// Phase 5: functions/triggerWorkflowRun.ts
// This is an nhost Serverless Function. Files in functions/
// map directly to routes: this file becomes
//   POST https://<subdomain>.functions.<region>.nhost.run/v1/triggerWorkflowRun
// Hasura's Action calls THIS url as its "handler".
// =========================================================
//
// WHY THIS LIVES IN CODE, NOT IN A HASURA PERMISSION:
// Everything up to now (Layer 1) was "can this row be seen/touched".
// This function does something permissions can't: it reads MULTIPLE
// rows, makes decisions based on their values (quota left? step type?
// previous step's output?), calls EXTERNAL APIs, and writes a chain
// of dependent rows in sequence. That's a workflow, not a row filter.
// =========================================================

import { Request, Response } from "express";

const HASURA_GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL || process.env.HASURA_GRAPHQL_URL!;
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET!;
const GROQ_API_KEY = process.env.GROQ_API_KEY!;

async function gql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(HASURA_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("GraphQL error: " + JSON.stringify(json.errors));
  }
  return json.data;
}

async function verifyCallerCanTrigger(workflowId: string, userId: string) {
  const data = await gql(
    `query ($workflowId: uuid!, $userId: uuid!) {
      workflows_by_pk(id: $workflowId) {
        id
        org_id
        organization {
          calls_allowed
          calls_used
          org_members(where: { user_id: { _eq: $userId } }) {
            role
          }
        }
      }
    }`,
    { workflowId, userId }
  );

  const workflow = data.workflows_by_pk;
  if (!workflow) throw new Error("Workflow not found");

  const membership = workflow.organization.org_members[0];
  if (!membership || !["owner", "editor"].includes(membership.role)) {
    throw new Error("Forbidden: caller is not owner/editor in this org");
  }

  const { calls_allowed, calls_used } = workflow.organization;
  if (calls_used >= calls_allowed) {
    throw new Error("Quota exhausted for this organization");
  }

  return workflow;
}

async function runLlmCall(config: any, previousOutput: any) {
  const prompt = config.prompt_template
    ? config.prompt_template.replace("{{previous_output}}", JSON.stringify(previousOutput ?? ""))
    : config.prompt;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.model || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { text: json.choices?.[0]?.message?.content ?? "" };
}

async function runHttpRequest(config: any, previousOutput: any) {
  const res = await fetch(config.url, {
    method: config.method || "GET",
    headers: config.headers || {},
    body: config.method && config.method !== "GET" ? JSON.stringify(config.body ?? previousOutput) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`HTTP request failed: ${res.status}`);
  return { status: res.status, body: parsed };
}

async function runDbWrite(config: any, previousOutput: any, runId: string) {
  return { saved: true, note: "Persisted via step_runs.output", data: previousOutput };
}

async function runNotify(config: any, previousOutput: any) {
  console.log("NOTIFY:", config.message || "Workflow step reached", previousOutput);
  return { notified: true };
}

function evaluateConditionalBranch(config: any, previousOutput: any) {
  const value = config.field ? previousOutput?.[config.field] : previousOutput;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const matched = config.contains ? text.includes(config.contains) : Boolean(value);
  return { branch: matched ? "true" : "false", matched };
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<{ result?: T; error?: string; attempts: number }> {
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err: any) {
      lastError = err.message || String(err);
    }
  }
  return { error: lastError, attempts: maxAttempts };
}

export default async (req: Request, res: Response) => {
  const { input, session_variables } = req.body;
  const workflowId = input.workflow_id;
  const userId = session_variables["x-hasura-user-id"];

  try {
    const workflow = await verifyCallerCanTrigger(workflowId, userId);

    const runData = await gql(
      `mutation ($workflowId: uuid!, $orgId: uuid!, $userId: uuid!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflowId,
          org_id: $orgId,
          status: running,
          triggered_by: $userId,
          trigger_type: manual,
          started_at: "now()"
        }) { id }
      }`,
      { workflowId, orgId: workflow.org_id, userId }
    );
    const runId = runData.insert_workflow_runs_one.id;

    const stepsData = await gql(
      `query ($workflowId: uuid!) {
        workflow_steps(where: { workflow_id: { _eq: $workflowId } }, order_by: { step_order: asc }) {
          id type name config
        }
      }`,
      { workflowId }
    );
    const steps = stepsData.workflow_steps;

    let previousOutput: any = null;

    for (const step of steps) {
      const stepRunData = await gql(
        `mutation ($runId: uuid!, $stepId: uuid!) {
          insert_step_runs_one(object: {
            workflow_run_id: $runId, step_id: $stepId, status: running, started_at: "now()"
          }) { id }
        }`,
        { runId, stepId: step.id }
      );
      const stepRunId = stepRunData.insert_step_runs_one.id;

      if (step.type === "approval_gate") {
        await gql(
          `mutation ($stepRunId: uuid!) {
            update_step_runs_by_pk(pk_columns: { id: $stepRunId }, _set: { status: awaiting_approval }) { id }
          }`,
          { stepRunId }
        );
        await gql(
          `mutation ($runId: uuid!) {
            update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: paused }) { id }
          }`,
          { runId }
        );
        return res.json({ run_id: runId, status: "paused" });
      }

      let outcome: { result?: any; error?: string; attempts: number };
      if (step.type === "llm_call") {
        outcome = await withRetry(() => runLlmCall(step.config, previousOutput));
      } else if (step.type === "http_request") {
        outcome = await withRetry(() => runHttpRequest(step.config, previousOutput));
      } else if (step.type === "db_write") {
        outcome = { result: await runDbWrite(step.config, previousOutput, runId), attempts: 1 };
      } else if (step.type === "notify") {
        outcome = { result: await runNotify(step.config, previousOutput), attempts: 1 };
      } else if (step.type === "conditional_branch") {
        outcome = { result: evaluateConditionalBranch(step.config, previousOutput), attempts: 1 };
      } else {
        outcome = { error: `Unknown step type: ${step.type}`, attempts: 1 };
      }

      if (outcome.error) {
        await gql(
          `mutation ($stepRunId: uuid!, $attempts: Int!, $error: String!) {
            update_step_runs_by_pk(pk_columns: { id: $stepRunId }, _set: {
              status: failed, error: $error, attempt_count: $attempts, finished_at: "now()"
            }) { id }
          }`,
          { stepRunId, attempts: outcome.attempts, error: outcome.error }
        );
        await gql(
          `mutation ($runId: uuid!, $error: String!) {
            update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: {
              status: failed, error: $error, finished_at: "now()"
            }) { id }
          }`,
          { runId, error: outcome.error }
        );
        return res.status(200).json({ run_id: runId, status: "failed" });
      }

      await gql(
        `mutation ($stepRunId: uuid!, $output: jsonb!, $attempts: Int!) {
          update_step_runs_by_pk(pk_columns: { id: $stepRunId }, _set: {
            status: succeeded, output: $output, attempt_count: $attempts, finished_at: "now()"
          }) { id }
        }`,
        { stepRunId, output: outcome.result, attempts: outcome.attempts }
      );

      previousOutput = outcome.result;
    }

    await gql(
      `mutation ($runId: uuid!) {
        update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: completed, finished_at: "now()" }) { id }
      }`,
      { runId }
    );
    await gql(
      `mutation ($orgId: uuid!) {
        update_organizations_by_pk(pk_columns: { id: $orgId }, _inc: { calls_used: 1 }) { id }
      }`,
      { orgId: workflow.org_id }
    );

    return res.json({ run_id: runId, status: "completed" });
  } catch (err: any) {
    return res.status(400).json({ message: err.message || "Unknown error" });
  }
};