-- Data module: catalog metadata, PII candidates, data quality tests, compliance (DSR, retention), usage teams.
-- Runs as comb_owner; default privileges give comb_app DML.

-- Comb's own metadata about target columns (the catalog itself is read live from pg_catalog).
create table catalog_columns (
  connection_id  uuid not null references connections(id) on delete cascade,
  schema_name    text not null,
  table_name     text not null,
  column_name    text not null,
  classification text not null default 'UNCLASSIFIED' check (classification in ('UNCLASSIFIED','INTERNAL','FINANCIAL','PII','SECRET')),
  masking        text not null default 'none' check (masking in ('none','partial','full')),
  owner_id       uuid references users(id) on delete set null,
  description    text not null default '',
  tags           text[] not null default '{}',
  updated_at     timestamptz not null default now(),
  updated_by     uuid references users(id) on delete set null,
  primary key (connection_id, schema_name, table_name, column_name)
);

-- PII scan results. Only names, pattern names and match counts are stored, never sampled values.
create table catalog_pii_candidates (
  id             bigserial primary key,
  connection_id  uuid not null references connections(id) on delete cascade,
  schema_name    text not null,
  table_name     text not null,
  column_name    text not null,
  suggested      text not null check (suggested in ('PII','SECRET')),
  name_hint      text,                      -- which name heuristic fired, e.g. 'email'
  matches        jsonb not null default '{}'::jsonb,  -- { email: 200, phone: 0, ... } counts only
  sampled        int not null default 0,
  state          text not null default 'candidate' check (state in ('candidate','confirmed','dismissed')),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  decided_by     uuid references users(id) on delete set null,
  decided_at     timestamptz,
  unique (connection_id, schema_name, table_name, column_name)
);

create table catalog_scans (
  id             bigserial primary key,
  connection_id  uuid not null references connections(id) on delete cascade,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  columns_seen   int not null default 0,
  columns_sampled int not null default 0,
  new_candidates int not null default 0,
  status         text not null default 'running' check (status in ('running','ok','error')),
  error          text,
  actor          text not null
);
create index catalog_scans_conn_idx on catalog_scans (connection_id, started_at desc);

-- Data quality tests and their runs.
create table dq_tests (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references connections(id) on delete cascade,
  name           text not null,
  kind           text not null check (kind in ('not_null','unique','accepted_values','freshness','row_count_min','referential','custom')),
  schema_name    text not null,
  table_name     text not null,
  column_name    text,
  config         jsonb not null default '{}'::jsonb,
  rule           text not null,
  sql            text not null,
  severity       text not null default 'warn' check (severity in ('info','warn','critical')),
  schedule       text,
  options        jsonb not null default '{}'::jsonb,   -- { notify, blockExport, runOnSchedule }
  muted          boolean not null default false,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  last_run_at    timestamptz,
  last_state     text check (last_state in ('pass','fail','error')),
  last_failing   bigint,
  last_ms        int
);
create index dq_tests_conn_idx on dq_tests (connection_id);

create table dq_runs (
  id        bigserial primary key,
  test_id   uuid not null references dq_tests(id) on delete cascade,
  at        timestamptz not null default now(),
  state     text not null check (state in ('pass','fail','error')),
  failing   bigint,
  ms        int,
  error     text,
  columns   jsonb,            -- column names of the stored sample
  sample    jsonb,            -- at most 4 offending rows, masked, without SECRET columns
  actor     text not null
);
create index dq_runs_test_idx on dq_runs (test_id, at desc);

-- Audit chain verifications (daily job + on demand).
create table compliance_chain_checks (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  ok       boolean not null,
  checked  bigint not null,
  broken_at bigint,
  head     text
);

-- Data subject requests.
create table compliance_dsr (
  id             bigserial primary key,
  connection_id  uuid not null references connections(id) on delete cascade,
  kind           text not null check (kind in ('access','erasure','rectification')),
  subject        text not null,
  locator        jsonb not null,          -- { schema, table, column } the subject identifier is matched on
  note           text not null default '',
  due_at         timestamptz not null,
  state          text not null default 'open' check (state in ('open','awaiting_approval','done','cancelled')),
  approval_id    bigint,
  result         jsonb,                   -- counts only
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index compliance_dsr_conn_idx on compliance_dsr (connection_id, created_at desc);

-- Retention policies: reported daily, enforced only by an explicit action through runSql.
create table compliance_retention (
  id             bigserial primary key,
  connection_id  uuid not null references connections(id) on delete cascade,
  schema_name    text not null,
  table_name     text not null,
  ts_column      text not null,
  keep_days      int not null check (keep_days between 1 and 36500),
  note           text not null default '',
  last_checked_at timestamptz,
  last_over      bigint,
  last_error     text,
  last_enforced_at timestamptz,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (connection_id, schema_name, table_name, ts_column)
);

-- Usage: user -> team mapping and per-connection instance rates.
create table usage_teams (
  user_id    uuid primary key references users(id) on delete cascade,
  team       text not null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table usage_rates (
  connection_id uuid primary key references connections(id) on delete cascade,
  usd_per_hour  numeric(12,4) not null check (usd_per_hour >= 0),
  updated_by    uuid references users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

-- Usage and catalog access read the trail per connection and period.
create index if not exists audit_log_data_conn_at_idx on audit_log (connection_id, at desc);
