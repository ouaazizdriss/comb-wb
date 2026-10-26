import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessLevel } from '@comb/shared';
import { q, one } from '../db/meta.ts';
import { parse, notFound, badRequest, HttpError } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { requireConn, requireRole, hasRole, levelAtLeast, connectionLevel, type AuthUser, type ConnRow } from '../security/authz.ts';
import { withTarget, escapeIdent, escapeLit } from '../targets/pool.ts';
import { runSql } from '../targets/exec.ts';
import { classify, SqlSyntaxError } from '../targets/classify.ts';
import { emit, notify } from '../core/events.ts';
import { registerWorker, scheduleCron, unscheduleCron } from '../core/jobs.ts';
import { fieldsFor, sanitizeForStorage } from './catalog.ts';

/*
 * Data quality tests. Every test is a query that returns the offending rows; it passes when
 * that query returns none. Runs go through runSql with forceReadOnly, so they are classified,
 * audited, masked and can never write. Stored samples are at most 4 rows, always masked, and
 * never contain SECRET columns.
 *
 * Option `blockExport`: while such a test is failing, scheduled exports on the connection should
 * not run. Exported as failingExportBlockers() for the jobs module to consult.
 */

export const DQ_KINDS = ['not_null', 'unique', 'accepted_values', 'freshness', 'row_count_min', 'referential', 'custom'] as const;
type Kind = (typeof DQ_KINDS)[number];

const connParam = z.object({ connId: z.string().uuid() });
const testParam = connParam.extend({ id: z.string().uuid() });
const ident = z.string().min(1).max(63);
// pg-boss cron: five fields of digits, *, /, -, and commas.
const cron = z.string().trim().max(100).regex(/^([\d*\/,-]+\s+){4}[\d*\/,-]+$/, 'five-field cron, e.g. 0 6 * * *');
const options = z.object({ notify: z.boolean().optional(), blockExport: z.boolean().optional(), runOnSchedule: z.boolean().optional() });

const testInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(DQ_KINDS),
  schema: ident.default('public'),
  table: ident,
  column: ident.nullable().optional(),
  config: z.object({
    values: z.array(z.string().max(200)).max(200).optional(),
    maxAgeMinutes: z.number().int().min(1).max(525_600).optional(),
    minRows: z.number().int().min(0).max(1e12).optional(),
    refSchema: ident.optional(),
    refTable: ident.optional(),
    refColumn: ident.optional(),
    sql: z.string().max(20_000).optional(),
  }).default({}),
  severity: z.enum(['info', 'warn', 'critical']).default('warn'),
  schedule: cron.nullable().optional(),
  options: options.default({}),
});
type TestInput = z.infer<typeof testInput>;

interface TestRow {
  id: string; connection_id: string; name: string; kind: Kind; schema_name: string; table_name: string; column_name: string | null;
  config: TestInput['config']; rule: string; sql: string; severity: string; schedule: string | null; options: z.infer<typeof options>;
  muted: boolean; created_by: string | null; created_at: Date; last_run_at: Date | null; last_state: string | null; last_failing: string | null; last_ms: number | null;
}

async function columnInfo(conn: ConnRow, actor: string, schema: string, table: string, column?: string | null): Promise<{ type: string | null }> {
  return withTarget(conn, { readOnly: true, actor }, async (c) => {
    const t = await c.query(`select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p','v','m','f')`, [schema, table]);
    if (!t.rows.length) throw badRequest(`Table ${schema}.${table} not found`);
    if (!column) return { type: null };
    const a = await c.query(`select format_type(atttypid, atttypmod) as type from pg_attribute where attrelid = $1 and attname = $2 and attnum > 0 and not attisdropped`, [t.rows[0].oid, column]);
    if (!a.rows.length) throw badRequest(`Column ${table}.${column} not found`);
    return { type: a.rows[0].type };
  });
}

/** Builds the offending-rows query and the human rule. Identifiers are validated against the catalog first. */
async function buildTest(conn: ConnRow, actor: string, t: TestInput): Promise<{ sql: string; rule: string }> {
  const rel = `${escapeIdent(t.schema)}.${escapeIdent(t.table)}`;
  const needsColumn = !['row_count_min', 'custom'].includes(t.kind);
  if (needsColumn && !t.column) throw badRequest('Pick a column for this kind of test');
  const info = await columnInfo(conn, actor, t.schema, t.table, needsColumn ? t.column : null);
  const c = t.column ? escapeIdent(t.column) : '';
  switch (t.kind) {
    case 'not_null':
      return { sql: `select *\nfrom ${rel}\nwhere ${c} is null`, rule: `${t.column} is null` };
    case 'unique':
      return { sql: `select ${c}, count(*) as copies\nfrom ${rel}\nwhere ${c} is not null\ngroup by 1\nhaving count(*) > 1`, rule: `count(*) > count(distinct ${t.column})` };
    case 'accepted_values': {
      const vals = t.config.values ?? [];
      if (!vals.length) throw badRequest('List the accepted values');
      const list = vals.map((v) => escapeLit(v)).join(', ');
      return { sql: `select ${c}, count(*) as n\nfrom ${rel}\nwhere ${c} is not null and ${c}::text not in (${list})\ngroup by 1`, rule: `${t.column} not in (${vals.join(', ')})` };
    }
    case 'freshness': {
      if (!/^(timestamp|date)/.test(info.type ?? '')) throw badRequest('Freshness needs a timestamp or date column');
      const m = t.config.maxAgeMinutes ?? 60;
      return { sql: `select max(${c}) as latest\nfrom ${rel}\nhaving max(${c}) is null or max(${c}) < now() - interval '${m} minutes'`, rule: `max(${t.column}) < now() - ${m} min` };
    }
    case 'row_count_min': {
      const n = t.config.minRows ?? 1;
      return { sql: `select count(*) as rows\nfrom ${rel}\nhaving count(*) < ${n}`, rule: `count(*) < ${n.toLocaleString('en-US')}` };
    }
    case 'referential': {
      const { refSchema = t.schema, refTable, refColumn } = t.config;
      if (!refTable || !refColumn) throw badRequest('Pick the referenced table and column');
      await columnInfo(conn, actor, refSchema, refTable, refColumn);
      const rrel = `${escapeIdent(refSchema)}.${escapeIdent(refTable)}`;
      return {
        sql: `select x.*\nfrom ${rel} x\nwhere x.${c} is not null\n  and not exists (select 1 from ${rrel} r where r.${escapeIdent(refColumn)} = x.${c})`,
        rule: `any ${t.column} has no ${refTable}.${refColumn}`,
      };
    }
    case 'custom': {
      const sql = t.config.sql ?? '';
      let stmts;
      try {
        stmts = classify(sql);
      } catch (e) {
        if (e instanceof SqlSyntaxError) throw badRequest('Syntax error: ' + e.message);
        throw e;
      }
      if (stmts.length !== 1) throw badRequest('A custom test is exactly one SELECT statement');
      const s = stmts[0];
      if (s.kind !== 'read' || s.blocked || !(s.command === 'SELECT' || s.command === 'VALUES')) {
        throw badRequest(`A custom test must be a single read-only SELECT; this is ${s.command}`);
      }
      return { sql: s.sql, rule: 'the query returns any row' };
    }
  }
}

function userFromRow(r: any): AuthUser {
  return { id: r.id, email: r.email, name: r.name, role: r.role, mfaEnabled: r.mfa_enabled, via: 'session', scopes: null };
}

async function recordRun(t: TestRow, conn: ConnRow, actor: string, out: { state: 'pass' | 'fail' | 'error'; failing: number | null; ms: number; error?: string; sample?: { columns: string[]; rows: unknown[][] } }): Promise<void> {
  await q(`insert into dq_runs (test_id, state, failing, ms, error, columns, sample, actor) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [t.id, out.state, out.failing, out.ms, out.error ?? null, out.sample ? JSON.stringify(out.sample.columns) : null, out.sample ? JSON.stringify(out.sample.rows) : null, actor]);
  await q(`update dq_tests set last_run_at = now(), last_state = $2, last_failing = $3, last_ms = $4 where id = $1`, [t.id, out.state, out.failing, out.ms]);
  // Keep the history bounded.
  await q(`delete from dq_runs where test_id = $1 and id not in (select id from dq_runs where test_id = $1 order by at desc limit 50)`, [t.id]);
  if (out.state === 'fail' && !t.muted) {
    emit('dq.failed', { testId: t.id, connection: conn.name, failing: out.failing ?? 0, severity: t.severity });
    if (t.options.notify) {
      const admins = await q(`select id from users where role in ('Owner','Admin') and status = 'active'`);
      for (const a of admins) {
        await notify({ userId: a.id, kind: 'err', title: `Quality test failing: ${t.name}`, body: `${(out.failing ?? 0).toLocaleString('en-US')} offending rows on ${conn.name}`, target: 'quality' });
      }
    }
  }
}

/** Runs one test as `user` (their access level applies, masking included). */
export async function runTest(t: TestRow, conn: ConnRow, user: AuthUser, level: AccessLevel, ip?: string) {
  const t0 = Date.now();
  try {
    const count = await runSql({ user, conn, level, ip, source: 'quality', forceReadOnly: true, maxRows: 1, sql: `select count(*)::bigint as failing from (\n${t.sql}\n) as dq` });
    const failing = Number(count.rows[0]?.[0] ?? 0);
    let sample: { columns: string[]; rows: unknown[][] } | undefined;
    if (failing > 0) {
      const s = await runSql({ user, conn, level, ip, source: 'quality', forceReadOnly: true, maxRows: 4, sql: `select * from (\n${t.sql}\n) as dq limit 4` });
      sample = await sanitizeForStorage(conn, fieldsFor(s.rows), s.columns.map((c) => c.name), s.rows, 4);
    }
    const out = { state: failing > 0 ? 'fail' as const : 'pass' as const, failing, ms: Date.now() - t0, sample };
    await recordRun(t, conn, user.email, out);
    return out;
  } catch (e) {
    const out = { state: 'error' as const, failing: null, ms: Date.now() - t0, error: String((e as Error).message).slice(0, 500) };
    await recordRun(t, conn, user.email, out);
    return out;
  }
}

/** Tests flagged "block scheduled exports" that are failing right now on a connection (for the jobs module). */
export async function failingExportBlockers(connId: string): Promise<Array<{ id: string; name: string; failing: number }>> {
  const rows = await q(`select id, name, last_failing from dq_tests where connection_id = $1 and not muted and last_state = 'fail' and (options->>'blockExport')::boolean`, [connId]);
  return rows.map((r) => ({ id: r.id, name: r.name, failing: Number(r.last_failing ?? 0) }));
}

const queueName = (id: string) => `dq-test-${id}`;
const attached = new Set<string>();
function attachWorker(id: string): void {
  if (attached.has(id)) return;
  attached.add(id);
  registerWorker(queueName(id), scheduledRun);
}

async function scheduledRun(data: { testId?: string }): Promise<void> {
  if (!data?.testId) return;
  const t = await one<TestRow>('select * from dq_tests where id = $1', [data.testId]);
  if (!t || !t.schedule || t.options.runOnSchedule === false) return;
  const conn = await one<ConnRow>('select * from connections where id = $1', [t.connection_id]);
  const urow = t.created_by ? await one(`select * from users where id = $1 and status = 'active'`, [t.created_by]) : null;
  if (!conn || !urow) return; // the author left or the connection is gone: the schedule goes quiet rather than running as someone else
  const user = userFromRow(urow);
  const level = await connectionLevel(user, conn);
  if (level === 'none') return;
  await runTest(t, conn, user, level);
}

async function applySchedule(t: { id: string; schedule: string | null; options: z.infer<typeof options> }): Promise<void> {
  const name = queueName(t.id);
  if (t.schedule && t.options.runOnSchedule !== false) {
    attachWorker(t.id);
    await scheduleCron(name, t.schedule, { testId: t.id });
  } else {
    await unscheduleCron(name);
  }
}

async function canEdit(req: FastifyRequest, connId: string) {
  const r = await requireConn(req, connId, 'read');
  if (!hasRole(r.user, 'Admin') && !levelAtLeast(r.level, 'write')) requireRole(req, 'Admin');
  return r;
}

function view(t: TestRow, runs: Array<{ state: string; failing: string | null; at: Date }>) {
  return {
    id: t.id, name: t.name, kind: t.kind, schema: t.schema_name, table: t.table_name, column: t.column_name, config: t.config,
    target: `${t.schema_name}.${t.table_name}${t.column_name ? '.' + t.column_name : ''}`, rule: t.rule, sql: t.sql, severity: t.severity,
    schedule: t.schedule, options: t.options, muted: t.muted, lastRunAt: t.last_run_at, lastState: t.last_state,
    failing: t.last_failing === null ? null : Number(t.last_failing), lastMs: t.last_ms,
    runs: runs.map((r) => ({ state: r.state, failing: r.failing === null ? null : Number(r.failing), at: r.at })),
  };
}

export default async function qualityModule(app: FastifyInstance): Promise<void> {
  // Re-attach workers for scheduled tests (schedules themselves persist in pg-boss).
  for (const t of await q(`select id from dq_tests where schedule is not null`).catch(() => [])) attachWorker(t.id);

  app.get('/quality/:connId/tests', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    const tests = await q<TestRow>('select * from dq_tests where connection_id = $1 order by created_at', [conn.id]);
    const runs = await q(`select test_id, state, failing, at from (
        select r.*, row_number() over (partition by test_id order by at desc) as rn from dq_runs r join dq_tests t on t.id = r.test_id where t.connection_id = $1) x
      where rn <= 10 order by at`, [conn.id]);
    const by = new Map<string, any[]>();
    for (const r of runs) { if (!by.has(r.test_id)) by.set(r.test_id, []); by.get(r.test_id)!.push(r); }
    return { tests: tests.map((t) => view(t, by.get(t.id) ?? [])), canEdit: hasRole(user, 'Admin') || levelAtLeast(level, 'write') };
  });

  app.get('/quality/:connId/tests/:id', async (req) => {
    const { connId, id } = parse(testParam, req.params);
    const { conn } = await requireConn(req, connId, 'read');
    const t = await one<TestRow>('select * from dq_tests where id = $1 and connection_id = $2', [id, conn.id]);
    if (!t) throw notFound('Test not found');
    const runs = await q(`select state, failing, at from dq_runs where test_id = $1 order by at desc limit 10`, [id]);
    const last = await one(`select at, state, failing, ms, error, columns, sample from dq_runs where test_id = $1 order by at desc limit 1`, [id]);
    return { ...view(t, runs.reverse()), last: last ?? null };
  });

  app.post('/quality/:connId/tests', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(testInput, req.body);
    const { conn, user } = await canEdit(req, connId);
    const built = await buildTest(conn, user.email, body);
    const row = await one<TestRow>(
      `insert into dq_tests (connection_id, name, kind, schema_name, table_name, column_name, config, rule, sql, severity, schedule, options, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [conn.id, body.name, body.kind, body.schema, body.table, body.column ?? null, JSON.stringify(body.config), built.rule, built.sql, body.severity,
        body.schedule ?? null, JSON.stringify(body.options), user.id]);
    try {
      await applySchedule(row!);
    } catch (e) {
      await q('delete from dq_tests where id = $1', [row!.id]);
      throw badRequest('Invalid schedule: ' + (e as Error).message);
    }
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DQ_TEST', target: `${body.schema}.${body.table}`,
      status: 'ok', ip: req.ip, detail: { action: 'create', testId: row!.id, kind: body.kind, schedule: body.schedule ?? null } });
    return view(row!, []);
  });

  app.patch('/quality/:connId/tests/:id', async (req) => {
    const { connId, id } = parse(testParam, req.params);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(120).optional(), muted: z.boolean().optional(), severity: z.enum(['info', 'warn', 'critical']).optional(),
      schedule: cron.nullable().optional(), options: options.optional(),
    }), req.body);
    const { conn, user } = await canEdit(req, connId);
    const t = await one<TestRow>('select * from dq_tests where id = $1 and connection_id = $2', [id, conn.id]);
    if (!t) throw notFound('Test not found');
    const next = {
      name: body.name ?? t.name, muted: body.muted ?? t.muted, severity: body.severity ?? t.severity,
      schedule: body.schedule === undefined ? t.schedule : body.schedule, options: { ...t.options, ...(body.options ?? {}) },
    };
    const row = await one<TestRow>(`update dq_tests set name = $2, muted = $3, severity = $4, schedule = $5, options = $6 where id = $1 returning *`,
      [id, next.name, next.muted, next.severity, next.schedule, JSON.stringify(next.options)]);
    if (body.schedule !== undefined || body.options?.runOnSchedule !== undefined) {
      try {
        await applySchedule(row!);
      } catch (e) {
        throw badRequest('Invalid schedule: ' + (e as Error).message);
      }
    }
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DQ_TEST', target: `${t.schema_name}.${t.table_name}`,
      status: 'ok', ip: req.ip, detail: { action: body.muted === true ? 'mute' : body.muted === false ? 'unmute' : 'update', testId: id, fields: Object.keys(body) } });
    return view(row!, []);
  });

  app.delete('/quality/:connId/tests/:id', async (req) => {
    const { connId, id } = parse(testParam, req.params);
    const { conn, user } = await canEdit(req, connId);
    const t = await one<TestRow>('delete from dq_tests where id = $1 and connection_id = $2 returning *', [id, conn.id]);
    if (!t) throw notFound('Test not found');
    await unscheduleCron(queueName(id));
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DQ_TEST', target: `${t.schema_name}.${t.table_name}`,
      status: 'ok', ip: req.ip, detail: { action: 'delete', testId: id, name: t.name } });
    return { ok: true };
  });

  app.post('/quality/:connId/tests/:id/run', async (req) => {
    const { connId, id } = parse(testParam, req.params);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    const t = await one<TestRow>('select * from dq_tests where id = $1 and connection_id = $2', [id, conn.id]);
    if (!t) throw notFound('Test not found');
    const out = await runTest(t, conn, user, level, req.ip);
    return { id, ...out };
  });

  // Preview of the generated SQL before saving (the "New test" form).
  app.post('/quality/:connId/preview', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(testInput, req.body);
    const { conn, user } = await requireConn(req, connId, 'read');
    try {
      return await buildTest(conn, user.email, body);
    } catch (e) {
      if (e instanceof HttpError) return { error: e.message };
      throw e;
    }
  });
}
