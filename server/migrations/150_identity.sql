-- Identity module (team invites, SSO login flows). Runs as comb_owner.

-- One-time invite links. Only the sha256 of the token is stored; the link is shown once to the admin.
create table team_invites (
  token_hash  bytea primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index team_invites_user_idx on team_invites (user_id);

-- In-flight SSO logins. The browser holds a random handle in an httpOnly SameSite=Lax cookie;
-- only its sha256 is stored here, next to the OIDC state/nonce/PKCE verifier or the SAML request ID.
create table sso_flows (
  id_hash          bytea primary key,
  kind             text not null check (kind in ('saml','oidc')),
  request_id       text unique,             -- SAML AuthnRequest ID (InResponseTo)
  state            text,                    -- OIDC
  nonce            text,                    -- OIDC
  code_verifier    text,                    -- OIDC PKCE
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  saml_consumed_at timestamptz,             -- set once node-saml accepted the InResponseTo
  ticket_hash      bytea unique,            -- SAML: ACS result waiting for the browser's cookie
  result           jsonb,                   -- validated identity (email, name, groups), never secrets
  done_at          timestamptz
);
create index sso_flows_expires_idx on sso_flows (expires_at);

-- SSO users created just-in-time without a mapped IdP group get no access at all. Their role is
-- Viewer (which defaults to read), so every connection gets an explicit 'none' row for them,
-- including connections created later (trigger below). A mapped group on a later sign-in lifts it.
create table identity_sso_unmapped (
  user_id    uuid primary key references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create function identity_fence_new_connection() returns trigger language plpgsql as $$
begin
  insert into connection_access (user_id, connection_id, level)
  select user_id, new.id, 'none' from identity_sso_unmapped
  on conflict do nothing;
  return new;
end $$;
create trigger identity_fence_new_connection after insert on connections
  for each row execute function identity_fence_new_connection();
