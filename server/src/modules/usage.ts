import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../db/meta.ts';
import { parse, notFound } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { requireConn, requireRole, type ConnRow } from '../security/authz.ts';
import { withTarget, escapeIdent } from '../targets/pool.ts';
import { redactLiterals } from '../targets/classify.ts';
import { toCsv } from './compliance.ts';

/*
 * Usage & cost, attributed from the audit trail (ms, rows, actor, kind per statement) and,
 * when installed, pg_stat_statements. Cost = compute seconds × the connection's instance rate.
 * Query text is always normalised with redactLiterals, so literal values never show here.
 */

const connParam = z.object({ connId: z.string().uuid() });
const RANGES = ['this_month', 'last_month', '90d'] as const;
type Range = (typeof RANGES)[number];
const rangeQuery = z.object({ range: z.enum(RANGES).default('this_month') });
const DEFAULT_RATE = 0.12;

const READ_KINDS = ['SELECT', 'EXPLAIN', 'SHOW', 'VALUES', 'WITH', 'TABLE'];
const SCHEMA_KINDS = ['CREATE', 'ALTER', 'DROP', 'COMMENT', 'GRANT', 'REVOKE', 'MIGRATE', 'RENAME'];
const segOf = (kind: string) => (READ_KINDS.includes(kind) ? 'read' : SCHEMA_KINDS.includes(kind) ? 'schema' : 'write');
// Statement kinds that count as database work (logins, catalog edits etc. carry no ms).
const NOT_WORK = `('BLOCKED','LOGIN','EXPORT','CATALOG','PII_SCAN','DQ_TEST','DSR','RETENTION','CONNECTION','SETTINGS')`;
const WORK = `ms is not null and kind not in ${NOT_WORK}`;
const WORK_A = `a.ms is not null and a.kind not in ${NOT_WORK}`;

function windows(range: Range, now = new Date()): { from: Date; to: Date; prevFrom: Date; prevTo: Date; days: number } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (range === 'this_month') {
    const span = now.getTime() - monthStart.getTime();
    return { from: monthStart, to: now, prevFrom: new Date(monthStart.getTime() - span), prevTo: monthStart, days: Math.max(1, span / 86_400_000) };
  }
  if (range === 'last_month') {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const prevFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    return { from, to: monthStart, prevFrom, prevTo: from, days: (monthStart.getTime() - from.getTime()) / 86_400_000 };
  }
  const from = new Date(now.getTime() - 90 * 86_400_000);
  return { from, to: now, prevFrom: new Date(from.getTime() - 90 * 86_400_000), prevTo: from, days: 90 };
}

async function rateOf(connId: string): Promise<number> {
  const r = await one('select usd_per_hour from usage_rates where connection_id = $1', [connId]);
  return r ? Number(r.usd_per_hour) : DEFAULT_RATE;
}

async function totals(connId: string, from: Date, to: Date) {
  return one(`select coalesce(sum(ms), 0)::float8 as ms, count(*)::int as statements,
      coalesce(sum(rows) filter (where kind = any($4)), 0)::float8 as rows_read
    from audit_log where connection_id = $1 and at >= $2 and at < $3 and ${WORK}`, [connId, from, to, READ_KINDS]);
}

async function perActor(connId: string, from: Date, to: Date) {
  return q(`select a.actor_id, a.actor_label, a.kind, coalesce(t.team, 'Unassigned') as team, sum(a.ms)::float8 as ms, count(*)::int as n
    from audit_log a left join usage_teams t on t.user_id = a.actor_id
    where a.connection_id = $1 and a.at >= $2 and a.at < $3 and ${WORK_A}
    group by 1, 2, 3, 4`, [connId, from, to]);
}

interface Normalised { query: string; ms: number; calls: number; who: string; kind: string }
async function expensive(connId: string, from: Date, to: Date): Promise<Normalised[]> {
  const rows = await q(`select sql, kind, actor_label, sum(ms)::float8 as ms, count(*)::int as n from audit_log
    where connection_id = $1 and at >= $2 and at < $3 and sql is not null and ${WORK}
    group by 1, 2, 3 order by 4 desc limit 400`, [connId, from, to]);
  const by = new Map<string, Normalised & { whoMs: Map<string, number> }>();
  for (const r of rows) {
    const norm = redactLiterals(r.sql).replace(/\s+/g, ' ').trim();
    const cur = by.get(norm) ?? { query: norm, ms: 0, calls: 0, who: '', kind: r.kind, whoMs: new Map() };
    cur.ms += r.ms;
    cur.calls += r.n;
    cur.whoMs.set(r.actor_label, (cur.whoMs.get(r.actor_label) ?? 0) + r.ms);
    by.set(norm, cur);
  }
  return [...by.values()].map((v) => {
    const top = [...v.whoMs.entries()].sort((a, b) => b[1] - a[1]);
    return { query: v.query, ms: v.ms, calls: v.calls, kind: v.kind, who: top[0]?.[0] + (top.length > 1 ? ` +${top.length - 1}` : '') };
  }).sort((a, b) => b.ms - a.ms);
}

const money = (n: number) => (n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 1 ? '$' + n.toFixed(2) : n > 0 ? '$' + n.toFixed(4) : '$0');
const bytes = (n: number) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n >= 1 << 20 ? Math.round(n / (1 << 20)) + ' MB' : Math.round(n / 1024) + ' kB');

async function savings(conn: ConnRow, actor: string, from: Date, to: Date, days: number, rate: number, top: Normalised[]) {
  const perMonth = (ms: number) => (ms / 3_600_000) * rate * (30 / Math.max(1, days));
  const out: Array<{ title: string; body: string; saving: string; value: number }> = [];
  const target = await withTarget(conn, { readOnly: true, actor, timeoutMs: 15_000 }, async (c) => {
    const seq = await c.query(`select schemaname as schema, relname as name, seq_scan::float8 as seq, coalesce(idx_scan, 0)::float8 as idx, seq_tup_read::float8 as tup, n_live_tup::float8 as live
      from pg_stat_user_tables where n_live_tup >= 10000 and seq_scan >= 20 and seq_scan > coalesce(idx_scan, 0) order by seq_tup_read desc limit 3`);
    const unused = await c.query(`select s.schemaname as schema, s.relname as tbl, s.indexrelname as name, pg_relation_size(s.indexrelid)::float8 as size
      from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
      where s.idx_scan = 0 and not i.indisunique and not i.indisprimary order by 4 desc limit 3`);
    const bloat = await c.query(`select schemaname as schema, relname as name, n_dead_tup::float8 as dead, n_live_tup::float8 as live
      from pg_stat_user_tables where n_dead_tup > 1000 and n_dead_tup > 0.2 * (n_live_tup + n_dead_tup) order by n_dead_tup desc limit 2`);
    return { seq: seq.rows, unused: unused.rows, bloat: bloat.rows };
  }).catch(() => ({ seq: [], unused: [], bloat: [] }));

  for (const t of target.seq) {
    const r = await one(`select coalesce(sum(ms), 0)::float8 as ms from audit_log where connection_id = $1 and at >= $2 and at < $3 and lower(target) in ($4, $5)`,
      [conn.id, from, to, String(t.name).toLowerCase(), `${t.schema}.${t.name}`.toLowerCase()]);
    const v = perMonth(r.ms);
    out.push({ title: `Index the hot filter on ${t.name}`, value: v, saving: v > 0 ? `≤ ${money(v)}/mo` : '—',
      body: `${Math.round(t.seq).toLocaleString('en-US')} sequential scans read ${Math.round(t.tup).toLocaleString('en-US')} rows (${Math.round(t.live).toLocaleString('en-US')} live). Index scans: ${Math.round(t.idx).toLocaleString('en-US')}.` });
  }
  for (const i of target.unused) {
    out.push({ title: `Drop ${i.name}`, value: 0, saving: bytes(i.size),
      body: `0 scans since statistics were reset, ${bytes(i.size)}, and it slows every write on ${i.tbl}.` });
  }
  for (const b of target.bloat) {
    out.push({ title: `Vacuum ${b.name}`, value: 0, saving: Math.round((100 * b.dead) / (b.dead + b.live)) + '% dead',
      body: `${Math.round(b.dead).toLocaleString('en-US')} dead rows next to ${Math.round(b.live).toLocaleString('en-US')} live ones make every scan read more pages than it needs.` });
  }
  for (const qy of top.filter((x) => x.calls >= 20 && READ_KINDS.includes(x.kind)).slice(0, 2)) {
    const v = perMonth(qy.ms);
    out.push({ title: `Cache a repeated query (${qy.calls.toLocaleString('en-US')} runs)`, value: v, saving: v > 0 ? `≤ ${money(v)}/mo` : '—',
      body: `${qy.query.slice(0, 90)}${qy.query.length > 90 ? '…' : ''} ran ${qy.calls.toLocaleString('en-US')} times for ${Math.round(qy.ms).toLocaleString('en-US')} ms in this period; a materialized view or app cache would serve it once.` });
  }
  return out.sort((a, b) => b.value - a.value).slice(0, 6).map(({ value: _v, ...rest }) => rest);
}

async function statStatements(conn: ConnRow, actor: string) {
  return withTarget(conn, { readOnly: true, actor, timeoutMs: 10_000 }, async (c) => {
    const ext = await c.query(`select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements'`);
    if (!ext.rows.length) return { available: false as const, reason: 'pg_stat_statements is not installed on this database' };
    const s = escapeIdent(ext.rows[0].nspname);
    try {
      const r = await c.query(`select query, calls::float8 as calls, total_exec_time::float8 as ms, rows::float8 as rows from ${s}.pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database()) order by total_exec_time desc limit 5`);
      const tot = await c.query(`select coalesce(sum(total_exec_time), 0)::float8 as ms, coalesce(sum(calls), 0)::float8 as calls from ${s}.pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())`);
      return { available: true as const, totalMs: tot.rows[0].ms, calls: tot.rows[0].calls,
        top: r.rows.map((x) => ({ query: redactLiterals(x.query).replace(/\s+/g, ' ').trim().slice(0, 300), calls: x.calls, ms: x.ms, rows: x.rows })) };
    } catch (e) {
      return { available: false as const, reason: String((e as Error).message).slice(0, 160) };
    }
  }).catch((e) => ({ available: false as const, reason: String((e as Error).message).slice(0, 160) }));
}

function teamBars(rows: any[], rate: number) {
  const teams = new Map<string, { team: string; read: number; write: number; schema: number; statements: number }>();
  for (const r of rows) {
    const t = teams.get(r.team) ?? { team: r.team, read: 0, write: 0, schema: 0, statements: 0 };
    t[segOf(r.kind) as 'read' | 'write' | 'schema'] += r.ms;
    t.statements += r.n;
    teams.set(r.team, t);
  }
  return [...teams.values()].map((t) => {
    const ms = t.read + t.write + t.schema;
    return { ...t, ms, hours: ms / 3_600_000, cost: (ms / 3_600_000) * rate };
  }).sort((a, b) => b.ms - a.ms);
}

export default async function usageModule(app: FastifyInstance): Promise<void> {
  app.get('/usage/:connId', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { range } = parse(rangeQuery, req.query);
    const { conn, user } = await requireConn(req, connId, 'read');
    requireRole(req, 'Admin');
    const w = windows(range);
    const rate = await rateOf(conn.id);
    const [cur, prev] = [await totals(conn.id, w.from, w.to), await totals(conn.id, w.prevFrom, w.prevTo)];
    const delta = (a: number, b: number) => (b > 0 ? (a - b) / b : null);
    const hours = cur.ms / 3_600_000;
    const prevHours = prev.ms / 3_600_000;
    const actors = await perActor(conn.id, w.from, w.to);
    const top = await expensive(conn.id, w.from, w.to);
    const members = new Set(actors.map((a) => a.actor_label)).size;
    return {
      range, from: w.from, to: w.to, rate, defaultRate: DEFAULT_RATE, members,
      kpis: {
        cost: { value: hours * rate, delta: delta(hours * rate, prevHours * rate) },
        hours: { value: hours, delta: delta(hours, prevHours) },
        statements: { value: cur.statements, delta: delta(cur.statements, prev.statements) },
        rowsRead: { value: cur.rows_read, delta: delta(cur.rows_read, prev.rows_read) },
        costPerStatement: { value: cur.statements ? (hours * rate) / cur.statements : 0, delta: delta(cur.statements ? hours / cur.statements : 0, prev.statements ? prevHours / prev.statements : 0) },
      },
      teams: teamBars(actors, rate),
      expensive: top.slice(0, 6).map((t) => ({ query: t.query.slice(0, 400), who: t.who, calls: t.calls, ms: t.ms, cost: (t.ms / 3_600_000) * rate })),
      savings: await savings(conn, user.email, w.from, w.to, w.days, rate, top),
      server: await statStatements(conn, user.email),
    };
  });

  app.put('/usage/:connId/rate', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { usdPerHour } = parse(z.object({ usdPerHour: z.number().min(0).max(10_000) }), req.body);
    const { conn } = await requireConn(req, connId, 'read');
    const user = requireRole(req, 'Admin');
    const before = await rateOf(conn.id);
    await q(`insert into usage_rates (connection_id, usd_per_hour, updated_by) values ($1,$2,$3)
      on conflict (connection_id) do update set usd_per_hour = excluded.usd_per_hour, updated_by = excluded.updated_by, updated_at = now()`, [conn.id, usdPerHour, user.id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'SETTINGS', target: 'usage.rate', status: 'ok', ip: req.ip,
      detail: { from: before, to: usdPerHour } });
    return { rate: usdPerHour };
  });

  app.get('/usage/teams', async (req) => {
    requireRole(req, 'Admin');
    const rows = await q(`select u.id, u.name, u.email, u.role, t.team from users u left join usage_teams t on t.user_id = u.id where u.status <> 'disabled' order by coalesce(t.team, 'zzz'), u.name, u.email`);
    const teams = (await q(`select distinct team from usage_teams order by 1`)).map((r) => r.team as string);
    return { members: rows, teams };
  });

  app.put('/usage/teams/:userId', async (req) => {
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    const { team } = parse(z.object({ team: z.string().trim().max(60).nullable() }), req.body);
    const user = requireRole(req, 'Admin');
    const target = await one('select email from users where id = $1', [userId]);
    if (!target) throw notFound('Member not found');
    if (team) {
      await q(`insert into usage_teams (user_id, team, updated_by) values ($1,$2,$3) on conflict (user_id) do update set team = excluded.team, updated_by = excluded.updated_by, updated_at = now()`, [userId, team, user.id]);
    } else {
      await q('delete from usage_teams where user_id = $1', [userId]);
    }
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'SETTINGS', target: 'usage.team', status: 'ok', ip: req.ip, detail: { member: target.email, team: team || null } });
    return { ok: true };
  });

  app.get('/usage/:connId/chargeback.csv', async (req, reply) => {
    const { connId } = parse(connParam, req.params);
    const { range } = parse(rangeQuery, req.query);
    const { conn } = await requireConn(req, connId, 'read');
    const user = requireRole(req, 'Admin');
    const w = windows(range);
    const rate = await rateOf(conn.id);
    const rows = await q(`select coalesce(t.team, 'Unassigned') as team, a.actor_label as member, count(*)::int as statements, sum(a.ms)::float8 as ms
      from audit_log a left join usage_teams t on t.user_id = a.actor_id
      where a.connection_id = $1 and a.at >= $2 and a.at < $3 and ${WORK_A}
      group by 1, 2 order by 1, 4 desc`, [conn.id, w.from, w.to]);
    const csv = toCsv(['connection', 'period_start', 'period_end', 'team', 'member', 'statements', 'compute_hours', 'rate_usd_per_hour', 'attributed_usd'],
      rows.map((r) => [conn.name, w.from.toISOString(), w.to.toISOString(), r.team, r.member, r.statements, (r.ms / 3_600_000).toFixed(4), rate, ((r.ms / 3_600_000) * rate).toFixed(4)]));
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'EXPORT', target: 'chargeback', rows: rows.length, status: 'ok', ip: req.ip, detail: { range } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="chargeback-${conn.name}-${range}.csv"`);
    return csv;
  });
}
