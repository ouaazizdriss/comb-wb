import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COMB_EVENTS, DATADOG_SITES, INTEGRATION_KINDS, INTEGRATION_META,
  type CombEventName, type DeliveryInfo, type IntegrationKind, type IntegrationSummary, type IntegrationsOverview,
} from '@comb/shared/src/platform.ts';
import { config } from '../config.ts';
import { q, one } from '../db/meta.ts';
import { parse, badRequest, notFound, HttpError } from '../core/http.ts';
import { getSetting, setSetting } from '../core/settings.ts';
import { onEvent, emit, type CombEvent } from '../core/events.ts';
import { registerSender, type DeliveryMessage } from '../core/delivery.ts';
import { enqueue, registerWorker } from '../core/jobs.ts';
import { encryptSecret, decryptSecret, hmacSha256 } from '../security/crypto.ts';
import { audit } from '../security/audit.ts';
import { requireRole, userOf, hasRole } from '../security/authz.ts';
import { safeFetch, setAllowlistProvider, SsrfError, type SafeFetchInit } from '../platform/ssrf.ts';
import { sendMail } from '../platform/smtp.ts';

/*
 * Integrations: Comb pushes events out (Slack, signed webhooks, Teams, PagerDuty, SMTP, Datadog).
 * Nothing reaches in: there are no inbound webhooks. Every outbound call goes through safeFetch.
 * Payloads carry ids and counts only: values must be string/number/boolean/null, strings ≤ 200 chars.
 */

export { safeFetch, SsrfError };
export type { SafeFetchInit };

export const ALLOWLIST_KEY = 'integrations.allow_private_hosts';
setAllowlistProvider(async () => {
  const v = await getSetting<unknown>(ALLOWLIST_KEY, []);
  return Array.isArray(v) ? v.map(String) : [];
});

const QUEUE = 'integration.deliver';
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_S = 2;
const MAX_STRING = 200;
const MAX_KEYS = 40;

// ── Payload sanitisation ─────────────────────────────────────────

export type SafePayload = Record<string, string | number | boolean | null>;

export class PayloadError extends Error {}

/**
 * Enforces "ids and counts, never row values": flat object, primitive values only,
 * strings capped at 200 characters. Objects, arrays, functions and bigints are rejected.
 */
export function sanitizePayload(raw: unknown): SafePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PayloadError('payload must be a flat object');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_KEYS) throw new PayloadError(`payload has more than ${MAX_KEYS} keys`);
  const out: SafePayload = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) throw new PayloadError(`payload key "${k.slice(0, 64)}" is not allowed`);
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new PayloadError(`payload key "${k}" is not a finite number`);
      out[k] = v;
    } else if (typeof v === 'string') out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING - 1) + '…' : v;
    else throw new PayloadError(`payload key "${k}" holds ${Array.isArray(v) ? 'an array' : (typeof v === 'object' ? 'an object' : 'a ' + typeof v)}; only strings, numbers and booleans are delivered`);
  }
  return out;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── Stored integrations ──────────────────────────────────────────

interface IntegRow {
  id: string;
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  config: Record<string, any>;
  secret_enc: Buffer | null;
  secret_last4: string | null;
}

interface Secrets {
  url?: string;
  signingSecret?: string;
  routingKey?: string;
  apiKey?: string;
  password?: string;
}

const aad = (id: string) => `integration:${id}`;

function readSecrets(r: IntegRow): Secrets {
  const s = decryptSecret(r.secret_enc, aad(r.id));
  return s ? (JSON.parse(s) as Secrets) : {};
}

function mainSecret(kind: IntegrationKind, s: Secrets): string | undefined {
  return kind === 'pagerduty' ? s.routingKey : kind === 'datadog' ? s.apiKey : kind === 'email' ? s.password : s.url;
}

function maskedTarget(r: IntegRow): string {
  const l4 = r.secret_last4 ? '••••' + r.secret_last4 : 'not set';
  const c = r.config ?? {};
  switch (r.kind) {
    case 'slack':
    case 'teams':
    case 'webhook':
      return c.host ? `${c.scheme ?? 'https'}://${c.host}/…${r.secret_last4 ?? ''}` : 'no URL set';
    case 'pagerduty':
      return `routing key ${l4}`;
    case 'datadog':
      return `${c.site ?? 'datadoghq.com'} · key ${l4}`;
    case 'email': {
      const to: string[] = Array.isArray(c.to) ? c.to : [];
      return `${c.host ?? '?'}:${c.port ?? '?'} → ${to[0] ?? '?'}${to.length > 1 ? ` +${to.length - 1}` : ''}`;
    }
  }
}

// ── Input validation ─────────────────────────────────────────────

const httpsUrl = z.string().trim().max(2048).url().refine((u) => u.startsWith('https://'), 'must be an https:// URL');
const anyUrl = z.string().trim().max(2048).url().refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');
const name = z.string().trim().min(1).max(60);
const email = z.string().trim().max(254).regex(/^[^\s<>@,;"]+@[^\s<>@,;"]+$/, 'must be an email address');
const hostName = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$|^\[?[0-9a-fA-F:.]+\]?$/, 'must be a host name or IP');

const emailConfig = z.object({
  host: hostName,
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['starttls', 'tls', 'none']),
  user: z.string().trim().max(254).optional().default(''),
  from: email,
  to: z.array(email).min(1).max(20),
});

const createBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), name, url: httpsUrl }),
  z.object({ kind: z.literal('teams'), name, url: httpsUrl }),
  z.object({ kind: z.literal('webhook'), name, url: anyUrl, signingSecret: z.string().min(16).max(256) }),
  z.object({ kind: z.literal('pagerduty'), name, routingKey: z.string().trim().regex(/^[A-Za-z0-9]{20,64}$/, 'must be a 32-character routing key') }),
  z.object({ kind: z.literal('datadog'), name, apiKey: z.string().trim().regex(/^[A-Za-z0-9]{20,64}$/, 'must be a Datadog API key'), site: z.enum(DATADOG_SITES) }),
  z.object({ kind: z.literal('email'), name, smtp: emailConfig, password: z.string().max(1024).optional() }),
]);

const patchBody = z.object({
  name: name.optional(),
  enabled: z.boolean().optional(),
  url: anyUrl.optional(),
  signingSecret: z.string().min(16).max(256).optional(),
  routingKey: z.string().trim().regex(/^[A-Za-z0-9]{20,64}$/).optional(),
  apiKey: z.string().trim().regex(/^[A-Za-z0-9]{20,64}$/).optional(),
  site: z.enum(DATADOG_SITES).optional(),
  smtp: emailConfig.optional(),
  password: z.string().max(1024).optional(),
});

function urlConfig(url: string): Record<string, string> {
  const u = new URL(url);
  return { host: u.host, scheme: u.protocol.replace(':', '') };
}

// ── Sending ──────────────────────────────────────────────────────

export const EVENT_TITLES: Record<string, string> = {
  'job.failed': 'Scheduled job failed',
  'job.succeeded': 'Scheduled job succeeded',
  'query.blocked': 'A query was blocked by policy',
  'approval.requested': 'Approval requested',
  'approval.decided': 'Approval decided',
  'migration.applied': 'Migration applied',
  'monitor.critical': 'Critical monitor alert',
  'backup.completed': 'Backup completed',
  'dq.failed': 'Data quality test failed',
  'security.alert': 'Security alert',
  'integration.test': 'Test event from Comb',
};

type Envelope =
  | { type: 'event'; id: string; event: string; at: string; payload: SafePayload }
  | { type: 'message'; id: string; at: string; msg: DeliveryMessage };

class SendError extends Error {
  constructor(message: string, public statusCode: number | null, public retryable: boolean) {
    super(message);
  }
}

function lines(p: SafePayload): string[] {
  return Object.entries(p).map(([k, v]) => `${k}: ${v === null ? '—' : String(v)}`);
}

function severity(event: string): 'critical' | 'error' | 'warning' | 'info' {
  if (event === 'monitor.critical' || event === 'security.alert') return 'critical';
  if (event === 'job.failed' || event === 'dq.failed') return 'error';
  if (event === 'query.blocked' || event === 'approval.requested') return 'warning';
  return 'info';
}

/** Everything that leaves Comb, per kind. Row data (attachments) only goes to webhook and email. */
function render(env: Envelope): { title: string; text: string; fields: SafePayload; event: string; attachment?: DeliveryMessage['attachment'] } {
  if (env.type === 'event') {
    return { title: EVENT_TITLES[env.event] ?? env.event, text: '', fields: env.payload, event: env.event };
  }
  return {
    title: cap(env.msg.title, 200),
    text: cap(env.msg.text, 4000),
    fields: env.msg.fields ? sanitizePayload(env.msg.fields) : {},
    event: 'delivery.message',
    attachment: env.msg.attachment,
  };
}

async function httpSend(url: string, body: string, headers: Record<string, string>): Promise<{ statusCode: number }> {
  let res: Response;
  try {
    res = await safeFetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'user-agent': `Comb/${config.COMB_VERSION}`, ...headers }, redirect: 'manual', timeoutMs: 8000 });
  } catch (e) {
    if (e instanceof SsrfError) throw e;
    throw new SendError((e as Error).message, null, true);
  }
  if (res.status >= 200 && res.status < 300) return { statusCode: res.status };
  const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
  throw new SendError(`HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}`, res.status, retryable);
}

async function send(r: IntegRow, env: Envelope): Promise<{ statusCode: number | null }> {
  const s = readSecrets(r);
  const m = render(env);
  const withheld = m.attachment ? `\n(${m.attachment.filename} withheld: attachments go to email and webhook integrations only.)` : '';
  switch (r.kind) {
    case 'slack': {
      if (!s.url) throw new SendError('No webhook URL is set', null, false);
      const text = [`*Comb · ${m.title}*`, m.text, ...lines(m.fields).map((l) => '• ' + l)].filter(Boolean).join('\n') + withheld;
      return httpSend(s.url, JSON.stringify({ text }), {});
    }
    case 'teams': {
      if (!s.url) throw new SendError('No webhook URL is set', null, false);
      const text = [m.text, ...lines(m.fields)].filter(Boolean).join('\n\n') + withheld;
      return httpSend(s.url, JSON.stringify({ '@type': 'MessageCard', '@context': 'http://schema.org/extensions', summary: m.title, title: `Comb · ${m.title}`, text: text || m.title }), {});
    }
    case 'webhook': {
      if (!s.url || !s.signingSecret) throw new SendError('URL or signing secret missing', null, false);
      const body = JSON.stringify(env.type === 'event'
        ? { id: env.id, type: 'event', event: env.event, at: env.at, payload: env.payload }
        : { id: env.id, type: 'message', at: env.at, title: m.title, text: m.text, fields: m.fields, attachment: m.attachment ?? null });
      const ts = String(Math.floor(Date.now() / 1000));
      return httpSend(s.url, body, {
        'x-comb-timestamp': ts,
        'x-comb-signature': 'sha256=' + hmacSha256(s.signingSecret, `${ts}.${body}`),
        'x-comb-event': m.event,
        'x-comb-delivery': env.id,
      });
    }
    case 'pagerduty': {
      if (!s.routingKey) throw new SendError('No routing key is set', null, false);
      const body = JSON.stringify({
        routing_key: s.routingKey,
        event_action: 'trigger',
        payload: { summary: cap(`Comb: ${m.title}`, 1000), source: 'comb', severity: severity(m.event), component: m.event, custom_details: m.fields },
      });
      return httpSend('https://events.pagerduty.com/v2/enqueue', body, {});
    }
    case 'datadog': {
      if (!s.apiKey) throw new SendError('No API key is set', null, false);
      const site = DATADOG_SITES.includes(r.config.site) ? r.config.site : 'datadoghq.com';
      const body = JSON.stringify([{ ddsource: 'comb', service: 'comb', status: severity(m.event), message: m.title, comb: { event: m.event, ...m.fields } }]);
      return httpSend(`https://http-intake.logs.${site}/api/v2/logs`, body, { 'dd-api-key': s.apiKey });
    }
    case 'email': {
      const c = r.config;
      const text = [m.text, ...lines(m.fields), '', `Sent by Comb ${config.COMB_VERSION}. Payloads carry ids and counts only.`].filter((x, i) => x || i > 0).join('\n');
      try {
        await sendMail({ host: c.host, port: c.port, tls: c.tls, user: c.user || undefined, password: s.password ?? null, from: c.from, to: c.to },
          { subject: `[Comb] ${m.title}`, text, attachment: m.attachment });
      } catch (e) {
        if (e instanceof SsrfError) throw e;
        throw new SendError((e as Error).message, null, true);
      }
      return { statusCode: null };
    }
  }
}

async function recordDelivery(d: { integrationId: string; event: string; attempt: number; status: DeliveryInfo['status']; statusCode?: number | null; ms?: number | null; error?: string | null; test?: boolean }): Promise<void> {
  await q(
    `insert into integration_deliveries (integration_id, event, attempt, status, status_code, ms, error, test) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [d.integrationId, d.event, d.attempt, d.status, d.statusCode ?? null, d.ms ?? null, d.error ? cap(d.error, 300) : null, !!d.test],
  ).catch((e) => console.error('integrations: could not record delivery', (e as Error).message));
}

interface DeliverJob {
  integrationId: string;
  id: string;
  event: string;
  at: string;
  payload: SafePayload;
  attempt: number;
}

async function queueDelivery(job: DeliverJob, delayS = 0): Promise<void> {
  try {
    await enqueue(QUEUE, job, { startAfterSeconds: delayS || undefined });
  } catch {
    // Job system not running (tests, early boot): deliver in-process instead of dropping it.
    setTimeout(() => void runDelivery(job), delayS * 1000);
  }
}

async function runDelivery(job: DeliverJob): Promise<void> {
  const r = await one<IntegRow>('select * from integrations where id = $1', [job.integrationId]);
  if (!r || !r.enabled) return;
  const t0 = Date.now();
  try {
    const out = await send(r, { type: 'event', id: job.id, event: job.event, at: job.at, payload: sanitizePayload(job.payload) });
    await recordDelivery({ integrationId: r.id, event: job.event, attempt: job.attempt, status: 'ok', statusCode: out.statusCode, ms: Date.now() - t0 });
  } catch (e) {
    const ms = Date.now() - t0;
    if (e instanceof SsrfError || e instanceof PayloadError) {
      await recordDelivery({ integrationId: r.id, event: job.event, attempt: job.attempt, status: 'refused', ms, error: (e as Error).message });
      return;
    }
    const se = e instanceof SendError ? e : new SendError((e as Error).message, null, true);
    if (se.retryable && job.attempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_BASE_S * 2 ** (job.attempt - 1);
      await recordDelivery({ integrationId: r.id, event: job.event, attempt: job.attempt, status: 'retrying', statusCode: se.statusCode, ms, error: `${se.message}; retry in ${delay}s` });
      await queueDelivery({ ...job, attempt: job.attempt + 1 }, delay);
    } else {
      await recordDelivery({ integrationId: r.id, event: job.event, attempt: job.attempt, status: 'failed', statusCode: se.statusCode, ms, error: se.message });
    }
  }
}

registerWorker<DeliverJob>(QUEUE, async (job) => {
  try {
    await runDelivery(job);
  } catch (e) {
    // Never throw: pg-boss would retry on its own and we already manage retries.
    console.error('integrations: delivery crashed', (e as Error).message);
  }
});

registerWorker('integration.prune', async () => {
  await q(`delete from integration_deliveries where created_at < now() - interval '30 days'`);
}, '17 3 * * *');

// Event bus → subscribed, enabled integrations.
onEvent(async (event, payload) => {
  const subs = await q<{ id: string }>(
    `select i.id from integrations i join integration_subscriptions s on s.integration_id = i.id where s.event = $1 and i.enabled`, [event]);
  if (!subs.length) return;
  let clean: SafePayload;
  try {
    clean = sanitizePayload(payload);
  } catch (e) {
    console.warn(`integrations: ${event} not delivered: ${(e as Error).message}`);
    for (const s of subs) await recordDelivery({ integrationId: s.id, event, attempt: 1, status: 'refused', error: 'payload rejected: ' + (e as Error).message });
    return;
  }
  const at = new Date().toISOString();
  for (const s of subs) await queueDelivery({ integrationId: s.id, id: crypto.randomUUID(), event, at, payload: clean, attempt: 1 });
});

// Scheduled jobs → one integration, delivered now (the caller handles its own retries).
registerSender(async (integrationId, msg) => {
  if (!/^[0-9a-f-]{36}$/i.test(integrationId)) throw new Error('Unknown integration');
  const r = await one<IntegRow>('select * from integrations where id = $1', [integrationId]);
  if (!r) throw new Error('Unknown integration');
  if (!r.enabled) throw new Error(`Integration ${r.name} is off`);
  const t0 = Date.now();
  try {
    const out = await send(r, { type: 'message', id: crypto.randomUUID(), at: new Date().toISOString(), msg });
    await recordDelivery({ integrationId: r.id, event: 'delivery.message', attempt: 1, status: 'ok', statusCode: out.statusCode, ms: Date.now() - t0 });
  } catch (e) {
    const se = e as SendError;
    await recordDelivery({ integrationId: r.id, event: 'delivery.message', attempt: 1, status: e instanceof SsrfError ? 'refused' : 'failed', statusCode: se.statusCode ?? null, ms: Date.now() - t0, error: se.message });
    throw new Error(`Delivery to ${r.name} failed: ${se.message}`);
  }
});

// ── Routes ───────────────────────────────────────────────────────

const idParam = z.object({ id: z.string().uuid() });

async function summaries(): Promise<IntegrationSummary[]> {
  const rows = await q<IntegRow & { last: any; ok24: number; bad24: number }>(`
    select i.*, (
      select row_to_json(d) from (
        select created_at as at, status, status_code as "statusCode", ms, error, event, test, attempt
        from integration_deliveries where integration_id = i.id order by id desc limit 1) d
    ) as last,
    (select count(*)::int from integration_deliveries where integration_id = i.id and status = 'ok' and created_at > now() - interval '24 hours') as ok24,
    (select count(*)::int from integration_deliveries where integration_id = i.id and status in ('failed','refused') and created_at > now() - interval '24 hours') as bad24
    from integrations i order by i.created_at`);
  return rows.map((r) => {
    const last = r.last as DeliveryInfo | null;
    const state: IntegrationSummary['state'] = !r.enabled ? 'off' : !last ? 'new' : last.status === 'ok' ? 'ok' : 'failing';
    const c = r.config ?? {};
    const pub: IntegrationSummary['config'] = {};
    for (const k of ['host', 'scheme', 'site', 'port', 'tls', 'user', 'from', 'to']) if (c[k] !== undefined) pub[k] = c[k];
    return {
      id: r.id, kind: r.kind, name: r.name, enabled: r.enabled, target: maskedTarget(r), config: pub,
      hasSecret: !!r.secret_enc, last4: r.secret_last4, hasSigningSecret: r.kind === 'webhook' ? !!r.secret_enc : undefined,
      state, lastDelivery: last, delivered24h: r.ok24, failed24h: r.bad24,
    };
  });
}

function storedFor(kind: IntegrationKind, b: any): { config: Record<string, unknown>; secrets: Secrets } {
  switch (kind) {
    case 'slack':
    case 'teams':
      return { config: urlConfig(b.url), secrets: { url: b.url } };
    case 'webhook':
      return { config: urlConfig(b.url), secrets: { url: b.url, signingSecret: b.signingSecret } };
    case 'pagerduty':
      return { config: {}, secrets: { routingKey: b.routingKey } };
    case 'datadog':
      return { config: { site: b.site }, secrets: { apiKey: b.apiKey } };
    case 'email':
      return { config: { ...b.smtp }, secrets: b.password ? { password: b.password } : {} };
  }
}

async function saveSecrets(id: string, kind: IntegrationKind, s: Secrets): Promise<void> {
  const main = mainSecret(kind, s);
  const has = Object.values(s).some(Boolean);
  await q('update integrations set secret_enc = $2, secret_last4 = $3, updated_at = now() where id = $1',
    [id, has ? encryptSecret(JSON.stringify(s), aad(id)) : null, main ? main.slice(-4) : null]);
}

export default async function integrationsModule(app: FastifyInstance): Promise<void> {
  app.get('/integrations', async (req): Promise<IntegrationsOverview> => {
    const user = userOf(req);
    const canEdit = hasRole(user, 'Admin');
    const subs = await q<{ integration_id: string; event: CombEventName }>('select integration_id, event from integration_subscriptions');
    const subscriptions: Record<string, CombEventName[]> = {};
    for (const s of subs) (subscriptions[s.integration_id] ??= []).push(s.event);
    const allow = await getSetting<string[]>(ALLOWLIST_KEY, []);
    return { integrations: await summaries(), events: [...COMB_EVENTS], subscriptions, allowPrivateHosts: canEdit ? allow : [], canEdit, emailAvailable: true };
  });

  app.post('/integrations', async (req) => {
    const user = requireRole(req, 'Admin');
    const body = parse(createBody, req.body);
    const { config: cfg, secrets } = storedFor(body.kind, body);
    const row = await one<{ id: string }>(
      'insert into integrations (kind, name, config, created_by) values ($1,$2,$3,$4) returning id', [body.kind, body.name, cfg, user.id],
    ).catch((e) => {
      if (e.code === '23505') throw badRequest('An integration with that name already exists');
      throw e;
    });
    await saveSecrets(row!.id, body.kind, secrets);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'INTEGRATION', target: body.name, status: 'ok', ip: req.ip, detail: { action: 'create', kind: body.kind } });
    return (await summaries()).find((s) => s.id === row!.id);
  });

  app.patch('/integrations/:id', async (req) => {
    const user = requireRole(req, 'Admin');
    const { id } = parse(idParam, req.params);
    const body = parse(patchBody, req.body);
    const cur = await one<IntegRow>('select * from integrations where id = $1', [id]);
    if (!cur) throw notFound('Integration not found');
    const secrets = readSecrets(cur);
    const cfg = { ...cur.config };
    const changed: string[] = [];
    if (body.url !== undefined) {
      if (!['slack', 'teams', 'webhook'].includes(cur.kind)) throw badRequest('This integration has no URL');
      if (cur.kind !== 'webhook' && !body.url.startsWith('https://')) throw badRequest('url must be an https:// URL');
      secrets.url = body.url;
      Object.assign(cfg, urlConfig(body.url));
      changed.push('url');
    }
    if (body.signingSecret !== undefined) {
      if (cur.kind !== 'webhook') throw badRequest('Only webhooks are signed');
      secrets.signingSecret = body.signingSecret;
      changed.push('signingSecret');
    }
    if (body.routingKey !== undefined) {
      if (cur.kind !== 'pagerduty') throw badRequest('Only PagerDuty has a routing key');
      secrets.routingKey = body.routingKey;
      changed.push('routingKey');
    }
    if (body.apiKey !== undefined || body.site !== undefined) {
      if (cur.kind !== 'datadog') throw badRequest('Only Datadog has an API key and site');
      if (body.apiKey) secrets.apiKey = body.apiKey;
      if (body.site) cfg.site = body.site;
      changed.push('datadog');
    }
    if (body.smtp !== undefined || body.password !== undefined) {
      if (cur.kind !== 'email') throw badRequest('Only email has SMTP settings');
      if (body.smtp) {
        const moved = body.smtp.host !== cfg.host || body.smtp.port !== cfg.port || body.smtp.user !== cfg.user;
        // Never send a stored password to a different server.
        if (moved && body.password === undefined && secrets.password) throw badRequest('Re-enter the SMTP password when changing host, port or user');
        Object.assign(cfg, body.smtp);
        changed.push('smtp');
      }
      if (body.password !== undefined) {
        if (body.password) secrets.password = body.password;
        else delete secrets.password;
        changed.push('password');
      }
    }
    if (body.name !== undefined) changed.push('name');
    if (body.enabled !== undefined) changed.push('enabled');
    await q('update integrations set name = $2, enabled = $3, config = $4, updated_at = now() where id = $1',
      [id, body.name ?? cur.name, body.enabled ?? cur.enabled, cfg]).catch((e) => {
      if (e.code === '23505') throw badRequest('An integration with that name already exists');
      throw e;
    });
    if (changed.some((c) => c !== 'name' && c !== 'enabled')) await saveSecrets(id, cur.kind, secrets);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'INTEGRATION', target: body.name ?? cur.name, status: 'ok', ip: req.ip,
      detail: { action: body.enabled === false ? 'disable' : body.enabled === true ? 'enable' : 'update', kind: cur.kind, fields: changed } });
    return (await summaries()).find((s) => s.id === id);
  });

  app.delete('/integrations/:id', async (req) => {
    const user = requireRole(req, 'Admin');
    const { id } = parse(idParam, req.params);
    const { confirm } = parse(z.object({ confirm: z.string().max(100).optional() }), req.body ?? {});
    const cur = await one<IntegRow>('select * from integrations where id = $1', [id]);
    if (!cur) throw notFound('Integration not found');
    if (confirm !== cur.name) throw new HttpError(409, `Type ${cur.name} to confirm`, { code: 'COMB_CONFIRM', confirm: { word: cur.name, kind: 'REMOVE', target: cur.name } });
    await q('delete from integrations where id = $1', [id]);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'INTEGRATION', target: cur.name, status: 'ok', ip: req.ip, detail: { action: 'delete', kind: cur.kind } });
    return { ok: true };
  });

  app.post('/integrations/:id/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireRole(req, 'Admin');
    const { id } = parse(idParam, req.params);
    const r = await one<IntegRow>('select * from integrations where id = $1', [id]);
    if (!r) throw notFound('Integration not found');
    if (!r.enabled) return { ok: false, statusCode: null, ms: null, error: 'Integration is off — nothing was sent.' };
    const t0 = Date.now();
    const payload: SafePayload = { integration: r.name, kind: r.kind, by: user.email, test: true };
    let result: { ok: boolean; statusCode: number | null; ms: number; error: string | null };
    let refusedBySsrf = false;
    try {
      const out = await send(r, { type: 'event', id: crypto.randomUUID(), event: 'integration.test', at: new Date().toISOString(), payload });
      result = { ok: true, statusCode: out.statusCode, ms: Date.now() - t0, error: null };
    } catch (e) {
      refusedBySsrf = e instanceof SsrfError;
      result = { ok: false, statusCode: (e as SendError).statusCode ?? null, ms: Date.now() - t0, error: (e as Error).message };
    }
    const status = result.ok ? 'ok' : refusedBySsrf ? 'refused' : 'failed';
    await recordDelivery({ integrationId: r.id, event: 'integration.test', attempt: 1, status, statusCode: result.statusCode, ms: result.ms, error: result.error, test: true });
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'INTEGRATION', target: r.name, status: result.ok ? 'ok' : 'error', ip: req.ip, detail: { action: 'test', kind: r.kind, statusCode: result.statusCode } });
    return result;
  });

  app.get('/integrations/:id/deliveries', async (req) => {
    requireRole(req, 'Admin');
    const { id } = parse(idParam, req.params);
    return q(`select id::text, created_at as at, event, attempt, status, status_code as "statusCode", ms, error, test
              from integration_deliveries where integration_id = $1 order by id desc limit 50`, [id]);
  });

  app.put('/integrations/subscriptions', async (req) => {
    const user = requireRole(req, 'Admin');
    const body = parse(z.object({ integrationId: z.string().uuid(), event: z.enum(COMB_EVENTS), on: z.boolean() }), req.body);
    const r = await one<IntegRow>('select id, name, kind from integrations where id = $1', [body.integrationId]);
    if (!r) throw notFound('Integration not found');
    if (body.on) await q('insert into integration_subscriptions (integration_id, event) values ($1,$2) on conflict do nothing', [r.id, body.event]);
    else await q('delete from integration_subscriptions where integration_id = $1 and event = $2', [r.id, body.event]);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'INTEGRATION', target: r.name, status: 'ok', ip: req.ip, detail: { action: body.on ? 'subscribe' : 'unsubscribe', event: body.event } });
    return { ok: true };
  });

  app.get('/integrations/allowlist', async (req) => {
    requireRole(req, 'Admin');
    return { hosts: await getSetting<string[]>(ALLOWLIST_KEY, []) };
  });

  app.put('/integrations/allowlist', async (req) => {
    const user = requireRole(req, 'Admin');
    const body = parse(z.object({ hosts: z.array(hostName).max(50) }), req.body);
    const hosts = [...new Set(body.hosts.map((h) => h.toLowerCase().replace(/^\[|\]$/g, '')))];
    await setSetting(ALLOWLIST_KEY, hosts, user.id);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'SETTINGS', target: ALLOWLIST_KEY, status: 'ok', ip: req.ip, detail: { action: 'allowlist', hosts } });
    return { hosts };
  });

  // Dev/test only: emits an event on the bus so the delivery path can be exercised end to end.
  if (!config.isProd) {
    app.post('/integrations/dev/emit', async (req) => {
      requireRole(req, 'Admin');
      const body = parse(z.object({ event: z.enum(COMB_EVENTS), payload: z.record(z.string(), z.unknown()) }), req.body);
      emit(body.event as CombEvent, body.payload as Record<string, string | number | boolean | null>);
      return { ok: true };
    });
  }
}

export { INTEGRATION_KINDS, INTEGRATION_META };
