// Creates the owner account (if needed) and the demo connection on a running server.
// Usage: BASE=http://127.0.0.1:8101 node tools/seed.mjs   -> prints a cookie + csrf you can reuse
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
let cookie = '', csrf = '';
async function api(method, path, body) {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-comb-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const creds = { email: 'owner@acme.test', name: 'Maya Owner', password: 'correct horse battery staple' };
let r = await api('POST', '/auth/setup', creds);
if (r.status !== 200) r = await api('POST', '/auth/login', creds);
csrf = r.body.csrfToken;
r = await api('POST', '/connections/demo', {});
console.log(JSON.stringify({ cookie, csrf, demoConnectionId: r.body.id }));
