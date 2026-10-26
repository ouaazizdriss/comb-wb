import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import * as oidc from 'openid-client';
import type { WorkspaceRole } from '@comb/shared';
import { config } from '../config.ts';
import { one, q, tx } from '../db/meta.ts';
import { parse, badRequest } from '../core/http.ts';
import { getSetting, getSecretSetting } from '../core/settings.ts';
import { audit } from '../security/audit.ts';
import { createSession } from '../security/auth.ts';
import { randomToken, sha256, safeEqual } from '../security/crypto.ts';
import { blockedReason, isPrivateOnly } from '../platform/ssrf.ts';

/*
 * Single sign-on: SAML 2.0 (HTTP-Redirect AuthnRequest, HTTP-POST response) through node-saml, and
 * OIDC (authorization code + PKCE + state + nonce) through openid-client.
 *
 * Binding the IdP's answer to the browser that started the login:
 *  - /sso/login stores state/nonce/PKCE verifier or the SAML request ID in sso_flows under the sha256
 *    of a random handle, and gives the browser the handle in an httpOnly SameSite=Lax cookie.
 *  - OIDC: the IdP redirects back with a top-level GET, which carries the Lax cookie.
 *  - SAML: the IdP's POST is cross-site, which does NOT carry Lax cookies. The ACS validates the
 *    signed assertion (signature, audience, issuer, NotOnOrAfter, InResponseTo, one use), parks the
 *    identity under a one-time ticket and 303-redirects to /sso/saml/finish — a top-level GET that does
 *    carry the cookie — where the flow must match before a session is created.
 * Group claims are only read from a validated (signed) assertion or ID token.
 */

export const SSO_ROLES = ['Owner', 'Admin', 'Analyst', 'Viewer'] as const;
const ROLE_RANK: Record<string, number> = { Owner: 4, Admin: 3, Analyst: 2, Viewer: 1 };
const FLOW_COOKIE = 'comb_sso';
const FLOW_MINUTES = 10;

const domainRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const urlOrEmpty = z.union([z.literal(''), z.string().trim().url().max(2048)]);

export const ssoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['saml', 'oidc']).default('saml'),
  /** Display name of the IdP, e.g. "Okta". */
  label: z.string().trim().max(40).default(''),
  saml: z.object({
    entryPoint: urlOrEmpty.default(''),
    idpIssuer: z.string().trim().max(1024).default(''),
    cert: z.string().trim().max(20_000).default(''),
    metadataUrl: urlOrEmpty.default(''),
  }).default({ entryPoint: '', idpIssuer: '', cert: '', metadataUrl: '' }),
  oidc: z.object({
    issuer: urlOrEmpty.default(''),
    clientId: z.string().trim().max(256).default(''),
    scopes: z.string().trim().max(200).regex(/^[\w:./ -]*$/).default('openid email profile'),
  }).default({ issuer: '', clientId: '', scopes: 'openid email profile' }),
  /** SAML attribute name / OIDC claim name carrying group names. */
  groupsAttribute: z.string().trim().min(1).max(200).default('groups'),
  domains: z.array(z.string().trim().toLowerCase().regex(domainRe, 'not a domain name')).max(20).default([]),
  jit: z.boolean().default(false),
  syncGroups: z.boolean().default(true),
  requireMfaClaim: z.boolean().default(false),
  /** The IdP lives on a private network (self-hosted Keycloak...). Loopback/RFC1918 allowed; link-local/metadata never. */
  allowPrivateNetwork: z.boolean().default(false),
  groupMap: z.array(z.object({ group: z.string().trim().min(1).max(200), role: z.enum(SSO_ROLES) })).max(100).default([]),
});
export type SsoConfig = z.infer<typeof ssoConfigSchema>;

export function urls() {
  const base = config.COMB_PUBLIC_URL;
  return {
    acsUrl: new URL('/api/sso/saml/acs', base).toString(),
    spEntityId: new URL('/api/sso/saml/metadata', base).toString(),
    oidcRedirectUrl: new URL('/api/sso/oidc/callback', base).toString(),
  };
}

/** What the Team screen may see: no secrets (the OIDC client secret is a separate secret setting). */
export function publicSsoConfig(raw: Partial<SsoConfig>) {
  const cfg = ssoConfigSchema.parse(raw ?? {});
  return { ...cfg, ...urls() };
}

async function loadConfig(): Promise<SsoConfig | null> {
  const raw = await getSetting<Partial<SsoConfig> | null>('sso.config', null);
  if (!raw) return null;
  const r = ssoConfigSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ── Outbound fetch to the IdP (SSRF guarded) ─────────────────────────────────

export function addressBlocked(ip: string, allowPrivate: boolean): boolean {
  if (!net.isIP(ip)) return true;
  if (!blockedReason(ip)) return false;
  // "IdP on a private network" lifts RFC 1918, loopback and unique-local only; never metadata or reserved ranges.
  return !(allowPrivate && isPrivateOnly(ip));
}

const MAX_IDP_BYTES = 1024 * 1024;

/** fetch-compatible request that validates every resolved address at connect time (no DNS rebinding). */
function guardedFetch(url: string, init: { method?: string; headers?: Record<string, string> | Headers; body?: unknown; signal?: AbortSignal }, allowPrivate: boolean): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.reject(new Error('only http(s) is allowed'));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && addressBlocked(host, allowPrivate)) return Promise.reject(new Error('that address is not allowed'));
  const headers: Record<string, string> = {};
  if (init.headers instanceof Headers) init.headers.forEach((v, k) => { headers[k] = v; });
  else Object.assign(headers, init.headers ?? {});
  let body: Buffer | undefined;
  const b = init.body;
  if (typeof b === 'string') body = Buffer.from(b);
  else if (b instanceof URLSearchParams) { body = Buffer.from(b.toString()); headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8'; }
  else if (b instanceof Uint8Array) body = Buffer.from(b);
  else if (b instanceof ArrayBuffer) body = Buffer.from(new Uint8Array(b));
  else if (b != null) return Promise.reject(new Error('unsupported request body'));
  if (body) headers['content-length'] = String(body.length);
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return (cb as any)(err);
      if (!addrs.length || addrs.some((a) => addressBlocked(a.address, allowPrivate))) return (cb as any)(new Error(`${hostname} resolves to an address that is not allowed`));
      if ((options as any)?.all) return (cb as any)(null, addrs);
      return (cb as any)(null, addrs[0].address, addrs[0].family);
    });
  };
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: init.method ?? 'GET', headers, lookup, timeout: 10_000, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_IDP_BYTES) { req.destroy(new Error('IdP response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
          else if (v !== undefined) h.set(k, String(v));
        }
        const status = res.statusCode ?? 502;
        const nobody = status === 204 || status === 304 || (status >= 100 && status < 200);
        resolve(new Response(nobody ? null : Buffer.concat(chunks), { status, headers: h }));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('IdP did not answer within 10 s')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Outbound requests to the IdP. Uses the integrations module's safeFetch (which honours the admin's
 * host allowlist) when it exists; an IdP explicitly marked as private-network uses the local guard,
 * which still refuses link-local and cloud-metadata addresses.
 */
export async function idpFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }, allowPrivate: boolean): Promise<Response> {
  if (!allowPrivate) {
    const integ: any = await import('./integrations.ts').catch(() => null);
    if (typeof integ?.safeFetch === 'function') return integ.safeFetch(url, { ...init, redirect: 'manual' });
  }
  return guardedFetch(url, init, allowPrivate);
}

/** Pulls the sign-on URL, entity ID and signing certificate out of SAML IdP metadata. */
export function parseSamlMetadata(xml: string): { entryPoint: string; idpIssuer: string; cert: string } {
  const entity = /<(?:\w+:)?EntityDescriptor\b[^>]*\bentityID\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? '';
  const sso = [...xml.matchAll(/<(?:\w+:)?SingleSignOnService\b([^>]*)\/?>/g)].map((m) => m[1]);
  const pick = (binding: string) => sso.find((a) => a.includes(binding));
  const attr = pick('HTTP-Redirect') ?? pick('HTTP-POST') ?? '';
  const entryPoint = /\bLocation\s*=\s*"([^"]+)"/.exec(attr)?.[1] ?? '';
  // Prefer a key explicitly marked for signing.
  const signing = /<(?:\w+:)?KeyDescriptor\b[^>]*use\s*=\s*"signing"[^>]*>([\s\S]*?)<\/(?:\w+:)?KeyDescriptor>/.exec(xml)?.[1];
  const certSrc = signing ?? xml;
  const cert = (/<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/.exec(certSrc)?.[1] ?? '').replace(/\s+/g, '');
  const valid = (s: string) => /^https?:\/\/[^\s"<>]+$/.test(s) ? s : '';
  return { entryPoint: valid(entryPoint.replace(/&amp;/g, '&')), idpIssuer: entity.slice(0, 1024), cert: /^[A-Za-z0-9+/=]+$/.test(cert) ? cert : '' };
}

// ── Flow storage ─────────────────────────────────────────────────────────────

function setFlowCookie(reply: FastifyReply, handle: string): void {
  reply.setCookie(FLOW_COOKIE, handle, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/api/sso', maxAge: FLOW_MINUTES * 60 });
}
function clearFlowCookie(reply: FastifyReply): void {
  reply.clearCookie(FLOW_COOKIE, { path: '/api/sso' });
}

/** node-saml request-ID cache backed by sso_flows. Records which ID it accepted so the ACS can find the flow. */
function flowCache(): CacheProvider & { accepted: string | null } {
  const c = {
    accepted: null as string | null,
    async saveAsync(_key: string, value: string) {
      return { value, createdAt: Date.now() }; // the flow row is inserted by /sso/login itself
    },
    async getAsync(key: string) {
      const r = await one(`select created_at from sso_flows where request_id = $1 and kind = 'saml' and saml_consumed_at is null and expires_at > now()`, [key]);
      if (r) c.accepted = key;
      return r ? new Date(r.created_at).toISOString() : null;
    },
    async removeAsync(key: string | null) {
      if (!key) return null;
      await q('update sso_flows set saml_consumed_at = coalesce(saml_consumed_at, now()) where request_id = $1', [key]);
      return key;
    },
  };
  return c;
}

function samlClient(cfg: SsoConfig, cache: CacheProvider, requestId?: string): SAML {
  const u = urls();
  return new SAML({
    callbackUrl: u.acsUrl,
    entryPoint: cfg.saml.entryPoint,
    issuer: u.spEntityId,
    audience: u.spEntityId,
    idpCert: cfg.saml.cert,
    idpIssuer: cfg.saml.idpIssuer || undefined,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: FLOW_MINUTES * 60_000,
    acceptedClockSkewMs: 60_000,
    cacheProvider: cache,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    disableRequestedAuthnContext: true,
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  });
}

let oidcCache: { key: string; at: number; cfg: oidc.Configuration } | null = null;

async function oidcClient(cfg: SsoConfig): Promise<oidc.Configuration> {
  const secret = await getSecretSetting('sso.oidc_client_secret');
  const key = JSON.stringify([cfg.oidc.issuer, cfg.oidc.clientId, secret ? sha256(secret).toString('hex') : '', cfg.allowPrivateNetwork]);
  if (oidcCache && oidcCache.key === key && Date.now() - oidcCache.at < 5 * 60_000) return oidcCache.cfg;
  const issuer = new URL(cfg.oidc.issuer);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname);
  if (issuer.protocol !== 'https:' && !(loopback && cfg.allowPrivateNetwork)) throw badRequest('The OIDC issuer must use https');
  const fetchFn = ((url: string, opts: oidc.CustomFetchOptions) => idpFetch(url, { method: opts.method, headers: opts.headers, body: opts.body, signal: opts.signal }, cfg.allowPrivateNetwork)) as oidc.CustomFetch;
  const c = await oidc.discovery(issuer, cfg.oidc.clientId, undefined, secret ? oidc.ClientSecretPost(secret) : oidc.None(), {
    [oidc.customFetch]: fetchFn,
    execute: issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [],
    timeout: 10,
  });
  // Verify the id_token signature against the IdP's JWKS even though it came over the back channel:
  // groups decide roles, so they must never be trusted unsigned.
  oidc.enableNonRepudiationChecks(c);
  oidcCache = { key, at: Date.now(), cfg: c };
  return c;
}

// ── Pages for the browser (callbacks cannot answer JSON) ─────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

function failPage(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).header('content-type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>:root{color-scheme:dark light}body{margin:0;font:14px/20px system-ui,sans-serif;background:#0F1419;color:#E6EAEE}
@media (prefers-color-scheme: light){body{background:#F7F8FA;color:#15191E}}main{max-width:420px;margin:14vh auto;padding:0 24px;display:flex;flex-direction:column;gap:12px}
h1{font-size:22px;margin:0}p{margin:0;opacity:.8}a{color:inherit}</style></head><body><main><h1>Single sign-on failed</h1><p>${esc(message)}</p><p><a href="/">Back to sign in</a></p></main></body></html>`);
}

class SsoDenied extends Error {
  constructor(message: string, public reason: string) { super(message); }
}

interface Identity { email: string; name: string; groups: string[]; mfa: boolean; subject: string }

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').map(String);
  return typeof v === 'string' ? [v] : [];
}

function mappedRole(cfg: SsoConfig, groups: string[]): WorkspaceRole | null {
  let best: WorkspaceRole | null = null;
  for (const m of cfg.groupMap) {
    if (groups.includes(m.group) && (!best || ROLE_RANK[m.role] > ROLE_RANK[best])) best = m.role;
  }
  return best;
}

/** Common end of both protocols: domain + membership checks, JIT, group → role, session. */
async function completeLogin(req: FastifyRequest, reply: FastifyReply, cfg: SsoConfig, idn: Identity): Promise<void> {
  const email = idn.email.trim().toLowerCase();
  const domain = email.split('@')[1] ?? '';
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new SsoDenied('The identity provider did not send an email address.', 'no email');
  if (!cfg.domains.includes(domain)) throw new SsoDenied(`${domain || 'That'} addresses cannot sign in to this workspace.`, 'domain');
  if (cfg.requireMfaClaim && !idn.mfa) throw new SsoDenied('Your identity provider did not report multi-factor authentication for this sign-in.', 'no mfa claim');
  const role = mappedRole(cfg, idn.groups);

  const user = await tx(async (c) => {
    const ex = (await c.query('select id, email, role, status, mfa_enabled from users where lower(email) = $1 for update', [email])).rows[0];
    if (ex) {
      if (ex.status === 'disabled') throw new SsoDenied('Your Comb account was removed. Ask an admin.', 'disabled');
      if (ex.role === 'Service') throw new SsoDenied('Service identities cannot sign in.', 'service');
      let next: WorkspaceRole = ex.role;
      // Sync only applies to mapped groups, and never demotes an Owner (Owners are managed in Comb).
      if (cfg.syncGroups && role && role !== ex.role && !(ex.role === 'Owner')) next = role;
      await c.query(`update users set role = $2, status = 'active', last_active_at = now(), auth = case when status = 'invited' then 'sso' else auth end where id = $1`, [ex.id, next]);
      if (ex.status === 'invited') await c.query('update team_invites set used_at = now() where user_id = $1 and used_at is null', [ex.id]);
      if (role) {
        // A mapped group lifts the "no access" fence placed on unmapped JIT users.
        const was = await c.query('delete from identity_sso_unmapped where user_id = $1 returning 1', [ex.id]);
        if (was.rows.length) await c.query(`delete from connection_access where user_id = $1 and level = 'none'`, [ex.id]);
      }
      return { id: ex.id as string, mfa: !!ex.mfa_enabled, created: false, from: ex.role as string, role: next, activated: ex.status === 'invited' };
    }
    if (!cfg.jit) throw new SsoDenied('You are not a member of this workspace yet. Ask an admin to invite you.', 'not a member');
    const name = idn.name.trim().slice(0, 100) || email.split('@')[0];
    const row = (await c.query(`insert into users (email, name, role, auth, status, last_active_at) values ($1, $2, $3, 'sso', 'active', now()) returning id`, [email, name, role ?? 'Viewer'])).rows[0];
    if (!role) {
      // Unmapped: no access at all, including connections created later (trigger in 150_identity.sql).
      await c.query('insert into identity_sso_unmapped (user_id) values ($1)', [row.id]);
      await c.query(`insert into connection_access (user_id, connection_id, level) select $1, id, 'none' from connections on conflict do nothing`, [row.id]);
    }
    return { id: row.id as string, mfa: false, created: true, from: null, role: (role ?? 'Viewer') as WorkspaceRole, activated: false };
  });

  await createSession(req, reply, user.id, { mfaPending: user.mfa });
  await audit({ actorId: user.id, actorLabel: email, kind: 'LOGIN', status: user.mfa ? 'pending' : 'ok', ip: req.ip, detail: {
    via: 'sso', provider: cfg.provider, jit: user.created, activated: user.activated, role: user.role, roleFrom: user.from, mapped: !!role,
    groups: idn.groups.filter((g) => cfg.groupMap.some((m) => m.group === g)).slice(0, 20),
  } });
  if (user.from && user.from !== user.role) {
    await audit({ actorId: user.id, actorLabel: 'sso', kind: 'ROLE', target: email, status: 'ok', ip: req.ip, detail: { action: 'sync', from: user.from, to: user.role } });
  }
}

async function denied(req: FastifyRequest, reply: FastifyReply, e: unknown, cfg: SsoConfig | null, who?: string) {
  const reason = e instanceof SsoDenied ? e.reason : 'invalid response';
  const message = e instanceof SsoDenied ? e.message : 'The response from the identity provider could not be verified.';
  if (!(e instanceof SsoDenied)) req.log.warn({ err: (e as Error)?.message }, 'sso validation failed');
  await audit({ actorLabel: (who ?? 'sso').slice(0, 254), kind: 'LOGIN', status: 'denied', ip: req.ip, detail: { via: 'sso', provider: cfg?.provider ?? null, reason,
    error: e instanceof SsoDenied ? undefined : String((e as Error)?.message ?? e).slice(0, 200) } });
  clearFlowCookie(reply);
  return failPage(reply, 403, message);
}

function samlIdentity(cfg: SsoConfig, p: Profile): Identity {
  const email = String(p.email ?? p.mail ?? p['urn:oid:0.9.2342.19200300.100.1.3'] ?? p['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']
    ?? (/emailAddress/.test(p.nameIDFormat ?? '') || /@/.test(p.nameID) ? p.nameID : ''));
  const name = String(p.displayName ?? p['http://schemas.microsoft.com/identity/claims/displayname'] ?? [p.firstName ?? p.givenName, p.lastName ?? p.sn].filter(Boolean).join(' ') ?? '');
  const groups = strings(p[cfg.groupsAttribute]);
  const xml = p.getAssertionXml?.() ?? '';
  const ctx = [...xml.matchAll(/<(?:\w+:)?AuthnContextClassRef>([^<]+)</g)].map((m) => m[1]);
  const amr = strings(p.amr ?? p['http://schemas.microsoft.com/claims/authnmethodsreferences']);
  const mfa = ctx.some((c) => /MultiFactor|mfa|TimeSyncToken|MobileTwoFactor/i.test(c)) || amr.some((a) => /mfa|multipleauthn|otp|hwk/i.test(a));
  return { email, name, groups, mfa, subject: p.nameID };
}

export default async function ssoModule(app: FastifyInstance): Promise<void> {
  // SAML HTTP-POST binding sends urlencoded bodies. Registered in this plugin's scope only.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 512 * 1024 }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const limited = { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.get('/sso/login', { config: limited }, async (req, reply) => {
    const cfg = await loadConfig();
    if (!cfg?.enabled) return reply.status(400).send({ error: 'Single sign-on is not configured for this workspace' });
    await q('delete from sso_flows where expires_at < now() - interval \'1 hour\'');
    const handle = randomToken(32);
    const expires = new Date(Date.now() + FLOW_MINUTES * 60_000);
    if (cfg.provider === 'saml') {
      if (!cfg.saml.entryPoint || !cfg.saml.cert) return reply.status(400).send({ error: 'SAML is missing the IdP sign-on URL or certificate' });
      const requestId = '_' + randomToken(24).replace(/[^A-Za-z0-9]/g, 'x');
      const url = await samlClient(cfg, flowCache(), requestId).getAuthorizeUrlAsync('', undefined, {});
      await q(`insert into sso_flows (id_hash, kind, request_id, expires_at) values ($1, 'saml', $2, $3)`, [sha256(handle), requestId, expires]);
      setFlowCookie(reply, handle);
      return reply.redirect(url, 302);
    }
    let client: oidc.Configuration;
    try {
      client = await oidcClient(cfg);
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'oidc discovery failed');
      return reply.status(502).send({ error: 'The identity provider could not be reached' });
    }
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: urls().oidcRedirectUrl,
      scope: cfg.oidc.scopes || 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    await q(`insert into sso_flows (id_hash, kind, state, nonce, code_verifier, expires_at) values ($1, 'oidc', $2, $3, $4, $5)`, [sha256(handle), state, nonce, verifier, expires]);
    setFlowCookie(reply, handle);
    return reply.redirect(url.href, 302);
  });

  // SAML ACS: cross-site POST from the IdP (no cookies). Validates and parks the identity under a one-time ticket.
  app.post('/sso/saml/acs', { config: { ...limited, crossOrigin: true } }, async (req, reply) => {
    const cfg = await loadConfig();
    if (!cfg?.enabled || cfg.provider !== 'saml') return failPage(reply, 400, 'SAML single sign-on is not configured for this workspace.');
    const body = parse(z.object({ SAMLResponse: z.string().min(1).max(400_000), RelayState: z.string().max(1024).optional() }), req.body);
    const cache = flowCache();
    let idn: Identity;
    try {
      const { profile } = await samlClient(cfg, cache).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse });
      if (!profile || !cache.accepted) throw new Error('no profile or no matching request');
      idn = samlIdentity(cfg, profile);
    } catch (e) {
      return denied(req, reply, e, cfg);
    }
    const ticket = randomToken(32);
    const parked = await one(
      `update sso_flows set ticket_hash = $2, result = $3 where request_id = $1 and kind = 'saml' and ticket_hash is null and done_at is null and expires_at > now() returning 1`,
      [cache.accepted, sha256(ticket), JSON.stringify(idn)],
    );
    if (!parked) return denied(req, reply, new Error('flow expired or already used'), cfg, idn.email);
    return reply.redirect('/api/sso/saml/finish?t=' + encodeURIComponent(ticket), 303);
  });

  // Same-site top-level GET: now the Lax flow cookie is present and must match the parked ticket.
  app.get('/sso/saml/finish', { config: limited }, async (req, reply) => {
    const cfg = await loadConfig();
    const { t } = parse(z.object({ t: z.string().min(20).max(100) }), req.query);
    const handle = req.cookies?.[FLOW_COOKIE];
    if (!cfg?.enabled || cfg.provider !== 'saml') return failPage(reply, 400, 'SAML single sign-on is not configured for this workspace.');
    if (!handle) return denied(req, reply, new SsoDenied('This sign-in was not started from this browser. Start again from the sign-in page.', 'no flow cookie'), cfg);
    const flow = await one(
      `update sso_flows set done_at = now() where id_hash = $1 and kind = 'saml' and done_at is null and ticket_hash is not null and expires_at > now() returning ticket_hash, result`,
      [sha256(handle)],
    );
    if (!flow || !safeEqual(flow.ticket_hash.toString('hex'), sha256(t).toString('hex'))) {
      return denied(req, reply, new SsoDenied('This sign-in does not belong to this browser, or it expired. Start again from the sign-in page.', 'flow mismatch'), cfg);
    }
    clearFlowCookie(reply);
    try {
      await completeLogin(req, reply, cfg, flow.result as Identity);
    } catch (e) {
      return denied(req, reply, e, cfg, (flow.result as Identity)?.email);
    }
    return reply.redirect('/', 303);
  });

  app.get('/sso/oidc/callback', { config: limited }, async (req, reply) => {
    const cfg = await loadConfig();
    if (!cfg?.enabled || cfg.provider !== 'oidc') return failPage(reply, 400, 'OIDC single sign-on is not configured for this workspace.');
    const handle = req.cookies?.[FLOW_COOKIE];
    if (!handle) return denied(req, reply, new SsoDenied('This sign-in was not started from this browser. Start again from the sign-in page.', 'no flow cookie'), cfg);
    const flow = await one(
      `update sso_flows set done_at = now() where id_hash = $1 and kind = 'oidc' and done_at is null and expires_at > now() returning state, nonce, code_verifier`,
      [sha256(handle)],
    );
    clearFlowCookie(reply);
    if (!flow) return denied(req, reply, new SsoDenied('This sign-in expired or was already used. Start again from the sign-in page.', 'flow'), cfg);
    let idn: Identity;
    try {
      const client = await oidcClient(cfg);
      const current = new URL(urls().oidcRedirectUrl);
      current.search = new URL(req.url, 'http://x').search;
      const tokens = await oidc.authorizationCodeGrant(client, current, {
        pkceCodeVerifier: flow.code_verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('no id_token');
      if (claims.email_verified === false) throw new SsoDenied('Your identity provider has not verified that email address.', 'email not verified');
      const name = typeof claims.name === 'string' ? claims.name : [claims.given_name, claims.family_name].filter((x) => typeof x === 'string').join(' ');
      idn = {
        email: typeof claims.email === 'string' ? claims.email : '',
        name,
        groups: strings(claims[cfg.groupsAttribute]),
        mfa: strings(claims.amr).some((a) => /mfa|otp|hwk|swk|sms|fpt|face/i.test(a)),
        subject: String(claims.sub),
      };
    } catch (e) {
      return denied(req, reply, e, cfg);
    }
    try {
      await completeLogin(req, reply, cfg, idn);
    } catch (e) {
      return denied(req, reply, e, cfg, idn.email);
    }
    return reply.redirect('/', 303);
  });

  // SP metadata for the IdP admin (entity ID = this URL, ACS URL, NameID format).
  app.get('/sso/saml/metadata', { config: limited }, async (_req, reply) => {
    const cfg = await loadConfig();
    if (!cfg || cfg.provider !== 'saml' || !cfg.saml.cert) return reply.status(404).send({ error: 'SAML is not configured' });
    const xml = samlClient(cfg, flowCache()).generateServiceProviderMetadata(null);
    return reply.header('content-type', 'application/samlmetadata+xml; charset=utf-8').send(xml);
  });
}
