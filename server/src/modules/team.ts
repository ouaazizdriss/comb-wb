import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS_LEVELS, type AccessLevel, type Environment, type WorkspaceRole } from '@comb/shared';
import { config } from '../config.ts';
import { one, q, tx } from '../db/meta.ts';
import { parse, badRequest, forbidden, notFound, conflict, HttpError } from '../core/http.ts';
import { getPolicy, getSetting, setSecretSetting, setSetting, hasSecretSetting } from '../core/settings.ts';
import { audit } from '../security/audit.ts';
import { requireRole, userOf, defaultLevel, type AuthUser } from '../security/authz.ts';
import { createSession, hashPassword, checkPasswordStrength } from '../security/auth.ts';
import { randomToken, sha256 } from '../security/crypto.ts';
import { issueToken, revokeAllFor, patchPolicy, TOKEN_SCOPES } from './security.ts';
import { idpFetch, parseSamlMetadata, ssoConfigSchema, publicSsoConfig, type SsoConfig } from './sso.ts';

/*
 * Team & access: members, invites, service identities, the connection access matrix and the
 * SSO/group-mapping configuration. Every rule is enforced here, the UI only mirrors it:
 *  - only Owners create, promote, demote or remove Owners; at least one active Owner remains;
 *  - Admins manage Analysts, Viewers and service identities;
 *  - nobody changes their own role or removes themselves;
 *  - removal disables the row (kept for audit integrity) and revokes sessions and tokens.
 */

const INVITE_DAYS = 7;
const ROLE_ORDER: Record<WorkspaceRole, number> = { Owner: 0, Admin: 1, Analyst: 2, Viewer: 3, Service: 4 };
const uuid = z.string().uuid();
const inviteRoles = ['Owner', 'Admin', 'Analyst', 'Viewer'] as const;

interface Target { id: string; email: string; name: string; role: WorkspaceRole; status: string; auth: string }

/** Throws unless `actor` may act on `target` (and, when given, assign `nextRole`). */
function assertCanManage(actor: AuthUser, target: Target, nextRole?: WorkspaceRole): void {
  if (actor.id === target.id) throw forbidden('You cannot change your own role or membership. Ask another Owner.');
  if (actor.role === 'Owner') return;
  if (actor.role !== 'Admin') throw forbidden('Requires the Admin role');
  if (target.role === 'Owner' || nextRole === 'Owner') throw forbidden('Only an Owner can create, promote, demote or remove an Owner');
  if (target.role === 'Admin' || nextRole === 'Admin') throw forbidden('Only an Owner can promote to or change an Admin');
}

/** Inside a transaction: refuses when `excludingId` is the last active Owner. Locks the Owner rows. */
async function assertAnotherOwner(c: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }, excludingId: string): Promise<void> {
  const r = await c.query(`select id from users where role = 'Owner' and status = 'active' for update`);
  if (!r.rows.some((x) => x.id !== excludingId)) throw conflict('The workspace must keep at least one active Owner. Promote someone else first.');
}

async function loadTarget(id: string): Promise<Target> {
  const t = await one<Target>('select id, email, name, role, status, auth from users where id = $1', [id]);
  if (!t) throw notFound('Member not found');
  return t;
}

function inviteLink(token: string): string {
  return new URL('/api/team/join/' + token, config.COMB_PUBLIC_URL).toString();
}

async function newInvite(userId: string, createdBy: string): Promise<{ link: string; expiresAt: string }> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + INVITE_DAYS * 86400_000);
  await tx(async (c) => {
    // A new link replaces any earlier one for the same person.
    await c.query('update team_invites set used_at = now() where user_id = $1 and used_at is null', [userId]);
    await c.query('insert into team_invites (token_hash, user_id, created_by, expires_at) values ($1,$2,$3,$4)', [sha256(token), userId, createdBy, expires]);
  });
  return { link: inviteLink(token), expiresAt: expires.toISOString() };
}

async function findInvite(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
  return one(
    `select i.token_hash, i.expires_at, u.id as user_id, u.email, u.name, u.role
     from team_invites i join users u on u.id = i.user_id
     where i.token_hash = $1 and i.used_at is null and i.expires_at > now() and u.status = 'invited'`,
    [sha256(token)],
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/** Minimal server-rendered page for invite links: works with no JavaScript (CSP forbids inline scripts). */
function joinPage(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join Comb</title>
<meta name="referrer" content="no-referrer">
<style>
:root{color-scheme:dark light;--bg:#0F1419;--fg:#E6EAEE;--muted:#8A96A3;--line:#2A333C;--btn:#E6EAEE;--btnfg:#0F1419;--err:#F87171}
@media (prefers-color-scheme: light){:root{--bg:#F7F8FA;--fg:#15191E;--muted:#5B6672;--line:#D5DBE1;--btn:#15191E;--btnfg:#F7F8FA;--err:#C2410C}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/20px system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:380px;margin:12vh auto 40px;padding:0 24px;display:flex;flex-direction:column;gap:16px}
h1{font-size:24px;line-height:30px;margin:0;font-weight:600}p{margin:0;color:var(--muted)}
label{display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
input{height:32px;padding:0 9px;border:1px solid var(--line);border-radius:3px;background:transparent;color:var(--fg);font:inherit;font-size:13px;text-transform:none;letter-spacing:0}
button{height:32px;border:0;border-radius:3px;background:var(--btn);color:var(--btnfg);font:inherit;font-weight:500;cursor:pointer}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}.err{color:var(--err)}a{color:inherit}
</style></head><body><main>${body}</main></body></html>`;
}

function sendPage(reply: FastifyReply, status: number, body: string) {
  return reply.status(status).header('content-type', 'text/html; charset=utf-8').send(joinPage(body));
}

/** Accept flow shared by the JSON API and the no-JS form. */
async function acceptInvite(req: FastifyRequest, reply: FastifyReply, body: { token: string; name: string; password: string }): Promise<{ csrfToken: string; email: string }> {
  const inv = await findInvite(body.token);
  if (!inv) {
    await audit({ actorLabel: 'invite', kind: 'INVITE', status: 'denied', ip: req.ip, detail: { action: 'accept', reason: 'invalid or expired' } });
    throw new HttpError(404, 'This invite link is not valid any more. Ask an admin for a new one.');
  }
  const sso = await getSetting<{ enabled?: boolean }>('sso.config', {});
  const policy = await getPolicy();
  if (sso.enabled && policy.ssoOnly && inv.role !== 'Owner') throw forbidden('This workspace signs in with single sign-on. Use "Continue with single sign-on" on the sign-in page.');
  checkPasswordStrength(body.password);
  const pw = await hashPassword(body.password);
  const done = await tx(async (c) => {
    const used = await c.query('update team_invites set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id', [inv.token_hash]);
    if (!used.rows.length) return false;
    await c.query(`update users set password_hash = $2, name = $3, status = 'active', auth = 'password' where id = $1 and status = 'invited'`, [inv.user_id, pw, body.name]);
    return true;
  });
  if (!done) throw new HttpError(404, 'This invite link was already used');
  await audit({ actorId: inv.user_id, actorLabel: inv.email, kind: 'INVITE', target: inv.email, status: 'ok', ip: req.ip, detail: { action: 'accept', role: inv.role } });
  const csrfToken = await createSession(req, reply, inv.user_id);
  await audit({ actorId: inv.user_id, actorLabel: inv.email, kind: 'LOGIN', status: 'ok', ip: req.ip, detail: { via: 'invite' } });
  return { csrfToken, email: inv.email };
}

const levelBody = z.object({ userId: uuid, connectionId: uuid, level: z.enum(ACCESS_LEVELS).nullable() });

export default async function teamModule(app: FastifyInstance): Promise<void> {
  const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  // The no-JS invite form posts urlencoded. Scoped to this plugin only, with a small body limit.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // ── Members ─────────────────────────────────────────────────────────────────
  app.get('/team/members', async (req) => {
    const actor = requireRole(req, 'Admin');
    const users = await q(
      `select u.id, u.email, u.name, u.role, u.auth, u.mfa_enabled, u.status, u.created_at,
              greatest(u.last_active_at, (select max(last_used_at) from api_tokens t where t.user_id = u.id)) as last_active,
              (select max(expires_at) from team_invites i where i.user_id = u.id and i.used_at is null) as invite_expires,
              (select count(*)::int from api_tokens t where t.user_id = u.id and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())) as tokens
       from users u`,
    );
    const conns = await q('select id, name, color, env from connections order by name');
    const access = await q('select user_id, connection_id, level from connection_access');
    const explicit = new Map(access.map((a) => [a.user_id + ':' + a.connection_id, a.level as AccessLevel]));
    users.sort((a, b) => (a.status === 'disabled' ? 1 : 0) - (b.status === 'disabled' ? 1 : 0) || ROLE_ORDER[a.role as WorkspaceRole] - ROLE_ORDER[b.role as WorkspaceRole] || a.name.localeCompare(b.name));
    const members = users.map((u) => ({
      id: u.id, email: u.email, name: u.name, role: u.role, auth: u.auth, mfa: u.mfa_enabled, status: u.status, createdAt: u.created_at,
      lastActive: u.last_active, inviteExpires: u.invite_expires, tokens: u.tokens, me: u.id === actor.id,
      access: Object.fromEntries(conns.map((c) => {
        const ex = explicit.get(u.id + ':' + c.id);
        return [c.id, { level: ex ?? defaultLevel(u.role, c.env as Environment), explicit: !!ex }];
      })),
    }));
    const active = users.filter((u) => u.status === 'active');
    return {
      me: { id: actor.id, role: actor.role },
      connections: conns,
      members,
      counts: {
        active: active.filter((u) => u.role !== 'Service').length,
        invited: users.filter((u) => u.status === 'invited').length,
        service: active.filter((u) => u.role === 'Service').length,
        disabled: users.filter((u) => u.status === 'disabled').length,
      },
    };
  });

  app.post('/team/invite', async (req) => {
    const actor = requireRole(req, 'Admin');
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(inviteRoles), name: z.string().trim().max(100).optional() }), req.body);
    if (actor.role !== 'Owner' && (body.role === 'Owner' || body.role === 'Admin')) throw forbidden(`Only an Owner can invite an ${body.role}`);
    const sso = await getSetting<SsoConfig | Record<string, never>>('sso.config', {});
    const domains = 'domains' in sso ? (sso.domains ?? []) : [];
    if ('enabled' in sso && sso.enabled && domains.length && !domains.includes(body.email.split('@')[1])) {
      throw badRequest(`Single sign-on only accepts ${domains.join(', ')} addresses`);
    }
    const existing = await one('select id, status, role from users where lower(email) = $1', [body.email]);
    let userId: string;
    if (existing) {
      if (existing.status !== 'invited') throw conflict(existing.status === 'disabled' ? 'That person was removed. Re-enable them from the members list instead.' : 'That person is already a member');
      if (existing.role === 'Owner' && actor.role !== 'Owner') throw forbidden('Only an Owner can re-invite an Owner');
      await q('update users set role = $2, name = coalesce(nullif($3, \'\'), name) where id = $1', [existing.id, body.role, body.name ?? '']);
      userId = existing.id;
    } else {
      const row = await one(`insert into users (email, name, role, status, auth) values ($1, $2, $3, 'invited', 'password') returning id`,
        [body.email, body.name ?? body.email.split('@')[0], body.role]);
      userId = row.id;
    }
    const inv = await newInvite(userId, actor.id);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'INVITE', target: body.email, status: 'ok', ip: req.ip, detail: { action: existing ? 'reinvite' : 'invite', role: body.role } });
    return { userId, email: body.email, role: body.role, ...inv };
  });

  app.post('/team/members/:id/resend', async (req) => {
    const actor = requireRole(req, 'Admin');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = await loadTarget(id);
    if (t.status !== 'invited') throw badRequest('Only pending invites can be resent');
    if (t.role === 'Owner' && actor.role !== 'Owner') throw forbidden('Only an Owner can re-invite an Owner');
    const inv = await newInvite(t.id, actor.id);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'INVITE', target: t.email, status: 'ok', ip: req.ip, detail: { action: 'resend', role: t.role } });
    return { userId: t.id, email: t.email, role: t.role, ...inv };
  });

  // Public: the invitee checks their link (rate-limited, reveals only the invited address).
  app.get('/team/invite/:token', { config: { public: true, ...strict } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.params);
    const inv = await findInvite(token);
    if (!inv) throw new HttpError(404, 'This invite link is not valid any more. Ask an admin for a new one.');
    return { email: inv.email, name: inv.name, role: inv.role, expiresAt: inv.expires_at };
  });

  app.post('/team/accept', { config: { public: true, ...strict } }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().max(200), name: z.string().trim().min(1).max(100), password: z.string().max(256) }), req.body);
    const r = await acceptInvite(req, reply, body);
    return { ok: true, csrfToken: r.csrfToken };
  });

  // Public: the page an invite link opens. A plain HTML form, so it needs nothing from the SPA.
  app.get('/team/join/:token', { config: { public: true, ...strict } }, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.params);
    const inv = await findInvite(token);
    if (!inv) return sendPage(reply, 404, `<h1>Invite expired</h1><p>This link is not valid any more. Invite links work once and expire after ${INVITE_DAYS} days. Ask an admin for a new one.</p>`);
    return sendPage(reply, 200, `<h1>Join Comb</h1><p>You were invited as <b>${esc(inv.role)}</b>. Choose a password to finish.</p>
<p class="mono">${esc(inv.email)}</p>
<form method="post" action="/api/team/join" style="display:flex;flex-direction:column;gap:12px">
<input type="hidden" name="token" value="${esc(token)}">
<label>Name<input name="name" value="${esc(inv.name)}" required maxlength="100" autocomplete="name"></label>
<label>Password<input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label>
<p style="font-size:12px">At least 12 characters. A passphrase is easiest.</p>
<button type="submit">Create account</button></form>`);
  });

  app.post('/team/join', { config: { public: true, ...strict } }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().max(200), name: z.string().trim().min(1).max(100), password: z.string().max(256) }), req.body);
    try {
      await acceptInvite(req, reply, body);
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : 'Something went wrong.';
      const retry = e instanceof HttpError && e.status === 400 ? `<p><a href="/api/team/join/${esc(body.token)}">Try again</a></p>` : '';
      return sendPage(reply, e instanceof HttpError ? e.status : 500, `<h1>Could not join</h1><p class="err">${esc(msg)}</p>${retry}`);
    }
    return reply.redirect('/', 303);
  });

  app.patch('/team/members/:id', async (req) => {
    const actor = requireRole(req, 'Admin');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ role: z.enum(['Owner', 'Admin', 'Analyst', 'Viewer']).optional(), status: z.enum(['active', 'disabled']).optional() }).strict(), req.body);
    const t = await loadTarget(id);
    if (body.role && body.role !== t.role) {
      if (t.role === 'Service') throw badRequest('Service identities have a fixed role. Rotate or revoke their token instead.');
      assertCanManage(actor, t, body.role);
      await tx(async (c) => {
        if (t.role === 'Owner') await assertAnotherOwner(c, t.id);
        await c.query('update users set role = $2 where id = $1', [t.id, body.role]);
      });
      // Tokens can never exceed the role: drop scopes the new role does not allow.
      if (body.role === 'Viewer' || body.role === 'Analyst') {
        await q(`update api_tokens set revoked_at = now() where user_id = $1 and revoked_at is null and ($2 = 'Viewer' and scopes && array['write','admin'] or 'admin' = any(scopes))`, [t.id, body.role]);
      }
      await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'ROLE', target: t.email, status: 'ok', ip: req.ip, detail: { action: 'role', from: t.role, to: body.role } });
    }
    if (body.status && body.status !== t.status) {
      assertCanManage(actor, t);
      if (body.status === 'disabled') {
        await tx(async (c) => {
          if (t.role === 'Owner') await assertAnotherOwner(c, t.id);
          await c.query(`update users set status = 'disabled' where id = $1`, [t.id]);
          await c.query('update team_invites set used_at = now() where user_id = $1 and used_at is null', [t.id]);
        });
        const r = await revokeAllFor(t.id);
        await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'MEMBER', target: t.email, status: 'ok', ip: req.ip, detail: { action: 'disable', role: t.role, sessionsRevoked: r.sessions, tokensRevoked: r.tokens } });
      } else {
        if (t.status !== 'disabled') throw badRequest('Only removed members can be re-enabled');
        await q(`update users set status = 'active' where id = $1`, [t.id]);
        await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'MEMBER', target: t.email, status: 'ok', ip: req.ip, detail: { action: 'enable', role: t.role } });
      }
    }
    return { ok: true };
  });

  // Remove = disable + revoke sessions and tokens. The row stays so the audit trail keeps its actor.
  app.delete('/team/members/:id', async (req) => {
    const actor = requireRole(req, 'Admin');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = await loadTarget(id);
    assertCanManage(actor, t);
    if (t.status === 'disabled') return { ok: true };
    await tx(async (c) => {
      if (t.role === 'Owner') await assertAnotherOwner(c, t.id);
      await c.query(`update users set status = 'disabled' where id = $1`, [t.id]);
      await c.query('update team_invites set used_at = now() where user_id = $1 and used_at is null', [t.id]);
    });
    const r = await revokeAllFor(t.id);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'MEMBER', target: t.email, status: 'ok', ip: req.ip,
      detail: { action: t.status === 'invited' ? 'cancel-invite' : 'remove', role: t.role, sessionsRevoked: r.sessions, tokensRevoked: r.tokens } });
    return { ok: true, sessionsRevoked: r.sessions, tokensRevoked: r.tokens };
  });

  app.post('/team/members/:id/reset-mfa', async (req) => {
    const actor = requireRole(req, 'Admin');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = await loadTarget(id);
    assertCanManage(actor, t);
    await q('update users set mfa_enabled = false, mfa_secret_enc = null where id = $1', [t.id]);
    const r = await revokeAllFor(t.id, { sessions: true, tokens: false });
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'MFA', target: t.email, status: 'ok', ip: req.ip, detail: { action: 'reset', sessionsRevoked: r.sessions } });
    return { ok: true };
  });

  // ── Service identities ──────────────────────────────────────────────────────
  app.post('/team/service', async (req) => {
    const actor = requireRole(req, 'Admin');
    if (actor.via !== 'session') throw forbidden('Sign in interactively to create service identities');
    const body = parse(z.object({
      name: z.string().trim().min(2).max(40).regex(/^[a-z0-9_][a-z0-9_.-]*$/, 'lowercase letters, digits, _ . - only'),
      scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).max(3).default(['read']),
      expiresDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(90),
    }), req.body);
    const email = 'tokens/' + body.name;
    if (await one('select 1 from users where lower(email) = $1', [email])) throw conflict('A service identity with that name already exists');
    const row = await one(`insert into users (email, name, role, auth, status) values ($1, $2, 'Service', 'token', 'active') returning id`, [email, body.name]);
    const issued = await issueToken({ id: row.id, role: 'Service' }, body.name, [...new Set(body.scopes)], body.expiresDays).catch(async (e) => {
      await q(`update users set status = 'disabled' where id = $1`, [row.id]);
      throw e;
    });
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'MEMBER', target: email, status: 'ok', ip: req.ip, detail: { action: 'service', scopes: issued.scopes, prefix: issued.prefix, expiresDays: body.expiresDays } });
    return { userId: row.id, email, ...issued };
  });

  // ── Connection access matrix ────────────────────────────────────────────────
  app.put('/team/access', async (req) => {
    const actor = requireRole(req, 'Admin');
    const body = parse(levelBody, req.body);
    const t = await loadTarget(body.userId);
    const conn = await one('select id, name, env from connections where id = $1', [body.connectionId]);
    if (!conn) throw notFound('Connection not found');
    if (actor.role !== 'Owner') {
      if (t.id === actor.id) throw forbidden('You cannot change your own access. Ask an Owner.');
      assertCanManage(actor, t);
      const cur = await one('select level from connection_access where user_id = $1 and connection_id = $2', [t.id, conn.id]);
      if (body.level === 'admin' || cur?.level === 'admin') throw forbidden('Only an Owner can grant or take away admin access');
    }
    const before = (await one('select level from connection_access where user_id = $1 and connection_id = $2', [t.id, conn.id]))?.level ?? null;
    if (body.level === null) {
      await q('delete from connection_access where user_id = $1 and connection_id = $2', [t.id, conn.id]);
    } else {
      await q(`insert into connection_access (user_id, connection_id, level) values ($1,$2,$3)
               on conflict (user_id, connection_id) do update set level = excluded.level`, [t.id, conn.id, body.level]);
    }
    const effective = body.level ?? defaultLevel(t.role, conn.env);
    await audit({ actorId: actor.id, actorLabel: actor.email, connectionId: conn.id, connectionName: conn.name, kind: 'ACCESS', target: t.email, status: 'ok', ip: req.ip,
      detail: { from: before ?? 'default', to: body.level ?? 'default', effective } });
    return { level: effective, explicit: body.level !== null };
  });

  // ── Single sign-on configuration ─────────────────────────────────────────────
  const ssoView = async () => {
    const cfg = await getSetting<Partial<SsoConfig>>('sso.config', {});
    const policy = await getPolicy();
    return { ...publicSsoConfig(cfg), hasClientSecret: await hasSecretSetting('sso.oidc_client_secret'), ssoOnly: policy.ssoOnly };
  };

  app.get('/team/sso', async (req) => {
    requireRole(req, 'Admin');
    return ssoView();
  });

  // SSO decides who becomes what (JIT + group → role), so only Owners change it.
  app.put('/team/sso', async (req) => {
    const actor = requireRole(req, 'Owner');
    if (actor.via !== 'session') throw forbidden('Sign in interactively to change single sign-on');
    const body = parse(ssoConfigSchema.extend({ ssoOnly: z.boolean().optional(), clientSecret: z.string().max(2048).optional() }), req.body);
    const { ssoOnly, clientSecret, ...cfg } = body;
    if (cfg.enabled) {
      if (cfg.provider === 'saml' && (!cfg.saml.entryPoint || !cfg.saml.cert)) throw badRequest('SAML needs the IdP sign-on URL and signing certificate (or import them from metadata)');
      if (cfg.provider === 'oidc' && (!cfg.oidc.issuer || !cfg.oidc.clientId)) throw badRequest('OIDC needs an issuer URL and a client ID');
      if (!cfg.domains.length) throw badRequest('Add at least one allowed email domain');
    }
    const before = await getSetting<Partial<SsoConfig>>('sso.config', {});
    await setSetting('sso.config', cfg, actor.id);
    if (clientSecret !== undefined) await setSecretSetting('sso.oidc_client_secret', clientSecret || null, actor.id);
    const policy = await getPolicy();
    const nextOnly = cfg.enabled ? (ssoOnly ?? policy.ssoOnly) : false;
    if (nextOnly !== policy.ssoOnly) await patchPolicy({ ssoOnly: nextOnly }, actor.id);
    await audit({ actorId: actor.id, actorLabel: actor.email, kind: 'SSO', target: cfg.provider, status: 'ok', ip: req.ip, detail: {
      action: 'configure', enabled: cfg.enabled, wasEnabled: !!before.enabled, provider: cfg.provider, domains: cfg.domains, jit: cfg.jit, syncGroups: cfg.syncGroups,
      requireMfaClaim: cfg.requireMfaClaim, ssoOnly: nextOnly, groupMap: cfg.groupMap, clientSecretChanged: clientSecret !== undefined,
    } });
    return ssoView();
  });

  // Reads IdP metadata (URL through the SSRF guard, or pasted XML) and returns what it found; nothing is saved.
  app.post('/team/sso/metadata', async (req) => {
    requireRole(req, 'Owner');
    const body = parse(z.object({ url: z.string().url().max(2048).optional(), xml: z.string().max(512 * 1024).optional(), allowPrivateNetwork: z.boolean().default(false) }), req.body);
    let xml = body.xml;
    if (!xml && body.url) {
      const u = new URL(body.url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('Metadata URL must be http(s)');
      const res = await idpFetch(body.url, { method: 'GET', headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' } }, body.allowPrivateNetwork)
        .catch((e) => { throw badRequest('Could not fetch the metadata: ' + (e as Error).message); });
      if (!res.ok) throw badRequest(`The metadata URL answered ${res.status}`);
      xml = await res.text();
    }
    if (!xml) throw badRequest('Paste the metadata XML or give its URL');
    const found = parseSamlMetadata(xml);
    if (!found.entryPoint && !found.cert) throw badRequest('No SAML sign-on URL or signing certificate found in that metadata');
    return found;
  });

}
