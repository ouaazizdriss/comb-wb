// End-to-end checks of the ops module (monitoring, topology, backups) against a running server.
// Usage: BASE=http://127.0.0.1:8106 node server/test/e2e-ops.mjs
// Env: TARGET_DSN (the demo DB, superuser in dev), META_DSN (the server's metadata DB).
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8106';
const TARGET_DSN = process.env.TARGET_DSN ?? 'postgresql://postgres:postgres-dev-only@127.0.0.1:55432/shop_ops';
const META_DSN = process.env.META_DSN ?? 'postgres://comb_app:comb-app-dev-only@127.0.0.1:55432/comb_meta_ops';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

let cookie = '', csrf = '';
async function api(method, p, body) {
  if (body === undefined && method !== 'GET') body = {};
  const r = await fetch(BASE + '/api' + p, { method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-comb-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600))); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = async (app) => { const c = new pg.Client({ connectionString: TARGET_DSN, application_name: app }); c.on('error', () => {}); await c.connect(); return c; };
async function waitTask(connId, id, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await api('GET', `/backup/${connId}/tasks/${id}`);
    if (r.body?.status === 'ok' || r.body?.status === 'error' || Date.now() > until) return r.body;
    await sleep(700);
  }
}

const creds = { email: 'owner@acme.test', name: 'Owner', password: 'correct horse battery staple' };
let r = await api('POST', '/auth/setup', creds);
if (r.status !== 200) r = await api('POST', '/auth/login', creds);
csrf = r.body.csrfToken;
r = await api('POST', '/connections/demo', {});
const id = r.body.id;
const me = (await api('GET', '/auth/me')).body;
const meta = new pg.Client({ connectionString: META_DSN }); await meta.connect();
const target = await client('ops-e2e');

// ── Sampler ─────────────────────────────────────────────────────
const n0 = Number((await meta.query('select count(*) from monitor_samples where connection_id = $1 and ok', [id])).rows[0].count);
r = await api('POST', `/monitor/${id}/sample`);
check('sampler writes a row', r.status === 200 && r.body.ok, r.body);
for (let i = 0; i < 60; i++) await target.query('select count(*) from orders where id = $1', [i]);
// A busy backend reports its stats to pg_stat_database only every ~10 s; the real sampler runs every 15–60 s,
// but this test samples 1 s apart, so flush this session's counters now (PostgreSQL 15+).
await target.query('select pg_stat_force_next_flush()').catch(() => {});
await target.query('select 1');
await sleep(1100);
r = await api('POST', `/monitor/${id}/sample`);
const n1 = Number((await meta.query('select count(*) from monitor_samples where connection_id = $1 and ok', [id])).rows[0].count);
check('sample rows stored', n1 >= n0 + 2, { n0, n1 });
const last = (await meta.query('select tps, cache_hit, conn_total, max_conn from monitor_samples where connection_id = $1 and ok order by at desc limit 1', [id])).rows[0];
check('rates computed from deltas', last.tps !== null && last.tps > 0 && last.cache_hit > 0 && last.max_conn > 0, last);
r = await api('GET', `/monitor/${id}/overview?range=15m`);
check('KPIs: overview with live snapshot and buckets', r.status === 200 && r.body.live?.maxConn > 0 && r.body.live.tps !== null && r.body.buckets.length === 14 && r.body.totals.samples >= 2 && r.body.header.version, r.body?.totals);
r = await api('GET', `/monitor/${id}/overview?range=7d`);
check('bad range rejected', r.status === 400, r.body);

// ── Alerts: idle in transaction opens, acks, resolves ───────────
const saved = (await api('GET', '/monitor/rules')).body;
r = await api('PUT', '/monitor/rules', { idleTxnSeconds: 1, deadlockQuietMinutes: 0 });
check('rules updated by Admin', r.status === 200 && r.body.idleTxnSeconds === 1, r.body);
const idle = await client('ops-e2e-idle');
await idle.query('begin'); await idle.query('select 1');
await sleep(2200);
await api('POST', `/monitor/${id}/sample`);
r = await api('GET', `/monitor/${id}/alerts`);
const idleAlert = r.body.find((a) => a.rule === 'idle_in_txn');
check('alert opens (idle in transaction)', !!idleAlert && idleAlert.severity === 'warn', r.body);
const notes = (await api('GET', '/notifications')).body;
check('admins notified', notes.some((n) => /idle in transaction/.test(n.title)), notes.slice(0, 3));
r = await api('POST', `/monitor/${id}/alerts/${idleAlert.id}/ack`);
check('ack records who', r.status === 200 && r.body.ackedBy === me.email, r.body);
const ackAudit = (await meta.query(`select count(*)::int as n from audit_log where kind = 'ALERT_ACK' and actor_label = $1`, [me.email])).rows[0].n;
check('ack audited', ackAudit >= 1, ackAudit);
await idle.query('commit');
await api('POST', `/monitor/${id}/sample`);
const resolved = (await meta.query('select resolved_at from monitor_alerts where id = $1', [idleAlert.id])).rows[0];
check('alert resolves when the condition clears', !!resolved.resolved_at, resolved);
await idle.end();

// Deadlock → critical alert.
const a = await client('ops-e2e-dl-a'), b = await client('ops-e2e-dl-b');
const ids = (await target.query('select min(id) as lo, max(id) as hi from orders')).rows[0];
await a.query('begin'); await b.query('begin');
await a.query('update orders set status = status where id = $1', [ids.lo]);
await b.query('update orders set status = status where id = $1', [ids.hi]);
const pa = a.query('update orders set status = status where id = $1', [ids.hi]).catch((e) => e);
await sleep(150);
const pb = b.query('update orders set status = status where id = $1', [ids.lo]).catch((e) => e);
const outcomes = await Promise.all([pa, pb]);
await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {});
await a.end(); await b.end();
check('deadlock produced', outcomes.some((o) => o instanceof Error && /deadlock/.test(o.message)), outcomes.map(String));
await sleep(600);
await api('POST', `/monitor/${id}/sample`);
r = await api('GET', `/monitor/${id}/alerts`);
check('critical alert on deadlock', r.body.some((x) => x.rule === 'deadlocks' && x.severity === 'crit'), r.body);
await api('POST', `/monitor/${id}/sample`);
r = await api('GET', `/monitor/${id}/alerts`);
check('deadlock alert resolves after the quiet period', !r.body.some((x) => x.rule === 'deadlocks'), r.body);
await api('PUT', '/monitor/rules', saved);

// ── Slow statements ─────────────────────────────────────────────
r = await api('GET', `/monitor/${id}/statements?sort=calls`);
check('slow statements listed', r.status === 200 && r.body.available && r.body.rows.length > 0, r.body);
check('sorted by calls', r.body.rows.every((x, i, arr) => i === 0 || arr[i - 1].calls >= x.calls), r.body.rows.map((x) => x.calls));
check('comb\'s own monitoring filtered out', !r.body.rows.some((x) => x.query.startsWith('/* comb-')), r.body.rows.map((x) => x.query.slice(0, 40)));

// ── Blocking tree + terminate ───────────────────────────────────
const holder = await client('ops-e2e-holder'), waiter = await client('ops-e2e-waiter');
const holderPid = (await holder.query('select pg_backend_pid() as p')).rows[0].p;
const waiterPid = (await waiter.query('select pg_backend_pid() as p')).rows[0].p;
await holder.query('begin'); await holder.query('update orders set status = status where id = $1', [ids.lo]);
await waiter.query('begin');
const waiting = waiter.query('update orders set status = status where id = $1', [ids.lo]).catch((e) => e);
await sleep(600);
r = await api('GET', `/monitor/${id}/locks`);
const hRow = r.body.rows?.find((x) => x.pid === holderPid), wRow = r.body.rows?.find((x) => x.pid === waiterPid);
check('blocking tree: blocker with waiter indented', hRow?.blocks >= 1 && hRow.depth === 0 && wRow?.depth === 1 && wRow.blockedBy.includes(holderPid), r.body);

// Read level cannot terminate.
await meta.query(`insert into connection_access (user_id, connection_id, level) values ($1, $2, 'read') on conflict (user_id, connection_id) do update set level = 'read'`, [me.id, id]);
r = await api('POST', `/monitor/${id}/terminate`, { pid: holderPid, confirm: String(holderPid) });
check('read level cannot terminate', r.status === 403, r.body);
await meta.query('delete from connection_access where user_id = $1 and connection_id = $2', [me.id, id]);

r = await api('POST', `/monitor/${id}/terminate`, { pid: holderPid });
check('terminate needs typed confirmation', r.status === 409 && r.body.code === 'COMB_CONFIRM' && r.body.confirm.word === String(holderPid), r.body);
r = await api('POST', `/monitor/${id}/terminate`, { pid: holderPid, confirm: String(holderPid) });
check('terminate blocker releases waiter', r.status === 200 && r.body.ok && r.body.released >= 1, r.body);
const wres = await waiting;
check('waiter proceeded', !(wres instanceof Error), String(wres));
await waiter.query('rollback'); await waiter.end();
await holder.end().catch(() => {});
const termAudit = (await meta.query(`select status from audit_log where kind = 'TERMINATE' order by id desc limit 1`)).rows[0];
check('terminate audited', termAudit?.status === 'ok', termAudit);

// Comb's own sessions are never terminated. Pooled sessions churn (see the report on core pool.ts and
// sslmode=prefer), so hold sessions that carry Comb's application names for the duration of the check.
for (const appName of ['comb', 'comb:comb-monitor']) {
  const own = await client(appName);
  const ownPid = (await own.query('select pg_backend_pid() as p')).rows[0].p;
  r = await api('POST', `/monitor/${id}/terminate`, { pid: ownPid, confirm: String(ownPid) });
  check(`refuses to terminate Comb's own session (${appName})`, r.status === 400 && /Comb/.test(r.body.error), r.body);
  const still = (await target.query('select 1 from pg_stat_activity where pid = $1', [ownPid])).rows.length;
  check(`Comb session still alive (${appName})`, still === 1, still);
  await own.end();
}
r = await api('POST', `/monitor/${id}/terminate`, { pid: 2147483000, confirm: '2147483000' });
check('unknown pid 404', r.status === 404, r.body);

// ── Table health ────────────────────────────────────────────────
r = await api('GET', `/monitor/${id}/health`);
check('table health with bloat estimate', r.status === 200 && r.body.rows.length > 0 && r.body.rows.every((x) => x.bloat === null || (x.bloat >= 0 && x.bloat <= 1)), r.body);

// ── Topology + SSRF ─────────────────────────────────────────────
await target.query(`select pg_create_physical_replication_slot('ops_e2e_slot', true)`).catch(() => {});
r = await api('GET', `/topology/${id}`);
check('topology: primary, no replicas, slot listed', r.status === 200 && r.body.role === 'primary' && r.body.replicas.length === 0 && r.body.slots.some((s) => s.name === 'ops_e2e_slot' && !s.active), r.body);
check('failover history says it needs Patroni', /Patroni/.test(r.body.history.note), r.body.history);
await target.query(`select pg_drop_replication_slot('ops_e2e_slot')`).catch(() => {});
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://169.254.169.254' });
check('SSRF: metadata address refused', r.status === 400 && r.body.code === 'COMB_SSRF', r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://169.254.169.254/latest', allowHosts: ['169.254.169.254'] });
check('SSRF: metadata refused even when allowlisted', r.status === 400 && r.body.code === 'COMB_SSRF', r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://127.0.0.1:8008' });
check('SSRF: loopback refused without allowlist', r.status === 400, r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://user:pw@example.com:8008' });
check('SSRF: credentials in URL refused', r.status === 400, r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'file:///etc/passwd' });
check('SSRF: non-http scheme refused', r.status === 400, r.body);
// Embedded-IPv4 spellings: Node rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], and NAT64 can reach metadata.
for (const h of ['[::ffff:127.0.0.1]', '[::127.0.0.1]', '[2002:7f00:1::]', '[64:ff9b::a9fe:a9fe]', '[::ffff:169.254.169.254]']) {
  r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: `http://${h}:8008` });
  check(`SSRF: ${h} refused`, r.status === 400 && r.body.code === 'COMB_SSRF', r.body);
}
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://[64:ff9b::a9fe:a9fe]:8008', allowHosts: ['64:ff9b::a9fe:a9fe'] });
check('SSRF: NAT64 metadata refused even when allowlisted', r.status === 400 && r.body.code === 'COMB_SSRF', r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://127.0.0.1:8008', allowHosts: ['127.0.0.1'], patroniAuth: 'patroni:secret' });
check('allowlisted private Patroni address saved with credentials', r.status === 200, r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://127.0.0.1:8008/patroni' });
check('same origin keeps stored credentials', r.status === 200, r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: 'http://localhost:9008', allowHosts: ['127.0.0.1', 'localhost'] });
check('moving Patroni to another server needs the credentials again', r.status === 400 && r.body.code === 'COMB_REENTER_SECRET', r.body);
r = await api('PUT', `/topology/${id}/settings`, { patroniUrl: null, patroniAuth: null });
check('Patroni settings cleared', r.status === 200, r.body);
r = await api('POST', `/topology/${id}/switchover`, {});
check('switchover refused without Patroni', r.status === 400 && /Patroni/.test(r.body.error), r.body);

// ── Backups ─────────────────────────────────────────────────────
r = await api('GET', `/backup/${id}`);
const hasDump = !!r.body.capabilities.pgDump;
check('backup overview reports capabilities', r.status === 200 && r.body.backend === 'logical' && r.body.capabilities.notes.length > 0, r.body.capabilities);
if (!hasDump) {
  console.log('SKIP backup tests: pg_dump not found on the Comb server');
} else {
  r = await api('POST', `/backup/${id}/run`, {});
  check('backup queued', r.status === 200 && r.body.status === 'queued', r.body);
  const t = await waitTask(id, r.body.id);
  check('backup finished', t.status === 'ok', t);
  const bk = (await meta.query('select * from backups where id = $1', [t.backupId])).rows[0];
  const sum = crypto.createHash('sha256').update(fs.readFileSync(bk.path)).digest('hex');
  check('backup checksum recorded and matches the file', /^[0-9a-f]{64}$/.test(bk.sha256) && sum === bk.sha256 && Number(bk.size_bytes) > 0, { recorded: bk.sha256, actual: sum });
  check('backup file is 0600 in a 0700 dir', (fs.statSync(bk.path).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(bk.path)).mode & 0o777) === 0o700, fs.statSync(bk.path).mode.toString(8));
  check('backup dir under the repo default', bk.path.startsWith(path.join(ROOT, '.comb-data', 'backups')) || !!process.env.COMB_BACKUP_DIR, bk.path);

  r = await api('POST', `/backup/${id}/verify`, { backupId: t.backupId });
  const v = await waitTask(id, r.body.id);
  const vb = (await meta.query('select verified, verify_note from backups where id = $1', [t.backupId])).rows[0];
  check('verification restores and counts tables', v.status === 'ok' && vb.verified === true, { v, vb });
  const leftovers = (await target.query(`select datname from pg_database where datname like 'comb_verify_%'`)).rows;
  check('verification scratch database dropped', leftovers.length === 0, leftovers);

  // The copy holds the source's data, so it must inherit the source's masking and per-user access.
  await meta.query(`insert into catalog_columns (connection_id, schema_name, table_name, column_name, classification, masking)
    values ($1, 'public', 'users', 'email', 'PII', 'full') on conflict (connection_id, schema_name, table_name, column_name) do update set masking = 'full'`, [id]);
  const srcConn = (await api('GET', '/connections')).body.find((c) => c.id === id);
  r = await api('POST', `/backup/${id}/restore-scratch`, { backupId: t.backupId });
  const s = await waitTask(id, r.body.id);
  check('restore to scratch', s.status === 'ok' && s.result.connectionId && s.result.tables === bk.table_count, s);
  if (s.status === 'ok') {
    const list = (await api('GET', '/connections')).body;
    const nc = list.find((c) => c.id === s.result.connectionId);
    check('scratch connection registered read-only, same environment as the source', nc && nc.readOnly && nc.env === srcConn.env && nc.db === s.result.database, { nc, srcEnv: srcConn?.env });
    const masks = (await meta.query(`select masking from catalog_columns where connection_id = $1 and schema_name = 'public' and table_name = 'users' and column_name = 'email'`, [nc.id])).rows;
    const acc = (await meta.query(`select (select count(*) from connection_access where connection_id = $1)::int as src, (select count(*) from connection_access where connection_id = $2)::int as dst`, [id, nc.id])).rows[0];
    check('scratch connection inherits masking and access', masks[0]?.masking === 'full' && acc.src === acc.dst, { masks, acc });
    const q = await api('POST', `/connections/${nc.id}/query`, { sql: 'select count(*) from orders' });
    check('scratch connection works', q.status === 200 && Number(q.body.rows[0][0]) > 0, q.body);
    await api('DELETE', `/connections/${nc.id}`, { confirm: nc.name });
    await target.query(`drop database if exists ${pg.escapeIdentifier(s.result.database)} with (force)`);
  }

  // In-place: change a row, restore, the row is back.
  const before = (await target.query('select status::text from orders where id = $1', [ids.lo])).rows[0].status;
  const other = before === 'cancelled' ? 'pending' : 'cancelled';
  await target.query(`update orders set status = $2 where id = $1`, [ids.lo, other]);
  r = await api('POST', `/backup/${id}/restore-inplace`, { backupId: t.backupId });
  check('in-place restore needs the connection name typed', r.status === 409 && r.body.code === 'COMB_CONFIRM' && r.body.confirm.word === 'shop_demo' && /pg_restore --clean --if-exists/.test(r.body.confirm.sql), r.body);
  r = await api('POST', `/backup/${id}/restore-inplace`, { backupId: t.backupId, confirm: 'shop_demo' });
  const ip = await waitTask(id, r.body.id, 120_000);
  const after = (await target.query('select status::text from orders where id = $1', [ids.lo])).rows[0].status;
  check('in-place restore brings back the backed-up row', ip.status === 'ok' && after === before, { ip, before, after });
  const ra = (await meta.query(`select count(*)::int as n from audit_log where kind = 'RESTORE' and status = 'pending'`)).rows[0].n;
  check('restores audited', ra >= 2, ra);
}

await target.end();
await meta.end();
