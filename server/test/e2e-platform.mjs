// End-to-end checks for the platform module (integrations + deployment) against a running server.
//
//   BASE=http://127.0.0.1:8109 node server/test/e2e-platform.mjs
//
// META_URL (default: the platform dev metadata DB) is used to create test users and sessions directly.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8109';
const META_URL = process.env.META_URL ?? 'postgres://comb_app:comb-app-dev-only@127.0.0.1:55432/comb_meta_platform';
const DOMAIN = 'platform-e2e.test';

const check = (name, cond, info) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)?.slice(0, 600)));
  if (!cond) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

function client(cookie = '', csrf = '') {
  const c = { cookie, csrf };
  c.api = async (method, p, body) => {
    if (body === undefined && method !== 'GET') body = {};
    const r = await fetch(BASE + '/api' + p, {
      method,
      headers: { 'content-type': 'application/json', cookie: c.cookie, ...(c.csrf ? { 'x-comb-csrf': c.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) c.cookie = sc.split(';')[0];
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
    return { status: r.status, body: j, text };
  };
  return c;
}

// ── Owner session ───────────────────────────────────────────────
const owner = client();
let r = await owner.api('POST', '/auth/setup', { email: 'owner@acme.test', name: 'Maya Owner', password: 'correct horse battery staple' });
if (r.status !== 200) r = await owner.api('POST', '/auth/login', { email: 'owner@acme.test', password: 'correct horse battery staple' });
owner.csrf = r.body.csrfToken;
check('owner signed in', !!owner.csrf, r.body);

// ── Test users via the metadata DB (team module is someone else's) ─
const db = new pg.Client({ connectionString: META_URL });
await db.connect();
await db.query(`delete from users where email like $1`, ['%@' + DOMAIN]);
async function makeUser(role, status = 'active') {
  const email = `${role.toLowerCase()}-${status}-${crypto.randomBytes(3).toString('hex')}@${DOMAIN}`;
  const u = (await db.query(`insert into users (email, name, role, status) values ($1,$2,$3,$4) returning id`, [email, role, role, status])).rows[0];
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  await db.query(`insert into sessions (id_hash, user_id, csrf_token, expires_at) values ($1,$2,$3, now() + interval '1 hour')`,
    [crypto.createHash('sha256').update(token).digest(), u.id, csrf]);
  return client('comb_sid=' + token, csrf);
}

// ── Local receivers ─────────────────────────────────────────────
const SIGNING = 'whsec_' + crypto.randomBytes(18).toString('hex');
const PATH_TOKEN = 'T0KEN' + crypto.randomBytes(10).toString('hex');
const received = { a: [], b: [], flaky: [], bad: [] };
let flakyHits = 0;
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ts = req.headers['x-comb-timestamp'];
    const sig = String(req.headers['x-comb-signature'] ?? '');
    const expect = 'sha256=' + crypto.createHmac('sha256', SIGNING).update(`${ts}.${body}`).digest('hex');
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    const valid = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) && fresh;
    const key = req.url.includes('/hook-a/') ? 'a' : req.url.includes('/hook-b/') ? 'b' : req.url.includes('/flaky/') ? 'flaky' : 'bad';
    if (!valid) { received.bad.push({ url: req.url }); res.writeHead(401); res.end('bad signature'); return; }
    if (key === 'flaky' && ++flakyHits <= 2) { res.writeHead(500); res.end('boom'); return; }
    received[key].push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((ok) => receiver.listen(0, '127.0.0.1', ok));
const PORT = receiver.address().port;
const url = (p) => `http://127.0.0.1:${PORT}/${p}/${PATH_TOKEN}`;

// Minimal SMTP receiver (plaintext, no auth) for the email integration.
const mails = [];
const smtp = net.createServer((s) => {
  s.setEncoding('utf8');
  let buf = '', inData = false, data = '';
  s.write('220 e2e ESMTP\r\n');
  s.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; mails.push(data); data = ''; s.write('250 queued\r\n'); } else data += line + '\n';
        continue;
      }
      if (/^EHLO/i.test(line)) s.write('250-e2e\r\n250 8BITMIME\r\n');
      else if (/^(MAIL|RCPT)/i.test(line)) s.write('250 ok\r\n');
      else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
      else s.write('502 no\r\n');
    }
  });
});
await new Promise((ok) => smtp.listen(0, '127.0.0.1', ok));

// ── Clean slate ─────────────────────────────────────────────────
await owner.api('PUT', '/integrations/allowlist', { hosts: [] });
for (const i of (await owner.api('GET', '/integrations')).body.integrations) {
  if (i.name.startsWith('e2e-')) await owner.api('DELETE', `/integrations/${i.id}`, { confirm: i.name });
}

// ── Create integrations ─────────────────────────────────────────
r = await owner.api('POST', '/integrations', { kind: 'webhook', name: 'e2e-a', url: url('hook-a'), signingSecret: SIGNING });
check('create webhook A', r.status === 200 && r.body.hasSecret && r.body.last4 === PATH_TOKEN.slice(-4), r.body);
const A = r.body.id;
r = await owner.api('POST', '/integrations', { kind: 'webhook', name: 'e2e-b', url: url('hook-b'), signingSecret: SIGNING });
const B = r.body.id;
r = await owner.api('POST', '/integrations', { kind: 'webhook', name: 'e2e-flaky', url: url('flaky'), signingSecret: SIGNING });
const F = r.body.id;
r = await owner.api('POST', '/integrations', { kind: 'slack', name: 'e2e-slack', url: 'http://hooks.slack.com/services/x' });
check('slack requires https', r.status === 400, r.body);
r = await owner.api('POST', '/integrations', { kind: 'pagerduty', name: 'e2e-pd', routingKey: 'R0UT1NGKEY' + 'a'.repeat(22) });
check('create pagerduty', r.status === 200 && r.body.target.includes('••••aaaa'), r.body);
const PD = r.body.id;
r = await owner.api('POST', '/integrations', { kind: 'email', name: 'e2e-mail', smtp: { host: '127.0.0.1', port: smtp.address().port, tls: 'none', from: 'comb@acme.test', to: ['ops@acme.test'] } });
check('create email', r.status === 200, r.body);
const M = r.body.id;
r = await owner.api('POST', '/integrations', { kind: 'email', name: 'e2e-mail-auth', smtp: { host: '127.0.0.1', port: 25, tls: 'none', user: 'u', from: 'comb@acme.test', to: ['ops@acme.test'] }, password: 'smtp-secret-pw' });
const M2 = r.body.id;

// ── Secrets never returned ──────────────────────────────────────
r = await owner.api('GET', '/integrations');
const listing = r.text;
check('secrets never returned (signing secret, URL token, routing key, smtp password)',
  r.status === 200 && !listing.includes(SIGNING) && !listing.includes(PATH_TOKEN) && !listing.includes('R0UT1NGKEY') && !listing.includes('smtp-secret-pw'), listing.slice(0, 400));
const enc = await db.query(`select bool_or(position($1 in convert_from(secret_enc, 'UTF8')) > 0 or position($2 in convert_from(secret_enc, 'UTF8')) > 0) as leak from integrations where secret_enc is not null`, [SIGNING, PATH_TOKEN]);
check('secrets encrypted at rest', enc.rows[0].leak === false, enc.rows[0]);
r = await owner.api('GET', `/integrations/${A}/deliveries`);
check('deliveries list carries no secrets', r.status === 200 && !r.text.includes(SIGNING), r.body);

// ── SSRF guard: refused until the host is allowlisted ───────────
r = await owner.api('POST', `/integrations/${A}/test`);
check('delivery to 127.0.0.1 refused without allowlist', r.status === 200 && r.body.ok === false && /Refused 127\.0\.0\.1/.test(r.body.error), r.body);
check('nothing reached the receiver', received.a.length === 0 && received.bad.length === 0, received);
r = await owner.api('GET', '/integrations');
check('refused test shows as failing', r.body.integrations.find((i) => i.id === A)?.state === 'failing', r.body.integrations.find((i) => i.id === A));
r = await owner.api('PUT', '/integrations/allowlist', { hosts: ['127.0.0.1'] });
check('admin sets allowlist', r.status === 200 && r.body.hosts[0] === '127.0.0.1', r.body);

// ── HMAC verified on the receiver ───────────────────────────────
r = await owner.api('POST', `/integrations/${A}/test`);
check('test delivery ok', r.status === 200 && r.body.ok === true && r.body.statusCode === 200, r.body);
check('receiver verified HMAC + timestamp', received.a.length === 1 && received.bad.length === 0 && received.a[0].headers['x-comb-signature'].startsWith('sha256='), received);
check('test payload is ids/counts only', received.a[0]?.body.event === 'integration.test' && Object.values(received.a[0].body.payload).every((v) => typeof v !== 'object'), received.a[0]?.body);
r = await owner.api('GET', '/integrations');
check('state ok + last delivery recorded', r.body.integrations.find((i) => i.id === A)?.state === 'ok' && r.body.integrations.find((i) => i.id === A)?.lastDelivery?.statusCode === 200, r.body.integrations.find((i) => i.id === A));

// Email over SMTP.
r = await owner.api('POST', `/integrations/${M}/test`);
check('email test delivered over SMTP', r.body.ok === true && mails.length === 1 && /Subject: \[Comb\] Test event from Comb/.test(mails[0]), { r: r.body, mails });
r = await owner.api('POST', `/integrations/${M2}/test`);
check('SMTP credentials refused over plaintext', r.body.ok === false && /unencrypted/.test(r.body.error), r.body);

// ── Event matrix routing ────────────────────────────────────────
const sub = (integrationId, event, on = true) => owner.api('PUT', '/integrations/subscriptions', { integrationId, event, on });
check('subscribe A to job.failed', (await sub(A, 'job.failed')).status === 200);
await sub(B, 'monitor.critical');
await sub(F, 'dq.failed');
r = await owner.api('GET', '/integrations');
check('matrix lists subscriptions', r.body.subscriptions[A]?.includes('job.failed') && r.body.subscriptions[B]?.includes('monitor.critical'), r.body.subscriptions);
received.a.length = 0;
await owner.api('POST', '/integrations/dev/emit', { event: 'job.failed', payload: { jobId: 'j-1', failures: 2 } });
await owner.api('POST', '/integrations/dev/emit', { event: 'monitor.critical', payload: { connectionId: 'c-1', metric: 'replication_lag', value: 42 } });
await waitFor(() => received.a.length >= 1 && received.b.length >= 1);
await sleep(1500);
check('job.failed routed to A only', received.a.length === 1 && received.a[0].body.event === 'job.failed' && received.a[0].body.payload.failures === 2, received.a.map((x) => x.body));
check('monitor.critical routed to B only', received.b.length === 1 && received.b[0].body.event === 'monitor.critical', received.b.map((x) => x.body));
check('signed event headers', received.a[0]?.headers['x-comb-event'] === 'job.failed' && !!received.a[0]?.headers['x-comb-timestamp'], received.a[0]?.headers);

// Disabled integrations get nothing.
await owner.api('PATCH', `/integrations/${A}`, { enabled: false });
await owner.api('POST', '/integrations/dev/emit', { event: 'job.failed', payload: { jobId: 'j-off' } });
await sleep(3000);
check('disabled integration receives nothing', received.a.length === 1, received.a.length);
await owner.api('PATCH', `/integrations/${A}`, { enabled: true });
r = await owner.api('POST', `/integrations/${A}/test`);

// ── Payload sanitisation ────────────────────────────────────────
received.a.length = 0;
await owner.api('POST', '/integrations/dev/emit', { event: 'job.failed', payload: { jobId: 'x'.repeat(500), rows: 3 } });
await waitFor(() => received.a.length >= 1);
check('long string capped at 200 chars', received.a[0]?.body.payload.jobId.length === 200 && received.a[0].body.payload.rows === 3, received.a[0]?.body.payload.jobId?.length);
received.a.length = 0;
// Core strips non-scalar fields from every event before any subscriber sees it, so the row never leaves.
await owner.api('POST', '/integrations/dev/emit', { event: 'job.failed', payload: { jobId: 'j-2', row: { email: 'alice@example.com' } } });
await waitFor(() => received.a.length >= 1);
check('object value stripped, row never delivered', received.a.length === 1 && received.a[0].body.payload.jobId === 'j-2' && !('row' in received.a[0].body.payload)
  && !JSON.stringify(received.a[0].body).includes('alice@example.com'), received.a[0]?.body?.payload);

// ── Retries on 500 with backoff ─────────────────────────────────
await owner.api('POST', '/integrations/dev/emit', { event: 'dq.failed', payload: { testId: 't-9', failing: 4 } });
const okAfterRetry = await waitFor(() => received.flaky.length >= 1, 30000, 500);
r = await owner.api('GET', `/integrations/${F}/deliveries`);
const ev = r.body.filter((d) => d.event === 'dq.failed').reverse();
check('retried on 500 then delivered', !!okAfterRetry && flakyHits === 3 && ev.map((d) => d.status).join(',') === 'retrying,retrying,ok' && ev[0].statusCode === 500 && ev[2].attempt === 3, ev);

// ── Analyst / Admin permissions ─────────────────────────────────
const analyst = await makeUser('Analyst');
const admin = await makeUser('Admin');
r = await analyst.api('GET', '/deploy/flags');
check('flags readable by an Analyst', r.status === 200 && r.body.flags['ai.panel'] === true, r.body);
r = await analyst.api('PUT', '/deploy/flags', { key: 'ai.panel', on: false });
check('flags not writable by an Analyst', r.status === 403, r.body);
r = await owner.api('PUT', '/deploy/flags', { key: 'experimental.explain_visualiser', on: true });
check('owner toggles a flag', r.status === 200 && r.body.flags['experimental.explain_visualiser'] === true, r.body);
r = await analyst.api('GET', '/deploy/flags');
check('analyst sees the new flag value', r.body.flags['experimental.explain_visualiser'] === true, r.body);
await owner.api('PUT', '/deploy/flags', { key: 'experimental.explain_visualiser', on: false });
r = await owner.api('PUT', '/deploy/flags', { key: 'nope.flag', on: true });
check('unknown flag rejected', r.status === 400, r.body);
r = await analyst.api('GET', '/integrations');
check('analyst can read integrations (masked) but not edit', r.status === 200 && r.body.canEdit === false && r.body.allowPrivateHosts.length === 0 && !r.text.includes(PATH_TOKEN), r.body);
r = await analyst.api('POST', `/integrations/${A}/test`);
check('analyst cannot test', r.status === 403, r.body);
r = await analyst.api('PUT', '/integrations/subscriptions', { integrationId: A, event: 'job.failed', on: false });
check('analyst cannot change subscriptions', r.status === 403, r.body);
r = await analyst.api('PUT', '/integrations/allowlist', { hosts: ['10.0.0.1'] });
check('analyst cannot change the allowlist', r.status === 403, r.body);
r = await analyst.api('GET', '/deploy/services');
check('analyst cannot read services', r.status === 403, r.body);

// ── Services don't leak env ─────────────────────────────────────
const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const secrets = envFile.split('\n').map((l) => l.split('=').slice(1).join('=').trim()).filter((v) => v.length >= 8 && !/^https?:\/\/127|^development$/.test(v));
for (const v of [...envFile.matchAll(/:\/\/[^:]+:([^@]+)@/g)].map((m) => m[1])) secrets.push(v);
secrets.push('comb-app-dev-only', 'postgres-dev-only', 'comb-owner-dev-only');
const dump = [(await owner.api('GET', '/deploy/services')).text, (await owner.api('GET', '/deploy/overview')).text, (await owner.api('GET', '/deploy/logs')).text, (await owner.api('GET', '/deploy/members')).text].join('\n');
const leaked = secrets.filter((s) => dump.includes(s));
check('services/overview/logs/members leak no env values', leaked.length === 0 && dump.includes('comb-api') && !/postgres(ql)?:\/\//.test(dump), leaked.map((s) => s.slice(0, 3) + '…'));

// ── Members (information only: Comb has no seat limit) ──────
r = await admin.api('GET', '/deploy/license');
check('no license endpoint', r.status === 404, r.status);
r = await owner.api('GET', '/deploy/members');
const before = r.body;
await makeUser('Viewer', 'invited');
await makeUser('Service');
await makeUser('Analyst', 'disabled');
r = await owner.api('GET', '/deploy/members');
check('members: invited counted, Service apart, disabled not', r.status === 200 && r.body.invited === before.invited + 1 && r.body.service === before.service + 1 && r.body.active === before.active, { before, after: r.body });
const realActive = (await db.query(`select count(*)::int as n from users where role <> 'Service' and status in ('active','invited')`)).rows[0].n;
check('members match the users table', r.body.active + r.body.invited === realActive, { api: r.body, db: realActive });

// ── Releases / overview ─────────────────────────────────────────
r = await owner.api('GET', '/deploy/releases');
check('release history from CHANGELOG', r.status === 200 && r.body.releases.some((x) => x.state === 'current' && x.version === r.body.current), r.body);
r = await owner.api('GET', '/deploy/overview');
check('overview has version, uptime, db size', r.status === 200 && r.body.version && r.body.uptimeS >= 0 && r.body.metaDb.sizeBytes > 0 && Array.isArray(r.body.pendingMigrations), r.body);

// ── Delete needs typed confirmation ─────────────────────────────
r = await owner.api('DELETE', `/integrations/${PD}`, {});
check('delete asks for typed confirmation', r.status === 409 && r.body.code === 'COMB_CONFIRM' && r.body.confirm.word === 'e2e-pd', r.body);
r = await owner.api('DELETE', `/integrations/${PD}`, { confirm: 'e2e-pd' });
check('confirmed delete', r.status === 200, r.body);

// ── Cleanup ─────────────────────────────────────────────────────
for (const i of (await owner.api('GET', '/integrations')).body.integrations) {
  if (i.name.startsWith('e2e-')) await owner.api('DELETE', `/integrations/${i.id}`, { confirm: i.name });
}
await owner.api('PUT', '/integrations/allowlist', { hosts: [] });
await db.query(`delete from users where email like $1`, ['%@' + DOMAIN]);
await db.end();
receiver.close();
smtp.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
process.exit(process.exitCode ?? 0);
