import type { FastifyInstance } from 'fastify';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import type { FailoverEvent, PatroniMember, ReplicaInfo, SlotInfo, TopologyResponse } from '@comb/shared/src/ops.ts';
import { q, one } from '../db/meta.ts';
import { parse, HttpError, badRequest } from '../core/http.ts';
import { requireConn, requireRole, type ConnRow } from '../security/authz.ts';
import { withTarget } from '../targets/pool.ts';
import { audit } from '../security/audit.ts';
import { encryptSecret, decryptSecret } from '../security/crypto.ts';
import { safeFetch, blockedReason, isPrivateOnly } from '../platform/ssrf.ts';

/*
 * Cluster topology. Role, replicas, slots and upstream come from the server's own views.
 * Patroni is optional: when an Admin sets a per-connection REST URL, Comb reads /cluster and
 * /history through the integrations module's SSRF guard (safeFetch). While that export does not
 * exist, a local guard does the same job: http(s) only, no credentials in the URL, DNS resolved
 * once and the connection pinned to the checked address, private / loopback / link-local
 * addresses refused unless the host is allowlisted on this connection, metadata addresses always.
 */

const MARK = '/* comb-topology */ ';
const connParam = z.object({ connId: z.string().uuid() });
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const SLOT_WARN_BYTES = 1024 ** 3;

// ── SSRF guard ──────────────────────────────────────────────────

/** Why an address may not be contacted, or null when it is public. Delegates to the shared SSRF guard. */
export function addressBlocked(ip: string): string | null {
  const why = blockedReason(ip);
  return why;
}

export class SsrfError extends Error {}

/** Validates a URL and resolves it to one address that may be contacted. */
export async function checkOutbound(raw: string, allowHosts: string[]): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new SsrfError('Put credentials in the credentials field, not in the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = allowHosts.map((h) => h.toLowerCase()).includes(host);
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true }).catch(() => {
    throw new SsrfError(`Cannot resolve ${host}`);
  });
  if (!addrs.length) throw new SsrfError(`Cannot resolve ${host}`);
  for (const a of addrs) {
    const why = addressBlocked(a.address);
    // The connection's allowlist only lifts private-network addresses; metadata and reserved ranges never pass.
    if (why && !(allowed && isPrivateOnly(a.address))) {
      throw new SsrfError(`${host} resolves to ${a.address} (${why}). ${isPrivateOnly(a.address) ? 'Add the host to this connection\'s allowlist to permit it.' : 'This kind of address is never allowed.'}`);
    }
  }
  return { url, address: addrs[0].address, family: addrs[0].family };
}

interface FetchResult { status: number; body: string }

/** Every Patroni call: this module's check (which knows the connection's allowlist), then the shared safeFetch. */
async function outbound(raw: string, init: { method?: string; body?: string; headers?: Record<string, string> }, allowHosts: string[]): Promise<FetchResult> {
  await checkOutbound(raw, allowHosts);
  const res = await safeFetch(raw, {
    method: init.method ?? 'GET', body: init.body,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    redirect: 'manual', allowHosts, timeoutMs: 5_000,
  });
  return { status: res.status, body: await res.text() };
}

// ── Settings ────────────────────────────────────────────────────

interface OpsSettings { patroni_url: string | null; patroni_auth_enc: Buffer | null; allow_hosts: string[]; region: string | null }

async function settingsOf(connId: string): Promise<OpsSettings> {
  return (await one<OpsSettings>('select patroni_url, patroni_auth_enc, allow_hosts, region from ops_conn_settings where connection_id = $1', [connId]))
    ?? { patroni_url: null, patroni_auth_enc: null, allow_hosts: [], region: null };
}

function authHeader(connId: string, s: OpsSettings): Record<string, string> {
  const cred = decryptSecret(s.patroni_auth_enc, `ops:${connId}:patroni`);
  return cred ? { authorization: 'Basic ' + Buffer.from(cred).toString('base64') } : {};
}

function patroniPath(base: string, p: string): string {
  return base.replace(/\/+$/, '') + p;
}

// ── Read ────────────────────────────────────────────────────────

async function topology(conn: ConnRow, actor: string): Promise<TopologyResponse> {
  const s = await settingsOf(conn.id);
  const db = await withTarget(conn, { readOnly: true, actor, timeoutMs: 10_000 }, async (c) => {
    const h = (await c.query(`${MARK}select pg_is_in_recovery() as replica, current_setting('server_version') as v, pg_postmaster_start_time() as started,
        current_setting('archive_mode') as archive_mode`)).rows[0];
    let timeline: number | null = null;
    await c.query('savepoint tl');
    try {
      timeline = num((await c.query(`${MARK}select timeline_id from pg_control_checkpoint()`)).rows[0].timeline_id);
      await c.query('release savepoint tl');
    } catch {
      await c.query('rollback to savepoint tl');
    }
    let replicas: any[] = [];
    let slots: any[] = [];
    let upstream: any = null;
    if (!h.replica) {
      replicas = (await c.query(`${MARK}select coalesce(nullif(r.application_name, ''), host(r.client_addr), 'replica') as name, host(r.client_addr) as addr, r.state, r.sync_state,
          extract(epoch from r.write_lag)::float8 as write_lag, extract(epoch from r.flush_lag)::float8 as flush_lag, extract(epoch from r.replay_lag)::float8 as replay_lag,
          pg_wal_lsn_diff(pg_current_wal_lsn(), r.sent_lsn)::float8 as sent_behind, pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn)::float8 as replay_behind,
          (select slot_name from pg_replication_slots s where s.active_pid = r.pid) as slot
        from pg_stat_replication r order by 1`)).rows;
      slots = (await c.query(`${MARK}select slot_name, slot_type, active, wal_status,
          case when restart_lsn is not null then pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::float8 end as retained
        from pg_replication_slots order by slot_name`)).rows;
    } else {
      await c.query('savepoint wr');
      try {
        upstream = (await c.query(`${MARK}select status, sender_host, sender_port, slot_name, last_msg_receipt_time,
            case when pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() then 0 else extract(epoch from now() - pg_last_xact_replay_timestamp())::float8 end as lag
          from pg_stat_wal_receiver`)).rows[0] ?? { status: 'not streaming' };
        await c.query('release savepoint wr');
      } catch {
        await c.query('rollback to savepoint wr');
        upstream = { status: 'unknown (needs pg_monitor)' };
      }
    }
    const arch = (await c.query(`${MARK}select archived_count, failed_count, last_archived_time, last_failed_time from pg_stat_archiver`)).rows[0];
    // Timeline switches: history files' modification time approximates each promotion (superuser / pg_read_server_files only).
    const tlEvents: FailoverEvent[] = [];
    if (timeline && timeline > 1) {
      for (let t = Math.max(2, timeline - 9); t <= timeline; t++) {
        const file = `pg_wal/${t.toString(16).toUpperCase().padStart(8, '0')}.history`;
        await c.query('savepoint hf');
        try {
          const st = (await c.query(`${MARK}select modification from pg_stat_file($1, true)`, [file])).rows[0];
          await c.query('release savepoint hf');
          tlEvents.push({ at: iso(st?.modification), kind: 'PROMOTION', text: `timeline ${t - 1} → ${t}: a standby was promoted (or recovery ended)`, timeline: t });
        } catch {
          await c.query('rollback to savepoint hf');
          tlEvents.push({ at: null, kind: 'PROMOTION', text: `timeline ${t - 1} → ${t}`, timeline: t });
        }
      }
    }
    return { h, timeline, replicas, slots, upstream, arch, tlEvents };
  });

  // Load and lag series from the monitor sampler (last hour).
  const samples = await q(
    `select at, conn_total, max_conn, db_size, wal_bytes, replicas from monitor_samples where connection_id = $1 and ok and at > now() - interval '1 hour' order by at`,
    [conn.id],
  );
  const last = samples[samples.length - 1];
  const first = samples[0];
  let walRate: number | null = null;
  if (first && last && first !== last && first.wal_bytes !== null && last.wal_bytes !== null) {
    const dt = (new Date(last.at).getTime() - new Date(first.at).getTime()) / 3_600_000;
    if (dt > 0) walRate = Math.max(0, (Number(last.wal_bytes) - Number(first.wal_bytes)) / dt);
  }
  const tail = samples.slice(-12);
  const load = tail.map((x) => (x.max_conn ? Number(x.conn_total) / Number(x.max_conn) : 0));
  const lagSeries = (name: string) => tail.map((x) => {
    const r = (x.replicas ?? []).find((y: any) => y.name === name);
    return r?.replayLag ?? 0;
  });

  const replicas: ReplicaInfo[] = db.replicas.map((r) => ({
    name: r.name, addr: r.addr, state: r.state, syncState: r.sync_state, writeLag: num(r.write_lag), flushLag: num(r.flush_lag), replayLag: num(r.replay_lag),
    sentBehind: num(r.sent_behind), replayBehind: num(r.replay_behind), slot: r.slot, lagSeries: lagSeries(r.name),
  }));
  const slots: SlotInfo[] = db.slots.map((x) => {
    const retained = num(x.retained);
    return { name: x.slot_name, type: x.slot_type, active: !!x.active, retainedBytes: retained, walStatus: x.wal_status ?? null, warn: (retained ?? 0) > SLOT_WARN_BYTES || (!x.active && (retained ?? 0) > 64 * 1024 ** 2) || x.wal_status === 'lost' || x.wal_status === 'unreserved' };
  });

  // Patroni.
  const patroni: TopologyResponse['patroni'] = { configured: !!s.patroni_url, url: s.patroni_url, members: [], error: null, scope: null };
  let history: TopologyResponse['history'] = {
    source: 'timeline',
    events: db.tlEvents.reverse(),
    note: db.timeline === null
      ? 'Failover history needs Patroni. This role cannot read the control file to derive timeline switches.'
      : db.timeline === 1
        ? 'Timeline 1: this server has never been promoted. A full failover history (who, why, downtime) needs Patroni.'
        : `Derived from timeline switches (now on timeline ${db.timeline}). Reasons and downtime need Patroni.`,
  };
  if (s.patroni_url) {
    try {
      const res = await outbound(patroniPath(s.patroni_url, '/cluster'), { headers: authHeader(conn.id, s) }, s.allow_hosts);
      if (res.status !== 200) throw new Error(`Patroni answered ${res.status}`);
      const j = JSON.parse(res.body);
      patroni.scope = j.scope ?? null;
      patroni.members = (j.members ?? []).slice(0, 50).map((m: any): PatroniMember => ({
        name: String(m.name ?? ''), role: String(m.role ?? ''), state: String(m.state ?? ''), host: m.host ?? null, port: num(m.port), timeline: num(m.timeline), lag: m.lag ?? null,
      }));
      const hr = await outbound(patroniPath(s.patroni_url, '/history'), { headers: authHeader(conn.id, s) }, s.allow_hosts).catch(() => null);
      if (hr?.status === 200) {
        const rows: any[] = JSON.parse(hr.body);
        history = {
          source: 'patroni',
          events: rows.slice(-20).reverse().map((r): FailoverEvent => ({
            at: r[3] ? iso(r[3]) : null, kind: /switchover/i.test(String(r[2])) ? 'PLANNED' : 'AUTOMATIC',
            text: `${String(r[2] ?? 'timeline switch')}${r[4] ? ' · new leader ' + r[4] : ''}`, timeline: num(r[0]),
          })),
          note: 'From Patroni /history.',
        };
      }
    } catch (e) {
      patroni.error = e instanceof SsrfError ? 'Blocked: ' + e.message : String((e as Error).message ?? e);
    }
  }

  return {
    role: db.h.replica ? 'replica' : 'primary', host: conn.host, port: conn.port, version: String(db.h.v).split(' ')[0], startedAt: iso(db.h.started),
    timeline: db.timeline, region: s.region, replicas, slots,
    upstream: db.upstream ? { status: db.upstream.status, host: db.upstream.sender_host ?? null, port: num(db.upstream.sender_port), slot: db.upstream.slot_name ?? null,
      lastMsgAt: iso(db.upstream.last_msg_receipt_time), replayLag: num(db.upstream.lag) } : null,
    archiver: db.h.archive_mode === 'off' ? null : { mode: db.h.archive_mode, lastArchivedAt: iso(db.arch.last_archived_time), lastFailedAt: iso(db.arch.last_failed_time),
      failed: Number(db.arch.failed_count), archived: Number(db.arch.archived_count) },
    self: { connTotal: num(last?.conn_total), maxConn: num(last?.max_conn), dbSize: num(last?.db_size), walRate, load },
    patroni, history,
    settings: { patroniUrl: s.patroni_url, hasPatroniAuth: !!s.patroni_auth_enc, allowHosts: s.allow_hosts, region: s.region },
  };
}

// ── Routes ──────────────────────────────────────────────────────

const hostRe = /^[a-z0-9.-]+$|^[0-9a-f:]+$/i;

export default async function topologyModule(app: FastifyInstance): Promise<void> {
  app.get('/topology/:connId', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'read');
    return topology(conn, user.email);
  });

  app.put('/topology/:connId/settings', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({
      patroniUrl: z.string().trim().max(500).nullable().optional(),
      /** "user:password" for Patroni's restapi.authentication; null clears, omitted keeps. */
      patroniAuth: z.string().max(500).nullable().optional(),
      allowHosts: z.array(z.string().trim().min(1).max(253).regex(hostRe, 'host names or IP addresses only')).max(20).optional(),
      region: z.string().trim().max(60).nullable().optional(),
    }), req.body);
    const user = requireRole(req, 'Admin');
    const { conn } = await requireConn(req, connId, 'read');
    const cur = await settingsOf(connId);
    const allow = body.allowHosts ?? cur.allow_hosts;
    const url = body.patroniUrl === undefined ? cur.patroni_url : body.patroniUrl || null;
    if (url) {
      try {
        await checkOutbound(url, allow);
      } catch (e) {
        if (e instanceof SsrfError) {
          await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'SETTINGS', target: 'patroni', status: 'denied', ip: req.ip,
            detail: { reason: e.message } });
          throw badRequest('Patroni URL refused: ' + e.message, { code: 'COMB_SSRF' });
        }
        throw e;
      }
    }
    // Stored credentials only ever go to the origin they were entered for: moving the URL elsewhere needs them
    // entered again (or cleared with null), as with SSH bastions.
    const originOf = (u: string | null) => { try { return u ? new URL(u).origin : null; } catch { return null; } };
    if (body.patroniAuth === undefined && cur.patroni_auth_enc && originOf(url) !== originOf(cur.patroni_url)) {
      throw badRequest('The Patroni address moved to a different server. Enter the Patroni credentials again (or clear them) to save it.', { code: 'COMB_REENTER_SECRET' });
    }
    const auth = body.patroniAuth === undefined ? cur.patroni_auth_enc : body.patroniAuth ? encryptSecret(body.patroniAuth, `ops:${connId}:patroni`) : null;
    await q(
      `insert into ops_conn_settings (connection_id, patroni_url, patroni_auth_enc, allow_hosts, region, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6, now())
       on conflict (connection_id) do update set patroni_url = excluded.patroni_url, patroni_auth_enc = excluded.patroni_auth_enc, allow_hosts = excluded.allow_hosts,
         region = excluded.region, updated_by = excluded.updated_by, updated_at = now()`,
      [connId, url, auth, allow, body.region === undefined ? cur.region : body.region || null, user.id],
    );
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'SETTINGS', target: 'topology', status: 'ok', ip: req.ip,
      detail: { patroniUrl: url, allowHosts: allow, authChanged: body.patroniAuth !== undefined, region: body.region } });
    return { ok: true };
  });

  app.post('/topology/:connId/switchover', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ candidate: z.string().trim().max(200).optional(), confirm: z.string().max(100).optional() }), req.body);
    const { conn, user } = await requireConn(req, connId, 'admin');
    requireRole(req, 'Admin');
    const s = await settingsOf(connId);
    if (!s.patroni_url) throw badRequest('Planned switchover needs Patroni. Set the Patroni REST URL for this connection first.');
    const res = await outbound(patroniPath(s.patroni_url, '/cluster'), { headers: authHeader(connId, s) }, s.allow_hosts).catch((e) => {
      throw badRequest('Cannot reach Patroni: ' + (e as Error).message);
    });
    if (res.status !== 200) throw badRequest(`Patroni answered ${res.status}`);
    const members: any[] = JSON.parse(res.body).members ?? [];
    const leader = members.find((m) => m.role === 'leader' || m.role === 'standby_leader');
    if (!leader) throw badRequest('Patroni reports no leader; refusing to switch over.');
    if (body.candidate && !members.some((m) => m.name === body.candidate && m.role !== 'leader')) throw badRequest(`${body.candidate} is not a replica in this cluster`);
    if (body.confirm !== conn.name) {
      throw new HttpError(409, `Type ${conn.name} to switch over`, {
        code: 'COMB_CONFIRM',
        confirm: { word: conn.name, kind: 'SWITCHOVER', target: conn.name, sql: `POST ${patroniPath(s.patroni_url, '/switchover')}\n{ "leader": ${JSON.stringify(leader.name)}${body.candidate ? `, "candidate": ${JSON.stringify(body.candidate)}` : ''} }\n-- writes pause while ${leader.name} steps down` },
      });
    }
    const payload = JSON.stringify({ leader: leader.name, ...(body.candidate ? { candidate: body.candidate } : {}) });
    const r = await outbound(patroniPath(s.patroni_url, '/switchover'), { method: 'POST', body: payload, headers: authHeader(connId, s) }, s.allow_hosts);
    const ok = r.status >= 200 && r.status < 300;
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'SWITCHOVER', target: leader.name, status: ok ? 'ok' : 'error', ip: req.ip,
      detail: { leader: leader.name, candidate: body.candidate ?? null, patroniStatus: r.status, response: r.body.slice(0, 300) } });
    if (!ok) throw badRequest(`Patroni refused the switchover (${r.status}): ${r.body.slice(0, 300)}`);
    return { ok: true, message: r.body.slice(0, 300) };
  });
}
