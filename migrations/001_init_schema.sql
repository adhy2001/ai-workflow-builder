-- =========================================================
-- Phase 1: Core schema for the AI Agent Workflow Builder
-- =========================================================
create extension if not exists pgcrypto;

-- organizations
create table organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  quota_period_start date not null default date_trunc('month', now())::date,
  calls_allowed integer not null default 1000,
  calls_used    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- org_members  — THE pivot table for every permission check
create type org_role as enum ('owner', 'editor', 'viewer');

create table org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null,
  role       org_role not null default 'viewer',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index idx_org_members_user on org_members(user_id);
create index idx_org_members_org on org_members(org_id);

-- workflows
create table workflows (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  description text,
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_workflows_org on workflows(org_id);

-- workflow_steps
create type step_type as enum (
  'llm_call', 'http_request', 'db_write', 'notify',
  'conditional_branch', 'approval_gate'
);

create table workflow_steps (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  step_order  integer not null,
  type        step_type not null,
  name        text not null,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (workflow_id, step_order)
);

create index idx_steps_workflow on workflow_steps(workflow_id);

-- workflow_triggers
create type trigger_type as enum ('manual', 'webhook', 'scheduled', 'db_event');

create table workflow_triggers (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  type        trigger_type not null,
  config      jsonb not null default '{}'::jsonb,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index idx_triggers_workflow on workflow_triggers(workflow_id);

-- workflow_runs
create type run_status as enum (
  'pending', 'running', 'paused', 'completed', 'failed'
);

create table workflow_runs (
  id             uuid primary key default gen_random_uuid(),
  workflow_id    uuid not null references workflows(id) on delete cascade,
  org_id         uuid not null references organizations(id) on delete cascade,
  status         run_status not null default 'pending',
  triggered_by   uuid,
  trigger_type   trigger_type not null default 'manual',
  started_at     timestamptz,
  finished_at    timestamptz,
  error          text,
  created_at     timestamptz not null default now()
);

create index idx_runs_workflow on workflow_runs(workflow_id);
create index idx_runs_org on workflow_runs(org_id);
create index idx_runs_status on workflow_runs(status);

-- step_runs
create type step_run_status as enum (
  'pending', 'running', 'succeeded', 'failed', 'awaiting_approval', 'skipped'
);

create table step_runs (
  id             uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  step_id        uuid not null references workflow_steps(id) on delete cascade,
  status         step_run_status not null default 'pending',
  input          jsonb,
  output         jsonb,
  error          text,
  attempt_count  integer not null default 0,
  approved_by    uuid,
  approved_at    timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index idx_step_runs_run on step_runs(workflow_run_id);
create index idx_step_runs_step on step_runs(step_id);

-- updated_at trigger helper
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_org_updated
  before update on organizations
  for each row execute function set_updated_at();

create trigger trg_workflow_updated
  before update on workflows
  for each row execute function set_updated_at();

-- Aggregation: org-level usage view
create view org_usage_summary as
select
  o.id as org_id,
  o.calls_allowed,
  o.calls_used,
  o.calls_allowed - o.calls_used as calls_remaining,
  count(distinct wr.id) filter (where wr.status = 'completed') as completed_runs,
  avg(extract(epoch from (wr.finished_at - wr.started_at)))
    filter (where wr.status = 'completed') as avg_run_duration_seconds
from organizations o
left join workflow_runs wr on wr.org_id = o.id
group by o.id, o.calls_allowed, o.calls_used;