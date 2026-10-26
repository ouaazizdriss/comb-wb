import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type {
  HealthResponse, HealthRow, LockRow, MonitorAlert, MonitorBucket, MonitorLive, MonitorOverview, MonitorRange, MonitorRules,
  SlowStatementsResponse,
} from '@comb/shared/src/ops.ts';
import { q, one } from '../db/meta.ts';
import { parse, HttpError, notFound, badRequest } from '../core/http.ts';
import { requireConn, requireRole, levelAtLeast, type ConnRow } from '../security/authz.ts';
import { redactLiterals } from '../targets/classify.ts';
import { withTarget } from '../targets/pool.ts';
import { audit } from '../security/audit.ts';
import { registerWorker } from '../core/jobs.ts';
import { emit, notify } from '../core/events.ts';
import { getSetting, setSetting } from '../core/settings.ts';

/*
 * Monitoring. A pg-boss cron samples every connection once a minute (read-only, short timeout,
 * one broken connection never stops the others), stores counters in monitor_samples, computes
 * rates from deltas, then evaluates alert rules. The screen adds a live snapshot on top.
 * Every query Comb issues here starts with a marker comment so pg_stat_statements output can
 * leave Comb's own monitoring out of "slowest statements".
 */

const ACTOR = 'comb-monitor';
const MARK = '/* comb-monitor */ ';
const SAMPLE_TIMEOUT_MS = 5_000;
const RETENTION = '7 days';

export const DEFAULT_RULES: MonitorRules = {
  replicaLagSeconds: 1.5,
  replicaLagMinutes: 5,
  connectionsPct: 85,
  idleTxnSeconds: 300,
  cacheHitPct: 95,
  longXactSeconds: 900,
  deadlockQuietMinutes: 60,
};

export async function getRules(): Promise<MonitorRules> {
  return { ...DEFAULT_RULES, ...(await getSetting<Partial<MonitorRules>>('monitor.rules', {})) };
}

const RANGES: Record<MonitorRange, { interval: string; seconds: number }> = {
  '15m': { interval: '15 minutes', seconds: 900 },
  '1h': { interval: '1 hour', seconds: 3600 },
  '6h': { interval: '6 hours', seconds: 21600 },
  '24h': { interval: '24 hours', seconds: 86400 },
};
const BUCKETS = 14;

const connParam = z.object({ connId: z.string().uuid() });
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Internal Comb sessions (server, jobs, migrations, monitor, backups): never terminable from the UI. */
export function isInternalApp(app: string | null | undefined): boolean {
  if (!app) return false;
  return /^comb(-server|-jobs|-migrate)?$/.test(app) || /^comb:comb-/.test(app);
}

// ── Sampling ────────────────────────────────────────────────────

interface Raw {
  xactCommit: number; xactRollback: number; blksHit: number; blksRead: number;
  tupIns: number; tupUpd: number; tupDel: number; deadlocks: number; tempBytes: number;
  dbSize: number; isReplica: boolean; maxConn: number; sharedBuffers: string;
  connTotal: number; connActive: number; connIdleTxn: number; connWaiting: number;
  longestIdleTxnS: number | null; longestIdleTxnPid: number | null;
  longestXactS: number | null; longestXactPid: number | null; longestXactState: string | null;
  replLag: number | null; walBytes: string | null;
  replicas: Array<{ name: string; addr: string | null; state: string | null; sync: string | null; replayLag: number | null; behind: number | null }>;
}

/** Reads every counter the sampler and the live tiles need. Read-only, inside withTarget. */
export async function readRaw(c: pg.PoolClient): Promise<Raw> {
  const d = (await c.query(`${MARK}select d.xact_commit, d.xact_rollback, d.blks_hit, d.blks_read, d.tup_inserted, d.tup_updated, d.tup_deleted,
      d.deadlocks, d.temp_bytes, pg_database_size(current_database()) as db_size, pg_is_in_recovery() as is_replica,
      current_setting('max_connections')::int as max_conn, current_setting('shared_buffers') as shared_buffers
    from pg_stat_database d where d.datname = current_database()`)).rows[0];
  const a = (await c.query(`${MARK}select
      count(*) filter (where backend_type = 'client backend')::int as total,
      count(*) filter (where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid())::int as active,
      count(*) filter (where state in ('idle in transaction', 'idle in transaction (aborted)'))::int as idle_txn,
      count(*) filter (where wait_event_type = 'Lock')::int as waiting
    from pg_stat_activity`)).rows[0];
  const idle = (await c.query(`${MARK}select pid, extract(epoch from now() - state_change)::float8 as s from pg_stat_activity
    where state in ('idle in transaction', 'idle in transaction (aborted)') and state_change < now() - interval '1 second' and pid <> pg_backend_pid() order by state_change limit 1`)).rows[0];
  const lx = (await c.query(`${MARK}select pid, extract(epoch from now() - xact_start)::float8 as s, state from pg_stat_activity
    where xact_start < now() - interval '1 second' and pid <> pg_backend_pid() and backend_type = 'client backend' order by xact_start limit 1`)).rows[0];
  let replLag: number | null = null;
  let walBytes: string | null = null;
  let replicas: Raw['replicas'] = [];
  if (d.is_replica) {
    const r = (await c.query(`${MARK}select case when pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() then 0
        else extract(epoch from now() - pg_last_xact_replay_timestamp())::float8 end as lag,
        pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '0/0')::text as wal`)).rows[0];
    replLag = num(r.lag);
    walBytes = r.wal;
  } else {
    const w = (await c.query(`${MARK}select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::text as wal`)).rows[0];
    walBytes = w.wal;
    const rs = await c.query(`${MARK}select coalesce(nullif(application_name, ''), host(client_addr), 'replica') as name, host(client_addr) as addr, state, sync_state,
        extract(epoch from replay_lag)::float8 as replay_lag, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::float8 as behind
      from pg_stat_replication`);
    replicas = rs.rows.map((r) => ({ name: r.name, addr: r.addr, state: r.state, sync: r.sync_state, replayLag: num(r.replay_lag), behind: num(r.behind) }));
    const streaming = replicas.filter((r) => r.state === 'streaming');
    if (streaming.length) replLag = Math.max(...streaming.map((r) => r.replayLag ?? 0));
  }
  return {
    xactCommit: Number(d.xact_commit), xactRollback: Number(d.xact_rollback), blksHit: Number(d.blks_hit), blksRead: Number(d.blks_read),
    tupIns: Number(d.tup_inserted), tupUpd: Number(d.tup_updated), tupDel: Number(d.tup_deleted), deadlocks: Number(d.deadlocks),
    tempBytes: Number(d.temp_bytes), dbSize: Number(d.db_size), isReplica: !!d.is_replica, maxConn: Number(d.max_conn), sharedBuffers: d.shared_buffers,
    connTotal: a.total, connActive: a.active, connIdleTxn: a.idle_txn, connWaiting: a.waiting,
    longestIdleTxnS: idle ? num(idle.s) : null, longestIdleTxnPid: idle ? idle.pid : null,
    longestXactS: lx ? num(lx.s) : null, longestXactPid: lx ? lx.pid : null, longestXactState: lx ? lx.state : null,
    replLag, walBytes, replicas,
  };
}

interface Rates { tps: number | null; cacheHit: number | null; deadlocksDelta: number | null; tempDelta: number | null; accesses: number }

function rates(raw: Raw, prev: any | undefined, now: number): Rates {
  const cum = raw.blksHit + raw.blksRead > 0 ? raw.blksHit / (raw.blksHit + raw.blksRead) : null;
  if (!prev) return { tps: null, cacheHit: cum, deadlocksDelta: null, tempDelta: null, accesses: 0 };
  const dt = (now - new Date(prev.at).getTime()) / 1000;
  const dx = raw.xactCommit + raw.xactRollback - Number(prev.xact_commit) - Number(prev.xact_rollback);
  const dh = raw.blksHit - Number(prev.blks_hit);
  const dr = raw.blksRead - Number(prev.blks_read);
  const reset = dx < 0 || dh < 0 || dr < 0; // stats were reset between samples
  if (reset || dt < 1) return { tps: null, cacheHit: cum, deadlocksDelta: null, tempDelta: null, accesses: 0 };
  const dd = raw.deadlocks - Number(prev.deadlocks);
  const dtb = raw.tempBytes - Number(prev.temp_bytes);
  return {
    tps: dx / dt,
    cacheHit: dh + dr > 0 ? dh / (dh + dr) : cum,
    deadlocksDelta: dd >= 0 ? dd : null,
    tempDelta: dtb >= 0 ? dtb : null,
    accesses: dh + dr,
  };
}

async function prevSample(connId: string): Promise<any | undefined> {
  return one(`select at, tps, cache_hit, xact_commit, xact_rollback, blks_hit, blks_read, deadlocks, temp_bytes from monitor_samples
    where connection_id = $1 and ok order by at desc limit 1`, [connId]);
}

/** Samples one connection, stores the row and evaluates alerts. Never throws. */
export async function sampleOne(conn: ConnRow): Promise<{ ok: boolean; error?: string }> {
  try {
    const raw = await withTarget(conn, { readOnly: true, actor: ACTOR, timeoutMs: SAMPLE_TIMEOUT_MS }, readRaw);
    const prev = await prevSample(conn.id);
    const now = Date.now();
    const r = rates(raw, prev, now);
    await q(
      `insert into monitor_samples (connection_id, at, ok, xact_commit, xact_rollback, blks_hit, blks_read, tup_ins, tup_upd, tup_del, deadlocks, temp_bytes,
         tps, cache_hit, deadlocks_delta, temp_bytes_delta, conn_total, conn_active, conn_idle_txn, conn_waiting, max_conn, is_replica, repl_lag_s,
         replicas, wal_bytes, db_size, longest_xact_s, longest_xact_pid, longest_idle_txn_s)
       values ($1, to_timestamp($2::float8 / 1000), true, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [conn.id, now, raw.xactCommit, raw.xactRollback, raw.blksHit, raw.blksRead, raw.tupIns, raw.tupUpd, raw.tupDel, raw.deadlocks, raw.tempBytes,
        r.tps, r.cacheHit, r.deadlocksDelta, r.tempDelta, raw.connTotal, raw.connActive, raw.connIdleTxn, raw.connWaiting, raw.maxConn, raw.isReplica,
        raw.replLag, JSON.stringify(raw.replicas), raw.walBytes, raw.dbSize, raw.longestXactS, raw.longestXactPid, raw.longestIdleTxnS],
    );
    await evaluate(conn, raw, r).catch((e) => console.error('monitor: alert evaluation failed', conn.name, (e as Error).message));
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    await q('insert into monitor_samples (connection_id, ok, error) values ($1, false, $2)', [conn.id, msg]).catch(() => {});
    await evaluateFailure(conn, msg).catch(() => {});
    return { ok: false, error: msg };
  }
}

let sampling = false;
let lastPurge = 0;

/** Cron entry point: every connection, a few at a time, errors isolated per connection. */
export async function sampleAll(): Promise<{ total: number; failed: number }> {
  if (sampling) return { total: 0, failed: 0 };
  sampling = true;
  try {
    const conns = await q<ConnRow>('select * from connections order by name');
    let failed = 0;
    const queue = [...conns];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const r = await sampleOne(c);
        if (!r.ok) failed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, conns.length) }, worker));
    if (Date.now() - lastPurge > 3_600_000) {
      lastPurge = Date.now();
      await q(`delete from monitor_samples where at < now() - interval '${RETENTION}'`);
      await q(`delete from monitor_alerts where resolved_at < now() - interval '30 days'`);
    }
    return { total: conns.length, failed };
  } finally {
    sampling = false;
  }
}

registerWorker('monitor.sample', async () => {
  await sampleAll();
}, '* * * * *');

// ── Alerts ──────────────────────────────────────────────────────

async function openAlert(conn: ConnRow, rule: string, severity: 'warn' | 'crit', title: string, body: string): Promise<void> {
  const row = await one(
    `insert into monitor_alerts (connection_id, rule, severity, title, body) values ($1,$2,$3,$4,$5)
     on conflict (connection_id, rule) where resolved_at is null
     do update set last_seen_at = now(), title = excluded.title, body = excluded.body, severity = excluded.severity
     returning id, (xmax = 0) as inserted`,
    [conn.id, rule, severity, title, body],
  );
  if (!row?.inserted) return;
  const admins = await q(`select id from users where role in ('Owner','Admin') and status = 'active'`);
  for (const a of admins) {
    await notify({ userId: a.id, kind: severity === 'crit' ? 'err' : 'info', title: `${severity === 'crit' ? 'Critical' : 'Warning'} on ${conn.name}: ${title}`, body, target: 'monitor' });
  }
  if (severity === 'crit') emit('monitor.critical', { alertId: Number(row.id), connectionId: conn.id, connection: conn.name, rule });
}

async function resolveAlert(conn: ConnRow, rule: string): Promise<void> {
  await q('update monitor_alerts set resolved_at = now() where connection_id = $1 and rule = $2 and resolved_at is null', [conn.id, rule]);
}

const fmtS = (s: number) => (s < 90 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

async function evaluate(conn: ConnRow, raw: Raw, r: Rates): Promise<void> {
  const rules = await getRules();
  await resolveAlert(conn, 'unreachable');

  // Replica lag above the threshold for the whole window.
  const lagBad = raw.replLag !== null && raw.replLag > rules.replicaLagSeconds;
  let lagSustained = false;
  if (lagBad) {
    if (rules.replicaLagMinutes <= 0) lagSustained = true;
    else {
      const w = await one(
        `select count(*)::int as n, count(*) filter (where repl_lag_s > $2)::int as bad,
           exists (select 1 from monitor_samples where connection_id = $1 and ok and at <= now() - make_interval(mins => $3) + interval '45 seconds') as covered
         from monitor_samples where connection_id = $1 and ok and at > now() - make_interval(mins => $3)`,
        [conn.id, rules.replicaLagSeconds, rules.replicaLagMinutes],
      );
      lagSustained = !!w && w.n > 0 && w.bad === w.n && w.covered;
    }
  }
  if (lagSustained) {
    const who = raw.isReplica ? 'This replica' : (raw.replicas.filter((x) => (x.replayLag ?? 0) > rules.replicaLagSeconds).map((x) => x.name).join(', ') || 'A replica');
    await openAlert(conn, 'replica_lag', raw.replLag! > 60 ? 'crit' : 'warn',
      `Replica lag above ${rules.replicaLagSeconds} s for ${rules.replicaLagMinutes} minutes`,
      `${who} is ${fmtS(raw.replLag!)} behind on WAL apply. Read queries routed there may return stale rows.`);
  } else if (!lagBad) await resolveAlert(conn, 'replica_lag');

  // Connections close to max_connections.
  const pct = raw.maxConn ? (raw.connTotal / raw.maxConn) * 100 : 0;
  if (pct > rules.connectionsPct) {
    await openAlert(conn, 'connections', pct > 95 ? 'crit' : 'warn', `Connections at ${Math.round(pct)}% of max_connections`,
      `${raw.connTotal} of ${raw.maxConn} slots in use (${raw.connActive} active, ${raw.connIdleTxn} idle in transaction). New clients are refused when it reaches 100%.`);
  } else await resolveAlert(conn, 'connections');

  // Idle in transaction.
  if (raw.longestIdleTxnS !== null && raw.longestIdleTxnS > rules.idleTxnSeconds) {
    await openAlert(conn, 'idle_in_txn', 'warn', `A session is idle in transaction for ${fmtS(raw.longestIdleTxnS)}`,
      `pid ${raw.longestIdleTxnPid} opened a transaction and stopped. It holds its locks and keeps vacuum from cleaning up.`);
  } else await resolveAlert(conn, 'idle_in_txn');

  // Deadlocks: opens on any increase, resolves after a quiet period.
  if ((r.deadlocksDelta ?? 0) > 0) {
    await openAlert(conn, 'deadlocks', 'crit', `Deadlock detected (${r.deadlocksDelta} new)`,
      `Two or more backends waited on each other and Postgres aborted one of them. ${raw.deadlocks} since statistics were last reset; the server log has the statements.`);
  } else {
    const quiet = await one(
      `select coalesce(sum(deadlocks_delta), 0)::int as n from monitor_samples where connection_id = $1 and ok and at > now() - make_interval(mins => $2)`,
      [conn.id, rules.deadlockQuietMinutes],
    );
    if (!quiet || quiet.n === 0 || rules.deadlockQuietMinutes <= 0) await resolveAlert(conn, 'deadlocks');
  }

  // Cache hit ratio, only when there was enough traffic in the interval to mean something.
  if (r.cacheHit !== null && r.accesses >= 1000 && r.cacheHit * 100 < rules.cacheHitPct) {
    await openAlert(conn, 'cache_hit', 'warn', `Cache hit ratio ${(r.cacheHit * 100).toFixed(1)}% (below ${rules.cacheHitPct}%)`,
      `Reads are going to disk. shared_buffers is ${raw.sharedBuffers}; a working set that no longer fits is the usual cause.`);
  } else if (r.cacheHit === null || r.cacheHit * 100 >= rules.cacheHitPct || r.accesses >= 1000) await resolveAlert(conn, 'cache_hit');

  // Long transaction.
  if (raw.longestXactS !== null && raw.longestXactS > rules.longXactSeconds) {
    await openAlert(conn, 'long_xact', raw.longestXactS > rules.longXactSeconds * 4 ? 'crit' : 'warn', `Transaction open for ${fmtS(raw.longestXactS)}`,
      `pid ${raw.longestXactPid} (${raw.longestXactState ?? 'unknown state'}) started its transaction ${fmtS(raw.longestXactS)} ago. Old snapshots hold back vacuum on every table.`);
  } else await resolveAlert(conn, 'long_xact');
}

async function evaluateFailure(conn: ConnRow, msg: string): Promise<void> {
  const last = await q('select ok from monitor_samples where connection_id = $1 order by at desc limit 3', [conn.id]);
  if (last.length === 3 && last.every((r) => !r.ok)) {
    await openAlert(conn, 'unreachable', 'crit', 'Monitoring cannot reach the database', `The last three samples failed: ${msg.slice(0, 200)}`);
  }
}

// ── Read endpoints helpers ──────────────────────────────────────

function alertOut(r: any): MonitorAlert {
  return {
    id: Number(r.id), rule: r.rule, severity: r.severity, title: r.title, body: r.body, openedAt: iso(r.opened_at)!, lastSeenAt: iso(r.last_seen_at)!,
    ackedAt: iso(r.acked_at), ackedBy: r.acked_label ?? null,
  };
}

async function overview(conn: ConnRow, actor: string, range: MonitorRange): Promise<MonitorOverview> {
  const R = RANGES[range];
  let live: MonitorLive | null = null;
  let liveError: string | null = null;
  let header: MonitorOverview['header'] = { host: conn.host, port: conn.port, db: conn.dbname, version: '', startedAt: null, role: 'primary' };
  try {
    const got = await withTarget(conn, { readOnly: true, actor, timeoutMs: SAMPLE_TIMEOUT_MS }, async (c) => {
      const h = (await c.query(`${MARK}select current_setting('server_version') as v, pg_postmaster_start_time() as started`)).rows[0];
      return { raw: await readRaw(c), h };
    });
    const raw = got.raw;
    header = { ...header, version: String(got.h.v).split(' ')[0], startedAt: iso(got.h.started), role: raw.isReplica ? 'replica' : 'primary' };
    const prev = await prevSample(conn.id);
    const r = rates(raw, prev, Date.now());
    live = {
      at: new Date().toISOString(), connTotal: raw.connTotal, connActive: raw.connActive, connIdleTxn: raw.connIdleTxn, connWaiting: raw.connWaiting,
      maxConn: raw.maxConn, tps: r.tps ?? num(prev?.tps), cacheHit: r.tps === null && prev?.cache_hit != null ? Number(prev.cache_hit) : r.cacheHit, cacheHitCumulative: raw.blksHit + raw.blksRead > 0 ? raw.blksHit / (raw.blksHit + raw.blksRead) : null,
      isReplica: raw.isReplica, replLag: raw.replLag, replicas: raw.replicas.length, longestXactS: raw.longestXactS, longestXactPid: raw.longestXactPid,
      longestXactState: raw.longestXactState, longestIdleTxnS: raw.longestIdleTxnS, deadlocksTotal: raw.deadlocks, dbSize: raw.dbSize, sharedBuffers: raw.sharedBuffers,
    };
  } catch (e) {
    liveError = String((e as Error).message ?? e);
  }

  const rows = await q(
    `with b as (
       select width_bucket(extract(epoch from at), extract(epoch from now()) - $2::float8, extract(epoch from now()) + 0.001, $3::int) as b, *
       from monitor_samples where connection_id = $1 and ok and at > now() - make_interval(secs => $2::float8)
     )
     select b, max(conn_total) as conn_total, max(max_conn) as max_conn, avg(tps) as tps, avg(cache_hit) as cache_hit, max(repl_lag_s) as repl_lag,
       max(longest_xact_s) as longest_xact, sum(deadlocks_delta) as deadlocks
     from b group by b order by b`,
    [conn.id, R.seconds, BUCKETS],
  );
  const byB = new Map(rows.map((r) => [Number(r.b), r]));
  const start = Date.now() - R.seconds * 1000;
  const buckets: MonitorBucket[] = Array.from({ length: BUCKETS }, (_, i) => {
    const r = byB.get(i + 1);
    return {
      at: new Date(start + (i * R.seconds * 1000) / BUCKETS).toISOString(),
      connTotal: num(r?.conn_total), maxConn: num(r?.max_conn), tps: num(r?.tps), cacheHit: num(r?.cache_hit), replLag: num(r?.repl_lag),
      longestXact: num(r?.longest_xact), deadlocks: num(r?.deadlocks),
    };
  });
  const tot = await one(
    `select coalesce(sum(deadlocks_delta), 0)::int as deadlocks, avg(tps) as avg_tps, count(*)::int as samples,
       (select avg(tps) from monitor_samples where connection_id = $1 and ok and at > now() - make_interval(secs => $2::float8 * 2) and at <= now() - make_interval(secs => $2::float8)) as prev_tps
     from monitor_samples where connection_id = $1 and ok and at > now() - make_interval(secs => $2::float8)`,
    [conn.id, R.seconds],
  );
  const peak = await one(
    `select conn_total, at from monitor_samples where connection_id = $1 and ok and at > now() - make_interval(secs => $2::float8) order by conn_total desc, at desc limit 1`,
    [conn.id, R.seconds],
  );
  const last = await one('select at, ok, error from monitor_samples where connection_id = $1 order by at desc limit 1', [conn.id]);
  return {
    header, live, liveError, range, buckets,
    totals: { deadlocks: tot?.deadlocks ?? 0, peakConn: num(peak?.conn_total), peakConnAt: iso(peak?.at), avgTps: num(tot?.avg_tps), prevAvgTps: num(tot?.prev_tps), samples: tot?.samples ?? 0 },
    sampler: { lastAt: iso(last?.at), lastOk: last ? !!last.ok : null, lastError: last?.error ?? null },
    rules: await getRules(),
  };
}

const NOISE = String.raw`^\s*(begin|commit|rollback|discard all|set |show |savepoint|release )`;

/**
 * Other sessions' SQL can carry literals: masked values, or a password in ALTER ROLE (pg_stat_statements
 * does not normalise utility statements). Below connection admin, literals are stripped.
 */
function shown(sql: string, redact: boolean): string {
  if (!redact) return sql;
  try { return redactLiterals(sql); } catch { return '(statement text hidden: it could not be parsed to strip its values)'; }
}

async function slowStatements(conn: ConnRow, actor: string, sort: 'total' | 'mean' | 'calls', redact: boolean): Promise<SlowStatementsResponse> {
  const hint = 'CREATE EXTENSION pg_stat_statements; in this database, with shared_preload_libraries = \'pg_stat_statements\' in postgresql.conf (needs a server restart).';
  return withTarget(conn, { readOnly: true, actor, timeoutMs: 10_000 }, async (c) => {
    const ext = await c.query(`${MARK}select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements'`);
    if (!ext.rows.length) return { available: false as const, reason: 'pg_stat_statements is not installed in this database.', hint };
    const ver = Number((await c.query(`${MARK}select current_setting('server_version_num') as v`)).rows[0].v);
    const total = ver >= 130000 ? 'total_exec_time' : 'total_time';
    const order = sort === 'calls' ? 'calls' : sort === 'mean' ? 'mean' : 'total';
    await c.query('savepoint pss');
    try {
      // Identifiers here come from the fixed lists above, never from the request.
      const view = `${c.escapeIdentifier(ext.rows[0].nspname)}.pg_stat_statements`;
      const r = await c.query(
        // One row per normalised text: the same statement gets several queryids across roles,
        // top-level/nested calls, or after a restore recreated the tables it touches.
        `${MARK}with s as (
           select min(s.queryid)::text as queryid, s.query, sum(s.calls) as calls, sum(s.${total}) as total, sum(s.rows) as rows,
                  sum(s.${total}) / nullif(sum(s.calls), 0) as mean
           from ${view} s join pg_database d on d.oid = s.dbid
           where d.datname = current_database() and s.query not like '/* comb-%' and s.query !~* $1
             and s.query !~* '^select set_config\\('
           group by s.query
         )
         select *, sum(total) over () as grand from s order by ${order} desc nulls last limit 25`,
        [NOISE],
      );
      await c.query('release savepoint pss');
      const grand = r.rows.length ? Number(r.rows[0].grand) : 0;
      return {
        available: true as const,
        totalMs: grand,
        rows: r.rows.map((x) => ({
          queryid: x.queryid, query: shown(String(x.query), redact).slice(0, 4000), calls: Number(x.calls), meanMs: Number(x.mean), totalMs: Number(x.total),
          rows: Number(x.rows), share: grand > 0 ? Number(x.total) / grand : 0,
        })),
      };
    } catch (e) {
      await c.query('rollback to savepoint pss');
      const m = String((e as Error).message);
      if (/shared_preload_libraries/.test(m)) return { available: false as const, reason: 'pg_stat_statements is installed but not loaded by the server.', hint };
      if (/permission denied/.test(m)) return { available: false as const, reason: 'This connection\'s role cannot read pg_stat_statements.', hint: 'GRANT pg_read_all_stats TO <role>; lets it see every statement.' };
      throw e;
    }
  });
}

async function locks(conn: ConnRow, actor: string, redact: boolean): Promise<{ rows: LockRow[] }> {
  return withTarget(conn, { readOnly: true, actor, timeoutMs: 10_000 }, async (c) => {
    const act = await c.query(`${MARK}select a.pid, a.usename, a.application_name, a.state, left(coalesce(a.query, ''), 600) as query,
        extract(epoch from now() - coalesce(a.state_change, a.query_start))::float8 as wait_s,
        extract(epoch from now() - a.xact_start)::float8 as xact_s, pg_blocking_pids(a.pid) as blocked_by
      from pg_stat_activity a where a.pid <> pg_backend_pid() and a.backend_type = 'client backend' and a.datname = current_database()`);
    const waits = await c.query(`${MARK}select l.pid, l.locktype, l.mode,
        case when l.relation is not null and l.database = (select oid from pg_database where datname = current_database()) then l.relation::regclass::text end as rel,
        l.transactionid::text as xid
      from pg_locks l where not l.granted`);
    const want = new Map<number, string>();
    for (const w of waits.rows) {
      const what = w.rel ? `${w.mode} on ${w.rel}` : w.locktype === 'transactionid' ? `row lock (waits for xid ${w.xid})` : `${w.mode} (${w.locktype})`;
      if (!want.has(w.pid)) want.set(w.pid, what);
    }
    const byPid = new Map<number, any>(act.rows.map((r) => [r.pid, r]));
    const waitersOf = new Map<number, number[]>();
    for (const r of act.rows) for (const b of r.blocked_by ?? []) {
      if (!waitersOf.has(b)) waitersOf.set(b, []);
      waitersOf.get(b)!.push(r.pid);
    }
    const out: LockRow[] = [];
    const seen = new Set<number>();
    const row = (pid: number, depth: number): LockRow => {
      const r = byPid.get(pid);
      const blocks = waitersOf.get(pid)?.length ?? 0;
      const blockedBy: number[] = r?.blocked_by ?? [];
      return {
        pid, depth, role: blockedBy.length ? 'waiter' : 'blocker', blocks, blockedBy,
        user: r?.usename ?? null, app: r?.application_name ?? null, state: r?.state ?? null,
        query: r ? shown(String(r.query), redact) : '(backend in another database or not visible to this role)',
        lock: want.get(pid) ?? null, waitS: r ? num(r.wait_s) : null, xactS: r ? num(r.xact_s) : null, internal: isInternalApp(r?.application_name),
      };
    };
    const walk = (pid: number, depth: number) => {
      if (seen.has(pid) || depth > 8) return;
      seen.add(pid);
      out.push(row(pid, depth));
      for (const w of waitersOf.get(pid) ?? []) walk(w, depth + 1);
    };
    // Roots: blockers that are not waiting themselves, then anything left (cycles).
    const roots = [...waitersOf.keys()].filter((p) => !(byPid.get(p)?.blocked_by?.length));
    roots.sort((a, b) => (waitersOf.get(b)!.length - waitersOf.get(a)!.length) || a - b);
    for (const p of roots) walk(p, 0);
    for (const p of waitersOf.keys()) walk(p, 0);
    return { rows: out };
  });
}

async function health(conn: ConnRow, actor: string): Promise<HealthResponse> {
  return withTarget(conn, { readOnly: true, actor, timeoutMs: 20_000 }, async (c) => {
    const bs = Number((await c.query(`${MARK}select current_setting('block_size') as b`)).rows[0].b);
    const pst = (await c.query(`${MARK}select 1 from pg_extension where extname = 'pgstattuple'`)).rows.length > 0;
    const t = await c.query(`${MARK}select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relpages, c.reltuples,
        pg_total_relation_size(c.oid) as total_bytes, pg_relation_size(c.oid) as heap_bytes,
        coalesce(s.n_live_tup, 0) as live, coalesce(s.n_dead_tup, 0) as dead, s.last_vacuum, s.last_autovacuum,
        coalesce((regexp_match(array_to_string(c.reloptions, ','), 'fillfactor=([0-9]+)'))[1]::int, 100) as fillfactor,
        (select sum((1 - coalesce(st.null_frac, 0)) * coalesce(st.avg_width, 0)) from pg_stats st where st.schemaname = n.nspname and st.tablename = c.relname) as data_width,
        (select count(*) from pg_stats st where st.schemaname = n.nspname and st.tablename = c.relname)::int as stat_cols,
        (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::int as ncols
      from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid
      where c.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast'
        and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
      order by pg_total_relation_size(c.oid) desc limit 10`);
    const rows: HealthRow[] = [];
    for (const r of t.rows) {
      let bloat: number | null = null;
      let method: HealthRow['method'] = null;
      const heap = Number(r.heap_bytes);
      if (pst && heap > 0 && heap < 20 * 1024 ** 3) {
        await c.query('savepoint pst');
        try {
          await c.query(`select set_config('statement_timeout', '3000', true)`);
          const a = (await c.query(`${MARK}select approx_free_percent, dead_tuple_percent from pgstattuple_approx($1::oid::regclass)`, [r.oid])).rows[0];
          await c.query(`select set_config('statement_timeout', '20000', true)`);
          await c.query('release savepoint pst');
          bloat = Math.min(1, (Number(a.approx_free_percent) + Number(a.dead_tuple_percent)) / 100);
          method = 'pgstattuple_approx';
        } catch {
          await c.query('rollback to savepoint pst');
        }
      }
      if (method === null && r.stat_cols > 0 && Number(r.relpages) >= 8 && Number(r.reltuples) > 0) {
        // Statistics-based estimate: expected pages from row count x average row width vs actual pages.
        const header = 23 + Math.ceil(r.ncols / 8);
        const tuple = Math.ceil((header + Number(r.data_width)) / 8) * 8 + 4;
        const usable = (bs - 24) * (r.fillfactor / 100);
        const expected = Math.ceil((Number(r.reltuples) * tuple) / usable);
        bloat = Math.max(0, Math.min(1, (Number(r.relpages) - expected) / Number(r.relpages)));
        method = 'statistics';
      }
      if (method === null && Number(r.live) + Number(r.dead) > 0) {
        bloat = Number(r.dead) / (Number(r.live) + Number(r.dead));
        method = 'dead tuples';
      }
      rows.push({
        schema: r.schema, name: r.name, totalBytes: Number(r.total_bytes), liveTup: Number(r.live), deadTup: Number(r.dead), bloat, method,
        lastVacuum: iso(r.last_vacuum), lastAutovacuum: iso(r.last_autovacuum),
      });
    }
    return { rows, pgstattuple: pst };
  });
}

// ── Routes ──────────────────────────────────────────────────────

export default async function monitorModule(app: FastifyInstance): Promise<void> {
  app.get('/monitor/:connId/overview', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { range } = parse(z.object({ range: z.enum(['15m', '1h', '6h', '24h']).default('1h') }), req.query);
    const { conn, user } = await requireConn(req, connId, 'read');
    return overview(conn, user.email, range);
  });

  app.get('/monitor/:connId/alerts', async (req) => {
    const { connId } = parse(connParam, req.params);
    await requireConn(req, connId, 'read');
    // Acked alerts stay silent for 4 hours, then reappear if the condition persists.
    const rows = await q(
      `select * from monitor_alerts where connection_id = $1 and resolved_at is null and (acked_at is null or acked_at < now() - interval '4 hours')
       order by case severity when 'crit' then 0 else 1 end, opened_at desc`,
      [connId],
    );
    return rows.map(alertOut);
  });

  app.post('/monitor/:connId/alerts/:id/ack', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const { conn, user } = await requireConn(req, connId, 'read');
    requireRole(req, 'Admin');
    const row = await one(
      `update monitor_alerts set acked_at = now(), acked_by = $3, acked_label = $4 where id = $1 and connection_id = $2 and resolved_at is null returning *`,
      [id, connId, user.id, user.email],
    );
    if (!row) throw notFound('Alert not found or already resolved');
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'ALERT_ACK', target: row.rule, status: 'ok', ip: req.ip,
      detail: { alertId: id, severity: row.severity, title: row.title } });
    return alertOut(row);
  });

  app.post('/monitor/:connId/sample', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn } = await requireConn(req, connId, 'read');
    return sampleOne(conn);
  });

  app.get('/monitor/:connId/statements', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { sort } = parse(z.object({ sort: z.enum(['total', 'mean', 'calls']).default('total') }), req.query);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    return slowStatements(conn, user.email, sort, !levelAtLeast(level, 'admin'));
  });

  app.get('/monitor/:connId/locks', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    return locks(conn, user.email, !levelAtLeast(level, 'admin'));
  });

  app.get('/monitor/:connId/health', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'read');
    return health(conn, user.email);
  });

  app.post('/monitor/:connId/terminate', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ pid: z.number().int().positive().max(2 ** 31 - 1), confirm: z.string().max(40).optional() }), req.body);
    const { conn, user } = await requireConn(req, connId, 'admin');
    const deny = async (msg: string, detail: Record<string, unknown>) => {
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'TERMINATE', target: `pid ${body.pid}`,
        status: 'denied', ip: req.ip, detail: { pid: body.pid, reason: msg, ...detail } });
      return badRequest(msg, { code: 'COMB_BLOCKED' });
    };
    const result = await withTarget(conn, { readOnly: true, actor: user.email, timeoutMs: 10_000 }, async (c) => {
      const me = (await c.query(`${MARK}select pg_backend_pid() as pid`)).rows[0].pid as number;
      const t = (await c.query(
        `${MARK}select pid, usename, application_name, state, left(coalesce(query, ''), 300) as query, backend_type, cardinality(pg_blocking_pids(pid)) as waiting_on
         from pg_stat_activity where pid = $1 and datname = current_database()`, [body.pid])).rows[0];
      if (body.pid === me) return { refused: 'Comb will not terminate its own session.' };
      if (!t) return { missing: true };
      if (isInternalApp(t.application_name)) return { refused: `pid ${body.pid} is one of Comb's own internal sessions (${t.application_name}); Comb never terminates itself.` };
      if (t.backend_type !== 'client backend') return { refused: `pid ${body.pid} is a ${t.backend_type}, not a client session.` };
      if (body.confirm !== String(body.pid)) {
        return {
          confirm: {
            word: String(body.pid), kind: 'TERMINATE', target: `pid ${body.pid}`,
            sql: `select pg_terminate_backend(${body.pid});\n-- ${t.usename ?? '?'} · ${t.application_name || 'no application_name'} · ${t.state ?? 'unknown'}\n-- ${String(t.query).replace(/\s+/g, ' ').slice(0, 200)}`,
          },
        };
      }
      const released = (await c.query(`${MARK}select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [body.pid])).rows[0].n as number;
      const ok = (await c.query(`${MARK}select pg_terminate_backend($1) as ok`, [body.pid])).rows[0].ok as boolean;
      return { ok, released, target: t };
    });
    if ('missing' in result) throw notFound(`No backend with pid ${body.pid} in ${conn.dbname}`);
    if ('refused' in result) throw await deny(result.refused!, {});
    if ('confirm' in result) throw new HttpError(409, `Type ${body.pid} to terminate it`, { code: 'COMB_CONFIRM', confirm: result.confirm });
    const t = result.target!;
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'TERMINATE', target: `pid ${body.pid}`,
      sql: `select pg_terminate_backend(${body.pid})`, status: result.ok ? 'ok' : 'error', ip: req.ip,
      detail: { pid: body.pid, user: t.usename, application: t.application_name, state: t.state, released: result.released } });
    if (!result.ok) throw badRequest(`Postgres refused to terminate pid ${body.pid} (it may have exited, or this role lacks pg_signal_backend).`);
    return { ok: true, pid: body.pid, released: result.released };
  });

  app.get('/monitor/rules', async (req) => {
    requireRole(req, 'Viewer');
    return getRules();
  });

  app.put('/monitor/rules', async (req) => {
    const user = requireRole(req, 'Admin');
    const body = parse(z.object({
      replicaLagSeconds: z.number().min(0).max(3600), replicaLagMinutes: z.number().int().min(0).max(1440), connectionsPct: z.number().min(1).max(100),
      idleTxnSeconds: z.number().int().min(1).max(86400), cacheHitPct: z.number().min(0).max(100), longXactSeconds: z.number().int().min(1).max(604800),
      deadlockQuietMinutes: z.number().int().min(0).max(10080),
    }).partial(), req.body);
    const next = { ...(await getRules()), ...body };
    await setSetting('monitor.rules', next, user.id);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'SETTINGS', target: 'monitor.rules', status: 'ok', ip: req.ip, detail: body });
    return next;
  });
}
