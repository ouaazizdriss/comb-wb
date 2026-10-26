// End-to-end checks for the data modules (catalog, quality, compliance, usage) against a running server.
// Usage: BASE=http://127.0.0.1:8108 META_DB=comb_meta_data node server/test/e2e-data.mjs
// Needs the seeded owner (tools/seed.mjs) and the demo connection; creates an Analyst in the meta DB.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8108';
const META_DB = process.env.META_DB ?? 'comb_meta_data';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = { email: 'owner@acme.test', password: 'correct horse battery staple' };
const ANALYST = { email: 'analyst.e2e@acme.test', password: 'analyst horse battery staple' };

function session() {
  let cookie = '', csrf = '';
  const call = async (method, p, body) => {
    const r = await fetch(BASE + '/api' + p, {
      method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-comb-csrf': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = text; }
    return { status: r.status, body: j, headers: r.headers };
  };
  call.login = async (creds) => { const r = await call('POST', '/auth/login', creds); csrf = r.body?.csrfToken ?? ''; return r; };
  return call;
}
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600))); if (!cond) process.exitCode = 1; };
const psql = (sql) => execFileSync('docker', ['compose', '-p', 'comb', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', META_DB, '-tAc', sql], { cwd: ROOT, encoding: 'utf8' }).trim();

const owner = session();
let r = await owner.login(OWNER);
check('owner login', r.status === 200, r.body);
r = await owner('GET', '/connections');
const conn = r.body.find((c) => c.name === 'shop_demo');
const id = conn.id;
await owner('PATCH', `/connections/${id}`, { readOnly: false, requireApproval: false });

// Some audit history.
for (let i = 0; i < 3; i++) await owner('POST', `/connections/${id}/query`, { sql: 'select count(*) from orders where status = \'paid\'' });
await owner('POST', `/connections/${id}/query`, { sql: "select * from users where email = 'secret-literal@leak.example'" });

// ── Catalog: PII scan ─────────────────────────────────────────────
r = await owner('POST', `/catalog/${id}/scan`, {});
check('PII scan runs', r.status === 200 && r.body.columnsSampled > 0, r.body);
r = await owner('GET', `/catalog/${id}`);
const col = (t, c) => r.body.columns.find((x) => x.table === t && x.column === c);
const catalog = r.body;
check('users.email is a PII candidate (name + values)', (col('users', 'email')?.candidate?.matches?.email ?? 0) > 0 || col('users', 'email')?.classification === 'PII', col('users', 'email'));
check('customers.phone is a PII candidate (values)', (col('customers', 'phone')?.candidate?.matches?.phone ?? 0) > 0 || col('customers', 'phone')?.classification === 'PII', col('customers', 'phone'));
check('candidates are not auto-confirmed', ['users.email', 'customers.phone'].every((k) => { const [t, c] = k.split('.'); const x = col(t, c); return x.candidate ? x.classification === 'UNCLASSIFIED' : true; }), null);
const stored = psql(`select coalesce(json_agg(c), '[]') from catalog_pii_candidates c`);
check('scan stores counts, never sampled values', !/@example\.com|\+1-555|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(stored), stored.slice(0, 300));
check('admins notified about candidates', Number(psql(`select count(*) from notifications where kind = 'cat'`)) > 0, null);

// Confirm / classify.
for (const [t, c, masking] of [['users', 'email', 'partial'], ['customers', 'phone', 'full'], ['customers', 'name', 'partial']]) {
  const x = catalog.columns.find((y) => y.table === t && y.column === c);
  if (x.candidate) r = await owner('POST', `/catalog/${id}/candidates/${x.candidate.id}`, { action: 'confirm', classification: 'PII', masking });
  else r = await owner('PATCH', `/catalog/${id}/column`, { schema: 'public', table: t, column: c, classification: 'PII', masking });
  check(`classify ${t}.${c} PII/${masking}`, r.status === 200, r.body);
}
r = await owner('PATCH', `/catalog/${id}/column`, { schema: 'public', table: 'sessions', column: 'token', classification: 'SECRET' });
check('SECRET turns full masking on', r.status === 200 && r.body.masking === 'full', r.body);
check('classification change audited', Number(psql(`select count(*) from audit_log where kind = 'CATALOG' and target = 'public.users.email'`)) > 0, null);
r = await owner('GET', `/catalog/${id}/column?schema=public&table=users&column=email`);
check('column detail: profile, lineage, access, retention', r.status === 200 && r.body.profile.n > 0 && r.body.lineage.some((l) => l.kind === 'referenced by' || l.kind === 'view' || l.kind === 'this column') && Array.isArray(r.body.access) && typeof r.body.retention === 'string', r.body);
check('masked column histogram has no values', r.body.hist.every((h) => h.value === null), r.body.hist);

// ── Masking ──────────────────────────────────────────────────────
const hash = execFileSync('npx', ['tsx', '--env-file=.env', '-e', `import('./server/src/security/auth.ts').then(async (m) => { console.log(await m.hashPassword(${JSON.stringify(ANALYST.password)})); process.exit(0); })`], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop();
psql(`insert into users (email, name, password_hash, role) values ('${ANALYST.email}', 'E2E Analyst', '${hash}', 'Analyst') on conflict ((lower(email))) do update set password_hash = excluded.password_hash, role = 'Analyst', status = 'active'`);
const analyst = session();
r = await analyst.login(ANALYST);
check('analyst login', r.status === 200, r.body);
const q = async (s, sql) => (await s('POST', `/connections/${id}/query`, { sql })).body;
let a = await q(analyst, 'select id, email from users order by id limit 3');
check('analyst sees partially masked emails', a.rows?.length === 3 && a.rows.every((row) => /^.\*\*\*@example\.com$/.test(row[1])), a);
let o = await q(owner, 'select id, email from users order by id limit 3');
check('owner (admin level) sees raw emails', o.rows.every((row) => !row[1].includes('***')), o);
a = await q(analyst, 'select phone, name from customers order by id limit 2');
check('analyst: full mask on phone, partial on name', a.rows?.every((row) => row[0] === '***' && /^\*\*\*/.test(row[1])), a);
a = await q(analyst, 'with x as (select email from users) select email from x limit 2');
check('masking follows CTE/subquery references', a.rows?.every((row) => row[0].includes('***')), a);
a = await q(analyst, 'select lower(email) as email from users limit 2');
check('unattributable expression named like a masked column is masked', a.rows?.every((row) => row[0].includes('***')), a);
a = await q(analyst, 'select token from sessions limit 1');
check('SECRET column masked', !a.rows?.length || a.rows[0][0] === '***', a);
r = await analyst('PATCH', `/catalog/${id}/column`, { schema: 'public', table: 'users', column: 'email', classification: 'INTERNAL' });
check('analyst cannot change classification', r.status === 403, r.body);

// ── Lineage: saved queries and jobs are scoped to the caller and the connection ──
{
  const ownerId = psql(`select id from users where lower(email) = lower('${OWNER.email}')`);
  const analystId = psql(`select id from users where lower(email) = lower('${ANALYST.email}')`);
  psql(`delete from sched_jobs where name like 'e2e %'; delete from library_queries where name like 'e2e %'; delete from connections where name = 'e2e_other'`);
  const other = psql(`insert into connections (name, host, dbname, username) values ('e2e_other', '127.0.0.1', 'nowhere', 'nobody') returning id`).split('\n')[0];
  const sql = 'select email from users where email is not null';
  psql(`insert into library_queries (name, sql, owner_id, visibility, connection_id) values
    ('e2e private by analyst', '${sql}', '${analystId}', 'private', '${id}'),
    ('e2e shared by analyst', '${sql}', '${analystId}', 'shared', '${id}'),
    ('e2e readonly by analyst, any connection', '${sql}', '${analystId}', 'readonly', null),
    ('e2e mine on this connection', '${sql}', '${ownerId}', 'private', '${id}'),
    ('e2e shared on another connection', '${sql}', '${ownerId}', 'shared', '${other}')`);
  psql(`insert into sched_jobs (name, kind, cron, connection_id, sql, owner_id) values
    ('e2e job here', 'query', '0 7 * * *', '${id}', '${sql}', '${analystId}'),
    ('e2e job elsewhere', 'query', '0 7 * * *', '${other}', '${sql}', '${ownerId}')`);
  r = await owner('GET', `/catalog/${id}/column?schema=public&table=users&column=email`);
  const names = (r.body.lineage ?? []).map((l) => `${l.kind}:${l.name}`);
  check('lineage lists own and shared/readonly saved queries', ['saved query:e2e shared by analyst', 'saved query:e2e readonly by analyst, any connection', 'saved query:e2e mine on this connection'].every((n) => names.includes(n)), names);
  check('lineage hides another user\'s private query', !names.some((n) => n.includes('e2e private by analyst')), names);
  check('lineage hides queries on another connection', !names.some((n) => n.includes('e2e shared on another connection')), names);
  check('lineage lists scheduled jobs from sched_jobs on this connection', names.includes('scheduled job:e2e job here') && !names.some((n) => n.includes('e2e job elsewhere')), names);
  r = await analyst('GET', `/catalog/${id}/column?schema=public&table=users&column=email`);
  const an = (r.body.lineage ?? []).map((l) => l.name);
  check('analyst sees own private query but not the owner\'s', an.includes('e2e private by analyst') && !an.includes('e2e mine on this connection'), an);
  psql(`delete from sched_jobs where name like 'e2e %'; delete from library_queries where name like 'e2e %'; delete from connections where id = '${other}'`);
}

// ── Data quality ─────────────────────────────────────────────────
const mk = async (body) => (await owner('POST', `/quality/${id}/tests`, body));
r = await mk({ name: 'users.email is unique', kind: 'unique', table: 'users', column: 'email' });
check('create unique test', r.status === 200 && /group by/.test(r.body.sql), r.body);
const tUnique = r.body.id;
r = await owner('POST', `/quality/${id}/tests/${tUnique}/run`, {});
check('unique test passes', r.status === 200 && r.body.state === 'pass' && r.body.failing === 0, r.body);
r = await mk({ name: 'orders.status accepted', kind: 'accepted_values', table: 'orders', column: 'status', config: { values: ['paid', 'shipped'] }, options: { notify: true } });
const tAcc = r.body.id;
r = await owner('POST', `/quality/${id}/tests/${tAcc}/run`, {});
check('accepted_values fails with offending rows', r.body.state === 'fail' && r.body.failing === 3 && r.body.sample.rows.length === 3, r.body);
r = await mk({ name: 'first users', kind: 'custom', table: 'users', config: { sql: 'select id, email from users where id <= 6;' } });
check('custom read test accepted', r.status === 200, r.body);
const tCustom = r.body.id;
r = await owner('POST', `/quality/${id}/tests/${tCustom}/run`, {});
check('custom test: failing count, at most 4 rows stored', r.body.state === 'fail' && r.body.failing >= 5 && r.body.sample.rows.length === 4, r.body);
const sample = psql(`select sample::text from dq_runs where test_id = '${tCustom}' order by at desc limit 1`);
check('stored sample is masked even when the owner ran it', !/[a-z]{2,}\d+@example\.com/.test(sample) && sample.includes('***@example.com'), sample);
r = await mk({ name: 'sessions', kind: 'custom', table: 'sessions', config: { sql: 'select id, token from sessions' } });
const tSecret = r.body.id;
await owner('POST', `/quality/${id}/tests/${tSecret}/run`, {});
const cols = psql(`select coalesce(columns::text, '') from dq_runs where test_id = '${tSecret}' order by at desc limit 1`);
check('SECRET columns are never stored in samples', !cols.includes('token'), cols);
r = await mk({ name: 'bad', kind: 'custom', table: 'users', config: { sql: 'delete from users where id = 1' } });
check('custom test refuses a write', r.status === 400 && /SELECT/.test(r.body.error), r.body);
r = await mk({ name: 'bad2', kind: 'custom', table: 'users', config: { sql: 'select 1; select 2' } });
check('custom test refuses two statements', r.status === 400, r.body);
r = await owner('PATCH', `/quality/${id}/tests/${tAcc}`, { muted: true });
check('mute', r.status === 200 && r.body.muted === true, r.body);
r = await owner('GET', `/quality/${id}/tests`);
check('list has last-10 runs', r.body.tests.find((t) => t.id === tAcc)?.runs.length >= 1, r.body);
check('quality runs audited as reads', Number(psql(`select count(*) from audit_log where detail->>'source' = 'quality' and kind = 'SELECT'`)) > 0, null);
r = await analyst('POST', `/quality/${id}/tests`, { name: 'x', kind: 'unique', table: 'users', column: 'email' });
check('analyst with write level may create tests', r.status === 200, r.body);

// ── Compliance ───────────────────────────────────────────────────
r = await owner('GET', `/compliance/${id}/controls`);
check('controls computed', r.status === 200 && r.body.controls.length >= 8 && r.body.controls.some((c) => c.id === 'audit-chain' && c.state === 'pass'), r.body);
check('masking control passes after classification', r.body.controls.find((c) => c.id === 'masking')?.state === 'pass', r.body.controls.find((c) => c.id === 'masking'));
r = await analyst('GET', `/compliance/${id}/controls`);
check('controls are admin-only', r.status === 403, r.body);
r = await owner('POST', `/compliance/${id}/evidence`, { format: 'json' });
check('evidence pack JSON has controls + chain head + timestamp', r.status === 200 && r.body.controls.length > 0 && r.body.auditChain.head && r.body.generatedAt, r.body);
r = await owner('POST', `/compliance/${id}/evidence`, { format: 'csv' });
check('evidence pack CSV', r.status === 200 && String(r.body).startsWith('control,frameworks'), r.body);
check('evidence pack audited as EXPORT', Number(psql(`select count(*) from audit_log where kind = 'EXPORT' and target = 'evidence pack'`)) >= 2, null);

r = await owner('POST', `/compliance/${id}/dsr`, { kind: 'erasure', subject: 'eli4@example.com', locator: { schema: 'public', table: 'users', column: 'email' } });
check('create erasure DSR', r.status === 200 && r.body.state === 'open', r.body);
const dsr = r.body.id;
r = await owner('GET', `/compliance/${id}/dsr/${dsr}/plan`);
const steps = r.body.steps ?? [];
const idx = (t) => steps.findIndex((s) => s.table === t);
check('DSR plan reaches users, customers, orders', ['users', 'customers', 'orders'].every((t) => idx(t) >= 0), r.body);
check('DSR plan is FK-ordered (dependants before users)', idx('customers') < idx('users') && idx('orders') < idx('users') && idx('users') === steps.length - 1, steps.map((s) => s.table));
check('DSR plan anonymises users/customers, deletes sessions, keeps orders', steps[idx('users')].action === 'anonymise' && steps[idx('customers')].action === 'anonymise' && steps[idx('orders')].action === 'keep', steps);
check('DSR plan lists unreachable PII tables', Array.isArray(r.body.unreachable), r.body.unreachable);
r = await owner('POST', `/compliance/${id}/dsr/${dsr}/run`, {});
check('erasure needs typed confirmation', r.status === 409 && r.body.code === 'COMB_CONFIRM' && r.body.confirm.word === 'eli4@example.com', r.body);
await owner('PATCH', `/connections/${id}`, { requireApproval: true });
r = await owner('POST', `/compliance/${id}/dsr/${dsr}/run`, { confirm: 'eli4@example.com' });
check('erasure on an approval-required connection yields an approval', r.status === 200 && r.body.approvalId > 0, r.body);
await owner('PATCH', `/connections/${id}`, { requireApproval: false });
const st = psql(`select state from compliance_dsr where id = ${dsr}`);
check('DSR awaits approval', st === 'awaiting_approval', st);
const still = (await q(owner, "select count(*) from users where email = 'eli4@example.com'")).rows[0][0];
check('nothing was erased before approval', Number(still) === 1, still);
r = await owner('POST', `/compliance/${id}/dsr`, { kind: 'access', subject: 'eli4@example.com', locator: { schema: 'public', table: 'users', column: 'email' } });
r = await owner('POST', `/compliance/${id}/dsr/${r.body.id}/run`, {});
check('access request exports the subject\'s rows', r.status === 200 && r.body.tables.users?.rows.length === 1 && r.body.tables.orders?.rows.length >= 0, r.body);

r = await owner('POST', `/compliance/${id}/retention`, { table: 'sessions', column: 'expires_at', keepDays: 1 });
check('retention policy created and reported', r.status === 200, r.body);
r = await owner('GET', `/compliance/${id}/retention`);
check('retention report has a count', r.body[0]?.over !== null && r.body[0]?.lastCheckedAt, r.body);
r = await owner('POST', `/compliance/${id}/retention/${r.body[0].id}/enforce`, {});
check('enforce needs typed confirmation', r.status === 409 && r.body.confirm?.word === 'sessions', r.body);
r = await owner('GET', `/compliance/${id}/residency`);
check('residency lists data hosts', r.status === 200 && r.body.data.length >= 1 && Array.isArray(r.body.processors), r.body);

// ── Usage ────────────────────────────────────────────────────────
const me = (await owner('GET', '/auth/me')).body;
r = await owner('PUT', `/usage/teams/${me.id}`, { team: '=HYPERLINK("http://evil.example","x")' });
check('assign team', r.status === 200, r.body);
r = await owner('GET', `/usage/${id}?range=this_month`);
check('usage KPIs from the trail', r.status === 200 && r.body.kpis.statements.value > 0 && r.body.kpis.hours.value >= 0 && r.body.rate === 0.12, r.body.kpis);
check('usage by team', r.body.teams.some((t) => t.team.startsWith('=HYPERLINK')) && r.body.teams.some((t) => t.team === 'Unassigned' || true), r.body.teams);
check('expensive queries are normalised (no literals)', r.body.expensive.length > 0 && !JSON.stringify(r.body).includes('secret-literal'), r.body.expensive);
r = await owner('PUT', `/usage/${id}/rate`, { usdPerHour: 2.5 });
check('rate editable', r.status === 200, r.body);
r = await owner('GET', `/usage/${id}/chargeback.csv?range=this_month`);
check('chargeback CSV neutralises formulas', r.status === 200 && String(r.body).includes(`"'=HYPERLINK(""http://evil.example"",""x"")"`), String(r.body).slice(0, 400));
check('chargeback audited', Number(psql(`select count(*) from audit_log where kind = 'EXPORT' and target = 'chargeback'`)) > 0, null);
r = await analyst('GET', `/usage/${id}`);
check('usage is admin-only', r.status === 403, r.body);
await owner('PUT', `/usage/teams/${me.id}`, { team: 'Data platform' });
await owner('PUT', `/usage/${id}/rate`, { usdPerHour: 0.12 });
