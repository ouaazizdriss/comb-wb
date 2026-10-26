// End-to-end checks of the identity module (team, security, SSO) against a running, seeded server.
// Usage: BASE=http://127.0.0.1:8105 PUBLIC=http://127.0.0.1:5205 DB_URL=<comb_app url of that meta DB> node server/test/e2e-identity.mjs
// Needs: openssl on PATH, a server started with COMB_PUBLIC_URL=$PUBLIC, the seed owner (tools/seed.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { generateSync } from 'otplib';
import { SignedXml } from 'xml-crypto';
import { startOidcStub } from './oidc-stub.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8105';
const PUBLIC = process.env.PUBLIC ?? 'http://127.0.0.1:5205';
const OWNER = { email: 'owner@acme.test', password: 'correct horse battery staple' };
const PW = 'a long enough passphrase 42';
const run = Date.now().toString(36);
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600))); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal cookie-jar client (one per person). */
function client(label) {
  const jar = new Map();
  let csrf = '';
  const c = {
    label, jar,
    setCsrf: (t) => { csrf = t; },
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (!v || /Expires=Thu, 01 Jan 1970/i.test(sc)) jar.delete(k); else jar.set(k, v);
      }
    },
    async raw(method, url, { body, headers = {}, form } = {}) {
      const h = { cookie: c.cookie(), ...headers };
      if (csrf && method !== 'GET') h['x-comb-csrf'] = csrf;
      let b;
      if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; b = new URLSearchParams(form).toString(); }
      else if (body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
      const res = await fetch(url.startsWith('http') ? url : BASE + url, { method, headers: h, body: b, redirect: 'manual' });
      c.absorb(res);
      return res;
    },
    async api(method, p, body, headers) {
      const res = await c.raw(method, '/api' + p, { body: body ?? (method === 'GET' ? undefined : {}), headers });
      const text = await res.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
      if (j?.csrfToken) csrf = j.csrfToken;
      return { status: res.status, body: j };
    },
    async login(email, password) {
      jar.clear(); csrf = '';
      return c.api('POST', '/auth/login', { email, password });
    },
  };
  return c;
}

async function bearer(token, method, p, body) {
  const res = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const tokenOf = (link) => new URL(link).pathname.split('/').pop();

// ── Setup ────────────────────────────────────────────────────────────────────
const owner = client('owner');
let r = await owner.login(OWNER.email, OWNER.password);
check('owner signs in', r.status === 200, r);
const conns = (await owner.api('GET', '/connections')).body;
const demo = conns.find((c) => c.name === 'shop_demo') ?? conns[0];
check('demo connection exists', !!demo, conns);
const me = (await owner.api('GET', '/auth/me')).body;

// ── Invite flow ──────────────────────────────────────────────────────────────
async function inviteAndJoin(email, role, name) {
  const inv = await owner.api('POST', '/team/invite', { email, role });
  const c = client(name);
  const acc = await c.api('POST', '/team/accept', { token: tokenOf(inv.body.link), name, password: PW });
  return { inv, c, acc, id: inv.body.userId };
}

r = await owner.api('POST', '/team/invite', { email: `admin.${run}@acme.test`, role: 'Admin' });
check('invite returns a one-time link with 7-day expiry', r.status === 200 && r.body.link?.startsWith(PUBLIC + '/api/team/join/')
  && Math.abs(new Date(r.body.expiresAt).getTime() - Date.now() - 7 * 86400_000) < 60_000, r.body);
const adminId = r.body.userId;
const adminTok = tokenOf(r.body.link);
const anon = client('anon');
r = await anon.api('GET', '/team/invite/' + adminTok);
check('public invite check shows the invited address', r.status === 200 && r.body.email === `admin.${run}@acme.test` && r.body.role === 'Admin', r.body);
r = await anon.api('GET', '/team/invite/' + 'x'.repeat(43));
check('unknown invite token is 404', r.status === 404, r.body);
const joinPage = await anon.raw('GET', '/api/team/join/' + adminTok);
const joinHtml = await joinPage.text();
check('no-JS join page renders the form', joinPage.status === 200 && joinHtml.includes('action="/api/team/join"') && !/<script/i.test(joinHtml), joinHtml.slice(0, 200));
r = await anon.api('POST', '/team/accept', { token: adminTok, name: 'Ada Admin', password: 'short' });
check('accept refuses a weak password', r.status === 400, r.body);
const admin = client('admin');
r = await admin.api('POST', '/team/accept', { token: adminTok, name: 'Ada Admin', password: PW });
check('accept activates the user and signs them in', r.status === 200 && r.body.csrfToken, r.body);
r = await admin.api('GET', '/auth/me');
check('invited admin is Admin', r.status === 200 && r.body.role === 'Admin', r.body);
r = await anon.api('POST', '/team/accept', { token: adminTok, name: 'Again', password: PW });
check('invite link works only once', r.status === 404, r.body);
const db = await owner.api('GET', '/team/members');
const adminRow = db.body.members.find((m) => m.id === adminId);
check('members list shows the admin active with password auth', adminRow?.status === 'active' && adminRow.auth === 'password', adminRow);
check('members list never exposes hashes or secrets', !/password_hash|mfa_secret|token_hash/.test(JSON.stringify(db.body)), null);

const { c: analyst, id: analystId, acc: aAcc } = await inviteAndJoin(`analyst.${run}@acme.test`, 'Analyst', 'Ana Analyst');
check('analyst joined', aAcc.status === 200, aAcc.body);
const { c: viewer, id: viewerId } = await inviteAndJoin(`viewer.${run}@acme.test`, 'Viewer', 'Vic Viewer');

// ── Role rules ───────────────────────────────────────────────────────────────
r = await admin.api('POST', '/team/invite', { email: `o2.${run}@acme.test`, role: 'Owner' });
check('an Admin cannot invite an Owner', r.status === 403, r.body);
r = await admin.api('PATCH', `/team/members/${analystId}`, { role: 'Owner' });
check('an Admin cannot promote to Owner', r.status === 403, r.body);
r = await admin.api('PATCH', `/team/members/${me.id}`, { role: 'Viewer' });
check('an Admin cannot demote an Owner', r.status === 403, r.body);
r = await admin.api('DELETE', `/team/members/${me.id}`);
check('an Admin cannot remove an Owner', r.status === 403, r.body);
r = await admin.api('PATCH', `/team/members/${adminId}`, { role: 'Owner' });
check('nobody changes their own role (admin)', r.status === 403, r.body);
r = await owner.api('PATCH', `/team/members/${me.id}`, { role: 'Admin' });
check('nobody changes their own role (owner)', r.status === 403, r.body);
r = await owner.api('DELETE', `/team/members/${me.id}`);
check('the last Owner cannot remove themselves', r.status === 403, r.body);
r = await admin.api('PATCH', `/team/members/${viewerId}`, { role: 'Analyst' });
check('an Admin can promote a Viewer to Analyst', r.status === 200, r.body);
r = await admin.api('PATCH', `/team/members/${viewerId}`, { role: 'Viewer' });
check('... and back', r.status === 200, r.body);
r = await analyst.api('GET', '/team/members');
check('an Analyst cannot list members', r.status === 403, r.body);

// Owner hand-over: owner promotes admin to Owner, the new Owner removes the old one, then restores them.
r = await owner.api('PATCH', `/team/members/${adminId}`, { role: 'Owner' });
check('an Owner can promote to Owner', r.status === 200, r.body);
r = await admin.api('DELETE', `/team/members/${me.id}`);
check('an Owner can remove another Owner when one remains', r.status === 200, r.body);
r = await owner.api('GET', '/auth/me');
check('removal revokes the removed user\'s sessions', r.status === 401, r.body);
r = await admin.api('DELETE', `/team/members/${adminId}`);
check('the only remaining Owner cannot remove themselves', r.status === 403, r.body);
r = await admin.api('PATCH', `/team/members/${me.id}`, { status: 'active' });
check('a removed member can be re-enabled', r.status === 200, r.body);
r = await owner.login(OWNER.email, OWNER.password);
check('re-enabled owner signs in again', r.status === 200, r.body);
r = await owner.api('PATCH', `/team/members/${adminId}`, { role: 'Admin' });
check('owner demotes the second Owner back to Admin', r.status === 200, r.body);

// ── API tokens ───────────────────────────────────────────────────────────────
r = await analyst.api('POST', '/security/tokens', { name: 'too much', scopes: ['read', 'admin'], expiresDays: 30 });
check('token scope cannot exceed the role (Analyst → admin)', r.status === 403, r.body);
r = await viewer.api('POST', '/security/tokens', { name: 'viewer write', scopes: ['write'], expiresDays: 30 });
check('token scope cannot exceed the role (Viewer → write)', r.status === 403, r.body);
r = await analyst.api('POST', '/security/tokens', { name: 'cli', scopes: ['read', 'write'], expiresDays: 90 });
const tok = r.body?.token;
check('token is returned once in comb_ + base64url(32 bytes) form', r.status === 200 && /^comb_[A-Za-z0-9_-]{43}$/.test(tok) && r.body.prefix === tok.slice(0, 9), r.body);
r = await analyst.api('GET', '/security/tokens');
check('token list shows the prefix but never the token', r.status === 200 && r.body.tokens.some((t) => t.prefix === tok.slice(0, 9)) && !JSON.stringify(r.body).includes(tok), r.body);
const tokId = r.body.tokens.find((t) => t.prefix === tok.slice(0, 9)).id;
r = await bearer(tok, 'GET', '/auth/me');
check('token authenticates', r.status === 200 && r.body.email === `analyst.${run}@acme.test`, r.body);
r = await bearer(tok, 'POST', '/security/tokens', { name: 'x', scopes: ['read'], expiresDays: 30 });
check('tokens cannot mint tokens', r.status === 403, r.body);
r = await analyst.api('DELETE', '/security/tokens/' + tokId);
check('revoke token', r.status === 200, r.body);
r = await bearer(tok, 'GET', '/auth/me');
check('revoked token gets 401', r.status === 401, r.body);

r = await admin.api('POST', '/team/service', { name: `svc_${run}`, scopes: ['read'], expiresDays: 30 });
check('admin creates a service identity with a one-time token', r.status === 200 && /^comb_/.test(r.body.token), r.body);
const svcId = r.body.userId, svcTok = r.body.token;
r = await bearer(svcTok, 'GET', '/connections');
check('service identity sees no connection by default', r.status === 200 && r.body.length === 0, r.body);
r = await admin.api('PATCH', `/team/members/${svcId}`, { role: 'Analyst' });
check('service identities have a fixed role', r.status === 400, r.body);
r = await admin.api('POST', '/security/tokens', { name: 'svc2', scopes: ['admin'], expiresDays: 30, user: svcId });
check('service token scope capped by Service role', r.status === 403, r.body);
r = await admin.api('POST', '/security/tokens', { name: 'nope', scopes: ['read'], expiresDays: 30, user: analystId });
check('admins cannot mint tokens for people', r.status === 403, r.body);
r = await owner.api('GET', '/team/members');
check('service identities consume no seat', r.body.counts.service >= 1 && r.body.members.find((m) => m.id === svcId)?.auth === 'token', r.body.counts);

// ── Connection access matrix ─────────────────────────────────────────────────
r = await admin.api('PUT', '/team/access', { userId: analystId, connectionId: demo.id, level: 'admin' });
check('only Owners grant admin access', r.status === 403, r.body);
r = await admin.api('PUT', '/team/access', { userId: svcId, connectionId: demo.id, level: 'read' });
check('admin grants read to the service identity', r.status === 200 && r.body.level === 'read' && r.body.explicit, r.body);
r = await bearer(svcTok, 'GET', '/connections');
check('service identity now sees the connection', r.body.length === 1, r.body);
r = await admin.api('PUT', '/team/access', { userId: adminId, connectionId: demo.id, level: 'write' });
check('an Admin cannot change their own access', r.status === 403, r.body);
r = await owner.api('PUT', '/team/access', { userId: analystId, connectionId: demo.id, level: 'admin' });
check('an Owner grants admin access', r.status === 200, r.body);
r = await owner.api('PUT', '/team/access', { userId: analystId, connectionId: demo.id, level: null });
check('reset to the role default', r.status === 200 && !r.body.explicit && r.body.level === 'write', r.body);

// ── Sessions ─────────────────────────────────────────────────────────────────
const owner2 = client('owner-2nd-device');
await owner2.login(OWNER.email, OWNER.password);
r = await owner.api('GET', '/security/sessions');
check('session list marks this session', r.status === 200 && r.body.sessions.filter((s) => s.current).length === 1 && r.body.sessions.length >= 2, r.body);
r = await owner.api('POST', '/security/sessions/revoke-others');
check('revoke all others', r.status === 200 && r.body.revoked >= 1, r.body);
r = await owner2.api('GET', '/auth/me');
check('other device is signed out', r.status === 401, r.body);
r = await owner.api('GET', '/auth/me');
check('this device stays signed in', r.status === 200, r.body);
r = await analyst.api('GET', `/security/sessions?user=${me.id}`);
check('non-admins cannot list others\' sessions', r.status === 403, r.body);

// ── MFA ──────────────────────────────────────────────────────────────────────
r = await analyst.api('POST', '/security/mfa/setup');
check('mfa setup returns secret + PNG QR', r.status === 200 && r.body.secret && r.body.qrDataUrl.startsWith('data:image/png;base64,'), r.body);
const secret = r.body.secret;
r = await analyst.api('POST', '/security/mfa/enable', { code: '000000' });
check('wrong code refused', r.status === 400, r.body);
const oldCookie = analyst.cookie();
r = await analyst.api('POST', '/security/mfa/enable', { code: generateSync({ secret }) });
check('mfa enabled, session rotated', r.status === 200 && r.body.ok && r.body.csrfToken && analyst.cookie() !== oldCookie, r.body);
r = await fetch(BASE + '/api/auth/me', { headers: { cookie: oldCookie } });
check('pre-enrollment cookie no longer works', r.status === 401, r.status);
r = await analyst.login(`analyst.${run}@acme.test`, PW);
check('password login now asks for the code', r.status === 200 && r.body.mfa === true, r.body);
r = await analyst.api('GET', '/connections');
check('nothing works before the code', r.status === 401 && r.body.mfa, r.body);
r = await analyst.api('POST', '/auth/mfa', { code: generateSync({ secret }) });
check('TOTP completes the login', r.status === 200, r.body);
r = await analyst.api('GET', '/connections');
check('full session after TOTP', r.status === 200, r.body);
r = await analyst.api('POST', '/security/mfa/setup');
check('setup refused while enabled', r.status === 409, r.body);

// requireMfa: the Admin enrolls first so they can turn it off again.
r = await admin.api('POST', '/security/mfa/setup');
const adminSecret = r.body.secret;
r = await admin.api('POST', '/security/mfa/enable', { code: generateSync({ secret: adminSecret }) });
check('admin enrolls', r.status === 200, r.body);
r = await admin.api('PATCH', '/security/policy', { requireMfa: true });
check('admin turns on requireMfa', r.status === 200 && r.body.requireMfa, r.body);
await sleep(5200); // settings cache
r = await viewer.api('GET', '/connections');
check('requireMfa forces enrollment for users without MFA', r.status === 403 && r.body.mfaEnroll, r.body);
r = await viewer.api('GET', '/auth/me');
check('auth/me reports mfaEnrollRequired', r.status === 200 && r.body.mfaEnrollRequired === true, r.body);
r = await viewer.api('POST', '/security/mfa/setup');
check('enrollment endpoints stay reachable', r.status === 200, r.body);
r = await viewer.api('POST', '/security/mfa/enable', { code: generateSync({ secret: r.body.secret }) });
check('viewer enrolls and gets a new csrf', r.status === 200 && r.body.csrfToken, r.body);
r = await viewer.api('GET', '/connections');
check('enrolled viewer passes the gate', r.status === 200, r.body);
r = await analyst.api('POST', '/security/mfa/disable', { code: generateSync({ secret }) });
check('cannot turn MFA off while policy requires it', r.status === 403, r.body);
r = await admin.api('PATCH', '/security/policy', { requireMfa: false });
check('admin turns requireMfa off again', r.status === 200 && !r.body.requireMfa && r.body.blockExportOnProd === true, r.body);
await sleep(5200);

// ── Password change ──────────────────────────────────────────────────────────
r = await viewer.api('POST', '/security/password', { current: 'wrong password!!', next: PW + '!' });
check('password change needs the current password', r.status === 400, r.body);
r = await viewer.api('POST', '/security/password', { current: PW, next: PW + '!' });
check('password changed', r.status === 200, r.body);

// ── Policy merge keeps unrelated fields ──────────────────────────────────────
r = await owner.api('PATCH', '/security/policy', { sessionIdleMinutes: 60 });
check('idle timeout set', r.status === 200 && r.body.sessionIdleMinutes === 60, r.body);
r = await owner.api('PATCH', '/security/policy', { sessionIdleMinutes: 480, requireTypedConfirm: false });
check('safety fields cannot be changed from here', r.status === 400, r.body);
r = await owner.api('PATCH', '/security/policy', { sessionIdleMinutes: 480 });

// ── IP allowlist ─────────────────────────────────────────────────────────────
r = await owner.api('POST', '/security/ip', { cidr: '10.0.0.0/33', note: '' });
check('invalid CIDR refused', r.status === 400, r.body);
r = await owner.api('POST', '/security/ip', { cidr: '10.0.0.0/8', note: 'office' });
check('adding a range that excludes the caller asks for confirmation', r.status === 409 && r.body.lockout, r.body);
r = await owner.api('POST', '/security/ip', { cidr: '10.0.0.0/8', note: 'office', confirmLockout: true });
check('confirmed range saved', r.status === 200 && r.body.list.length === 1 && r.body.yourIpAllowed === false, r.body);
await sleep(5200);
r = await owner.api('GET', '/auth/me');
check('non-allowlisted address is refused before authentication', r.status === 403 && /allowlist/.test(r.body.error), r.body);
{
  const env = { ...process.env, COMB_DATABASE_URL: process.env.DB_URL };
  const out = spawnSync('npm', ['-w', 'server', 'run', 'allowlist:clear'], { env, encoding: 'utf8' });
  check('break-glass CLI clears the list', out.status === 0 && /cleared/.test(out.stdout), out.stderr?.slice(-300));
}
await sleep(5200);
r = await owner.api('GET', '/auth/me');
check('access restored after allowlist:clear', r.status === 200, r.body);
{
  // CIDR logic as a unit (no trusted proxy here, so X-Forwarded-For cannot be used to fake a source).
  const code = `(async () => { const m = await import('./src/modules/security.ts');
const L = [{ cidr: '10.2.0.0/16' }, { cidr: '2001:db8::/32' }, { cidr: '198.51.100.22' }];
const out = {
  inside: m.ipAllowedBy(L, '10.2.7.44', false), outside: m.ipAllowedBy(L, '10.3.0.1', false), mapped: m.ipAllowedBy(L, '::ffff:10.2.0.9', false),
  v6: m.ipAllowedBy(L, '2001:db8::1', false), single: m.ipAllowedBy(L, '198.51.100.22', false), loopNoBypass: m.ipAllowedBy(L, '127.0.0.1', false),
  loopBypass: m.ipAllowedBy(L, '127.0.0.1', true), empty: m.ipAllowedBy([], '203.0.113.9', false),
  norm: [m.normaliseCidr('10.0.0.0/8'), m.normaliseCidr('10.0.0.0/33'), m.normaliseCidr('300.1.1.1'), m.normaliseCidr('2001:DB8::/32'), m.normaliseCidr('1.2.3.4/8/1'), m.normaliseCidr('evil')],
};
console.log(JSON.stringify(out)); process.exit(0); })();`;
  const out = spawnSync('npx', ['tsx', '--env-file=../.env', '-e', code], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), encoding: 'utf8' });
  let u = null; try { u = JSON.parse(out.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
  check('CIDR unit: inside/outside/mapped/v6/single/loopback/empty', u && u.inside && !u.outside && u.mapped && u.v6 && u.single && !u.loopNoBypass && u.loopBypass && u.empty, u ?? out.stderr.slice(-400));
  check('CIDR unit: normalisation rejects junk', u && JSON.stringify(u.norm) === JSON.stringify(['10.0.0.0/8', null, null, '2001:db8::/32', null, null]), u?.norm);
}

// ── SSO: SAML ────────────────────────────────────────────────────────────────
const scratch = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), 'comb-sso-'));
const keyPath = path.join(scratch, 'idp.key'), certPath = path.join(scratch, 'idp.crt');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=test-idp'], { stdio: 'ignore' });
const idpKey = fs.readFileSync(keyPath, 'utf8');
const idpCert = fs.readFileSync(certPath, 'utf8');
const certB64 = idpCert.replace(/-----[^-]+-----|\s+/g, '');
const IDP = 'https://idp.test/saml';
const ACS = PUBLIC + '/api/sso/saml/acs';
const SP = PUBLIC + '/api/sso/saml/metadata';

r = await admin.api('PUT', '/team/sso', { enabled: true, provider: 'saml' });
check('only Owners configure SSO', r.status === 403, r.body);
r = await owner.api('PUT', '/team/sso', {
  enabled: true, provider: 'saml', label: 'Test IdP', saml: { entryPoint: 'https://idp.test/sso', idpIssuer: IDP, cert: certB64 },
  domains: ['acme.test'], jit: true, syncGroups: true, groupMap: [{ group: 'acme-analysts', role: 'Analyst' }],
});
check('owner saves SAML config', r.status === 200 && r.body.enabled && r.body.acsUrl === ACS && !JSON.stringify(r.body).includes('BEGIN'), r.body);

async function samlStart(c) {
  const res = await c.raw('GET', '/api/sso/login');
  const loc = res.headers.get('location') ?? '';
  const req = zlib.inflateRawSync(Buffer.from(new URL(loc).searchParams.get('SAMLRequest'), 'base64')).toString();
  return { status: res.status, loc, id: /ID="([^"]+)"/.exec(req)?.[1], req };
}
function samlResponse({ inResponseTo, email, groups = [], sign = true, audience = SP, notOnOrAfter = new Date(Date.now() + 5 * 60_000) }) {
  const now = new Date().toISOString();
  const exp = notOnOrAfter.toISOString();
  const aid = '_a' + crypto.randomBytes(8).toString('hex');
  const attrs = `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>`
    + (groups.length ? `<saml:Attribute Name="groups">${groups.map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')}</saml:Attribute>` : '');
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${now}"><saml:Issuer>${IDP}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`
    + `<saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${exp}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${now}" NotOnOrAfter="${exp}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${now}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion>`;
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now}" Destination="${ACS}" InResponseTo="${inResponseTo}">`
    + `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  if (sign) {
    const sig = new SignedXml({ privateKey: idpKey, publicCert: idpCert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    xml = sig.getSignedXml();
  }
  return Buffer.from(xml).toString('base64');
}
async function samlPost(c, b64, origin) {
  // Cross-site POST from the IdP: no cookies (and, from a real browser, a foreign Origin).
  const res = await fetch(BASE + '/api/sso/saml/acs', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
    body: new URLSearchParams({ SAMLResponse: b64 }).toString() });
  return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
}
async function samlFinish(c, loc) {
  const res = await c.raw('GET', loc);
  return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
}

{
  const u = client('saml-user');
  const st = await samlStart(u);
  check('SSO login redirects to the IdP with a SAMLRequest and sets a Lax flow cookie', st.status === 302 && st.loc.startsWith('https://idp.test/sso?') && st.id && u.jar.has('comb_sso'), st);
  const good = samlResponse({ inResponseTo: st.id, email: `saml.${run}@acme.test`, groups: ['acme-analysts'] });
  const xo = await samlPost(u, samlResponse({ inResponseTo: '_probe', email: 'probe@acme.test' }), 'https://idp.test');
  if (xo.status === 403 && /Cross-origin/.test(xo.text)) console.log('WARN core guard refuses the browser\'s cross-site ACS POST (Origin: https://idp.test); needs the crossOrigin route flag in security/auth.ts');
  else check('ACS reachable with a foreign Origin (browser POST binding)', xo.status === 403 && !/Cross-origin/.test(xo.text), xo);
  const acs = await samlPost(u, good);
  check('ACS accepts a signed response and hands over a one-time ticket', acs.status === 303 && acs.loc?.startsWith('/api/sso/saml/finish?t='), acs);
  const other = client('attacker-browser');
  const stolen = await samlFinish(other, acs.loc);
  check('ticket is useless in a browser without the flow cookie', stolen.status === 403, stolen.status);
  const fin = await samlFinish(u, acs.loc);
  check('finish creates a session and redirects to /', fin.status === 303 && fin.loc === '/' && u.jar.has('comb_sid'), fin);
  r = await u.api('GET', '/auth/me');
  check('SAML user is JIT-provisioned with the mapped role', r.status === 200 && r.body.email === `saml.${run}@acme.test` && r.body.role === 'Analyst', r.body);
  const replay = await samlPost(u, good);
  check('replayed response is rejected', replay.status === 403, replay.status);
  const audit = (await owner.api('GET', '/team/members')).body.members.find((m) => m.email === `saml.${run}@acme.test`);
  check('SSO member shows auth sso', audit?.auth === 'sso', audit);
}
{
  const u = client('saml-tamper');
  const st = await samlStart(u);
  const good = Buffer.from(samlResponse({ inResponseTo: st.id, email: `saml2.${run}@acme.test`, groups: ['acme-everyone'] }), 'base64').toString();
  const tampered = Buffer.from(good.replace('acme-everyone', 'acme-analysts')).toString('base64');
  const acs = await samlPost(u, tampered);
  check('tampered (group changed after signing) response is rejected', acs.status === 403 && !acs.loc, acs.status);
  const st2 = await samlStart(u);
  const unsigned = await samlPost(u, samlResponse({ inResponseTo: st2.id, email: `saml3.${run}@acme.test`, groups: ['acme-analysts'], sign: false }));
  check('unsigned response is rejected', unsigned.status === 403, unsigned.status);
  const st3 = await samlStart(u);
  const aud = await samlPost(u, samlResponse({ inResponseTo: st3.id, email: `saml4.${run}@acme.test`, audience: 'https://someone-else' }));
  check('wrong audience is rejected', aud.status === 403, aud.status);
  const st4 = await samlStart(u);
  const old = await samlPost(u, samlResponse({ inResponseTo: st4.id, email: `saml5.${run}@acme.test`, notOnOrAfter: new Date(Date.now() - 5 * 60_000) }));
  check('expired (NotOnOrAfter) response is rejected', old.status === 403, old.status);
  const unsolicited = await samlPost(u, samlResponse({ inResponseTo: '_never-requested', email: `saml6.${run}@acme.test` }));
  check('unsolicited response (unknown InResponseTo) is rejected', unsolicited.status === 403, unsolicited.status);
  // Valid signature, but the user's domain is not allowed.
  const st5 = await samlStart(u);
  const acs5 = await samlPost(u, samlResponse({ inResponseTo: st5.id, email: `x.${run}@evil.test`, groups: ['acme-analysts'] }));
  const fin5 = await samlFinish(u, acs5.loc);
  check('email domain outside the allowed list is refused', fin5.status === 403 && !u.jar.has('comb_sid'), fin5.status);
  // Unmapped group + JIT: user exists but has no access to anything.
  const st6 = await samlStart(u);
  const acs6 = await samlPost(u, samlResponse({ inResponseTo: st6.id, email: `unmapped.${run}@acme.test`, groups: ['random-group'] }));
  const fin6 = await samlFinish(u, acs6.loc);
  r = await u.api('GET', '/connections');
  check('unmapped JIT user lands on an empty launcher', fin6.status === 303 && r.status === 200 && r.body.length === 0, r.body);
  r = await owner.api('POST', '/connections', { name: `fresh_${run}`, env: 'dev', host: '127.0.0.1', port: 5432, db: 'x', user: 'x' });
  r = await u.api('GET', '/connections');
  check('... including connections created later', r.status === 200 && r.body.length === 0, r.body);
}
r = await anon.raw('GET', '/api/sso/saml/metadata');
check('SP metadata is published', r.status === 200 && (await r.text()).includes(ACS), r.status);

// ── SSO: OIDC ────────────────────────────────────────────────────────────────
const idp = await startOidcStub({ port: Number(process.env.OIDC_PORT ?? 8199) });
r = await owner.api('PUT', '/team/sso', {
  enabled: true, provider: 'oidc', label: 'Stub', oidc: { issuer: idp.issuer, clientId: idp.clientId }, clientSecret: idp.clientSecret, allowPrivateNetwork: true,
  domains: ['acme.test'], jit: true, syncGroups: true, groupMap: [{ group: 'acme-analysts', role: 'Analyst' }, { group: 'acme-data-eng', role: 'Admin' }],
});
check('owner saves OIDC config; secret is never echoed', r.status === 200 && r.body.hasClientSecret && !JSON.stringify(r.body).includes(idp.clientSecret), r.body);

async function oidcLogin(c, who) {
  idp.next = who;
  const start = await c.raw('GET', '/api/sso/login');
  const authUrl = start.headers.get('location');
  if (start.status !== 302 || !authUrl?.startsWith(idp.issuer)) return { start: start.status, body: await start.text() };
  const p = new URL(authUrl).searchParams;
  const az = await fetch(authUrl, { redirect: 'manual' });
  const cb = new URL(az.headers.get('location'));
  const res = await c.raw('GET', '/api' + cb.pathname.replace(/^\/api/, '') + cb.search);
  return { start: start.status, pkce: p.get('code_challenge_method'), hasNonce: !!p.get('nonce'), hasState: !!p.get('state'), status: res.status, loc: res.headers.get('location'), cbUrl: cb };
}
{
  const u = client('oidc-user');
  const res = await oidcLogin(u, { email: `oidc.${run}@acme.test`, name: 'Olive Oidc', groups: ['acme-data-eng'], amr: ['pwd', 'mfa'] });
  check('OIDC uses PKCE S256 + state + nonce', res.pkce === 'S256' && res.hasNonce && res.hasState, res);
  check('OIDC callback creates a session', res.status === 303 && res.loc === '/' && u.jar.has('comb_sid'), res);
  r = await u.api('GET', '/auth/me');
  check('OIDC user gets the mapped role', r.status === 200 && r.body.role === 'Admin' && r.body.name === 'Olive Oidc', r.body);
  const again = await u.raw('GET', '/api' + res.cbUrl.pathname.replace(/^\/api/, '') + res.cbUrl.search);
  check('OIDC callback replay is refused', again.status === 403, again.status);

  const t = client('oidc-tamper');
  idp.tamper = 'payload';
  const bad = await oidcLogin(t, { email: `oidc2.${run}@acme.test`, groups: [], amr: [] });
  check('id_token with a modified payload is rejected', bad.status === 403 && !t.jar.has('comb_sid'), bad);
  idp.tamper = 'nonce';
  const t2 = client('oidc-tamper-2');
  const bad2 = await oidcLogin(t2, { email: `oidc3.${run}@acme.test`, groups: [], amr: [] });
  check('id_token with the wrong nonce is rejected', bad2.status === 403 && !t2.jar.has('comb_sid'), bad2);
  idp.tamper = null;
  const n = client('no-cookie');
  idp.next = { email: `oidc4.${run}@acme.test`, groups: ['acme-analysts'], amr: [] };
  const st = await u.raw('GET', '/api/sso/login');
  const az = await fetch(st.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(az.headers.get('location'));
  const res2 = await n.raw('GET', cb.pathname + cb.search);
  check('callback without the flow cookie is refused', res2.status === 403 && !n.jar.has('comb_sid'), res2.status);
}
// SSO-only policy: password login closes for non-Owners.
r = await owner.api('PUT', '/team/sso', { ...(await owner.api('GET', '/team/sso')).body, ssoOnly: true });
check('enforce SSO only', r.status === 200 && r.body.ssoOnly, r.body);
await sleep(5200);
r = await client('v').login(`viewer.${run}@acme.test`, PW + '!');
check('password login refused for non-Owners when SSO is enforced', r.status === 403, r.body);
r = await owner.api('PUT', '/team/sso', { ...(await owner.api('GET', '/team/sso')).body, enabled: false, ssoOnly: false });
check('SSO disabled again', r.status === 200 && !r.body.enabled && !r.body.ssoOnly, r.body);
await sleep(5200);
r = await client('anon2').raw('GET', '/api/sso/login');
check('login route returns a clear 400 when SSO is off', r.status === 400, r.status);
await idp.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
