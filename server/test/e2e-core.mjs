// End-to-end check of the core security flow against a running server.
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
let cookie = '', csrf = '';
async function api(method, path, body, extra = {}) {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-comb-csrf': csrf } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info))); if (!cond) process.exitCode = 1; };

let r = await api('POST', '/auth/setup', { email: 'owner@acme.test', name: 'Owner', password: 'short' });
check('weak password rejected', r.status === 400, r.body);
r = await api('POST', '/auth/setup', { email: 'owner@acme.test', name: 'Owner', password: 'correct horse battery staple' });
check('setup creates owner', r.status === 200 || r.status === 409, r.body);
if (r.status === 409) { r = await api('POST', '/auth/login', { email: 'owner@acme.test', password: 'correct horse battery staple' }); }
csrf = r.body.csrfToken;
r = await api('POST', '/auth/setup', { email: 'x@acme.test', name: 'X', password: 'correct horse battery staple' });
check('second setup refused', r.status === 409, r.body);
r = await api('GET', '/auth/me');
check('me', r.status === 200 && r.body.role === 'Owner', r.body);
const saved = csrf; csrf = '';
r = await api('POST', '/connections/demo', {});
check('mutation without CSRF refused', r.status === 403, r.body);
csrf = saved;
r = await api('POST', '/connections/demo', {}, { origin: 'https://evil.example' });
check('cross-origin mutation refused', r.status === 403, r.body);
r = await api('POST', '/connections/demo', {});
check('demo connection', r.status === 200 && r.body.id, r.body);
const id = r.body.id;
r = await api('GET', '/connections');
check('list has no secrets', r.status === 200 && !JSON.stringify(r.body).includes('postgres-dev-only') && r.body[0].hasPassword, r.body);
r = await api('GET', `/connections/${id}/tree`);
check('tree', r.status === 200 && r.body.schemas.some((s) => s.name === 'public' && s.tables.some((t) => t.name === 'users')), r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'select id, email from users order by id limit 3' });
check('select', r.status === 200 && r.body.rows.length === 3 && r.body.columns[0].family === 'numeric', r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'select 1;\nselect * from ordrs' });
check('error with position/line', r.status === 400 && r.body.code === '42P01' && r.body.line === 2, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'begin; delete from users; commit' });
check('transaction control blocked', r.status === 400 && r.body.code === 'COMB_BLOCKED', r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'set role postgres' });
check('set role blocked', r.status === 400, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'delete from sessions' });
check('whereless delete blocked by policy', r.status === 400 && /without WHERE/.test(r.body.error), r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'truncate sessions' });
check('truncate needs typed confirm', r.status === 409 && r.body.confirm?.word === 'sessions', r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'truncate sessions', confirm: 'sessions' });
check('confirmed truncate runs', r.status === 200, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: "select set_config('default_transaction_read_only','off',false)" });
check('set_config escape blocked', r.status === 400 && r.body.code === 'COMB_BLOCKED', r.body);
r = await api('POST', `/connections/${id}/query`, { sql: "select set_config('role','postgres',false)" });
check('set_config role escalation blocked', r.status === 400, r.body);
r = await api('PATCH', `/connections/${id}`, { readOnly: true });
check('make read-only', r.status === 200 && r.body.readOnly, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'update users set plan = plan where id = 1' });
check('write on read-only blocked', r.status === 400 && /read-only/.test(r.body.error), r.body);
r = await api('POST', `/connections/${id}/query`, { sql: "select public.bill_cycle(1)" });
check('read on read-only ok', r.status === 200, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: "with x as (select 1) select * from x; select pg_sleep(0)" });
check('multi statement read', r.status === 200 && r.body.statements.length === 2, r.body);
r = await api('PATCH', `/connections/${id}`, { host: 'attacker.example' });
check('moving host requires password', r.status === 400, r.body);
r = await api('PATCH', `/connections/${id}`, { readOnly: false, requireApproval: true });
r = await api('POST', `/connections/${id}/query`, { sql: 'update users set plan = plan where id = 1' });
check('approval-required write becomes approval', r.status === 200 && r.body.approvalId > 0, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: "select 1; update users set plan=plan where id=1" });
check('approval-gated batch with write -> approval', r.status === 200 && r.body.approvalId > 0, r.body);
await api('PATCH', `/connections/${id}`, { requireApproval: false });
r = await api('POST', '/auth/logout', {});
r = await api('GET', '/auth/me');
check('logged out', r.status === 401, r.body);
