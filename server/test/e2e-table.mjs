// End-to-end checks for the Table tab API (server/src/modules/table.ts) against a running server.
// Usage: BASE=http://127.0.0.1:8101 META_URL=postgres://comb_owner:comb-owner-dev-only@127.0.0.1:55432/comb_meta_table node server/test/e2e-table.mjs
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8101';
const META_URL = process.env.META_URL ?? 'postgres://comb_owner:comb-owner-dev-only@127.0.0.1:55432/comb_meta_table';
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
let passed = 0, failed = 0;
const check = (name, cond, info) => {
  if (cond) passed++; else failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600)));
  if (!cond) process.exitCode = 1;
};
const qs = (o) => '?' + new URLSearchParams(o).toString();

// ── login + demo connection ─────────────────────────────────────
const creds = { email: 'owner@acme.test', name: 'Maya Owner', password: 'correct horse battery staple' };
let r = await api('POST', '/auth/setup', creds);
if (r.status !== 200) r = await api('POST', '/auth/login', creds);
csrf = r.body.csrfToken;
r = await api('POST', '/connections/demo', {});
const id = r.body.id;
check('demo connection', !!id, r.body);
await api('PATCH', `/connections/${id}`, { readOnly: false, requireApproval: false, env: 'local' });
const sql = (s, confirm) => api('POST', `/connections/${id}/query`, { sql: s, confirm });

// Fixtures: an editable table with an awkward column name, cleaned first.
await sql('drop table if exists public.grid_test', 'grid_test');
r = await sql(`create table public.grid_test (id serial primary key, name text not null, note text, "Weird ""Col""" text, born date, gen int generated always as (id * 2) stored)`);
check('fixture table created', r.status === 200, r.body);
await sql(`insert into public.grid_test (name, note, born) select 'row ' || i, case when i % 2 = 0 then 'even' end, date '2024-01-01' + i from generate_series(1, 250) i`);
await sql('analyze public.grid_test');

// ── meta ────────────────────────────────────────────────────────
r = await api('GET', `/table/${id}/meta` + qs({ schema: 'public', table: 'users' }));
check('meta users', r.status === 200 && r.body.pk[0] === 'id' && r.body.columns.length === 8 && r.body.kind === 'table', r.body);
check('meta users: RLS enabled with real policy count', r.body.rls?.enabled === true && r.body.rls.policies === 2, r.body.rls);
check('meta users: editable for owner', r.body.editable === true && r.body.readOnlyReason === null, r.body);
check('meta users: estimate from reltuples', r.body.estimate > 40000, r.body.estimate);
check('meta users: comment + family', r.body.columns.find((c) => c.name === 'mrr').comment === 'monthly recurring revenue, USD' && r.body.columns.find((c) => c.name === 'created_at').family === 'temporal', r.body.columns);
r = await api('GET', `/table/${id}/meta` + qs({ schema: 'public', table: 'customers' }));
check('meta customers: fk marked', r.body.columns.find((c) => c.name === 'user_id').fk?.includes('users'), r.body.columns);
r = await api('GET', `/table/${id}/meta` + qs({ schema: 'public', table: 'nope' }));
check('meta unknown table 404', r.status === 404, r.body);
r = await api('GET', `/table/${id}/meta` + qs({ schema: 'public', table: 'users; drop table users' }));
check('meta injection in table name -> 404', r.status === 404, r.body);
r = await api('GET', `/table/${id}/meta` + qs({ schema: "public' or '1'='1", table: 'users' }));
check('meta injection in schema name -> 404', r.status === 404, r.body);
r = await api('GET', `/table/00000000-0000-0000-0000-000000000000/meta` + qs({ schema: 'public', table: 'users' }));
check('unknown connection 404', r.status === 404, r.body);
r = await api('GET', `/table/${id}/meta`);
check('meta without params 400', r.status === 400, r.body);

// ── rows: keyset paging, sort, filter ───────────────────────────
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users' });
check('rows page 1', r.status === 200 && r.body.rows.length === 100 && r.body.hasMore && r.body.paging === 'keyset', { s: r.status, n: r.body?.rows?.length, e: r.body?.error });
check('rows: keys returned', r.body.keys?.length === 100 && r.body.keys[0][0] === '1', r.body.keys?.[0]);
check('rows: timestamptz as exact text', typeof r.body.rows[0][5] === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(r.body.rows[0][5]), r.body.rows[0][5]);
check('rows: jsonb as object, null as null', r.body.rows.some((x) => x[6] && typeof x[6] === 'object') && r.body.rows.some((x) => x[6] === null), null);
const last = r.body.keys[99];
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', after: last });
check('rows page 2 via keyset', r.status === 200 && r.body.keys[0][0] === '101', r.body.keys?.[0]);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', sort: 'id', dir: 'desc' });
check('sort by pk desc (keyset)', r.status === 200 && r.body.paging === 'keyset' && Number(r.body.keys[0][0]) > Number(r.body.keys[1][0]), r.body.keys?.slice(0, 2));
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', sort: 'email', dir: 'asc' });
check('sort by other column uses offset', r.status === 200 && r.body.paging === 'offset' && r.body.rows[0][1] <= r.body.rows[1][1], r.body.rows?.slice(0, 2).map((x) => x[1]));
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', sort: 'email', dir: 'asc', offset: 100 });
check('offset page 2', r.status === 200 && r.body.rows.length === 100, r.body.error);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', filter: 'ana20@' });
check('filter server-side', r.status === 200 && r.body.rows.length >= 1 && r.body.rows.every((x) => JSON.stringify(x).toLowerCase().includes('ana20@')), r.body.rows?.length);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', filter: "x' or 1=1; drop table users; --" });
check('filter injection is a literal', r.status === 200 && r.body.rows.length === 0, r.body);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', filter: '%' });
check('filter % is literal, not a wildcard', r.status === 200 && r.body.rows.length === 0, r.body.rows?.length);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', filter: "\\' \\\\ $$ E'x" });
check('filter backslashes/quotes are safe', r.status === 200 && r.body.rows.length === 0, r.body);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', sort: 'id; drop table users' });
check('sort injection rejected', r.status === 400, r.body);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users', after: ["1) or (1=1"] });
check('cursor injection is a literal (error, not executed)', r.status === 400, r.body);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'users"; drop table users; --' });
check('rows injection in table -> 404', r.status === 404, r.body);
r = await sql('select count(*)::int as n from public.users');
check('users table intact', r.status === 200 && r.body.rows[0][0] === 48201, r.body.rows);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'grid_test' });
check('date column as exact text', r.body.rows[0][4] === '2024-01-02', r.body.rows?.[0]);

// ── catalog panels ──────────────────────────────────────────────
r = await api('GET', `/table/${id}/constraints` + qs({ schema: 'public', table: 'users' }));
check('constraints', r.status === 200 && r.body.constraints.some((c) => c.kind === 'primary key' && c.def === 'PRIMARY KEY (id)') && r.body.policies.length === 2, r.body);
r = await api('GET', `/table/${id}/indexes` + qs({ schema: 'public', table: 'users' }));
check('indexes with size', r.status === 200 && r.body.indexes.some((i) => i.name === 'users_created_at_idx' && i.size > 0 && /btree/.test(i.def)), r.body);
r = await api('GET', `/table/${id}/triggers` + qs({ schema: 'public', table: 'customers' }));
check('triggers', r.status === 200 && r.body.triggers[0]?.name === 'customers_trim' && r.body.triggers[0].timing.startsWith('before'), r.body);
r = await api('GET', `/table/${id}/ddl` + qs({ schema: 'public', table: 'users' }));
check('ddl table', r.status === 200 && r.body.ddl.startsWith('create table public.users (') && /enable row level security/.test(r.body.ddl) && /create policy users_owner_all/.test(r.body.ddl) && /comment on column public.users.mrr/.test(r.body.ddl) && /create index users_created_at_idx/.test(r.body.ddl), r.body);
r = await api('GET', `/table/${id}/ddl` + qs({ schema: 'public', table: 'grid_test' }));
check('ddl quotes odd identifiers + generated column', /"Weird ""Col"""/.test(r.body.ddl) && /generated always as \(id \* 2\) stored/.test(r.body.ddl), r.body.ddl);
r = await api('GET', `/table/${id}/ddl` + qs({ schema: 'public', table: 'active_users' }));
check('ddl view', r.status === 200 && r.body.ddl.startsWith('create or replace view public.active_users as'), r.body);

// ── views and no-PK tables are not editable ─────────────────────
r = await api('GET', `/table/${id}/meta` + qs({ schema: 'public', table: 'active_users' }));
check('view not editable', r.body.kind === 'view' && r.body.editable === false && /view/.test(r.body.readOnlyReason), r.body);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'active_users' });
check('view browsable', r.status === 200 && r.body.rows.length === 100 && r.body.paging === 'offset', r.body.error);
r = await api('GET', `/table/${id}/meta` + qs({ schema: 'analytics', table: 'fct_orders' }));
check('no-PK table not editable', r.body.editable === false && /no primary key/.test(r.body.readOnlyReason), r.body);
r = await api('POST', `/table/${id}/rows`, { schema: 'analytics', table: 'fct_orders' });
check('no-PK table browsable with offset paging', r.status === 200 && r.body.keys === null && r.body.paging === 'offset', r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'analytics', table: 'fct_orders', deletes: [{ pk: { id: 1 } }] });
check('no-PK apply refused', r.status === 403 && r.body.code === 'COMB_READONLY', r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'active_users', updates: [{ pk: { id: 1 }, set: { plan: 'x' } }] });
check('view apply refused', r.status === 403, r.body);

// ── staged edits: preview + apply ───────────────────────────────
const edits = {
  schema: 'public', table: 'grid_test',
  updates: [{ pk: { id: 1 }, set: { name: 'renamed', note: null, 'Weird "Col"': 'w' } }],
  deletes: [{ pk: { id: 2 } }, { pk: { id: 3 } }],
  inserts: [{ values: { name: 'fresh', note: 'n' } }],
};
r = await api('POST', `/table/${id}/preview`, edits);
check('preview statements', r.status === 200 && r.body.statements.length === 3 && r.body.statements[0].sql === `update public.grid_test set name = 'renamed', note = NULL, "Weird ""Col""" = 'w'\nwhere id = 1;` && /where id in \(2, 3\)/.test(r.body.statements[1].sql), r.body);
r = await api('POST', `/table/${id}/apply`, edits);
check('apply in one call', r.status === 200 && r.body.statements.length === 3 && r.body.statements.map((s) => s.rowCount).join() === '1,2,1', r.body);
r = await sql(`select (select name from grid_test where id = 1), (select count(*)::int from grid_test where id in (2,3)), (select count(*)::int from grid_test where name = 'fresh')`);
check('apply took effect', r.body.rows[0].join() === 'renamed,0,1', r.body.rows);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 4 }, set: { name: "x'); drop table public.users; --" } }] });
check('value injection stored literally', r.status === 200, r.body);
r = await sql(`select name from grid_test where id = 4`);
check('value injection round-trips', r.body.rows[0][0] === "x'); drop table public.users; --", r.body.rows);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 4 }, set: { 'name = 1; drop table users; --': 'x' } }] });
check('column injection rejected', r.status === 400 && /does not exist/.test(r.body.error), r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { 'id = id or true; --': 1 }, set: { name: 'x' } }] });
check('pk injection rejected', r.status === 400, r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: '1 or true' }, set: { name: 'everyone' } }] });
check('pk value is a literal (type error, no mass update)', r.status === 400, r.body);
r = await sql(`select count(*)::int from grid_test where name = 'everyone'`);
check('no rows mass-updated', r.body.rows[0][0] === 0, r.body.rows);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: {}, set: { name: 'x' } }] });
check('missing pk rejected', r.status === 400, r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 5 }, set: { gen: '1' } }] });
check('generated column write rejected', r.status === 400 && /generated/.test(r.body.error), r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', sql: 'drop table users', updates: [] });
check('nothing to apply / SQL text ignored', r.status === 400, r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 6 }, set: { name: null } }] });
check('constraint error surfaces, transaction rolled back', r.status === 400 && r.body.code === '23502', r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 7 }, set: { name: 'ok' } }, { pk: { id: 8 }, set: { name: null } }] });
r = await sql(`select name from grid_test where id = 7`);
check('multi-statement apply is atomic', r.body.rows[0][0] === 'row 7', r.body.rows);
const saved = csrf; csrf = '';
r = await api('POST', `/table/${id}/apply`, edits);
check('apply without CSRF refused', r.status === 403, r.body);
csrf = saved;
r = await api('GET', `/audit/mine?connectionId=${id}&limit=50`);
if (r.status === 200 && Array.isArray(r.body)) check('grid writes audited', r.body.some((a) => /update public.grid_test/.test(a.sql)), r.body.slice(0, 3));

// ── read-only connection ────────────────────────────────────────
await api('PATCH', `/connections/${id}`, { readOnly: true });
r = await api('GET', `/table/${id}/meta` + qs({ schema: 'public', table: 'grid_test' }));
check('read-only conn: not editable, says why', r.body.editable === false && /read-only/.test(r.body.readOnlyReason), r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 9 }, set: { name: 'ro' } }] });
check('read-only conn: apply refused', r.status === 403 && /read-only/.test(r.body.error), r.body);
r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'grid_test' });
check('read-only conn: rows still readable', r.status === 200, r.body);
await api('PATCH', `/connections/${id}`, { readOnly: false });

// ── approvals + prod typed confirmation ─────────────────────────
await api('PATCH', `/connections/${id}`, { requireApproval: true });
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 9 }, set: { name: 'approved?' } }] });
check('approval-required: apply becomes approval', r.status === 200 && r.body.approvalId > 0, r.body);
r = await sql(`select name from grid_test where id = 9`);
check('approval-required: nothing ran', r.body.rows[0][0] === 'row 9', r.body.rows);
await api('PATCH', `/connections/${id}`, { requireApproval: false, env: 'prod' });
await api('PATCH', `/connections/${id}`, { readOnly: false, requireApproval: false });
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 10 }, set: { name: 'prod' } }] });
check('prod: typed confirmation required', r.status === 409 && r.body.code === 'COMB_CONFIRM' && r.body.confirm.word === 'shop_demo', r.body);
r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', confirm: 'shop_demo', updates: [{ pk: { id: 10 }, set: { name: 'prod' } }] });
check('prod: confirmed apply runs', r.status === 200 && r.body.statements[0].rowCount === 1, r.body);
await api('PATCH', `/connections/${id}`, { env: 'local' });

// ── read level ──────────────────────────────────────────────────
const meta = new pg.Client({ connectionString: META_URL });
await meta.connect();
const me = await api('GET', '/auth/me');
await meta.query(`insert into connection_access (user_id, connection_id, level) values ($1, $2, 'read') on conflict (user_id, connection_id) do update set level = 'read'`, [me.body.id, id]);
try {
  r = await api('GET', `/table/${id}/meta` + qs({ schema: 'public', table: 'grid_test' }));
  check('read level: not editable, says why', r.body.editable === false && /read access/.test(r.body.readOnlyReason) && r.body.level === 'read', r.body);
  r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'grid_test' });
  check('read level: rows readable', r.status === 200, r.body);
  r = await api('POST', `/table/${id}/apply`, { schema: 'public', table: 'grid_test', updates: [{ pk: { id: 11 }, set: { name: 'nope' } }] });
  check('read level: apply refused (403)', r.status === 403, r.body);
  await meta.query(`update connection_access set level = 'none' where user_id = $1 and connection_id = $2`, [me.body.id, id]);
  r = await api('POST', `/table/${id}/rows`, { schema: 'public', table: 'grid_test' });
  check('no access: 404', r.status === 404, r.body);
} finally {
  await meta.query(`delete from connection_access where user_id = $1 and connection_id = $2`, [me.body.id, id]);
  await meta.end();
}
r = await sql(`select name from grid_test where id = 11`);
check('read level: nothing written', r.body.rows[0][0] === 'row 11', r.body.rows);

await sql('drop table if exists public.grid_test', 'grid_test');
console.log(`\n${passed} passed, ${failed} failed`);
