#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d shop <<'SQL'
create extension if not exists pg_stat_statements;
create extension if not exists pgstattuple;
create extension if not exists pgcrypto;

create type plan_tier as enum ('free','pro','team','enterprise');
create type order_status as enum ('pending','paid','shipped','refunded','cancelled');

create table public.users (
  id          bigserial primary key,
  email       text not null unique,
  plan        text not null default 'free',
  is_active   boolean not null default true,
  mrr         numeric(10,2),
  created_at  timestamptz not null default now(),
  metadata    jsonb,
  org_id      uuid
);
comment on column public.users.email is 'login identity, unique';
comment on column public.users.mrr is 'monthly recurring revenue, USD';

create table public.customers (
  id bigserial primary key,
  name text not null,
  user_id bigint references public.users(id),
  phone text,
  created_at timestamptz not null default now()
);
create table public.orders (
  id bigserial primary key,
  user_id bigint not null references public.users(id),
  customer_id bigint references public.customers(id),
  status order_status not null default 'pending',
  shipped_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.order_items (
  id bigserial primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  sku text not null,
  qty int4 not null check (qty > 0),
  price numeric(10,2) not null
);
create table public.invoices (
  id bigserial primary key,
  order_id bigint not null references public.orders(id),
  amount numeric(12,2) not null,
  issued_at timestamptz not null default now()
);
create table public.events (
  id bigserial primary key,
  user_id bigint,
  name text not null,
  payload jsonb,
  ip inet,
  created_at timestamptz not null default now()
);
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint references public.users(id),
  token text not null,
  expires_at timestamptz not null
);

insert into public.users (email, plan, is_active, mrr, created_at, metadata, org_id)
select (array['ana','ben','cy','dara','eli','fen','gus','hana','ivo','jun','kai','lena','mira','noor','omar','pia','quinn','rui','sena','tao'])[1 + i % 20] || i || '@example.com',
       (array['free','pro','team','enterprise'])[1 + (i * 7) % 4],
       (i % 9) <> 0,
       case when i % 7 = 0 then null else round((19 + (i * 37) % 880)::numeric, 2) end,
       now() - ((i % 400) || ' days')::interval - ((i % 24) || ' hours')::interval,
       case when i % 5 = 0 then null else jsonb_build_object('keys', 2 + i % 6, 'source', (array['web','ios','api'])[1 + i % 3]) end,
       gen_random_uuid()
from generate_series(1, 48201) i;

insert into public.customers (name, user_id, phone)
select 'Customer ' || i, 1 + (i * 3) % 48201, '+1-555-' || lpad((i % 10000)::text, 4, '0') from generate_series(1, 12900) i;

insert into public.orders (user_id, customer_id, status, shipped_at, created_at)
select 1 + (i * 13) % 48201, 1 + (i * 5) % 12900,
       (array['pending','paid','shipped','refunded','cancelled'])[1 + i % 5]::order_status,
       case when i % 5 = 2 then now() - ((i % 90) || ' days')::interval end,
       now() - ((i % 365) || ' days')::interval
from generate_series(1, 131000) i;

insert into public.order_items (order_id, sku, qty, price)
select 1 + (i * 7) % 131000, 'SKU-' || (i % 500), 1 + i % 4, round((5 + (i * 11) % 200)::numeric, 2) from generate_series(1, 402000) i;

insert into public.invoices (order_id, amount, issued_at)
select 1 + (i * 3) % 131000, round((20 + (i * 17) % 900)::numeric, 2), now() - ((i % 300) || ' days')::interval from generate_series(1, 88400) i;

insert into public.events (user_id, name, payload, ip)
select 1 + i % 48201, (array['login','view','click','purchase'])[1 + i % 4],
       jsonb_build_object('path', '/p/' || (i % 50)), ('10.0.' || (i % 255) || '.' || (i % 250))::inet
from generate_series(1, 50000) i;

create index orders_user_id_idx on public.orders(user_id);
create index order_items_order_id_idx on public.order_items(order_id);
create index users_created_at_idx on public.users(created_at);

create view public.active_users as select id, email, plan from public.users where is_active;
create view public.mrr_by_month as
  select date_trunc('month', created_at) as month, plan, sum(mrr) as mrr, count(*) as accounts
  from public.users group by 1, 2;

create function public.bill_cycle(p_user bigint) returns numeric language sql stable as
  $$ select coalesce(sum(mrr), 0) from public.users where id = p_user $$;
create function public.tsv_update() returns trigger language plpgsql as
  $$ begin new.name := trim(new.name); return new; end $$;
create trigger customers_trim before insert or update on public.customers for each row execute function public.tsv_update();

alter table public.users enable row level security;
create policy users_owner_all on public.users to app using (true) with check (true);
create policy users_analyst_read on public.users for select to analyst using (is_active);

create schema analytics;
create table analytics.fct_orders as select id, user_id, status, created_at from public.orders limit 1000;
create table analytics.dim_users as select id, email, plan from public.users limit 1000;

grant usage on schema public, analytics to app, analyst, readonly;
grant select, insert, update, delete on all tables in schema public to app;
grant usage on all sequences in schema public to app;
grant select on all tables in schema public to analyst;
grant select on public.orders, public.order_items, public.invoices to readonly;
analyze;
SQL
