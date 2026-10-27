# Comb

**[Take the interactive product tour →](https://ouaazizdriss.github.io/comb-wb/)**

Comb is a self-hosted, browser-based workbench for PostgreSQL. It combines a SQL client (query editor,
data grid, ERD) with the admin, governance and compliance tools a team needs around production
databases: approvals, an audit trail, roles and privileges, monitoring, backups, a data catalog with
column masking, and more.

Comb runs entirely in your own infrastructure. It never phones home, and it is free to use, with no
license, seat limit or feature gating.

- [Principles](#principles)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start (local development)](#quick-start-local-development)
- [Configuration](#configuration)
- [Production deployment](#production-deployment)
- [Users, roles and access](#users-roles-and-access)
- [Security model](#security-model)
- [Operations](#operations)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## Principles

1. **Safe on production by default.** Production connections can be opened read-only, destructive
   statements need a typed confirmation, and writes on approval-required connections need a second
   person to approve them.
2. **The server decides, never the browser.** Every safety rule (read-only, approvals, masking, audit)
   is enforced in the Comb server. The UI only shows what the server already allows.
3. **Every action is recorded.** The audit trail is append-only and hash-chained, so tampering can be
   detected, and compliance evidence comes from what actually happened.
4. **Credentials never reach the browser.** Database passwords, SSH keys, tokens and webhook secrets
   are encrypted at rest and only ever used on the server.

## Features

### Workbench

| Area | What you get |
|---|---|
| **Connections** | Connection form with "paste a connection string" to fill every field, test connection, SSL modes, optional SSH tunnel through a bastion with a pinned host key. Each connection has an environment (local, dev, staging, prod), can be read-only, and can require approvals for writes. |
| **Object tree** | Schemas, tables, views, functions and enums from the live catalog. |
| **Command palette** | `⌘K` / `Ctrl+K` to jump to any table, saved query or admin screen, plus keyboard shortcuts throughout. |
| **Table tab** | Virtual data grid with server-side paging (keyset on the primary key), sort and filter, and row-count estimates for large tables. Edits are staged, reviewed as SQL, then applied in one transaction. Sub-tabs for Structure, Constraints, Indexes, Triggers and DDL. |
| **Query tab** | SQL editor with PostgreSQL highlighting and autocomplete from the live catalog. Runs the statement under the cursor (`⌘↵`) or everything (`⌘⇧↵`), with cancel, error position, notices, results and CSV export. |
| **ERD** | Entity-relationship diagram with automatic layout and inferred relationships where no foreign key exists. |
| **History and saved queries** | Your recent statements and the team's query library, in the sidebar. |

### Admin modules

| Group | Module | Highlights |
|---|---|---|
| **Database** | Monitoring | KPIs (transactions/s, cache hit, connections), slowest statements, blocking tree with confirmed terminate, table health, alert rules. |
| | Approvals | Write requests from approval-required connections, with row estimates, lock warnings, a dry run on the real schema (rolled back), discussion thread, and approve/reject by someone other than the author. |
| | Cluster topology | Primary and replicas from `pg_stat_replication`, replication slots and lag. With Patroni: members, switchover and failover history. |
| | Migrations | Versioned up/down scripts per project, dry run, lock warnings, apply and roll back with approval support, drift detection by checksum. |
| | Scheduled jobs | Cron-scheduled SQL or saved queries (pinned to a version), run history, retries, delivery to integrations. |
| | Query library | Saved queries with versions, tags and private / shared / read-only visibility. |
| | Data catalog | Column descriptions, owners and tags, classification (internal, financial, PII, secret), a PII scan, and **column masking** applied server-side to every result set. |
| | Data quality | Tests (not null, unique, accepted values, freshness, minimum row count, referential integrity, custom SQL) with scheduled runs and failure alerts. |
| | Backups | Logical backups with `pg_dump`, or pgBackRest when configured. Nightly verification, restore points, restore to a scratch database or in place. |
| **Governance** | Audit trail | Every statement, login and change, with filters, export, before/after row images for writes, drafted "undo" SQL, and chain verification. |
| | Compliance | Controls with evidence, data-subject requests (find and erase/export a person's data), retention policies. |
| | Usage & cost | Query time by team and statement kind, most expensive queries (values stripped), chargeback CSV. |
| **Access** | Roles & privileges | Database roles and grants, staged GRANT/REVOKE reviewed as SQL before running, password resets that never store the password. |
| | Team & access | Members, invites, workspace roles, per-connection access levels, SSO group mapping. |
| | Security | TOTP multi-factor authentication, API tokens with scopes, IP allowlist, active sessions, password and session policy. |
| **Platform** | Integrations | Slack, Microsoft Teams, PagerDuty, email (SMTP), Datadog and signed webhooks, all behind an SSRF guard. |
| | Deployment | Service health, member counts, feature flags, release history and upgrade commands. |

## How it works

```
 Browser (React SPA)                 Comb server (Node.js)                       Your systems
 ───────────────────                 ─────────────────────                       ────────────
 grid · editor · ERD   ── HTTPS ──▶  API (Fastify) · WebSocket                ─▶ Target PostgreSQL databases
 no credentials, ever                SQL classifier (real Postgres parser)       (direct or via SSH tunnel)
                                     policy · approvals · audit · masking     ─▶ Patroni / pgBackRest (optional)
                                     encrypted credential vault               ─▶ Slack, Teams, SMTP… (optional)
                                     background jobs (pg-boss)                ─▶ SAML / OIDC identity provider
                                              │
                                              ▼
                                     Comb metadata database (PostgreSQL)
```

- **One TypeScript codebase** in three packages: `web` (React single-page app), `server` (API and job
  worker in one process) and `shared` (types and schemas used by both).
- **Comb's own data** (users, connections, saved queries, audit trail, jobs, approvals…) lives in a
  PostgreSQL *metadata database*, separate from the databases you work on.
- **Background work** (scheduled jobs, monitoring samples, data-quality runs, nightly backup checks)
  runs on pg-boss, a queue stored in that same database, so there's no Redis or broker to run.
- **Every SQL statement is parsed** with the real PostgreSQL parser (`libpg-query`) before it is sent.
  That classification drives read-only enforcement, approvals, typed confirmations, the audit "kind"
  and grid editability.

## Requirements

| Component | Version |
|---|---|
| Node.js | 24 (the production image uses `node:24-bookworm-slim`) |
| PostgreSQL for Comb's metadata | 16 recommended |
| Target databases | PostgreSQL 13 to 17 by design; currently tested on 16 |
| Docker + Docker Compose | For the local development database |
| `pg_dump` / `pg_restore` | On the Comb server, for logical backups (included in the image) |
| Optional | `pgbackrest` (PITR backups), Patroni (switchover), a SAML or OIDC identity provider, an SMTP server |

Monitoring is richest when the target database loads the `pg_stat_statements` extension
(`shared_preload_libraries = 'pg_stat_statements'`).

## Quick start (local development)

```bash
# 1. Start PostgreSQL 16 with the metadata database and the "shop" demo database
docker compose -p comb up -d

# 2. Configure
cp .env.example .env
openssl rand -base64 32          # paste the output as COMB_MASTER_KEY in .env

# 3. Install dependencies
npm install

# 4. Run the API (port 8080) and the web app (port 5173)
./tools/dev.sh
```

Open **http://localhost:5173**, create the Owner account, then choose **Load the demo database** to
get a ready-made connection to the `shop` sample database.

> Open the app at the exact address in `COMB_PUBLIC_URL` (`http://localhost:5173` by default).
> Mutating requests from any other origin, such as `http://127.0.0.1:5173`, are refused as cross-origin.

To fill an empty install with a demo owner and connection in one step (development only):

```bash
BASE=http://127.0.0.1:8080 node tools/seed.mjs
# signs in as owner@acme.test / "correct horse battery staple"
```

The development database listens on `127.0.0.1:55432` only, and its passwords
(`docker/init/01-databases.sql`) are throwaway values that must never be used anywhere else.

## Configuration

Comb is configured with environment variables. Invalid configuration stops the server at start-up,
and only variable names (never values) are printed.

### Required

| Variable | Purpose |
|---|---|
| `COMB_DATABASE_URL` | Metadata database, as the **runtime role** (`comb_app`). It has DML rights only and never owns tables, so it cannot disable the audit trigger or rewrite history. |
| `COMB_MIGRATION_DATABASE_URL` | Metadata database, as the **owner role** (`comb_owner`). Used only to run migrations at start-up. |
| `COMB_MASTER_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts every stored secret. **Back it up: losing it makes all stored credentials unreadable.** |

### Common

| Variable | Default | Purpose |
|---|---|---|
| `COMB_PUBLIC_URL` | `http://localhost:8080` | The URL users open. `https://` turns on Secure cookies and HSTS, and it is the only origin allowed to send mutating requests. |
| `COMB_TRUST_PROXY` | *(none)* | Addresses or CIDR of your reverse proxy / ingress, so client IPs (audit, IP allowlist) are real. Keep it as narrow as possible. |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Where the server listens. |
| `NODE_ENV` | `production` | `development` for local work. |
| `COMB_STATEMENT_TIMEOUT_MS` | `60000` | Statement timeout for user SQL (a watchdog also cancels runaway statements). |
| `COMB_MAX_RESULT_ROWS` | `5000` | Row cap for grid and query results (exports go up to 100,000). |
| `COMB_SESSION_ABSOLUTE_HOURS` | `168` | Absolute session lifetime; idle timeout is set under Security. |

### Optional

| Variable | Purpose |
|---|---|
| `COMB_DEMO_DSN` | Connection string used by **Load the demo database**. |
| `COMB_BACKUP_DIR` | Where logical backups are written (`/data/backups` in the image). |
| `COMB_PGBACKREST_STANZA` | Enables the pgBackRest backend (the `pgbackrest` binary must be on the server's `PATH`). |
| `COMB_AUDIT_ARCHIVE_DIR` | Directory for the daily audit archive (JSONL with hashes). Without it, nothing is archived. |
| `COMB_RELEASE_FEED` | Path to a local JSON file listing releases (`[{ "version", "date", "notes" }]`), shown on the Deployment screen. Comb never checks the internet for updates. |
| `COMB_WEB_DIST` | Directory of the built web app served by the API (set in the image). |
| `COMB_ALLOWLIST_LOOPBACK_BYPASS` | `true` lets requests from `127.0.0.1` through the IP allowlist (break-glass on a single host). Default `false`. |

## Production deployment

### 1. Create the metadata database and roles

Create two roles, as `docker/init/01-databases.sql` does, with your own strong passwords:

```sql
create role comb_owner login password '…';
create role comb_app   login password '…';
create database comb_meta owner comb_owner;
revoke all on database comb_meta from public;
grant connect on database comb_meta to comb_app;
```

Migrations run automatically at start-up as `comb_owner`. Default privileges give `comb_app` DML on
new tables, and audit tables additionally revoke UPDATE/DELETE/TRUNCATE from it.

### 2. Build the image

```bash
docker build -t comb:1.5.0 .
```

The image runs as a non-root user, serves the web app and the API on port 8080, keeps backups under
the `/data` volume, and exposes a health check at `GET /api/health`.

### 3a. Run with Docker

```bash
docker run -d --name comb -p 8080:8080 -v comb-data:/data \
  -e COMB_DATABASE_URL='postgres://comb_app:…@db-host:5432/comb_meta' \
  -e COMB_MIGRATION_DATABASE_URL='postgres://comb_owner:…@db-host:5432/comb_meta' \
  -e COMB_MASTER_KEY='…' \
  -e COMB_PUBLIC_URL='https://comb.example.com' \
  comb:1.5.0
```

Put Comb behind a TLS-terminating reverse proxy and set `COMB_TRUST_PROXY` to that proxy's address.

### 3b. Run on Kubernetes with Helm

Create the Secret out of band (sealed-secrets, external-secrets, Vault…). The chart never templates
secrets:

```bash
kubectl create secret generic comb-secrets \
  --from-literal=COMB_DATABASE_URL='postgres://comb_app:…@db:5432/comb_meta' \
  --from-literal=COMB_MIGRATION_DATABASE_URL='postgres://comb_owner:…@db:5432/comb_meta' \
  --from-literal=COMB_MASTER_KEY="$(openssl rand -base64 32)"

helm install comb deploy/helm/comb \
  --set publicUrl=https://comb.example.com \
  --set trustProxy=10.0.12.34/32
```

Key values in `deploy/helm/comb/values.yaml`:

| Value | Purpose |
|---|---|
| `publicUrl` | The URL users open. |
| `existingSecret` | Secret holding the three required variables (default `comb-secrets`). |
| `trustProxy` | Exact address/CIDR of your ingress controller. Empty trusts no proxy. |
| `ingressFrom` | Labels of the ingress controller pods; the NetworkPolicy admits only them. |
| `persistence` | Volume for backups (`20Gi` by default). |
| `ingress.*` | Optional Ingress with host and TLS secret. |
| `statementTimeoutMs`, `maxResultRows` | Same as the environment variables above. |

### Upgrading

Upgrades are applied by your deploy tooling, never from the UI. Migrations run on the next start; the
Deployment screen shows pending migrations and the exact upgrade commands for Docker and Helm.

## Users, roles and access

The first person to open a new install creates the **Owner** account. Others join through invite
links (Team & access) or SSO. Comb does not send invite email itself; copy the link to the person.

### Workspace roles

| Role | Default access per connection | Can also |
|---|---|---|
| **Owner** | admin everywhere | Everything, including SSO settings and promoting Admins. |
| **Admin** | write, or read on `prod` | Manage members (except Owners and Admins), settings, integrations, approvals. |
| **Analyst** | write, or read on `prod` | Run queries, save to the library, request approvals. |
| **Viewer** | read | Browse and run read-only queries. |
| **Service** | none | API tokens for automation, with explicitly granted access only. |

### Connection access levels

Each member can be given `none`, `read`, `write` or `admin` on each connection, overriding the default.
On top of that, the **database user stored in the connection is the real ceiling**: Comb can only
narrow what that role may do, never widen it.

- `read` runs everything inside `BEGIN READ ONLY`.
- `write` allows DML, still subject to typed confirmations and approvals.
- `admin` allows privilege statements (GRANT/REVOKE, roles) and is exempt from column masking.

### Single sign-on

Team & access supports **OIDC** (Okta, Entra ID, Google…) with PKCE, and **SAML** with signed
assertions. IdP groups map to workspace roles and connection access. Users created on first SSO login
without a mapped group get no access until a group is mapped. "SSO only" can block password login
for everyone except Owners.

## Security model

- **Credential vault.** Database passwords, SSH secrets, MFA seeds, tokens and webhook secrets are
  envelope-encrypted (AES-256-GCM with a per-secret data key, bound to their row) and never returned to
  the browser.
- **Sessions.** httpOnly, SameSite=Strict cookies with a server-side record; every mutating request
  carries a per-session CSRF token and is origin-checked. Idle and absolute timeouts apply. Passwords use
  argon2id, login is rate-limited, and TOTP MFA can be required by policy.
- **SQL policy.** Every statement is parsed with the real PostgreSQL parser before it is sent:
  - read-only connections and read-level users run inside `BEGIN READ ONLY`;
  - transaction control, `SET ROLE`, unsafe `set_config()`, `COPY` to files or programs, server-file
    functions and SQL-from-string functions are refused;
  - `DROP` and `TRUNCATE` need a typed confirmation, and `UPDATE`/`DELETE` without `WHERE` are blocked by
    default;
  - writes on approval-required connections become approval requests that someone other than the author
    must approve;
  - statements run one per protocol message, with a statement timeout and a watchdog.
- **Column masking.** Masks from the data catalog are applied on the server to every result set (query,
  grid, exports, audit row images). Masked columns are excluded from grid filtering and sorting so their
  values can't be probed.
- **Audit trail.** Append-only (the runtime role has no UPDATE/DELETE, and a trigger refuses them) and
  hash-chained, with verification from the UI. Literal values can be redacted from history.
- **Outbound requests.** Every outbound call (integrations, Patroni, identity provider, SMTP) goes through
  an SSRF guard that refuses private, loopback, link-local and cloud-metadata addresses in every IPv4 and
  IPv6 spelling, pins the vetted address, and caps size and time. An Admin allowlist can open
  private-network hosts, never metadata addresses.
- **SSH tunnels.** The bastion's host key is pinned (SHA-256); a changed key refuses to connect. Any
  change to a bastion or a Patroni address requires the secrets to be entered again.

### What Comb cannot protect against

Comb enforces policy on the SQL it sees, but the database user stored in a connection is the real
ceiling. **Give each connection a least-privilege database role**: no superuser, no membership in
`pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`, and only the grants the
team actually needs. A function that runs dynamic SQL executes with that role's privileges, and Comb
cannot see inside it.

## Operations

| Task | How |
|---|---|
| Health check | `GET /api/health` returns `{ ok, version }`. |
| Logs | stdout/stderr; the last warning and error lines (secrets redacted) are also on the Deployment screen. |
| Back up Comb itself | Back up the metadata database **and** `COMB_MASTER_KEY`. One is useless without the other. |
| Locked out by the IP allowlist | `npm -w server run allowlist:clear` on the server (audited), or set `COMB_ALLOWLIST_LOOPBACK_BYPASS=true` temporarily. |
| Run migrations by hand | `npm -w server run migrate` (they also run on every start). |
| Audit retention | Set `COMB_AUDIT_ARCHIVE_DIR`; events past the retention window are archived daily. Pruning the table afterwards is a deliberate DBA action as `comb_owner`. |

## Testing

```bash
npm run typecheck        # shared, server and web
npm test                 # unit tests (SQL classifier, SSRF guard, redaction)
```

End-to-end suites live in `server/test/e2e-*.mjs` (core, table, query, gov, identity, ops, workflow,
data, platform, ssh). Each runs against a live server and documents its prerequisites in its header.
For example:

```bash
BASE=http://127.0.0.1:8080 node server/test/e2e-core.mjs
```

See [docs/DEVELOPING.md](docs/DEVELOPING.md) for isolated per-module stacks
(`tools/module-dev.sh`), seeding and screenshots.

## Project layout

```
shared/src/                 types and zod schemas shared by server and web
server/src/config.ts        environment configuration
server/src/db/              metadata DB pool and migration runner
server/migrations/          NNN_name.sql, applied in order as comb_owner
server/src/security/        credential vault, sessions, authorisation, audit chain, MFA
server/src/targets/         SQL classifier, target-database pools and the policy-enforcing executor
server/src/core/            connections, object tree, query routes, settings, events, jobs, delivery
server/src/platform/        SSRF guard, SMTP client, log buffer
server/src/modules/         one Fastify plugin per feature module, mounted under /api
web/src/shell/              app shell: sign-in, launcher, workspace, overlays
web/src/screens/            one screen per tab kind (registry.ts maps kinds to screens)
web/src/ui/                 UI kit
deploy/helm/comb/           Helm chart
docker/init/                development database bootstrap
tools/                      dev scripts: dev.sh, seed.mjs, shot.mjs, module-dev.sh
docs/index.html             the product tour, published with GitHub Pages
docs/mockup/                the design reference the screens follow
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Cross-origin request refused" when signing in | You opened Comb at a different address than `COMB_PUBLIC_URL` (for example `127.0.0.1` instead of `localhost`). Use the exact URL. |
| Server exits with "COMB_MASTER_KEY must be 32 random bytes" | Generate one with `openssl rand -base64 32`. |
| Stored passwords stopped working after a redeploy | `COMB_MASTER_KEY` changed. Restore the original key; secrets encrypted with another key cannot be read. |
| Monitoring shows no slowest statements | The target doesn't load `pg_stat_statements`. Add it to `shared_preload_libraries` and run `create extension pg_stat_statements`. |
| Topology says "Patroni not configured" | Expected without Patroni; replication is read from `pg_stat_replication`. Set the Patroni URL under Cluster topology to enable switchover. |
| Backups say pgBackRest is not configured | Expected; logical backups with `pg_dump` work out of the box. Set `COMB_PGBACKREST_STANZA` and install `pgbackrest` for point-in-time recovery. |
| Audit IPs all show the proxy's address | Set `COMB_TRUST_PROXY` to your proxy or ingress address. |
| Restore to a scratch database fails | The connection's database role needs `CREATEDB`. |
