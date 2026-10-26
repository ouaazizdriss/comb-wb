-- Monitoring, cluster topology and backups (ops module).

-- One row per connection per sampler tick. Raw counters are kept so rates can be recomputed;
-- tps / cache_hit are computed from the delta to the previous sample. 7-day retention.
create table monitor_samples (
  id               bigserial primary key,
  connection_id    uuid not null references connections(id) on delete cascade,
  at               timestamptz not null default now(),
  ok               boolean not null default true,
  error            text,
  xact_commit      bigint,
  xact_rollback    bigint,
  blks_hit         bigint,
  blks_read        bigint,
  tup_ins          bigint,
  tup_upd          bigint,
  tup_del          bigint,
  deadlocks        bigint,
  temp_bytes       bigint,
  tps              double precision,
  cache_hit        double precision,
  deadlocks_delta  bigint,
  temp_bytes_delta bigint,
  conn_total       int,
  conn_active      int,
  conn_idle_txn    int,
  conn_waiting     int,
  max_conn         int,
  is_replica       boolean,
  repl_lag_s       double precision,
  replicas         jsonb,
  wal_bytes        numeric,
  db_size          bigint,
  longest_xact_s   double precision,
  longest_xact_pid int,
  longest_idle_txn_s double precision
);
create index monitor_samples_conn_at_idx on monitor_samples (connection_id, at desc);
create index monitor_samples_at_idx on monitor_samples (at);

create table monitor_alerts (
  id            bigserial primary key,
  connection_id uuid not null references connections(id) on delete cascade,
  rule          text not null,
  severity      text not null check (severity in ('warn','crit')),
  title         text not null,
  body          text not null default '',
  opened_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  acked_at      timestamptz,
  acked_by      uuid references users(id) on delete set null,
  acked_label   text
);
create unique index monitor_alerts_open_uq on monitor_alerts (connection_id, rule) where resolved_at is null;
create index monitor_alerts_conn_idx on monitor_alerts (connection_id, opened_at desc);

-- Per-connection ops settings (Patroni URL, region, outbound allowlist). The Patroni
-- credentials are envelope-encrypted and never returned to the browser.
create table ops_conn_settings (
  connection_id   uuid primary key references connections(id) on delete cascade,
  patroni_url     text,
  patroni_auth_enc bytea,
  allow_hosts     text[] not null default '{}',
  region          text,
  updated_by      uuid references users(id) on delete set null,
  updated_at      timestamptz not null default now()
);

create table backups (
  id             bigserial primary key,
  connection_id  uuid not null references connections(id) on delete cascade,
  backend        text not null check (backend in ('logical','pgbackrest')),
  kind           text not null check (kind in ('logical','full','incr','diff')),
  status         text not null default 'running' check (status in ('running','ok','error','expired')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  size_bytes     bigint,
  duration_ms    integer,
  sha256         text,
  path           text,
  destination    text,
  table_count    integer,
  server_version text,
  error          text,
  created_by     uuid references users(id) on delete set null,
  created_label  text not null default 'system',
  verified       boolean,
  verified_at    timestamptz,
  verify_note    text
);
create index backups_conn_idx on backups (connection_id, started_at desc);

-- Long-running ops work (backup, restore, verification) with status the UI polls.
create table ops_tasks (
  id            bigserial primary key,
  connection_id uuid not null references connections(id) on delete cascade,
  kind          text not null check (kind in ('backup','restore_scratch','restore_inplace','verify')),
  status        text not null default 'queued' check (status in ('queued','running','ok','error')),
  backup_id     bigint references backups(id) on delete set null,
  detail        jsonb not null default '{}'::jsonb,
  result        jsonb,
  error         text,
  created_by    uuid references users(id) on delete set null,
  created_label text not null default 'system',
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index ops_tasks_conn_idx on ops_tasks (connection_id, created_at desc);
