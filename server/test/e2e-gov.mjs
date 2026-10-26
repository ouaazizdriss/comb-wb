// End-to-end checks for the gov module (audit trail, roles & privileges, approvals) against a running server.
// Usage: BASE=http://127.0.0.1:8104 META_URL=postgres://comb_app:...@127.0.0.1:55432/comb_meta_gov node server/test/e2e-gov.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8104';
const META_URL = process.env.META_URL ?? 'postgres://comb_app:comb-app-dev-only@127.0.0.1:55432/comb_meta_gov';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PASS = 'correct horse battery staple';

class Session {
  constructor(name) { this.name = name; this.cookie = ''; this.csrf = ''; }
  async api(method, p, body) {
    if (body === undefined && method !== 'GET') body = {};
    const r = await fetch(BASE + '/api' + p, {
      method, headers: { 'content-type': 'application/json', cookie: this.cookie, ...(this.csrf ? { 'x-comb-csrf': this.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { j = text; }
    return { status: r.status, body: j, text };
  }
  async login(email) {
    let r = await this.api('POST', '/auth/login', { email, password: PASS });
    if (r.status === 429) throw new Error('login rate limit hit; wait a minute and rerun');
    if (r.status !== 200 && email === 'owner@acme.test') r = await this.api('POST', '/auth/setup', { email, name: 'Owner', password: PASS });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    this.csrf = r.body.csrfToken;
    return this;
  }
}
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600))); if (!cond) process.exitCode = 1; };

// Extra users, created directly in the metadata DB with the server's own argon2 hashing.
const code = `
(async () => {
const { hashPassword } = await import('./server/src/security/auth.ts');
const { meta } = await import('./server/src/db/meta.ts');
const h = await hashPassword(${JSON.stringify(PASS)});
for (const [email, role] of [['admin2@acme.test','Admin'],['analyst@acme.test','Analyst'],['viewer@acme.test','Viewer']]) {
  await meta.query("insert into users (email, name, password_hash, role) values ($1,$2,$3,$4) on conflict (lower(email)) do update set password_hash = excluded.password_hash, role = excluded.role, status = 'active'", [email, email.split('@')[0], h, role]);
}
await meta.end();
})();`;
execFileSync('npx', ['tsx', '--env-file=.env', '-e', code], { cwd: ROOT, env: { ...process.env, COMB_DATABASE_URL: META_URL }, stdio: 'inherit' });

const owner = await new Session('owner').login('owner@acme.test');
const admin2 = await new Session('admin2').login('admin2@acme.test');
const analyst = await new Session('analyst').login('analyst@acme.test');
const viewer = await new Session('viewer').login('viewer@acme.test');

let r = await owner.api('POST', '/connections/demo', {});
const id = r.body.id;
check('demo connection', !!id, r.body);
await owner.api('PATCH', `/connections/${id}`, { requireApproval: false, readOnly: false });

// ── Audit ─────────────────────────────────────────────────────────────
r = await owner.api('GET', '/audit/verify');
check('audit verify ok', r.status === 200 && r.body.ok && /^chain verified/.test(r.body.text), r.body);
r = await viewer.api('GET', '/audit/export.csv');
check('viewer gets 403 on audit export', r.status === 403, r.body);
r = await viewer.api('GET', '/audit');
check('viewer gets 403 on audit list', r.status === 403, r.body);
r = await analyst.api('GET', '/audit?window=all');
check('analyst sees only own events', r.status === 200 && r.body.ownOnly && r.body.rows.every((e) => e.actor === 'analyst@acme.test'), r.body);
r = await analyst.api('GET', '/audit/export.csv');
check('analyst gets 403 on audit export', r.status === 403, r.body);
await owner.api('POST', `/connections/${id}/query`, { sql: 'create table if not exists "=cmd|calc" (id int primary key)' });
r = await owner.api('GET', '/audit/export.csv?window=24h');
check('owner export csv neutralises formulas', r.status === 200 && r.text.startsWith('id,at,actor') && r.text.includes(",'=cmd|calc,") && !r.text.includes(',=cmd'), r.text.slice(0, 300));
r = await owner.api('GET', '/audit?kind=Reads&q=export&window=24h');
check('export is audited (EXPORT)', r.status === 200, r.body);
r = await owner.api('GET', '/audit?window=24h&limit=2');
const page1 = r.body;
r = await owner.api('GET', `/audit?window=24h&limit=2&before=${page1.next}`);
check('keyset pagination', page1.rows.length === 2 && r.body.rows.length > 0 && r.body.rows[0].id < page1.rows[1].id + 0 + 1 && r.body.rows[0].id !== page1.rows[0].id, { page1: page1.next, r: r.body.rows?.map((x) => x.id) });
r = await owner.api('GET', `/audit/mine?connectionId=${id}&limit=5`);
check('audit/mine shape', r.status === 200 && Array.isArray(r.body) && r.body[0] && 'sql' in r.body[0] && 'ms' in r.body[0] && 'kind' in r.body[0], r.body);
const evId = r.body[0]?.id;
r = await owner.api('GET', `/audit/${evId}`);
check('audit detail', r.status === 200 && r.body.hash?.length === 64 && r.body.connection === 'shop_demo', r.body);
r = await owner.api('GET', `/audit/${evId}/compensate`);
check('compensate on a non-DML event explains', r.status === 200 && r.body.sql === null && /No compensating statement/.test(r.body.reason), r.body);

// ── Roles & privileges ───────────────────────────────────────────────
const role = 'gov_e2e_' + Math.random().toString(36).slice(2, 7);
r = await owner.api('POST', `/connections/${id}/query`, { sql: 'create table if not exists public."we""ird" (id int primary key, v text)' });
check('weird table exists', r.status === 200, r.body);
r = await owner.api('POST', `/roles/${id}/create`, { name: role, login: true, password: false });
check('create role via runSql', r.status === 200, r.body);
const changes = [{ type: 'grant', on: true, role, schema: 'public', table: 'we"ird', privilege: 'SELECT' }, { type: 'grant', on: true, role, schema: 'public', table: 'we"ird', privilege: 'UPDATE' }];
r = await owner.api('POST', `/roles/${id}/preview`, { changes });
check('grant SQL quotes weird identifiers', r.status === 200 && r.body.statements[0] === `grant select on table "public"."we""ird" to "${role}"` && r.body.sql.startsWith('begin;\n'), r.body);
r = await owner.api('POST', `/roles/${id}/preview`, { changes: [{ type: 'grant', on: true, role, schema: 'public', table: 'nope"; drop table users; --', privilege: 'SELECT' }] });
check('unknown table refused', r.status === 400, r.body);
r = await viewer.api('POST', `/roles/${id}/apply`, { changes });
check('viewer cannot apply grants', r.status === 403, r.body);
r = await owner.api('POST', `/roles/${id}/apply`, { changes });
check('grants applied through runSql', r.status === 200 && r.body.statements?.length === 2, r.body);
r = await owner.api('GET', `/roles/${id}/privileges?role=${role}&schema=public`);
const weird = r.body.tables?.find((t) => t.name === 'we"ird');
check('privilege grid shows direct grants', weird?.cells.SELECT === 'direct' && weird?.cells.UPDATE === 'direct' && weird?.cells.DELETE === 'none', weird);
r = await owner.api('GET', `/audit?q=${encodeURIComponent('we""ird')}&window=24h`);
check('grants audited with source roles', r.body.rows?.some((e) => e.kind === 'GRANT' && e.source === 'roles'), r.body.rows);

r = await owner.api('POST', `/roles/${id}/password`, { role });
const pw = r.body.password;
check('password reset returns a strong password once', r.status === 200 && typeof pw === 'string' && pw.length === 24, r.body);
r = await owner.api('GET', `/audit?q=${encodeURIComponent(pw)}&window=all`);
check('password not in audit search', r.status === 200 && r.body.matched === 0, r.body);
r = await owner.api('GET', '/audit/export.csv?window=all');
check('password and verifier not in audit export', !r.text.includes(pw) && !r.text.includes('SCRAM-SHA-256$'), 'leak');
check('password reset audited redacted', r.text.includes(`with password '***'`), r.text.slice(-500));

r = await owner.api('GET', `/roles/${id}/sessions?role=postgres`);
const combPid = r.body.find?.((s) => s.comb)?.pid;
r = await owner.api('POST', `/roles/${id}/terminate`, { pid: combPid, role: 'postgres' });
check("terminate refuses Comb's own backend", r.status === 400 && /Comb's own/.test(r.body.error), r.body);
r = await analyst.api('POST', `/roles/${id}/terminate`, { pid: combPid, role: 'postgres' });
check('terminate needs admin level', r.status === 403 || r.status === 404, r.body);

r = await owner.api('POST', `/roles/${id}/apply`, { changes: changes.map((c) => ({ ...c, on: false })) });
check('revoke applied', r.status === 200, r.body);
r = await owner.api('POST', `/roles/${id}/drop`, { role });
check('drop role asks for typed confirmation', r.status === 409 && r.body.code === 'COMB_CONFIRM' && r.body.confirm.word === role, r.body);
r = await owner.api('POST', `/roles/${id}/drop`, { role, confirm: role });
check('drop role with confirmation', r.status === 200, r.body);

// ── Approvals ────────────────────────────────────────────────────────
r = await owner.api('PATCH', `/connections/${id}`, { requireApproval: true });
check('connection requires approval', r.body.requireApproval === true, r.body);
r = await owner.api('POST', `/connections/${id}/query`, { sql: "update users set plan = plan where id = 1" });
const ap = r.body.approvalId;
check('write becomes an approval', r.status === 200 && ap, r.body);

r = await owner.api('POST', `/approvals/${ap}/approve`);
check('author cannot approve own request', r.status === 403, r.body);
r = await analyst.api('POST', `/approvals/${ap}/approve`);
check('non-admin cannot approve', r.status === 403 || r.status === 404, r.body);
r = await viewer.api('GET', `/approvals/${ap}`);
check('viewer cannot see the request', r.status === 404, r.body);

r = await admin2.api('GET', '/approvals?filter=waiting-on-me');
check('waiting on admin2', r.body.rows?.some((a) => a.id === ap), r.body);
r = await owner.api('GET', '/approvals?filter=waiting-on-me');
check('not waiting on its author', !r.body.rows?.some((a) => a.id === ap), r.body);
r = await admin2.api('GET', `/approvals/${ap}`);
check('detail with estimate', r.status === 200 && r.body.can.approve && r.body.estimates?.[0]?.rows >= 1, r.body);
r = await owner.api('POST', `/approvals/${ap}/dry-run`);
check('dry run allowed for admin approver', r.status === 200 && r.body.dryRun?.ok && r.body.dryRun.steps[0].rows === 1 && r.body.dryRun.rolledBack, r.body.dryRun ?? r.body);
r = await admin2.api('POST', `/approvals/${ap}/comments`, { body: 'Looks fine, approving.' });
check('comment', r.status === 200 && r.body.comments.length === 1, r.body);

const [a1, a2] = await Promise.all([admin2.api('POST', `/approvals/${ap}/approve`), admin2.api('POST', `/approvals/${ap}/approve`)]);
const statuses = [a1.status, a2.status].sort();
check('double approve race: exactly one wins', statuses[0] === 200 && statuses[1] === 409, [a1.body, a2.body]);
const won = a1.status === 200 ? a1.body : a2.body;
check('approve then apply', won.state === 'applied' && won.result?.ok && won.decidedBy?.email === 'admin2@acme.test', won);
r = await owner.api('GET', `/audit?window=24h&q=${encodeURIComponent('ap-' + ap)}`);
check('apply audited with author', r.body.rows?.some((e) => e.kind === 'APPROVAL'), r.body.rows);
r = await owner.api('GET', '/notifications');
check('author notified', r.body.some?.((n) => n.title.includes(`ap-${ap} applied`)), r.body);

r = await owner.api('POST', `/connections/${id}/query`, { sql: "update users set plan = plan where id = 2" });
const ap2 = r.body.approvalId;
r = await admin2.api('POST', `/approvals/${ap2}/reject`, { note: 'Not now.' });
check('reject', r.status === 200 && r.body.state === 'rejected', r.body);
r = await owner.api('POST', `/connections/${id}/query`, { sql: "update users set plan = plan where id = 3" });
const ap3 = r.body.approvalId;
r = await admin2.api('POST', `/approvals/${ap3}/withdraw`);
check('only author can withdraw', r.status === 403, r.body);
r = await owner.api('POST', `/approvals/${ap3}/withdraw`);
check('author withdraws', r.status === 200 && r.body.state === 'withdrawn', r.body);
r = await owner.api('POST', `/roles/${id}/password`, { role: 'app' });
check('password reset refused on approval-required connection', r.status === 400 && /approval/.test(r.body.error), r.body);

await owner.api('PATCH', `/connections/${id}`, { requireApproval: false });
r = await owner.api('GET', '/audit/verify');
check('chain still verified at the end', r.body.ok, r.body);
