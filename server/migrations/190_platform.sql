-- Platform module: outbound integrations (Slack, webhook, Teams, PagerDuty, email, Datadog).
-- Secrets (URLs, keys, passwords) live envelope-encrypted in secret_enc, bound to the row id.

create table integrations (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('slack','webhook','teams','pagerduty','email','datadog')),
  name         text not null,
  enabled      boolean not null default true,
  config       jsonb not null default '{}'::jsonb,   -- non-secret settings: host name, SMTP host/port/from/to, Datadog site
  secret_enc   bytea,                                -- JSON of the secrets, encryptSecret(.., 'integration:<id>')
  secret_last4 text,                                 -- last 4 characters of the main secret, for the UI
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index integrations_name_uq on integrations (lower(name));

-- Event subscription matrix: rows = events, columns = integrations.
create table integration_subscriptions (
  integration_id uuid not null references integrations(id) on delete cascade,
  event          text not null,
  primary key (integration_id, event)
);

-- Delivery attempts (ids, status codes and timings only; never payload contents).
create table integration_deliveries (
  id             bigserial primary key,
  integration_id uuid not null references integrations(id) on delete cascade,
  event          text not null,
  attempt        int not null default 1,
  status         text not null check (status in ('ok','failed','retrying','refused')),
  status_code    int,
  ms             int,
  error          text,
  test           boolean not null default false,
  created_at     timestamptz not null default now()
);
create index integration_deliveries_idx on integration_deliveries (integration_id, id desc);
create index integration_deliveries_at_idx on integration_deliveries (created_at);
