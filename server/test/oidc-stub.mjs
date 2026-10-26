// Tiny local OpenID Connect provider for tests: discovery, JWKS, authorize (auto-approves) and a token
// endpoint that checks PKCE and signs an RS256 id_token. Usage:
//   const idp = await startOidcStub({ port: 8199 }); idp.next = { email, groups, amr }; ...; idp.close()
// Run standalone: node server/test/oidc-stub.mjs 8199
import http from 'node:http';
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

export async function startOidcStub({ port = 8199, clientId = 'comb-test', clientSecret = 'stub-secret' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'k' + crypto.randomBytes(4).toString('hex');
  const issuer = `http://127.0.0.1:${port}`;
  const codes = new Map();
  const state = { next: { email: 'oidc.user@acme.test', name: 'Oidc User', groups: [], amr: ['pwd'] }, tamper: null, issued: 0 };

  const sign = (claims) => {
    const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64u(JSON.stringify(claims));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + body), privateKey);
    return `${header}.${body}.${b64u(sig)}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') {
      return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('base64url');
      codes.set(code, { challenge: p.get('code_challenge'), nonce: p.get('nonce'), redirect: p.get('redirect_uri'), who: { ...state.next } });
      const back = new URL(p.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state'));
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const p = new URLSearchParams(raw);
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      if (!c) return json(400, { error: 'invalid_grant' });
      if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
      const expect = crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (expect !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      if (p.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: clientId, sub: 'sub-' + c.who.email, iat: now, exp: now + 300, nonce: c.nonce,
        email: c.who.email, email_verified: true, name: c.who.name, groups: c.who.groups, amr: c.who.amr };
      let idToken = sign(claims);
      if (state.tamper === 'payload') {
        // Re-encode the payload with different groups but keep the original signature.
        const [h, , s] = idToken.split('.');
        idToken = `${h}.${b64u(JSON.stringify({ ...claims, groups: ['acme-data-platform'] }))}.${s}`;
      }
      if (state.tamper === 'nonce') idToken = sign({ ...claims, nonce: 'wrong' });
      state.issued++;
      return json(200, { access_token: crypto.randomBytes(16).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    issuer, clientId, clientSecret,
    get next() { return state.next; }, set next(v) { state.next = v; },
    get tamper() { return state.tamper; }, set tamper(v) { state.tamper = v; },
    close: () => new Promise((r) => server.close(r)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idp = await startOidcStub({ port: Number(process.argv[2] ?? 8199) });
  console.log('OIDC stub listening at ' + idp.issuer);
}
