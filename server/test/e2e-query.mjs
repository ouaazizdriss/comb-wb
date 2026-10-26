// End-to-end checks for the query + ERD modules against a running server (seeded with tools/seed.mjs).
// Usage: BASE=http://127.0.0.1:8102 DEMO_DB=shop_query node server/test/e2e-query.mjs
const BASE = process.env.BASE ?? 'http://127.0.0.1:8102';
const DEMO_DB = process.env.DEMO_DB ?? 'shop_query';
let cookie = '', csrf = '';
async function raw(method, path, body) {
  return fetch(BASE + '/api' + path, {
    method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-comb-csrf': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api(method, path, body) {
  const r = await raw(method, path, body);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600))); if (!cond) process.exitCode = 1; };

let r = await api('POST', '/auth/login', { email: 'owner@acme.test', password: 'correct horse battery staple' });
check('login', r.status === 200, r.body);
csrf = r.body.csrfToken;
r = await api('POST', '/connections/demo', {});
const id = r.body.id;
check('demo connection', !!id, r.body);

// ── completions / classify ──
r = await api('GET', `/query/${id}/completions`);
const pub = r.body?.schemas?.find((s) => s.name === 'public');
check('completions list columns', r.status === 200 && pub?.relations.some((t) => t.name === 'users' && t.columns.some(([c]) => c === 'email')), r.body);
r = await api('POST', `/query/${id}/classify`, { sql: 'select 1; delete from users where id = 0' });
check('classify kinds', r.status === 200 && r.body.statements[0].kind === 'read' && r.body.statements[1].kind === 'write', r.body);

// ── explain ──
r = await api('POST', `/connections/${id}/query`, { sql: 'explain (format json) select * from users u join orders o on o.user_id = u.id where u.id < 100' });
const plan = r.body?.rows?.[0]?.[0];
check('explain json plan', r.status === 200 && Array.isArray(plan) && typeof plan[0].Plan['Node Type'] === 'string' && plan[0].Plan['Total Cost'] > 0, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'explain (analyze, format json) select count(*) from users' });
check('explain analyze of a read runs', r.status === 200 && r.body.rows[0][0][0]['Execution Time'] >= 0, r.body);
r = await api('POST', `/query/${id}/classify`, { sql: 'explain analyze delete from users where id = -1' });
check('explain analyze of a write classified as write', r.body.statements[0].kind === 'write', r.body);

// ── search_path prefix ──
r = await api('POST', `/connections/${id}/query`, { sql: 'set search_path = analytics, public;\nselect count(*) from dim_users' });
check('search_path prefix runs', r.status === 200 && r.body.statements.length === 2, r.body);

// ── cancel ──
const slow = api('POST', `/connections/${id}/query`, { sql: 'select pg_sleep(10)' });
await new Promise((res) => setTimeout(res, 700));
const t0 = Date.now();
r = await api('POST', `/connections/${id}/cancel`, {});
check('cancel found the run', r.status === 200 && r.body.cancelled >= 1, r.body);
const s = await slow;
check('cancelled statement fails with 57014', s.status === 400 && s.body.code === '57014' && Date.now() - t0 < 5000, s.body);

// ── export ──
let res = await raw('POST', `/query/${id}/export`, { sql: "select id, email, '=HYPERLINK(\"x\")' as f, '-1+1' as g from users order by id limit 5", format: 'csv' });
let text = await res.text();
check('export csv ok', res.status === 200 && /text\/csv/.test(res.headers.get('content-type')) && text.split('\r\n').length === 6 && text.startsWith('id,email,f,g'), text.slice(0, 200));
check('export neutralises formulas', text.includes(`"'=HYPERLINK(""x"")"`) && text.includes("'-1+1"), text.slice(0, 300));
res = await raw('POST', `/query/${id}/export`, { sql: 'delete from sessions where id is null', format: 'csv' });
check('export is read-only', res.status === 400 && /read-only/.test((await res.json()).error), res.status);
res = await raw('POST', `/query/${id}/export`, { sql: 'select 1', format: 'xlsx' });
check('export validates format', res.status === 400, res.status);

// prod connection to the same DB: export blocked by policy
const name = 'shop_prod_' + Date.now().toString(36);
r = await api('POST', '/connections', { name, env: 'prod', host: '127.0.0.1', port: 55432, db: DEMO_DB, user: 'postgres', password: 'postgres-dev-only', sslmode: 'disable' });
check('create prod connection', r.status === 200 && r.body.env === 'prod', r.body);
const prodId = r.body.id;
res = await raw('POST', `/query/${prodId}/export`, { sql: 'select id from users limit 1', format: 'csv' });
const pb = await res.json().catch(() => ({}));
check('export refused on prod', res.status === 403 && pb.code === 'COMB_EXPORT_BLOCKED' && /production/.test(pb.error), pb);
r = await api('POST', `/connections/${prodId}/query`, { sql: 'select 1 as x' });
check('reads still work on prod', r.status === 200, r.body);
await api('DELETE', `/connections/${prodId}`, { confirm: name });

// ── ERD ──
r = await api('GET', `/erd/${id}?schema=public`);
const e = r.body?.edges ?? [];
check('erd tables', r.status === 200 && r.body.tables.some((t) => t.name === 'users' && t.columns.some((c) => c.name === 'id' && c.pk)), r.body);
check('erd users→orders fk', e.some((x) => x.from === 'users' && x.to === 'orders' && !x.inferred && x.cardinality === '1:n' && x.toColumns[0] === 'user_id'), e);
check('erd inferred events.user_id → users', e.some((x) => x.from === 'users' && x.to === 'events' && x.inferred && x.toColumns[0] === 'user_id'), e);
check('erd no inferred edge where an fk exists', !e.some((x) => x.inferred && x.to === 'orders' && x.toColumns[0] === 'user_id'), e);
check('erd fk marks', r.body.tables.find((t) => t.name === 'orders').columns.find((c) => c.name === 'user_id').fk === true, null);
r = await api('GET', `/erd/${id}?schema=analytics`);
check('erd other schema', r.status === 200 && r.body.tables.some((t) => t.name === 'fct_orders'), r.body);

// ── injection attempts on schema / ids ──
for (const bad of ["public' or '1'='1", 'public; drop table users', 'pg_catalog"; select 1; --', "x') union select relname from pg_class --"]) {
  r = await api('GET', `/erd/${id}?schema=${encodeURIComponent(bad)}`);
  check('erd schema injection → 404: ' + bad, r.status === 404, r.body);
}
r = await api('GET', `/erd/${id}?schema=${'a'.repeat(64)}`);
check('erd schema too long → 400', r.status === 400, r.body);
r = await api('GET', `/erd/not-a-uuid?schema=public`);
check('erd bad conn id → 400', r.status === 400, r.body);
r = await api('GET', `/erd/00000000-0000-0000-0000-000000000000?schema=public`);
check('erd unknown conn → 404', r.status === 404, r.body);
r = await api('POST', `/connections/${id}/query`, { sql: 'select count(*) from users' });
check('users table still there', r.status === 200 && Number(r.body.rows[0][0]) > 0, r.body);

// ── auth ──
const saved = cookie; cookie = '';
r = await api('GET', `/erd/${id}?schema=public`);
check('erd needs login', r.status === 401, r.body);
res = await raw('POST', `/query/${id}/export`, { sql: 'select 1' });
check('export needs login', res.status === 401 || res.status === 403, res.status);
cookie = saved;
const savedCsrf = csrf; csrf = '';
res = await raw('POST', `/query/${id}/export`, { sql: 'select 1' });
check('export needs CSRF', res.status === 403, res.status);
csrf = savedCsrf;
