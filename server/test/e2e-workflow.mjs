// End-to-end checks for the workflow modules (query library, scheduled jobs, migrations).
// Usage: BASE=http://127.0.0.1:8107 META_DB=comb_meta_workflow node server/test/e2e-workflow.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8107';
const META_DB = process.env.META_DB ?? 'comb_meta_workflow';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASS = 'correct horse battery staple';
const sfx = Date.now().toString(36);

function client() {
  let cookie = '', csrf = '';
  const api = async (method, p, body) => {
    const r = await fetch(BASE + '/api' + p, {
      method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-comb-csrf': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  api.login = async (email) => { const r = await api('POST', '/auth/login', { email, password: PASS }); csrf = r.body?.csrfToken; return r; };
  return api;
}
// Test fixtures the team/roles modules would normally manage, written straight into the meta DB.
const psql = (sql) => execFileSync('docker', ['compose', '-p', 'comb', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', META_DB, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { cwd: ROOT, encoding: 'utf8' }).trim();
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600))); if (!cond) process.exitCode = 1; };

const owner = client();
let r = await owner('POST', '/auth/setup', { email: 'owner@acme.test', name: 'Maya Owner', password: PASS });
if (r.status !== 200) r = await owner.login('owner@acme.test'); else await owner.login('owner@acme.test');
r = await owner('POST', '/connections/demo', {});
const conn = r.body.id;
check('demo connection', !!conn, r.body);
await owner('PATCH', `/connections/${conn}`, { readOnly: false, requireApproval: false });

psql(`insert into users (email, name, password_hash, role) select 'ana@acme.test', 'Ana Analyst', password_hash, 'Analyst' from users where email = 'owner@acme.test'
      on conflict (lower(email)) do update set status = 'active', role = 'Analyst'`);
const anaId = psql(`select id from users where email = 'ana@acme.test'`);
psql(`delete from connection_access where user_id = '${anaId}'`);
const ana = client();
r = await ana.login('ana@acme.test');
check('second user can sign in', r.status === 200, r.body);

// ── Query library ─────────────────────────────────────────────
console.log('\n# library');
r = await owner('POST', '/library', {
  name: 'Users on plan ' + sfx, description: 'count by plan', sql: "select count(*)::int as n from users where plan = :plan and id < :lim and ':not_a_param' <> '' -- :nope",
  params: { lim: { type: 'number', default: '1000000' } }, tags: ['test'],
});
check('create saved query', r.status === 200 && r.body.id, r.body);
const qid = r.body.id;
r = await owner('GET', `/library/${qid}`);
check('placeholders found outside strings and comments', JSON.stringify(r.body.params) === JSON.stringify(['plan', 'lim']), r.body.params);
r = await owner('GET', '/library?limit=20');
check('list contract [{id,name}]', Array.isArray(r.body) && r.body.some((x) => x.id === qid && x.name), r.body);

r = await owner('POST', `/library/${qid}/run`, { connId: conn, params: { plan: 'pro' } });
check('run with params', r.status === 200 && typeof r.body.rows?.[0]?.[0] === 'number', r.body);
r = await owner('POST', `/connections/${conn}/query`, { sql: 'select count(*)::int from users' });
const totalUsers = r.body.rows[0][0];
for (const evil of ["') or 1=1 --", "' or '1'='1", "pro'; drop table users; --", '1; drop table users', "x\\'; select 1; --"]) {
  r = await owner('POST', `/library/${qid}/run`, { connId: conn, params: { plan: evil } });
  check(`text injection stays a literal: ${evil}`, r.status === 200 && r.body.statements.length === 1 && r.body.rows[0][0] === 0, r.body);
}
for (const evil of ['1; drop table users', '1) or (1=1', '1 or 1=1', '-1--', '1e5 union select 1']) {
  r = await owner('POST', `/library/${qid}/run`, { connId: conn, params: { plan: 'pro', lim: evil } });
  check(`number param rejects ${evil}`, r.status === 400, r.body);
}
r = await owner('POST', `/library/${qid}/run`, { connId: conn, params: { plan: 'pro', lim: '-5' } });
check('negative number is bound safely', r.status === 200 && r.body.rows[0][0] === 0, r.body);
r = await owner('POST', `/connections/${conn}/query`, { sql: 'select count(*)::int from users' });
check('users table intact after injection attempts', r.status === 200 && r.body.rows[0][0] === totalUsers, r.body);
r = await owner('POST', `/library/${qid}/bind`, { params: { plan: "o'brien" } });
check('bind escapes quotes', r.status === 200 && r.body.sql.includes("'o''brien'") && r.body.sql.includes('(1000000)'), r.body);

// visibility
r = await ana('GET', `/library/${qid}`);
check('private query is 404 for another user', r.status === 404, r.body);
r = await ana('GET', '/library?limit=200');
check('private query absent from their list', r.status === 200 && !r.body.some((x) => x.id === qid), r.body);
r = await ana('POST', `/library/${qid}/run`, { connId: conn, params: { plan: 'pro' } });
check('private query cannot be run by another user', r.status === 404, r.body);
r = await owner('PATCH', `/library/${qid}/sharing`, { visibility: 'readonly' });
check('share read-only', r.status === 200 && r.body.visibility === 'readonly', r.body);
r = await ana('GET', `/library/${qid}`);
check('shared query visible', r.status === 200 && r.body.canEdit === false, r.body);
r = await ana('PUT', `/library/${qid}`, { sql: 'select 1', note: 'hijack' });
check('locked SQL: others cannot edit', r.status === 403, r.body);
r = await ana('DELETE', `/library/${qid}`, {});
check('others cannot delete', r.status === 403, r.body);
r = await ana('PATCH', `/library/${qid}/sharing`, { visibility: 'shared' });
check('others cannot change sharing', r.status === 403, r.body);
r = await ana('POST', `/library/${qid}/fork`, {});
check('fork to a private copy', r.status === 200 && r.body.id, r.body);
await ana('DELETE', `/library/${r.body.id}`, {});

// versions + diff
r = await owner('PUT', `/library/${qid}`, { sql: "select count(*)::int as n\nfrom users\nwhere plan = :plan and id < :lim", note: 'reformatted' });
check('save creates version 2 and keeps tags', r.status === 200 && r.body.version === 2 && r.body.tags.includes('test'), r.body);
r = await owner('GET', `/library/${qid}/versions/1`);
check('version 1 kept', r.status === 200 && r.body.sql.includes(':not_a_param'), r.body);
r = await owner('GET', `/library/${qid}/diff?from=1&to=2`);
check('line diff', r.status === 200 && r.body.added >= 1 && r.body.removed >= 1, r.body);

// ── Scheduled jobs ────────────────────────────────────────────
console.log('\n# jobs');
r = await ana('POST', '/jobs', { name: 'bad cron', cron: '* * * * * *', connectionId: conn, sql: 'select 1' });
check('six-field cron refused (max once a minute)', r.status === 400, r.body);
r = await ana('POST', '/jobs', { name: 'bad cron', cron: '61 * * * *', connectionId: conn, sql: 'select 1' });
check('out-of-range cron refused', r.status === 400, r.body);
r = await ana('GET', '/jobs/cron/preview?cron=' + encodeURIComponent('0 7 * * MON') + '&tz=Europe/Paris');
check('cron preview next five', r.body.ok && r.body.next.length === 5 && r.body.next.every((d) => new Date(d).getUTCDay() === 1), r.body);

// With the integrations module loaded a sender is registered, so an unknown integration id fails delivery
// instead of being skipped; the ok job then runs without one (integration test of all modules together).
const integrationsLoaded = (await owner('GET', '/integrations')).status === 200;
if (integrationsLoaded) {
  r = await ana('POST', '/jobs', { name: 'unknown integ ' + sfx, kind: 'query', cron: '0 7 * * MON', connectionId: conn, sql: 'select 1', integrationId: 'slack-ops' });
  const uj = r.body.id;
  r = await ana('POST', `/jobs/${uj}/run`, {});
  check('unknown integration (integrations loaded) fails delivery', r.status === 200 && r.body.status === 'failed' && /Unknown integration/.test(r.body.error), r.body);
  await ana('DELETE', `/jobs/${uj}`, {});
}
r = await ana('POST', '/jobs', { name: 'ok job ' + sfx, kind: 'query', cron: '0 7 * * MON', timezone: 'Europe/Paris', connectionId: conn, sql: 'select id from users order by id limit 3', integrationId: integrationsLoaded ? null : 'slack-ops' });
check('create job', r.status === 200 && r.body.id, r.body);
const okJob = r.body.id;
r = await ana('POST', `/jobs/${okJob}/run`, {});
check('job run succeeds', r.status === 200 && r.body.status === 'ok' && r.body.rows === 3, r.body);
if (integrationsLoaded) check('no integration recorded as stored result only', r.body.delivery === 'stored result only', r.body);
else check('missing integration recorded as delivery skipped', r.body.delivery === 'delivery skipped: no integration', r.body);
r = await ana('POST', '/jobs', { name: 'failing job ' + sfx, cron: '*/5 * * * *', connectionId: conn, sql: 'select * from users where id = 1 / 0' });
const badJob = r.body.id;
r = await ana('POST', `/jobs/${badJob}/run`, {});
check('job run failure recorded', r.status === 200 && r.body.status === 'failed' && /division by zero/.test(r.body.error), r.body);
const failedRun = r.body.id;
r = await ana('POST', `/jobs/runs/${failedRun}/retry`, {});
check('retry creates a new run', r.status === 200 && r.body.id !== failedRun && r.body.status === 'failed', r.body);
r = await ana('GET', `/jobs/${badJob}`);
check('history lists runs newest first with retry link', r.status === 200 && r.body.history.length === 2 && r.body.history[0].retry_of === failedRun && r.body.history[0].trigger === 'retry', r.body.history);
r = await ana('GET', '/jobs');
const row = r.body.find((j) => j.id === okJob);
check('list has last runs and next run', row && row.runs.length === 1 && row.runs[0].status === 'ok' && row.nextRunAt, row);
r = await ana('PATCH', `/jobs/${okJob}/state`, { state: 'paused' });
check('pause', r.status === 200 && r.body.nextRunAt === null, r.body);
r = await ana('PATCH', `/jobs/${okJob}/state`, { state: 'active' });
check('resume', r.status === 200 && r.body.nextRunAt, r.body);
r = await ana('GET', '/notifications');
check('owner notified of failure', r.body.some((n) => n.title.includes('failing job ' + sfx)), r.body);

// write job created while allowed, then the owner is downgraded / connection gated
r = await ana('POST', '/jobs', { name: 'write job ' + sfx, cron: '0 3 * * *', connectionId: conn, sql: "update users set plan = plan where id = 1" });
check('write job on a normal connection', r.status === 200, r.body);
const writeJob = r.body.id;
psql(`insert into connection_access (user_id, connection_id, level) values ('${anaId}', '${conn}', 'read') on conflict (user_id, connection_id) do update set level = 'read'`);
r = await owner('POST', `/jobs/${writeJob}/run`, {});
check('downgraded owner (read): write job fails', r.body?.status === 'failed' && /read access/.test(r.body.error), r.body);
psql(`update connection_access set level = 'none' where user_id = '${anaId}'`);
r = await owner('POST', `/jobs/${okJob}/run`, {});
check('owner without access: job fails clearly', r.body?.status === 'failed' && /no longer has access/.test(r.body.error), r.body);
psql(`delete from connection_access where user_id = '${anaId}'`);
psql(`update users set status = 'disabled' where id = '${anaId}'`);
r = await owner('POST', `/jobs/${okJob}/run`, {});
check('disabled owner: job fails clearly', r.body?.status === 'failed' && /disabled/.test(r.body.error), r.body);
psql(`update users set status = 'active' where id = '${anaId}'`);

await owner('PATCH', `/connections/${conn}`, { requireApproval: true });
r = await owner('POST', '/jobs', { name: 'gated write', cron: '0 3 * * *', connectionId: conn, sql: 'delete from sessions where id = 0' });
check('write job refused on approval-required connection', r.status === 400 && /approval-required/.test(r.body.error), r.body);
r = await owner('POST', '/jobs', { name: 'gated read ' + sfx, cron: '0 3 * * *', connectionId: conn, sql: 'select 1' });
check('read job allowed on approval-required connection', r.status === 200, r.body);
const gatedRead = r.body.id;
r = await owner('POST', `/jobs/${writeJob}/run`, {});
check('existing write job refused at run time once gated', r.body?.status === 'failed' && /approval-required/.test(r.body.error), r.body);
r = await owner('POST', `/jobs/${gatedRead}/run`, {});
check('read job runs on approval-required connection', r.body?.status === 'ok', r.body);
await owner('PATCH', `/connections/${conn}`, { requireApproval: false });

r = await owner('POST', '/jobs', { name: 'lib job ' + sfx, cron: '0 * * * *', connectionId: conn, libraryId: qid, params: { plan: "') or 1=1 --" } });
check('job from a saved query', r.status === 200, r.body);
const libJob = r.body.id;
r = await owner('POST', `/jobs/${libJob}/run`, {});
check('saved-query job binds params safely', r.body?.status === 'ok' && r.body.rows === 1, r.body);
// The saved query's author cannot change what someone else's job runs with that job owner's access.
r = await ana('POST', '/jobs', { name: 'ana lib job ' + sfx, cron: '0 * * * *', connectionId: conn, libraryId: qid, params: { plan: 'pro' } });
check('another user schedules a shared saved query', r.status === 200, r.body);
const anaLibJob = r.body.id;
r = await owner('PUT', `/library/${qid}`, { sql: "select count(*)::int as n, 'v3' as tag from users where plan = :plan and id < :lim", note: 'v3' });
check('saved query edited to v3 by its owner', r.status === 200 && r.body.version === 3, r.body);
r = await ana('GET', `/jobs/${anaLibJob}`);
check('job stays pinned to v2 and shows v3 is newer', r.body.libraryVersion === 2 && r.body.libraryLatest === 3 && !r.body.sql.includes("'v3'"), r.body);
r = await ana('POST', `/jobs/${anaLibJob}/run`, {});
const pinnedRun = (await ana('GET', `/jobs/runs/${r.body.id}`)).body;
check('pinned job runs the version its owner saved', r.body.status === 'ok' && JSON.stringify(pinnedRun.result?.columns) === '["n"]', pinnedRun);
await ana('DELETE', `/jobs/${anaLibJob}`, {});
r = await owner('POST', '/library', { name: 'secret q ' + sfx, sql: 'select 7 as secret_col' });
const privQ = r.body.id;
r = await owner('POST', '/jobs', { name: 'private lib job ' + sfx, cron: '0 * * * *', connectionId: conn, libraryId: privQ });
const privJob = r.body.id;
r = await ana('GET', `/jobs/${privJob}`);
check('job detail hides a private saved query from other viewers', r.status === 200 && r.body.sql === null && !JSON.stringify(r.body).includes('secret'), r.body);
r = await ana('GET', '/jobs');
check('job list hides a private saved query name', !JSON.stringify(r.body).includes('secret q'), r.body.find((j) => j.id === privJob));
await owner('DELETE', `/jobs/${privJob}`, {});
await owner('DELETE', `/library/${privQ}`, {});
r = await owner('POST', '/jobs', { name: 'bad maint', kind: 'maintenance', cron: '0 4 * * SUN', connectionId: conn, sql: 'select 1' });
check('maintenance kind accepts maintenance statements only', r.status === 400, r.body);

// run records never keep row values
r = await owner('GET', `/jobs/${okJob}`);
const someRun = r.body.history.find((h) => h.status === 'ok');
r = await owner('GET', `/jobs/runs/${someRun.id}`);
check('run record stores counts, not row values', r.status === 200 && r.body.result?.rowCount === 3 && !('rows' in (r.body.result ?? {})), r.body);
// an Admin/Owner editing someone else's job becomes its owner (no borrowing the owner's access)
r = await owner('GET', `/jobs/${okJob}`);
const def = r.body;
r = await owner('PUT', `/jobs/${okJob}`, { name: def.name, kind: def.kind, cron: def.cron, timezone: def.timezone, connectionId: def.connectionId, sql: 'select 42', params: {}, integrationId: null, options: def.options, state: def.state });
check('editing another user\'s job reassigns ownership', r.status === 200 && r.body.ownerChanged === true, r.body);
r = await owner('GET', '/jobs');
const me = (await owner('GET', '/auth/me')).body;
check('job now owned by the editor', r.body.find((j) => j.id === okJob)?.owner.id === me.id, r.body.find((j) => j.id === okJob));
r = await ana('PUT', `/jobs/${okJob}`, { name: def.name, cron: def.cron, connectionId: def.connectionId, sql: 'select 1' });
check('former owner can no longer edit it', r.status === 403, r.body);
for (const id of [okJob, badJob, writeJob, gatedRead, libJob]) await owner('DELETE', `/jobs/${id}`, {});

// ── Migrations ────────────────────────────────────────────────
console.log('\n# migrations');
const ver = (n) => { const d = new Date(Date.now() + n * 60_000); const p = (x) => String(x).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`; };
r = await owner('POST', `/migrations/${conn}`, { version: ver(1), name: 'dry_' + sfx, up: `alter table orders add column wf_tmp_${sfx} int;\nupdate orders set status = status where id < 50;\ncreate table wf_dry_${sfx} (id int primary key);`, down: `alter table orders drop column wf_tmp_${sfx};\ndrop table wf_dry_${sfx};` });
check('create migration', r.status === 200, r.body);
const dryId = r.body.id;
r = await owner('POST', `/connections/${conn}/query`, { sql: 'select count(*)::int, max(id) from orders' });
const before = JSON.stringify(r.body.rows);
r = await owner('POST', `/migrations/${conn}/${dryId}/dry-run`, { direction: 'up' });
check('dry run reports each statement', r.status === 200 && r.body.ok && r.body.statements.length === 3 && r.body.rolledBack, r.body);
check('dry run catalog diff', r.body.diff?.some((d) => d.sign === '+' && d.text.includes(`wf_tmp_${sfx}`)) && r.body.diff.some((d) => d.text.includes(`wf_dry_${sfx}`)), r.body.diff);
r = await owner('POST', `/connections/${conn}/query`, { sql: `select count(*)::int from information_schema.columns where column_name = 'wf_tmp_${sfx}'; ` });
check('dry run left no column behind', r.body.rows[0][0] === 0, r.body);
r = await owner('POST', `/connections/${conn}/query`, { sql: `select to_regclass('public.wf_dry_${sfx}') is null` });
check('dry run left no table behind', r.body.rows[0][0] === true, r.body);
r = await owner('POST', `/connections/${conn}/query`, { sql: 'select count(*)::int, max(id) from orders' });
check('orders unchanged after dry run', JSON.stringify(r.body.rows) === before, r.body);
r = await owner('GET', `/migrations/${conn}/${dryId}`);
check('migration stays pending after dry run', r.body.state === 'pending', r.body.state);
await owner('DELETE', `/migrations/${conn}/${dryId}`, {});

r = await owner('POST', `/migrations/${conn}`, { version: ver(2), name: 'idx_' + sfx, up: `create index wf_idx_${sfx} on orders (created_at);` , down: `drop index wf_idx_${sfx};` });
const idxId = r.body.id;
r = await owner('GET', `/migrations/${conn}/${idxId}`);
check('lock warning: create index without concurrently', r.body.analysis?.warnings?.some((w) => /blocks writes on orders/.test(w.title)) && r.body.analysis.lock === 'SHARE' && r.body.analysis.reversible, r.body.analysis);
await owner('DELETE', `/migrations/${conn}/${idxId}`, {});
r = await owner('POST', `/migrations/${conn}`, { version: ver(3), name: 'cidx_' + sfx, up: `create index concurrently wf_cidx_${sfx} on orders (created_at);` });
const cId = r.body.id;
r = await owner('POST', `/migrations/${conn}/${cId}/dry-run`, {});
check('noTxn statement refused for dry run with explanation', r.status === 400 && r.body.code === 'COMB_NO_DRYRUN', r.body);
r = await owner('GET', `/migrations/${conn}/${cId}`);
check('concurrent index analysed as outside a transaction', r.body.analysis.warnings.some((w) => /outside a transaction/.test(w.title)) && r.body.analysis.risk === 'concurrent', r.body.analysis);
await owner('DELETE', `/migrations/${conn}/${cId}`, {});
r = await owner('POST', `/migrations/${conn}`, { version: ver(4), name: 'vol_' + sfx, up: `alter table orders add column wf_v_${sfx} uuid default gen_random_uuid();` });
const vId = r.body.id;
r = await owner('GET', `/migrations/${conn}/${vId}`);
check('lock warning: volatile default rewrites', r.body.analysis.warnings.some((w) => /rewrites orders/.test(w.title)) && r.body.analysis.lock === 'ACCESS EXCLUSIVE', r.body.analysis);
await owner('DELETE', `/migrations/${conn}/${vId}`, {});
r = await owner('POST', `/migrations/${conn}`, { version: ver(5), name: 'txn', up: 'begin; create table x (id int); commit;' });
check('BEGIN/COMMIT refused with an explanation', r.status === 400 && /BEGIN\/COMMIT/.test(r.body.error), r.body);

// apply + drift
const appVer = ver(6);
r = await owner('POST', `/migrations/${conn}`, { version: appVer, name: 'apply_' + sfx, up: `create table wf_app_${sfx} (id int primary key, note text);`, down: `drop table wf_app_${sfx};` });
const appId = r.body.id;
r = await owner('POST', `/migrations/${conn}/${appId}/apply`, {});
check('apply', r.status === 200 && r.body.state === 'applied', r.body);
r = await owner('POST', `/connections/${conn}/query`, { sql: `select to_regclass('public.wf_app_${sfx}') is not null` });
check('applied table exists', r.body.rows[0][0] === true, r.body);
r = await owner('POST', `/migrations/${conn}/${appId}/apply`, {});
check('applying twice refused', r.status === 400, r.body);
r = await owner('POST', `/migrations/${conn}/drift`, {});
check('no drift right after apply', r.status === 200 && r.body.clean && r.body.baseline, r.body);
r = await owner('POST', `/connections/${conn}/query`, { sql: `alter table wf_app_${sfx} add column sneaky int` });
r = await owner('POST', `/migrations/${conn}/drift`, {});
check('schema drift detected after an out-of-band change', !r.body.clean && r.body.schema.some((d) => d.text.includes('sneaky')), r.body);
r = await owner('PUT', `/migrations/${conn}/${appId}`, { name: 'apply_' + sfx, up: `create table wf_app_${sfx} (id bigint primary key, note text);`, down: `drop table wf_app_${sfx};` });
check('editing applied up SQL flags drift', r.status === 200 && r.body.drift, r.body);
r = await owner('GET', `/migrations/${conn}`);
check('list shows checksum drift', r.body.migrations.find((m) => m.id === appId)?.drift === true && r.body.summary.drift >= 1, r.body.summary);
r = await owner('POST', `/migrations/${conn}/drift`, {});
check('drift check lists the edited migration', r.body.edited.some((e) => e.version === appVer), r.body);
r = await owner('GET', `/migrations/${conn}/${appId}`);
check('promotion lists environments', Array.isArray(r.body.envs) && r.body.envs.some((e) => e.id === conn && e.state === 'applied'), r.body.envs);
r = await owner('POST', `/migrations/${conn}/${appId}/rollback`, {});
check('rollback runs the down SQL', r.status === 200 && r.body.state === 'pending', r.body);
r = await owner('POST', `/connections/${conn}/query`, { sql: `select to_regclass('public.wf_app_${sfx}') is null` });
check('table gone after rollback', r.body.rows[0][0] === true, r.body);

await owner('PATCH', `/connections/${conn}`, { requireApproval: true });
r = await owner('POST', `/migrations/${conn}/${appId}/apply`, {});
check('apply on approval-required connection becomes an approval', r.status === 200 && r.body.state === 'awaiting approval' && r.body.approvalId > 0, r.body);
r = await owner('GET', `/migrations/${conn}`);
check('state shows awaiting approval', r.body.migrations.find((m) => m.id === appId)?.state === 'awaiting approval', r.body.migrations);
await owner('PATCH', `/connections/${conn}`, { requireApproval: false });
psql(`update approvals set state = 'withdrawn' where id = ${r.body.migrations.find((m) => m.id === appId).approvalId}`);
r = await owner('GET', `/migrations/${conn}`);
check('withdrawn approval returns the migration to pending', r.body.migrations.find((m) => m.id === appId)?.state === 'pending', r.body.migrations);
await owner('DELETE', `/migrations/${conn}/${appId}`, {});

psql(`insert into connection_access (user_id, connection_id, level) values ('${anaId}', '${conn}', 'read') on conflict (user_id, connection_id) do update set level = 'read'`);
r = await ana('POST', `/migrations/${conn}`, { name: 'x', up: 'select 1' });
check('read-level user cannot author migrations', r.status === 403, r.body);
psql(`delete from connection_access where user_id = '${anaId}'`);

await owner('DELETE', `/library/${qid}`, {});
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
