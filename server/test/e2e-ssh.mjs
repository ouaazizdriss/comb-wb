// SSH tunnel: host key pinning (TOFU by an admin), mismatch refusal, queries through the tunnel.
// Needs the dev bastion: docker run ... linuxserver/openssh-server on 127.0.0.1:2222 (see docs/DEVELOPING.md).
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
let cookie = '', csrf = '';
async function api(method, path, body) {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-comb-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const check = (n, c, i) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(i))); if (!c) process.exitCode = 1; };
let r = await api('POST', '/auth/login', { email: 'owner@acme.test', password: 'correct horse battery staple' });
csrf = r.body.csrfToken;
const base = { host: 'db', port: 5432, db: 'shop', user: 'postgres', password: 'postgres-dev-only', sslmode: 'disable', sshHost: '127.0.0.1', sshPort: 2222, sshUser: 'tunnel', sshAuth: 'password', sshSecret: 'tunnel-dev-only' };
r = await api('POST', '/connections/test', base);
check('unknown host key is reported, not accepted', r.body.ok === false && /^SHA256:/.test(r.body.hostKey), r.body);
const fp = r.body.hostKey;
r = await api('POST', '/connections/test', { ...base, sshHostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
check('wrong pinned key refused', r.body.ok === false && /changed/.test(r.body.text), r.body);
r = await api('POST', '/connections/test', { ...base, sshHostKey: fp });
check('test through tunnel with pinned key', r.body.ok === true && /via 127.0.0.1/.test(r.body.text), r.body);
await api('DELETE', '/connections/' + ((await api('GET', '/connections')).body.find((c) => c.name === 'ssh_shop')?.id ?? '00000000-0000-0000-0000-000000000000'), { confirm: 'ssh_shop' });
r = await api('POST', '/connections', { ...base, name: 'ssh_shop', env: 'dev', sshHostKey: fp });
check('create tunnelled connection', r.status === 200 && r.body.ssh?.hostKey === fp && r.body.ssh?.hasSecret && !JSON.stringify(r.body).includes('tunnel-dev-only'), r.body);
const id = r.body.id;
r = await api('POST', `/connections/${id}/query`, { sql: 'select count(*) from users' });
check('query through tunnel', r.status === 200 && Number(r.body.rows[0][0]) > 0, r.body);
r = await api('PATCH', `/connections/${id}`, { sshHost: 'localhost' });
check('moving bastion requires secret', r.status === 400, r.body);
r = await api('PATCH', `/connections/${id}`, { sshPort: 2223 });
check('changing SSH port requires the DB password again', r.status === 400 && /database password/.test(r.body.error), r.body);
r = await api('POST', '/connections/test', { id, sshHost: '203.0.113.9' });
check('testing a different bastion with stored secrets refused', r.status === 400, r.body);
const demo = (await api('GET', '/connections')).body.find((c) => c.name === 'shop_demo');
r = await api('PATCH', `/connections/${demo.id}`, { sshHost: '127.0.0.1', sshUser: 'tunnel', sshSecret: 'x', sshHostKey: fp });
check('adding a tunnel to a connection requires the DB password', r.status === 400, r.body);
// No listening socket: the tunnel must not open a local port.
const { execSync } = await import('node:child_process');
const before = execSync('ss -ltnp 2>/dev/null | grep -c node || true').toString().trim();
r = await api('POST', `/connections/${id}/query`, { sql: 'select 1' });
const after = execSync('ss -ltnp 2>/dev/null | grep -c node || true').toString().trim();
check('tunnel opens no local listener', r.status === 200 && before === after, { before, after });
r = await api('PATCH', `/connections/${id}`, { sshPort: 2223, password: 'postgres-dev-only' });
check('changing SSH port requires the SSH secret too', r.status === 400 && /SSH password or key/.test(r.body.error), r.body);
r = await api('POST', '/connections/test', { id, sshPort: 2223, password: 'postgres-dev-only' });
check('testing another SSH port with stored SSH secret refused', r.status === 400, r.body);
