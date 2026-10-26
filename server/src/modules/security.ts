import net from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verify as argonVerify } from '@node-rs/argon2';
import QRCode from 'qrcode';
import type { WorkspaceRole } from '@comb/shared';
import { config } from '../config.ts';
import { one, q, tx } from '../db/meta.ts';
import { parse, badRequest, forbidden, notFound, conflict, HttpError } from '../core/http.ts';
import { getPolicy, getSetting, setSetting, type SecurityPolicy } from '../core/settings.ts';
import { audit } from '../security/audit.ts';
import { requireRole, userOf, type AuthUser } from '../security/authz.ts';
import { createSession, hashPassword, checkPasswordStrength } from '../security/auth.ts';
import { randomToken, sha256, decryptSecret } from '../security/crypto.ts';
import { newMfaSecret, storeMfaSecret, checkTotp, verifyUserTotp } from '../security/mfa.ts';

/*
 * Security module: workspace sessions, API tokens, IP allowlist, workspace policy, the current
 * user's two-factor enrollment and password. Team management lives in team.ts, SSO in sso.ts.
 */

export const TOKEN_SCOPES = ['read', 'write', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** The widest token scopes a workspace role may hold. A token never exceeds its owner's role. */
export function maxScopes(role: WorkspaceRole): TokenScope[] {
  switch (role) {
    case 'Owner':
    case 'Admin': return ['read', 'write', 'admin'];
    case 'Analyst':
    case 'Service': return ['read', 'write'];
    case 'Viewer': return ['read'];
  }
}

export interface IssuedToken {
  id: string;
  token: string;
  prefix: string;
  name: string;
  scopes: TokenScope[];
  expiresAt: string | null;
}

/** Creates an API token. The plaintext is returned once; only its sha256 and a 9-char prefix are stored. */
export async function issueToken(owner: { id: string; role: WorkspaceRole }, name: string, scopes: TokenScope[], expiresDays: number | null): Promise<IssuedToken> {
  const allowed = maxScopes(owner.role);
  const bad = scopes.filter((s) => !allowed.includes(s));
  if (bad.length) throw forbidden(`A ${owner.role} cannot hold the ${bad.join(', ')} scope${bad.length > 1 ? 's' : ''}`);
  const token = 'comb_' + randomToken(32);
  const prefix = token.slice(0, 9);
  const expires = expiresDays ? new Date(Date.now() + expiresDays * 86400_000) : null;
  const row = await one(
    `insert into api_tokens (user_id, name, prefix, hash, scopes, expires_at) values ($1,$2,$3,$4,$5,$6) returning id`,
    [owner.id, name, prefix, sha256(token), scopes, expires],
  );
  return { id: row.id, token, prefix, name, scopes, expiresAt: expires ? expires.toISOString() : null };
}

/** Revokes every live session and token of a user (removal, disable, password change elsewhere). */
export async function revokeAllFor(userId: string, opts: { sessions?: boolean; tokens?: boolean; exceptSession?: Buffer } = { sessions: true, tokens: true }): Promise<{ sessions: number; tokens: number }> {
  let sessions = 0;
  let tokens = 0;
  if (opts.sessions !== false) {
    const r = await q(
      `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::bytea is null or id_hash <> $2) returning 1`,
      [userId, opts.exceptSession ?? null],
    );
    sessions = r.length;
  }
  if (opts.tokens !== false) {
    const r = await q('update api_tokens set revoked_at = now() where user_id = $1 and revoked_at is null returning 1', [userId]);
    tokens = r.length;
  }
  return { sessions, tokens };
}

/** Human device label from a user agent string. */
export function deviceOf(ua: string | null | undefined): string {
  const s = ua ?? '';
  if (!s) return 'Unknown device';
  if (/^curl\//i.test(s)) return 'curl';
  if (/^node|undici|axios|python|go-http|okhttp|postman/i.test(s)) return 'API client · ' + s.split(/[ /]/)[0];
  const os = /iPad/.test(s) ? 'iPad' : /iPhone/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? (/HeadlessChrome/.test(s) ? 'Headless Chrome' : 'Chrome')
    : /Safari\//.test(s) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

// ── IP allowlist helpers (mirrors the guard in security/auth.ts) ─────────────────

export interface IpEntry { cidr: string; note: string }

/** Validates and normalises "a.b.c.d", "a.b.c.d/nn" or an IPv6 equivalent. Returns null when invalid. */
export function normaliseCidr(input: string): string | null {
  const s = input.trim();
  const [base, bits, extra] = s.split('/');
  if (extra !== undefined || !base) return null;
  const fam = net.isIP(base);
  if (!fam) return null;
  if (bits !== undefined) {
    if (!/^\d{1,3}$/.test(bits)) return null;
    const n = Number(bits);
    if (n < 0 || n > (fam === 4 ? 32 : 128)) return null;
  }
  const bl = new net.BlockList();
  try {
    if (bits === undefined) bl.addAddress(base, fam === 4 ? 'ipv4' : 'ipv6');
    else bl.addSubnet(base, Number(bits), fam === 4 ? 'ipv4' : 'ipv6');
  } catch {
    return null;
  }
  return bits === undefined ? base.toLowerCase() : `${base.toLowerCase()}/${Number(bits)}`;
}

/** True when the address falls inside one of the listed ranges (no loopback exemption). */
export function inAllowlist(list: Array<{ cidr: string }>, ip: string): boolean {
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!net.isIP(addr)) return false;
  const bl = new net.BlockList();
  for (const { cidr } of list) {
    const [base, bits] = cidr.split('/');
    const type = net.isIPv6(base) ? 'ipv6' : 'ipv4';
    try {
      if (bits === undefined) bl.addAddress(base, type);
      else bl.addSubnet(base, Number(bits), type);
    } catch { /* skip malformed */ }
  }
  return bl.check(addr, net.isIPv6(addr) ? 'ipv6' : 'ipv4');
}

/** Same decision the auth guard makes: an empty list allows everyone; loopback only with COMB_ALLOWLIST_LOOPBACK_BYPASS. */
export function ipAllowedBy(list: Array<{ cidr: string }>, ip: string, loopbackBypass = config.COMB_ALLOWLIST_LOOPBACK_BYPASS): boolean {
  if (!list.length) return true;
  return (loopbackBypass && isLoopback(ip)) || inAllowlist(list, ip);
}

function isLoopback(ip: string): boolean {
  const a = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return a === '127.0.0.1' || a === '::1';
}

/** Reads the stored policy row (not the merged defaults) so a patch only touches the fields it names. */
export async function patchPolicy(patch: Partial<SecurityPolicy>, userId: string): Promise<SecurityPolicy> {
  const row = await one(`select value from app_settings where key = 'security.policy'`);
  const stored = (row?.value ?? {}) as Partial<SecurityPolicy>;
  await setSetting('security.policy', { ...stored, ...patch }, userId);
  return getPolicy();
}

function sessionOnly(u: AuthUser): void {
  if (u.via !== 'session') throw forbidden('Sign in interactively to do this; API tokens cannot');
}

/** Admin acting on someone else's sessions/tokens: Owners are only managed by Owners. */
async function targetUser(req: FastifyRequest, userParam: string | undefined): Promise<{ actor: AuthUser; target: { id: string; email: string; role: WorkspaceRole } }> {
  const actor = userOf(req);
  if (!userParam || userParam === actor.id) return { actor, target: { id: actor.id, email: actor.email, role: actor.role } };
  requireRole(req, 'Admin');
  const t = await one('select id, email, role from users where id = $1', [userParam]);
  if (!t) throw notFound('User not found');
  if (t.role === 'Owner' && actor.role !== 'Owner') throw forbidden('Only an Owner can manage an Owner');
  return { actor, target: t };
}

const idleChoices = [15, 60, 480, 1440] as const;
const uuid = z.string().uuid();

export default async function securityModule(app: FastifyInstance): Promise<void> {
  const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  // ── Current user summary (Security screen header, two-factor section) ─────────
  app.get('/security/me', { config: { mfaEnroll: true } }, async (req) => {
    const u = userOf(req);
    const row = await one('select auth, mfa_enabled, password_hash is not null as has_password from users where id = $1', [u.id]);
    const policy = await getPolicy();
    return { id: u.id, email: u.email, role: u.role, via: u.via, auth: row?.auth, mfaEnabled: !!row?.mfa_enabled, hasPassword: !!row?.has_password, requireMfa: policy.requireMfa };
  });

  // ── Sessions ────────────────────────────────────────────────────────────────
  app.get('/security/sessions', async (req) => {
    const { user } = parse(z.object({ user: uuid.optional() }), req.query);
    const { actor, target } = await targetUser(req, user);
    const policy = await getPolicy();
    const rows = await q(
      `select encode(s.id_hash, 'hex') as id, s.id_hash, s.created_at, s.last_seen_at, s.expires_at, host(s.ip) as ip, s.user_agent, s.mfa_pending, u.auth
       from sessions s join users u on u.id = s.user_id
       where s.user_id = $1 and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - make_interval(mins => $2)
       order by s.last_seen_at desc`,
      [target.id, policy.sessionIdleMinutes],
    );
    return {
      user: { id: target.id, email: target.email },
      sessions: rows.map((r) => ({
        id: r.id, device: deviceOf(r.user_agent), userAgent: r.user_agent, ip: r.ip, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
        current: !!actor.sessionId && actor.sessionId.equals(r.id_hash), mfaPending: r.mfa_pending, auth: r.auth,
      })),
    };
  });

  app.delete('/security/sessions/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }), req.params);
    const actor = userOf(req);
    const row = await one('select s.user_id, u.email, u.role from sessions s join users u on u.id = s.user_id where s.id_hash = $1 and s.revoked_at is null', [Buffer.from(id, 'hex')]);
    if (!row) throw notFound('Session not found');
    if (row.user_id !== actor.id) {
      requireRole(req, 'Admin');
      if (row.role === 'Owner' && actor.role !== 'Owner') throw forbidden('Only an Owner can manage an Owner');
    }
    await q('update sessions set revoked_at = now() where id_hash = $1', [Buffer.from(id, 'hex')]);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'SESSION', target: row.email, status: 'ok', ip: req.ip, detail: { action: 'revoke', current: !!actor.sessionId?.equals(Buffer.from(id, 'hex')) } });
    return { ok: true };
  });

  app.post('/security/sessions/revoke-others', async (req) => {
    const { user } = parse(z.object({ user: uuid.optional() }), req.body ?? {});
    const { actor, target } = await targetUser(req, user);
    const self = target.id === actor.id;
    const r = await revokeAllFor(target.id, { sessions: true, tokens: false, exceptSession: self ? actor.sessionId : undefined });
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'SESSION', target: target.email, status: 'ok', ip: req.ip, detail: { action: self ? 'revoke-others' : 'revoke-all', count: r.sessions } });
    return { ok: true, revoked: r.sessions };
  });

  // ── API tokens ──────────────────────────────────────────────────────────────
  app.get('/security/tokens', async (req) => {
    const { user } = parse(z.object({ user: uuid.optional() }), req.query);
    const { target } = await targetUser(req, user);
    const rows = await q(
      `select id, name, prefix, scopes, created_at, last_used_at, expires_at from api_tokens
       where user_id = $1 and revoked_at is null and (expires_at is null or expires_at > now() - interval '30 days') order by created_at desc`,
      [target.id],
    );
    return {
      user: { id: target.id, email: target.email, role: target.role },
      maxScopes: maxScopes(target.role),
      tokens: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at,
        expired: !!r.expires_at && new Date(r.expires_at).getTime() < Date.now() })),
    };
  });

  app.post('/security/tokens', async (req) => {
    const actor = userOf(req);
    sessionOnly(actor);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_.\- ]+$/, 'letters, digits, space, _ . - only'),
      scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).max(3),
      expiresDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
      user: uuid.optional(),
    }), req.body);
    let owner: { id: string; email: string; role: WorkspaceRole } = { id: actor.id, email: actor.email, role: actor.role };
    if (body.user && body.user !== actor.id) {
      // Admins mint tokens only for service identities, never on behalf of a person.
      requireRole(req, 'Admin');
      const t = await one(`select id, email, role, status from users where id = $1`, [body.user]);
      if (!t) throw notFound('User not found');
      if (t.role !== 'Service') throw forbidden('Tokens can be created for yourself or for a service identity only');
      if (t.status !== 'active') throw badRequest('That service identity is disabled');
      owner = t;
    }
    const scopes = [...new Set(body.scopes)];
    let issued: IssuedToken;
    try {
      issued = await issueToken(owner, body.name, scopes, body.expiresDays);
    } catch (e) {
      await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'TOKEN', target: owner.email, status: 'denied', ip: req.ip, detail: { action: 'create', name: body.name, scopes } });
      throw e;
    }
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'TOKEN', target: owner.email, status: 'ok', ip: req.ip,
      detail: { action: 'create', name: body.name, prefix: issued.prefix, scopes, expiresDays: body.expiresDays } });
    return issued;
  });

  app.delete('/security/tokens/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const actor = userOf(req);
    const row = await one('select t.user_id, t.name, t.prefix, u.email, u.role from api_tokens t join users u on u.id = t.user_id where t.id = $1 and t.revoked_at is null', [id]);
    if (!row) throw notFound('Token not found');
    if (row.user_id !== actor.id) {
      requireRole(req, 'Admin');
      if (row.role === 'Owner' && actor.role !== 'Owner') throw forbidden('Only an Owner can manage an Owner');
    }
    await q('update api_tokens set revoked_at = now() where id = $1', [id]);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'TOKEN', target: row.email, status: 'ok', ip: req.ip, detail: { action: 'revoke', name: row.name, prefix: row.prefix } });
    return { ok: true };
  });

  // ── IP allowlist ────────────────────────────────────────────────────────────
  const ipView = async (req: FastifyRequest) => {
    const list = await getSetting<IpEntry[]>('security.ip_allowlist', []);
    return { list, yourIp: req.ip, loopback: isLoopback(req.ip), loopbackBypass: config.COMB_ALLOWLIST_LOOPBACK_BYPASS, yourIpAllowed: ipAllowedBy(list, req.ip), yourIpListed: inAllowlist(list, req.ip) };
  };

  /** Refuses (409) a change that would shut out the caller's own address unless they confirm it. */
  const lockoutCheck = (req: FastifyRequest, next: IpEntry[], confirmed: boolean) => {
    if (confirmed || ipAllowedBy(next, req.ip)) return;
    throw conflict(`After this change your current address (${req.ip}) is not allowed, and your next request would be refused. The way back is \`npm -w server run allowlist:clear\` on the server.`, { lockout: true, yourIp: req.ip });
  };

  app.get('/security/ip', async (req) => {
    requireRole(req, 'Admin');
    return ipView(req);
  });

  app.post('/security/ip', async (req) => {
    const actor = requireRole(req, 'Admin');
    const body = parse(z.object({ cidr: z.string().max(64), note: z.string().trim().max(80).default(''), confirmLockout: z.boolean().default(false) }), req.body);
    const cidr = normaliseCidr(body.cidr);
    if (!cidr) throw badRequest('Not a valid IP address or CIDR range, e.g. 10.0.0.0/8 or 2001:db8::/32');
    const list = await getSetting<IpEntry[]>('security.ip_allowlist', []);
    if (list.some((e) => e.cidr === cidr)) throw conflict('That range is already on the allowlist');
    if (list.length >= 200) throw badRequest('The allowlist is limited to 200 entries');
    const next = [...list, { cidr, note: body.note }];
    lockoutCheck(req, next, body.confirmLockout);
    await setSetting('security.ip_allowlist', next, actor.id);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'SECURITY', target: 'ip_allowlist', status: 'ok', ip: req.ip, detail: { action: 'add', cidr, note: body.note } });
    return ipView(req);
  });

  app.delete('/security/ip', async (req) => {
    const actor = requireRole(req, 'Admin');
    const { cidr, confirmLockout } = parse(z.object({ cidr: z.string().max(64), confirmLockout: z.boolean().default(false) }), req.body);
    const list = await getSetting<IpEntry[]>('security.ip_allowlist', []);
    if (!list.some((e) => e.cidr === cidr)) throw notFound('That range is not on the allowlist');
    const next = list.filter((e) => e.cidr !== cidr);
    lockoutCheck(req, next, confirmLockout);
    await setSetting('security.ip_allowlist', next, actor.id);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'SECURITY', target: 'ip_allowlist', status: 'ok', ip: req.ip, detail: { action: 'remove', cidr } });
    return ipView(req);
  });

  // ── Workspace policy ────────────────────────────────────────────────────────
  app.get('/security/policy', async (req) => {
    requireRole(req, 'Admin');
    const p = await getPolicy();
    const sso = await getSetting<{ enabled?: boolean }>('sso.config', {});
    return { requireMfa: p.requireMfa, ssoOnly: p.ssoOnly, blockExportOnProd: p.blockExportOnProd, sessionIdleMinutes: p.sessionIdleMinutes, ssoEnabled: !!sso.enabled };
  });

  app.patch('/security/policy', async (req) => {
    const actor = requireRole(req, 'Admin');
    sessionOnly(actor);
    const body = parse(z.object({
      requireMfa: z.boolean().optional(),
      ssoOnly: z.boolean().optional(),
      blockExportOnProd: z.boolean().optional(),
      sessionIdleMinutes: z.union([z.literal(idleChoices[0]), z.literal(idleChoices[1]), z.literal(idleChoices[2]), z.literal(idleChoices[3])]).optional(),
    }).strict(), req.body);
    if (body.ssoOnly) {
      const sso = await getSetting<{ enabled?: boolean }>('sso.config', {});
      if (!sso.enabled) throw badRequest('Turn on single sign-on in Team & access first');
    }
    const before = await getPolicy();
    const after = await patchPolicy(body, actor.id);
    const changed = Object.fromEntries(Object.keys(body).map((k) => [k, { from: (before as any)[k], to: (after as any)[k] }]));
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'SECURITY', target: 'policy', status: 'ok', ip: req.ip, detail: { action: 'policy', changed } });
    return { requireMfa: after.requireMfa, ssoOnly: after.ssoOnly, blockExportOnProd: after.blockExportOnProd, sessionIdleMinutes: after.sessionIdleMinutes };
  });

  // ── Two-factor (contract used by the shell's MfaEnrollScreen) ─────────────────
  app.post('/security/mfa/setup', { config: { mfaEnroll: true, ...strict } }, async (req) => {
    const u = userOf(req);
    sessionOnly(u);
    const row = await one('select mfa_enabled from users where id = $1', [u.id]);
    if (row?.mfa_enabled) throw conflict('Two-factor is already on. Turn it off first to enroll a new device.');
    const { secret, uri } = newMfaSecret(u.email);
    // Stored encrypted and not enabled until a code proves the authenticator has it.
    await storeMfaSecret(u.id, secret, false);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 180, errorCorrectionLevel: 'M' });
    await audit({ actorId: u.id, actorLabel: u.email, kind: 'MFA', status: 'ok', ip: req.ip, detail: { action: 'setup' } });
    return { secret, qrDataUrl };
  });

  app.post('/security/mfa/enable', { config: { mfaEnroll: true, ...strict } }, async (req, reply) => {
    const u = userOf(req);
    sessionOnly(u);
    const { code } = parse(z.object({ code: z.string().max(10) }), req.body);
    const row = await one('select mfa_secret_enc, mfa_enabled from users where id = $1', [u.id]);
    if (row?.mfa_enabled) throw conflict('Two-factor is already on');
    const secret = row?.mfa_secret_enc ? decryptSecret(row.mfa_secret_enc, 'user:' + u.id + ':mfa') : null;
    if (!secret) throw badRequest('Start the setup first');
    if (!checkTotp(secret, code.trim())) {
      await audit({ actorId: u.id, actorLabel: u.email, kind: 'MFA', status: 'denied', ip: req.ip, detail: { action: 'enable' } });
      throw new HttpError(400, 'That code is not valid. Check the time on your phone and try the next code.');
    }
    await q('update users set mfa_enabled = true where id = $1', [u.id]);
    // Privilege changed: rotate the session so the pre-enrollment cookie stops working.
    if (u.sessionId) await q('update sessions set revoked_at = now() where id_hash = $1', [u.sessionId]);
    const csrfToken = await createSession(req, reply, u.id);
    await audit({ actorId: u.id, actorLabel: u.email, kind: 'MFA', status: 'ok', ip: req.ip, detail: { action: 'enable' } });
    return { ok: true, csrfToken };
  });

  app.post('/security/mfa/disable', { config: { mfaEnroll: true, ...strict } }, async (req) => {
    const u = userOf(req);
    sessionOnly(u);
    const { code } = parse(z.object({ code: z.string().max(10) }), req.body);
    if ((await getPolicy()).requireMfa) throw forbidden('Workspace policy requires two-factor authentication');
    if (!(await verifyUserTotp(u.id, code.trim()))) {
      await audit({ actorId: u.id, actorLabel: u.email, kind: 'MFA', status: 'denied', ip: req.ip, detail: { action: 'disable' } });
      throw new HttpError(400, 'That code is not valid');
    }
    await q('update users set mfa_enabled = false, mfa_secret_enc = null where id = $1', [u.id]);
    await audit({ actorId: u.id, actorLabel: u.email, kind: 'MFA', status: 'ok', ip: req.ip, detail: { action: 'disable' } });
    return { ok: true };
  });

  // ── Password ────────────────────────────────────────────────────────────────
  app.post('/security/password', { config: strict }, async (req) => {
    const u = userOf(req);
    sessionOnly(u);
    const body = parse(z.object({ current: z.string().max(256), next: z.string().max(256) }), req.body);
    const row = await one('select password_hash from users where id = $1', [u.id]);
    if (!row?.password_hash) throw badRequest('This account signs in with single sign-on and has no password');
    const ok = await argonVerify(row.password_hash, body.current).catch(() => false);
    if (!ok) {
      await audit({ actorId: u.id, actorLabel: u.email, kind: 'PASSWORD', status: 'denied', ip: req.ip });
      throw new HttpError(400, 'The current password is not correct');
    }
    checkPasswordStrength(body.next);
    if (body.next === body.current) throw badRequest('Choose a password you have not used here');
    await tx(async (c) => {
      await c.query('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(body.next)]);
      await c.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and id_hash <> $2', [u.id, u.sessionId ?? Buffer.alloc(0)]);
    });
    await audit({ actorId: u.id, actorLabel: u.email, kind: 'PASSWORD', status: 'ok', ip: req.ip, detail: { action: 'change', otherSessionsRevoked: true } });
    return { ok: true };
  });

}
