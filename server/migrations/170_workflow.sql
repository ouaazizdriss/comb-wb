-- Workflow: query library, scheduled jobs, migrations.

-- ── Query library ─────────────────────────────────────────────
create table library_queries (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text not null default '',
  sql            text not null,
  -- Declared parameter types/defaults, keyed by placeholder name: {"months": {"type":"number","default":"24"}}
  params         jsonb not null default '{}'::jsonb,
  owner_id       uuid not null references users(id) on delete cascade,
  -- private: owner only · shared: workspace can run and edit · readonly: workspace can run, only the owner edits
  visibility     text not null default 'private' check (visibility in ('private','shared','readonly')),
  allow_schedule boolean not null default true,
  tags           text[] not null default '{}',
  connection_id  uuid references connections(id) on delete set null,
  version        int not null default 1,
  runs           bigint not null default 0,
  total_ms       bigint not null default 0,
  last_run_at    timestamptz,
  last_run_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index library_queries_owner_idx on library_queries (owner_id);

-- Versions are immutable: every save appends one.
create table library_versions (
  query_id     uuid not null references library_queries(id) on delete cascade,
  n            int not null,
  name         text not null,
  description  text not null default '',
  sql          text not null,
  params       jsonb not null default '{}'::jsonb,
  author_id    uuid references users(id) on delete set null,
  author_label text not null,
  note         text not null default '',
  created_at   timestamptz not null default now(),
  primary key (query_id, n)
);
revoke update, truncate on library_versions from comb_app;

-- ── Scheduled jobs ────────────────────────────────────────────
create table sched_jobs (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  kind           text not null check (kind in ('query','export','maintenance','quality','refresh')),
  cron           text not null,
  timezone       text not null default 'UTC',
  connection_id  uuid not null references connections(id) on delete cascade,
  sql            text,
  library_id     uuid references library_queries(id) on delete set null,
  params         jsonb not null default '{}'::jsonb,
  integration_id text,                       -- null = store the result only
  options        jsonb not null default '{}'::jsonb,
  owner_id       uuid not null references users(id) on delete cascade,
  state          text not null default 'active' check (state in ('active','paused')),
  next_run_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index sched_jobs_due_idx on sched_jobs (next_run_at) where state = 'active';

create table sched_job_runs (
  id          bigserial primary key,
  job_id      uuid not null references sched_jobs(id) on delete cascade,
  trigger     text not null check (trigger in ('schedule','manual','retry')),
  retry_of    bigint references sched_job_runs(id) on delete set null,
  attempt     int not null default 1,
  status      text not null default 'running' check (status in ('running','ok','failed','skipped')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  rows        bigint,
  ms          int,
  error       text,
  delivery    text,
  -- Column names and counts only; row values are never stored (they would escape per-viewer masking).
  result      jsonb
);
create index sched_job_runs_job_idx on sched_job_runs (job_id, id desc);

-- ── Migrations ────────────────────────────────────────────────
create table wf_migrations (
  id           uuid primary key default gen_random_uuid(),
  project      text not null default 'default',
  version      text not null,
  name         text not null,
  up_sql       text not null,
  down_sql     text not null default '',
  author_id    uuid references users(id) on delete set null,
  author_label text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project, version)
);

-- Which migration project each connection follows (dev → staging → prod share one).
create table wf_migration_projects (
  connection_id uuid primary key references connections(id) on delete cascade,
  project       text not null default 'default'
);

-- Applied state lives in Comb's metadata, never in the target database.
create table wf_migration_state (
  migration_id  uuid not null references wf_migrations(id) on delete cascade,
  connection_id uuid not null references connections(id) on delete cascade,
  state         text not null check (state in ('applied','failed','pending_approval','rolled_back')),
  checksum      text,
  applied_at    timestamptz,
  applied_by    text,
  ms            int,
  error         text,
  approval_id   bigint,
  approval_dir  text,                       -- 'up' | 'down' while waiting for approval
  snapshot      jsonb,                      -- catalog snapshot recorded after apply (drift check)
  updated_at    timestamptz not null default now(),
  primary key (migration_id, connection_id)
);
