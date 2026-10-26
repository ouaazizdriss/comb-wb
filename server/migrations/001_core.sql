-- Core schema. Runs as comb_owner; the runtime role comb_app gets DML only.
create extension if not exists pgcrypto;

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  name           text not null default '',
  password_hash  text,
  role           text not null default 'Viewer' check (role in ('Owner','Admin','Analyst','Viewer','Service')),
  auth           text not null default 'password' check (auth in ('password','sso','token')),
  mfa_secret_enc bytea,
  mfa_enabled    boolean not null default false,
  status         text not null default 'active' check (status in ('active','invited','disabled')),
  created_at     timestamptz not null default now(),
  last_active_at timestamptz
);
create unique index users_email_uq on users (lower(email));

create table sessions (
  id_hash      bytea primary key,           -- sha256 of the cookie token; the token itself is never stored
  user_id      uuid not null references users(id) on delete cascade,
  csrf_token   text not null,
  mfa_pending  boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           inet,
  user_agent   text,
  revoked_at   timestamptz
);
create index sessions_user_idx on sessions (user_id);

create table api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  prefix       text not null,               -- first characters shown in the UI, e.g. comb_7f2a
  hash         bytea not null unique,       -- sha256 of the full token
  scopes       text[] not null default '{}',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

create table connections (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  color            text not null default 'slate',
  env              text not null default 'local' check (env in ('local','dev','staging','prod')),
  host             text not null,
  port             int not null default 5432,
  dbname           text not null,
  username         text not null,
  secret_enc       bytea,                   -- envelope-encrypted password, bound to the row id
  sslmode          text not null default 'prefer',
  ssl_ca           text,                    -- PEM bundle for verify-ca / verify-full against private CAs
  read_only        boolean not null default false,
  require_approval boolean not null default false,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  last_opened_at   timestamptz
);

create table connection_access (
  user_id       uuid not null references users(id) on delete cascade,
  connection_id uuid not null references connections(id) on delete cascade,
  level         text not null check (level in ('none','read','write','admin')),
  primary key (user_id, connection_id)
);

create table app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  secret_enc bytea,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

-- Append-only, hash-chained audit trail.
create table audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  actor_id        uuid,
  actor_label     text not null,
  connection_id   uuid,
  connection_name text,
  kind            text not null,
  target          text,
  sql             text,
  rows            bigint,
  ms              integer,
  status          text not null,
  detail          jsonb,
  ip              inet,
  prev_hash       bytea not null,
  hash            bytea not null
);
create index audit_log_at_idx on audit_log (at desc);

create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_immutable();

create table notifications (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete cascade,  -- null = everyone
  kind       text not null,                                -- appr | err | job | cat | info
  title      text not null,
  body       text not null default '',
  target     text,                                         -- tab kind to open, e.g. 'approvals'
  created_at timestamptz not null default now()
);
create table notification_reads (
  notification_id bigint not null references notifications(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  primary key (notification_id, user_id)
);

-- Approvals: writes on approval-required connections land here instead of running.
create table approvals (
  id            bigserial primary key,
  connection_id uuid not null references connections(id) on delete cascade,
  author_id     uuid not null references users(id),
  kind          text not null,
  title         text not null,
  sql           text not null,
  state         text not null default 'pending' check (state in ('pending','approved','rejected','applied','failed','withdrawn')),
  est_rows      bigint,
  created_at    timestamptz not null default now(),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  applied_at    timestamptz,
  result        jsonb
);
create table approval_comments (
  id          bigserial primary key,
  approval_id bigint not null references approvals(id) on delete cascade,
  user_id     uuid not null references users(id),
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Runtime privileges.
grant usage on schema public to comb_app;
grant select, insert, update, delete on all tables in schema public to comb_app;
grant usage, select on all sequences in schema public to comb_app;
revoke update, delete, truncate on audit_log from comb_app;
alter default privileges for role comb_owner in schema public grant select, insert, update, delete on tables to comb_app;
alter default privileges for role comb_owner in schema public grant usage, select on sequences to comb_app;

-- pg-boss keeps its own tables in its own schema and always issues CREATE SCHEMA IF NOT EXISTS,
-- which Postgres checks against database-level CREATE. That right lets comb_app add schemas;
-- it does not give it any power over tables owned by comb_owner, such as audit_log.
create schema if not exists pgboss;
grant usage, create on schema pgboss to comb_app;
do $$ begin execute format('grant create on database %I to comb_app', current_database()); end $$;
