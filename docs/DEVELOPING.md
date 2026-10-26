# Developing Comb

Comb is a self-hosted PostgreSQL workbench. The UI reference is the mockup in `docs/mockup/`
(`markup.html` = the layout with inline styles, `logic.js` = the mock data, texts and behaviour,
`tokens.css` = colour tokens). Screens must look and read like the mockup, but run on real data.

## Layout

```
shared/src/index.ts        types + zod schemas shared by server and web
server/src/config.ts       env config (never log values)
server/src/db/             metadata DB pool (q, one, tx) and migration runner
server/migrations/         NNN_name.sql, run in order as comb_owner
server/src/security/       crypto vault, sessions/auth guard, authz, audit chain, MFA
server/src/targets/        SQL classifier, target-DB pools, the policy-enforcing executor
server/src/core/           routes for connections/tree/query/notifications, settings, events, jobs, delivery
server/src/modules/<m>.ts  one Fastify plugin per feature module, mounted under /api
web/src/shell/             app shell: auth, launcher, workspace, overlays
web/src/screens/<kind>.tsx one screen per tab kind (registry.ts maps kinds → screens)
web/src/ui/index.tsx       UI kit mirroring the mockup's recurring styles
web/src/lib/               api client, zustand store, confirm flow, formatting, tree/status hooks
```

## Security rules (non-negotiable)

1. **Every input is validated** with zod via `parse(schema, req.body | req.query | req.params)`.
2. **Every route checks permissions.** Workspace-level: `requireRole(req, 'Admin')`. Connection-level:
   `requireConn(req, connId, 'read' | 'write' | 'admin')` (returns `{ conn, level, user }`; unknown and
   no-access both 404). `/api/*` requires login by default; only add `config: { public: true }` for
   login/SSO callbacks.
3. **SQL that a user wrote, or that changes a target database, goes through `runSql`** in
   `server/src/targets/exec.ts` with the right `source`. It classifies with the real Postgres parser,
   enforces read-only/approvals/typed confirmation, runs one statement per protocol message, applies
   result filters (masking) and audits. Never bypass it for writes.
4. **Catalog reads Comb itself issues** (pg_catalog, pg_stat_*) use
   `withTarget(conn, { readOnly: true, actor: user.email }, async (c) => c.query(sql, params))` with
   parameters. Never interpolate. Identifiers you must splice in go through `escapeIdent()`, literals
   through `escapeLit()` (from `targets/pool.ts`), after validating they exist in the catalog.
5. **Meta DB queries are parameterised** (`q('... $1', [x])`). No string building.
6. **Audit every state change**: `audit({ actorId, actorLabel, kind, target, status, detail, ip: req.ip })`.
   `audit_log` is append-only and hash-chained; nothing may update or delete it.
7. **Secrets** (passwords, API keys, webhook secrets, tokens) are stored with `encryptSecret(value, aad)` /
   `setSecretSetting`, and are **never** returned to the browser — return `hasX: true` instead.
8. **Outbound HTTP** (webhooks, Slack, IdP metadata, Patroni) must use the SSRF guard the integrations
   module exports (`safeFetch`), which blocks private/link-local/metadata addresses unless an Admin
   allowlisted the host.
9. **Destructive UI actions** call the API without a confirm word first; on `409 COMB_CONFIRM` use
   `withConfirm()` (web/src/lib/confirm.ts) which shows the typed-confirmation dialog. The server decides.
10. **No `dangerouslySetInnerHTML`**, no `eval`, no inline scripts (CSP forbids them anyway).
11. **Exports** neutralise CSV formula injection (`toCsv` in web/src/lib/format.ts; mirror it server-side).
12. **Avoid new npm dependencies.** Prefer what is already installed, and discuss a new dependency before adding it.

## Conventions

- Server module: `export default async function xModule(app: FastifyInstance)`. Prefix its routes with
  the module name: `/monitor/kpis`, `/roles/:connId/...`. Connection-scoped routes take `connId` as a
  path param and call `requireConn`.
- Migrations: put a module's tables in that module's number range (see the Modules table below). They run as
  `comb_owner`; default privileges give `comb_app` DML automatically. For append-only tables add
  `revoke update, delete, truncate on <t> from comb_app;`. Never edit `001_core.sql`.
- Background work: `registerWorker(name, handler, cron?)`, `enqueue(name, data)`, `scheduleCron(...)`
  from `server/src/core/jobs.ts` (pg-boss).
- Events: `emit('job.failed', { ...ids and counts only })`; notifications: `notify({ userId, kind, title, body, target })`.
- Settings: `getSetting(key, fallback)` / `setSetting(key, value, userId)`; secrets via `setSecretSetting`.
- Web screen: `export default function XScreen({ tab }: { tab: Tab })`. Use `@tanstack/react-query`
  with `api.get/post/...`, the UI kit (`Button`, `Seg`, `Toggle`, `Table`, `Page`, `Section`, `Stat`,
  `Split`, `Callout`, `CodeLines`, `Chip`, `Empty`, `Loading`, `ErrorBox`...), `useConn()` for the open
  connection, `useApp().toast(...)` for feedback. Tab params live in `tab.params`
  (`useApp.getState().updateTab(tab.id, { params })`).
- Match the mockup: find your screen in `docs/mockup/markup.html` (search `is<Kind>Tab`, e.g.
  `isMonitorTab`) and its data/text in `docs/mockup/logic.js`. Keep its copy where it is still true.
  Replace mock numbers with real ones; where the real system lacks something (e.g. no Patroni), say so
  plainly in the UI instead of faking it.

## Cross-module contracts

| Provider | Contract |
|---|---|
| core | `POST /api/connections/:id/query { sql, confirm?, maxRows? }` → `QueryResult` or `{ approvalId }`; errors carry `code, position, line` |
| core | `GET /api/connections/:id/tree`, `POST /api/connections/:id/cancel` |
| core | `registerResultFilter(fn)` in exec.ts (catalog masking) · `registerSender(fn)` in core/delivery.ts (integrations) |
| audit (gov) | `GET /api/audit/mine?connectionId&limit` → `[{ id, at, sql, ms, status, kind }]` (sidebar History) |
| library (workflow) | `GET /api/library?limit` → `[{ id, name, ... }]` (sidebar Queries, palette). Library tab param `sel` = query id |
| security (identity) | `POST /api/security/mfa/setup` → `{ secret, qrDataUrl }`, `POST /api/security/mfa/enable { code }` → `{ ok, csrfToken }` — both with `config: { mfaEnroll: true }` |
| sso (identity) | `GET /api/sso/login` (public) starts SSO; callbacks are public and create a session via `createSession` |
| query (query) | `POST /api/query/:connId/export { sql, format: 'csv' }` streams a CSV (EXPORT audited, blocked on prod by policy) |
| assistant panel (ai) | reads `useApp().aiDraft` (text to prefill/send); writes `useApp().editorInsert = { sql, mode, nonce }` which the query editor consumes |
| integrations (platform) | exports `safeFetch(url, init)` from `server/src/modules/integrations.ts`; calls `registerSender` |
| catalog (data) | registers a result filter applying column masks; exports `maskedColumns(conn, level, user, relOid)` → attnums masked for that caller (the table grid leaves them out of filter and sort) |

## Modules

Each feature module has its own migration number range, and a default port pair and database pair for
running it on its own. The e2e suites default to these.

| Module group | Files | Migrations | API / web ports | Meta DB / demo DB |
|---|---|---|---|---|
| table | modules/table.ts, screens/table.tsx | 110–119 | 8101 / 5201 | comb_meta_table / shop_table |
| query | modules/query.ts, modules/erd.ts, screens/query.tsx, screens/erd.tsx | 120–129 | 8102 / 5202 | comb_meta_query / shop_query |
| ai | modules/ai.ts, modules/settings.ts, screens/ai.tsx, screens/ai-panel.tsx, screens/settings.tsx | 130–139 | 8103 / 5203 | comb_meta_ai / shop_ai |
| gov | modules/audit.ts, roles.ts, approvals.ts + screens | 140–149 | 8104 / 5204 | comb_meta_gov / shop_gov |
| identity | modules/team.ts, sso.ts, security.ts + screens team/security | 150–159 | 8105 / 5205 | comb_meta_identity / shop_identity |
| ops | modules/monitor.ts, topology.ts, backup.ts + screens | 160–169 | 8106 / 5206 | comb_meta_ops / shop_ops |
| workflow | modules/migrations.ts, jobs.ts, library.ts + screens | 170–179 | 8107 / 5207 | comb_meta_workflow / shop_workflow |
| data | modules/catalog.ts, quality.ts, compliance.ts, usage.ts + screens | 180–189 | 8108 / 5208 | comb_meta_data / shop_data |
| platform | modules/integrations.ts, deploy.ts + screens | 190–199 | 8109 / 5209 | comb_meta_platform / shop_platform |

Run one module on its own: `tools/module-dev.sh <name> <apiPort> <webPort> '^(001|1[1-9]x)'` where the
regex keeps only core and that module's migrations (leave it out to load everything). Seed it: `BASE=http://127.0.0.1:<apiPort> node tools/seed.mjs`.
Screenshot: `WEB=http://127.0.0.1:<webPort> node tools/shot.mjs out.png --tab <kind>`
(`--table public.users`, `--theme light`, `--eval "<js>"`). Typecheck: `npm run typecheck`.
Stop servers by port: `fuser -k <apiPort>/tcp <webPort>/tcp`. Avoid broad commands such as `pkill -f`, and
don't signal a server's parent process: for a backgrounded server it is often `systemd --user`, which ends
the desktop session.

## Dev SSH bastion (for tunnel tests)

```
docker run --rm -d --name comb-sshd --network comb_default -p 127.0.0.1:2222:2222 \
  -e PUID=1000 -e PGID=1000 -e USER_NAME=tunnel -e USER_PASSWORD=tunnel-dev-only -e PASSWORD_ACCESS=true \
  -e DOCKER_MODS=linuxserver/mods:openssh-server-ssh-tunnel linuxserver/openssh-server:latest
node server/test/e2e-ssh.mjs
```
