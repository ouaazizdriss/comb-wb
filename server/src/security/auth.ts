import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { z } from 'zod';
import type { Me, WorkspaceRole } from '@comb/shared';
import { config } from '../config.ts';
import { one, q } from '../db/meta.ts';
import { HttpError, parse, badRequest } from '../core/http.ts';
import { getPolicy, getSetting } from '../core/settings.ts';
import { randomToken, sha256, safeEqual } from './crypto.ts';
import { audit } from './audit.ts';
import { verifyUserTotp } from './mfa.ts';
import { userOf, type AuthUser } from './authz.ts';

export const SESSION_COOKIE = 'comb_sid';
const MIN_PASSWORD = 12;
// Verifying against this when the email is unknown keeps response time constant.
let dummyHash: string | null = null;

export async function hashPassword(pw: string): Promise<string> {
  return argonHash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export function checkPasswordStrength(pw: string): void {
  if (pw.length < MIN_PASSWORD) throw badRequest(`Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > 256) throw badRequest('Password is too long');
}

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: string, opts: { mfaPending?: boolean } = {}): Promise<string> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + config.COMB_SESSION_ABSOLUTE_HOURS * 3600_000);
  await q(
    `insert into sessions (id_hash, user_id, csrf_token, mfa_pending, expires_at, ip, user_agent) values ($1,$2,$3,$4,$5,$6,$7)`,
    [sha256(token), userId, csrf, !!opts.mfaPending, expires, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    expires,
  });
  return csrf;
}

async function ipAllowed(ip: string): Promise<boolean> {
  const list = await getSetting<Array<{ cidr: string }>>('security.ip_allowlist', []);
  if (!list.length) return true;
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  // No implicit loopback exemption: behind a same-host reverse proxy every request would look local.
  // Operators who need it opt in explicitly; the break-glass path is `npm -w server run allowlist:clear`.
  if (config.COMB_ALLOWLIST_LOOPBACK_BYPASS && (addr === '127.0.0.1' || addr === '::1')) return true;
  const bl = new net.BlockList();
  for (const { cidr } of list) {
    const [base, bits] = cidr.split('/');
    const type = net.isIPv6(base) ? 'ipv6' : 'ipv4';
    try {
      if (bits === undefined) bl.addAddress(base, type);
      else bl.addSubnet(base, Number(bits), type);
    } catch { /* skip malformed entries */ }
  }
  return bl.check(addr, net.isIPv6(addr) ? 'ipv6' : 'ipv4');
}

function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; CSRF token still applies to cookies
  const allowed = new Set([new URL(config.COMB_PUBLIC_URL).origin]);
  const host = req.headers.host;
  if (host) {
    allowed.add('http://' + host);
    allowed.add('https://' + host);
  }
  return allowed.has(origin);
}

async function authenticate(req: FastifyRequest): Promise<{ user: AuthUser; mfaPending: boolean } | null> {
  const authz = req.headers.authorization;
  if (authz?.startsWith('Bearer ')) {
    const token = authz.slice(7).trim();
    if (!token.startsWith('comb_')) return null;
    const row = await one(
      `select t.id as token_id, t.scopes, u.id, u.email, u.name, u.role, u.mfa_enabled
       from api_tokens t join users u on u.id = t.user_id
       where t.hash = $1 and t.revoked_at is null and (t.expires_at is null or t.expires_at > now()) and u.status = 'active'`,
      [sha256(token)],
    );
    if (!row) return null;
    q('update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval \'1 minute\')', [row.token_id]).catch(() => {});
    return {
      user: { id: row.id, email: row.email, name: row.name, role: row.role, mfaEnabled: row.mfa_enabled, via: 'token', scopes: row.scopes },
      mfaPending: false,
    };
  }
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const idHash = sha256(sid);
  const policy = await getPolicy();
  const row = await one(
    `select s.csrf_token, s.mfa_pending, s.last_seen_at, u.id, u.email, u.name, u.role, u.mfa_enabled
     from sessions s join users u on u.id = s.user_id
     where s.id_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'
       and s.last_seen_at > now() - make_interval(mins => $2)`,
    [idHash, policy.sessionIdleMinutes],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    q('update sessions set last_seen_at = now(), ip = $2 where id_hash = $1', [idHash, req.ip]).catch(() => {});
    q('update users set last_active_at = now() where id = $1', [row.id]).catch(() => {});
  }
  return {
    user: { id: row.id, email: row.email, name: row.name, role: row.role, mfaEnabled: row.mfa_enabled, via: 'session', scopes: null, sessionId: idHash, csrfToken: row.csrf_token },
    mfaPending: row.mfa_pending,
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Global guard for /api: IP allowlist, authentication, MFA gate, CSRF, origin check. */
export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (!(await ipAllowed(req.ip))) throw new HttpError(403, 'Your IP address is not on the allowlist');
    const cfg = req.routeOptions.config ?? {};
    // The SAML HTTP-POST binding is a cross-site form POST by design; such routes are public and verify a signed payload.
    if (MUTATING.has(req.method) && !(cfg.public && cfg.crossOrigin) && !sameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused');

    const auth = await authenticate(req);
    if (auth) req.user = auth.user;
    if (cfg.public) return;
    if (!auth) throw new HttpError(401, 'Not signed in');
    if (auth.mfaPending && !cfg.mfaPending) throw new HttpError(401, 'MFA code required', { mfa: true });
    if (auth.user.via === 'session' && !auth.user.mfaEnabled && !cfg.mfaEnroll && !cfg.mfaPending) {
      if ((await getPolicy()).requireMfa) throw new HttpError(403, 'Set up two-factor authentication first', { mfaEnroll: true });
    }

    if (auth.user.via === 'session' && MUTATING.has(req.method)) {
      const sent = req.headers['x-comb-csrf'];
      if (typeof sent !== 'string' || !auth.user.csrfToken || !safeEqual(sent, auth.user.csrfToken)) {
        throw new HttpError(403, 'Missing or invalid CSRF token');
      }
    }
    if (auth.user.via === 'token' && MUTATING.has(req.method)) {
      const s = auth.user.scopes ?? [];
      if (!s.includes('write') && !s.includes('admin')) throw new HttpError(403, 'Token is read-only');
    }
  });
}

function me(u: AuthUser): Me {
  return { id: u.id, email: u.email, name: u.name, role: u.role as WorkspaceRole, mfaEnabled: u.mfaEnabled, csrfToken: u.csrfToken ?? '' };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const loginLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.get('/auth/status', { config: { public: true } }, async (req) => {
    const users = await one('select count(*)::int as n from users');
    const sso = await getSetting<{ enabled?: boolean; provider?: string }>('sso.config', {});
    const policy = await getPolicy();
    return {
      needsSetup: users.n === 0,
      signedIn: !!req.user,
      ssoEnabled: !!sso.enabled,
      ssoOnly: !!sso.enabled && policy.ssoOnly,
    };
  });

  // First run only: creates the Owner. Refuses once any user exists.
  app.post('/auth/setup', { config: { public: true, ...loginLimit } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email().max(254), name: z.string().trim().min(1).max(100), password: z.string() }), req.body);
    checkPasswordStrength(body.password);
    const pw = await hashPassword(body.password);
    const created = await one(
      `insert into users (email, name, password_hash, role)
       select $1, $2, $3, 'Owner' where not exists (select 1 from users) returning id`,
      [body.email.toLowerCase(), body.name, pw],
    );
    if (!created) throw new HttpError(409, 'Setup is already complete');
    const csrf = await createSession(req, reply, created.id);
    await audit({ actorId: created.id, actorLabel: body.email, kind: 'SETUP', status: 'ok', ip: req.ip, detail: { role: 'Owner' } });
    return { ok: true, csrfToken: csrf };
  });

  app.post('/auth/login', { config: { public: true, ...loginLimit } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().max(254), password: z.string().max(256) }), req.body);
    const policy = await getPolicy();
    const sso = await getSetting<{ enabled?: boolean }>('sso.config', {});
    const user = await one(`select id, email, password_hash, mfa_enabled, status, role from users where lower(email) = lower($1)`, [body.email]);
    dummyHash ??= await hashPassword(randomToken());
    const ok = await argonVerify(user?.password_hash ?? dummyHash, body.password).catch(() => false);
    if (!user || !ok || user.status !== 'active' || !user.password_hash) {
      await audit({ actorLabel: body.email.slice(0, 254), kind: 'LOGIN', status: 'denied', ip: req.ip });
      throw new HttpError(401, 'Email or password is incorrect');
    }
    // With "SSO only", password login stays open to Owners so a broken IdP cannot lock the workspace.
    if (sso.enabled && policy.ssoOnly && user.role !== 'Owner') {
      throw new HttpError(403, 'This workspace requires single sign-on');
    }
    const csrf = await createSession(req, reply, user.id, { mfaPending: user.mfa_enabled });
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'LOGIN', status: user.mfa_enabled ? 'pending' : 'ok', ip: req.ip });
    return { ok: true, mfa: user.mfa_enabled, csrfToken: csrf };
  });

  app.post('/auth/mfa', { config: { mfaPending: true, ...loginLimit } }, async (req, reply) => {
    const u = userOf(req);
    const { code } = parse(z.object({ code: z.string().max(10) }), req.body);
    if (!(await verifyUserTotp(u.id, code))) {
      await audit({ actorId: u.id, actorLabel: u.email, kind: 'MFA', status: 'denied', ip: req.ip });
      throw new HttpError(401, 'That code is not valid');
    }
    // Rotate the session on privilege change so a pre-MFA cookie can never become a full session.
    if (u.sessionId) await q('update sessions set revoked_at = now() where id_hash = $1', [u.sessionId]);
    const csrf = await createSession(req, reply, u.id);
    await audit({ actorId: u.id, actorLabel: u.email, kind: 'MFA', status: 'ok', ip: req.ip });
    return { ok: true, csrfToken: csrf };
  });

  app.post('/auth/logout', { config: { mfaPending: true, mfaEnroll: true } }, async (req, reply) => {
    const u = userOf(req);
    if (u.sessionId) await q('update sessions set revoked_at = now() where id_hash = $1', [u.sessionId]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { config: { mfaEnroll: true } }, async (req) => {
    const u = userOf(req);
    const policy = await getPolicy();
    return { ...me(u), mfaEnrollRequired: policy.requireMfa && !u.mfaEnabled && u.via === 'session' };
  });
}
