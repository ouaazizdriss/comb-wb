import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccessLevel, WorkspaceRole } from '@comb/shared';
import { q, one } from '../db/meta.ts';
import { parse, badRequest, notFound, forbidden, HttpError } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { userOf, hasRole, requireConn, connectionLevel, levelAtLeast, type AuthUser, type ConnRow } from '../security/authz.ts';
import { classify, SqlSyntaxError } from '../targets/classify.ts';
import { runSql, plan } from '../targets/exec.ts';
import { registerWorker, enqueue } from '../core/jobs.ts';
import { deliver } from '../core/delivery.ts';
import { emit, notify } from '../core/events.ts';
import { bindParams, loadVisible, type ParamDef } from './library.ts';

/*
 * Scheduled jobs. One pg-boss cron ("workflow-tick", every minute) acts as a dispatcher: it claims
 * jobs whose next_run_at has passed (an atomic UPDATE, so two servers never both claim one),
 * moves next_run_at forward with Comb's own cron evaluator (timezone-aware) and enqueues a run.
 * Each run executes through runSql as the job's owner, with the owner's access level re-checked
 * at run time; a disabled owner, or one who lost access, makes the run fail with a clear message.
 */

// ── Cron ──────────────────────────────────────────────────────

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MACROS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

interface Cron { min: number[]; hour: number[]; dom: Set<number>; mon: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function field(src: string, lo: number, hi: number, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const val = (s: string): number => {
    const up = s.toUpperCase();
    if (names) {
      const i = names.indexOf(up);
      if (i >= 0) return i + nameBase;
    }
    if (!/^\d+$/.test(s)) throw new Error(`"${s}" is not a number`);
    return Number(s);
  };
  for (const part of src.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cannot read "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error('step must be at least 1');
    let a: number, b: number;
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) { const [x, y] = m[1].split('-'); a = val(x); b = val(y); }
    else { a = val(m[1]); b = m[2] ? hi : a; }
    if (a < lo || b > hi || a > b) throw new Error(`"${part}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Five-field cron (minute hour day-of-month month day-of-week). No seconds field, so at most once a minute. */
export function parseCron(expr: string): Cron {
  const e = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error('Use five fields: minute hour day-of-month month day-of-week');
  const dow = field(f[4], 0, 7, DAYS);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    min: [...field(f[0], 0, 59)].sort((a, b) => a - b), hour: [...field(f[1], 0, 23)].sort((a, b) => a - b),
    dom: field(f[2], 1, 31), mon: field(f[3], 1, 12, MONTHS, 1), dow, domStar: f[2] === '*', dowStar: f[4] === '*',
  };
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmts = new Map<string, Intl.DateTimeFormat>();
function wallParts(tz: string, t: number): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })));
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, dow: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() };
}
function offset(tz: string, t: number): number {
  const w = wallParts(tz, t);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000;
}
function wallToInstant(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = offset(tz, guess);
  let t = guess - o1;
  const o2 = offset(tz, t);
  if (o2 !== o1) t = guess - o2;
  return t;
}

/** The next `count` run instants strictly after `from`, in the job's timezone. */
export function nextRuns(expr: string, tz: string, from: Date, count = 1): Date[] {
  const c = parseCron(expr);
  const out: Date[] = [];
  const start = wallParts(tz, from.getTime());
  let day = Date.UTC(start.y, start.mo - 1, start.d);
  for (let i = 0; i < 366 * 8 && out.length < count; i++, day += 86_400_000) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
    if (!c.mon.has(mo)) continue;
    const domOk = c.dom.has(d), dowOk = c.dow.has(wd);
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of c.hour) {
      for (const mi of c.min) {
        const t = wallToInstant(tz, y, mo, d, h, mi);
        if (t > from.getTime() && (!out.length || t > out[out.length - 1].getTime())) {
          out.push(new Date(t));
          if (out.length >= count) return out;
        }
      }
    }
  }
  return out;
}

// ── Shapes ────────────────────────────────────────────────────

const KINDS = ['query', 'export', 'maintenance', 'quality', 'refresh'] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = { query: 'query', export: 'query export', maintenance: 'maintenance', quality: 'data-quality run', refresh: 'refresh matview' };

const optionsSchema = z.object({
  failOnZero: z.boolean().default(false),
  retry: z.boolean().default(false),
  skipIfRunning: z.boolean().default(true),
  attachSql: z.boolean().default(false),
  attachCsv: z.boolean().default(false),
  notifyOnFailure: z.boolean().default(true),
  weekdaysOnly: z.boolean().default(false),
});
type Options = z.infer<typeof optionsSchema>;

const jobBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS).default('query'),
  cron: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  connectionId: z.string().uuid(),
  sql: z.string().max(200_000).nullable().default(null),
  libraryId: z.string().uuid().nullable().default(null),
  params: z.record(z.string().max(63), z.union([z.string().max(10_000), z.number()])).default({}),
  integrationId: z.string().trim().min(1).max(100).nullable().default(null),
  options: z.preprocess((v) => v ?? {}, optionsSchema),
  state: z.enum(['active', 'paused']).default('active'),
});
type JobBody = z.infer<typeof jobBody>;

interface JobRow {
  id: string; name: string; kind: Kind; cron: string; timezone: string; connection_id: string; sql: string | null; library_id: string | null;
  params: Record<string, string | number>; integration_id: string | null; options: Partial<Options>; owner_id: string; state: 'active' | 'paused';
  library_version: number | null; next_run_at: Date | null; created_at: Date; updated_at: Date;
}

const idParam = z.object({ id: z.string().uuid() });

function opts(o: Partial<Options> | null | undefined): Options {
  return optionsSchema.parse(o ?? {});
}

function validateCron(cron: string, tz: string): Date[] {
  if (!validTimezone(tz)) throw badRequest(`Unknown timezone ${tz}`);
  let runs: Date[];
  try {
    runs = nextRuns(cron, tz, new Date(), 5);
  } catch (e) {
    throw badRequest('Invalid cron: ' + (e as Error).message);
  }
  if (!runs.length) throw badRequest('That cron expression never fires');
  return runs;
}

type JobSource = { sql: string | null; library_id: string | null; library_version: number | null; params: Record<string, string | number> };

/**
 * Resolves the SQL a job runs: its own text, or the pinned version of a saved query with its params bound.
 * The pin matters: a saved query can be edited by its owner (or anyone, when 'shared'), and the job must
 * never run SQL that someone other than the job owner chose with the job owner's access.
 */
async function jobSql(owner: AuthUser, j: JobSource): Promise<string> {
  if (j.library_id) {
    const lib = await loadVisible(owner, j.library_id).catch(() => null);
    if (!lib) throw new HttpError(400, 'The saved query this job runs is no longer visible to its owner');
    if (!j.library_version) throw new HttpError(400, 'This job is not pinned to a saved-query version; edit and save it to pin the current one');
    const v = await one<{ sql: string; params: Record<string, ParamDef> }>('select sql, params from library_versions where query_id = $1 and n = $2', [j.library_id, j.library_version]);
    if (!v) throw new HttpError(400, `Version ${j.library_version} of the saved query no longer exists`);
    return bindParams(v.sql, j.params, v.params);
  }
  if (!j.sql) throw new HttpError(400, 'The saved query this job ran was deleted');
  return j.sql;
}

function checkKind(kind: Kind, sql: string): { writes: boolean } {
  let stmts;
  try {
    stmts = classify(sql);
  } catch (e) {
    if (e instanceof SqlSyntaxError) throw badRequest('The job SQL does not parse: ' + e.message);
    throw e;
  }
  if (!stmts.length) throw badRequest('The job has no SQL');
  const cmds = stmts.map((s) => s.command);
  if (kind === 'maintenance' && !cmds.every((c) => ['VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER'].includes(c))) {
    throw badRequest('Maintenance jobs run VACUUM, ANALYZE, REINDEX or CLUSTER only');
  }
  if (kind === 'refresh' && !cmds.every((c) => c === 'REFRESH MATERIALIZED VIEW')) throw badRequest('Refresh jobs run REFRESH MATERIALIZED VIEW only');
  return { writes: stmts.some((s) => s.kind !== 'read' && s.kind !== 'session') };
}

const APPROVAL_READS_ONLY = 'Jobs on approval-required connections may only run read statements';

async function ownerUser(id: string): Promise<(AuthUser & { status: string }) | null> {
  const u = await one(`select id, email, name, role, mfa_enabled, status from users where id = $1`, [id]);
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role as WorkspaceRole, mfaEnabled: u.mfa_enabled, via: 'session', scopes: null, status: u.status };
}

// ── Execution ─────────────────────────────────────────────────

function csv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

interface RunRequest { jobId: string; trigger: 'schedule' | 'manual' | 'retry'; retryOf?: number | null; attempt?: number }

export async function executeJob(r: RunRequest): Promise<number | null> {
  const job = await one<JobRow>('select * from sched_jobs where id = $1', [r.jobId]);
  if (!job) return null;
  const o = opts(job.options);
  const attempt = r.attempt ?? 1;

  if (r.trigger === 'schedule' && o.weekdaysOnly) {
    const w = wallParts(job.timezone, Date.now());
    if (w.dow === 0 || w.dow === 6) return null;
  }
  if (o.skipIfRunning && r.trigger !== 'manual') {
    const busy = await one(`select id from sched_job_runs where job_id = $1 and status = 'running' and started_at > now() - interval '6 hours'`, [job.id]);
    if (busy) {
      const s = await one(`insert into sched_job_runs (job_id, trigger, status, finished_at, error, attempt) values ($1,$2,'skipped',now(),$3,$4) returning id`,
        [job.id, r.trigger, `skipped: run #${busy.id} is still going`, attempt]);
      return Number(s.id);
    }
  }

  const run = await one(`insert into sched_job_runs (job_id, trigger, retry_of, attempt) values ($1,$2,$3,$4) returning id`, [job.id, r.trigger, r.retryOf ?? null, attempt]);
  const runId = Number(run.id);
  const t0 = Date.now();
  let status: 'ok' | 'failed' = 'ok';
  let error: string | null = null;
  let rows: number | null = null;
  let delivery: string | null = null;
  let result: unknown = null;

  try {
    const conn = await one<ConnRow>('select * from connections where id = $1', [job.connection_id]);
    if (!conn) throw new Error('The connection was removed');
    const owner = await ownerUser(job.owner_id);
    if (!owner) throw new Error('The job owner no longer exists');
    if (owner.status !== 'active') throw new Error(`The job owner ${owner.email} is ${owner.status}; the job cannot run as them`);
    // Re-check the owner's access at run time, never trust what it was at creation.
    const level: AccessLevel = await connectionLevel(owner, conn);
    if (level === 'none') throw new Error(`${owner.email} no longer has access to ${conn.name}`);
    const sql = await jobSql(owner, job);
    const { writes } = checkKind(job.kind, sql);
    if (writes && conn.require_approval) throw new Error(`${APPROVAL_READS_ONLY}; ${conn.name} requires approval for writes`);
    if (writes && !levelAtLeast(level, 'write')) throw new Error(`${owner.email} now has ${level} access to ${conn.name}; this job writes`);

    const res = await runSql({
      user: owner, conn, level, sql, source: 'job', maxRows: job.kind === 'export' ? 50_000 : 10_000,
      forceReadOnly: conn.require_approval,
    });
    if (res.approvalId) throw new Error('The run was turned into an approval request; jobs never wait for approvals');
    const hasRows = res.columns.length > 0;
    rows = hasRows ? res.rows.length : res.statements.reduce((a, s) => a + (s.rowCount ?? 0), 0);
    // Runs keep column names and counts only, never row values: a stored row would escape the
    // masking that applies to whoever later views the history.
    if (hasRows) result = { columns: res.columns.map((c) => c.name), rowCount: res.rows.length, truncated: res.truncated };
    if (job.kind === 'quality' && hasRows && rows > 0) throw new Error(`${rows} row${rows === 1 ? '' : 's'} violate the check`);
    if (o.failOnZero && hasRows && rows === 0) throw new Error('The query returned zero rows');

    if (job.integration_id) {
      try {
        await deliver({ integrationId: job.integration_id }, {
          title: `${job.name}: ${rows ?? 0} rows`,
          text: `Scheduled job ${job.name} on ${conn.name} finished in ${Date.now() - t0} ms.` + (o.attachSql ? `\n\n${sql}` : ''),
          fields: { job: job.name, connection: conn.name, rows: rows ?? 0, run: runId },
          ...(o.attachCsv && hasRows ? { attachment: { filename: job.name.replace(/[^A-Za-z0-9_.-]+/g, '_') + '.csv', contentType: 'text/csv', body: csv(res.columns.map((c) => c.name), res.rows) } } : {}),
        });
        delivery = 'delivered';
      } catch (e) {
        const m = String((e as Error).message ?? e);
        if (/No delivery integration/i.test(m)) delivery = 'delivery skipped: no integration';
        else { delivery = 'delivery failed'; throw new Error('Delivery failed: ' + m.slice(0, 300)); }
      }
    } else delivery = 'stored result only';
  } catch (e) {
    status = 'failed';
    error = String((e as Error).message ?? e).slice(0, 1000);
  }

  const ms = Date.now() - t0;
  await q(`update sched_job_runs set status = $2, finished_at = now(), ms = $3, rows = $4, error = $5, delivery = $6, result = $7 where id = $1`,
    [runId, status, ms, rows, error, delivery, result === null ? null : JSON.stringify(result)]);

  if (status === 'failed') {
    emit('job.failed', { jobId: job.id, runId, attempt });
    if (o.notifyOnFailure) {
      await notify({ userId: job.owner_id, kind: 'err', title: `Job failed: ${job.name}`, body: (error ?? '').slice(0, 300), target: 'jobs' });
    }
    if (o.retry && r.trigger !== 'manual' && attempt < 4) {
      await enqueue('workflow-job', { jobId: job.id, trigger: 'retry', retryOf: runId, attempt: attempt + 1 }, { startAfterSeconds: 30 * 2 ** (attempt - 1) }).catch(() => {});
    }
  } else {
    emit('job.succeeded', { jobId: job.id, runId, rows: rows ?? 0 });
  }
  return runId;
}

async function tick(): Promise<void> {
  const due = await q<{ id: string; cron: string; timezone: string }>(
    `select id, cron, timezone from sched_jobs where state = 'active' and next_run_at <= now() order by next_run_at limit 200`);
  for (const j of due) {
    let next: Date | null = null;
    try {
      next = nextRuns(j.cron, j.timezone, new Date(), 1)[0] ?? null;
    } catch {
      next = null;
    }
    // Claim atomically: only the server whose UPDATE matched enqueues the run.
    const claimed = await one(`update sched_jobs set next_run_at = $2 where id = $1 and state = 'active' and next_run_at <= now() returning id`, [j.id, next]);
    if (claimed) await enqueue('workflow-job', { jobId: j.id, trigger: 'schedule' });
  }
}

// ── Routes ────────────────────────────────────────────────────

async function loadJob(user: AuthUser, id: string): Promise<{ job: JobRow; conn: ConnRow; level: AccessLevel }> {
  const job = await one<JobRow>('select * from sched_jobs where id = $1', [id]);
  if (!job) throw notFound('Job not found');
  const conn = await one<ConnRow>('select * from connections where id = $1', [job.connection_id]);
  if (!conn) throw notFound('Job not found');
  const level = await connectionLevel(user, conn);
  if (level === 'none' && job.owner_id !== user.id) throw notFound('Job not found');
  return { job, conn, level };
}

function canManage(user: AuthUser, job: JobRow): boolean {
  return job.owner_id === user.id || hasRole(user, 'Admin');
}

async function validateJob(req: Parameters<typeof requireConn>[0], user: AuthUser, body: JobBody): Promise<{ conn: ConnRow; libraryVersion: number | null }> {
  validateCron(body.cron, body.timezone);
  if (!body.sql === !body.libraryId) throw badRequest('Give the job either SQL or a saved query');
  let libraryVersion: number | null = null;
  if (body.libraryId) {
    const lib = await loadVisible(user, body.libraryId);
    if (lib.owner_id !== user.id && !lib.allow_schedule) throw forbidden('The owner of that saved query does not allow scheduling it; fork it first');
    // Saving pins the version the editor sees now; later edits of the saved query do not reach the job.
    libraryVersion = lib.version;
  }
  const sql = await jobSql(user, { sql: body.sql, library_id: body.libraryId, library_version: libraryVersion, params: body.params });
  const { writes } = checkKind(body.kind, sql);
  const { conn, level } = await requireConn(req, body.connectionId, writes ? 'write' : 'read');
  if (writes && conn.require_approval) throw badRequest(`${APPROVAL_READS_ONLY}. ${conn.name} requires approval for writes; schedule a read, or run the change through an approval.`);
  // Same policy checks a real run would apply (blocked statements, read-only connections, whereless writes).
  await plan({ user, conn, level, sql, source: 'job', forceReadOnly: conn.require_approval });
  return { conn, libraryVersion };
}

function deliveryLabel(j: JobRow): string {
  return j.integration_id ? j.integration_id : 'store result only';
}

export default async function jobsModule(app: FastifyInstance): Promise<void> {
  registerWorker('workflow-tick', tick, '* * * * *');
  registerWorker<RunRequest>('workflow-job', async (d) => { await executeJob(d); });

  app.get('/jobs/cron/preview', async (req) => {
    userOf(req);
    const qs = parse(z.object({ cron: z.string().max(120), tz: z.string().max(64).default('UTC') }), req.query);
    try {
      if (!validTimezone(qs.tz)) return { ok: false, error: `Unknown timezone ${qs.tz}`, next: [] };
      return { ok: true, next: nextRuns(qs.cron, qs.tz, new Date(), 5) };
    } catch (e) {
      return { ok: false, error: (e as Error).message, next: [] };
    }
  });

  app.get('/jobs', async (req) => {
    const user = userOf(req);
    const rows = await q<JobRow & { conn_name: string; conn_color: string; conn_env: string; conn_env_id: string; owner_label: string; lib_name: string | null }>(
      `select j.*, c.name as conn_name, c.color as conn_color, c.env as conn_env, coalesce(nullif(u.name,''), u.email) as owner_label, l.name as lib_name
       from sched_jobs j join connections c on c.id = j.connection_id join users u on u.id = j.owner_id
       left join library_queries l on l.id = j.library_id order by j.created_at`);
    const runs = await q(`select job_id, status, started_at, error from (
        select r.*, row_number() over (partition by job_id order by id desc) as rn from sched_job_runs r) x where rn <= 7 order by id`);
    const out = [];
    for (const j of rows) {
      const level = await connectionLevel(user, { id: j.connection_id, env: j.conn_env as ConnRow['env'] });
      if (level === 'none' && j.owner_id !== user.id) continue;
      out.push({
        id: j.id, name: j.name, kind: j.kind, kindLabel: KIND_LABEL[j.kind] + (j.integration_id ? ' → ' + j.integration_id : ''), cron: j.cron, timezone: j.timezone,
        connection: { id: j.connection_id, name: j.conn_name, color: j.conn_color, env: j.conn_env }, delivery: deliveryLabel(j),
        library: j.library_id ? { id: j.library_id, name: (await loadVisible(user, j.library_id).then(() => true, () => false)) ? j.lib_name : '(private saved query)' } : null,
        runs: runs.filter((r) => r.job_id === j.id).map((r) => ({ status: r.status, at: r.started_at, error: r.error })),
        nextRunAt: j.state === 'active' ? j.next_run_at : null, state: j.state, owner: { id: j.owner_id, label: j.owner_label },
        canManage: canManage(user, j),
      });
    }
    return out;
  });

  app.get('/jobs/:id', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const { job, conn } = await loadJob(user, id);
    const history = await q(`select id, trigger, retry_of, attempt, status, started_at, finished_at, rows, ms, error, delivery from sched_job_runs where job_id = $1 order by id desc limit 50`, [id]);
    let libName: string | null = null;
    let sql = job.sql;
    let libLatest: number | null = null;
    if (job.library_id) {
      const lib = await one('select l.name, l.version, v.sql from library_queries l left join library_versions v on v.query_id = l.id and v.n = $2 where l.id = $1',
        [job.library_id, job.library_version]);
      // A private saved query stays invisible to other viewers of the job (same rule as the library).
      const visible = lib ? await loadVisible(user, job.library_id).then(() => true, () => false) : false;
      libName = lib ? (visible ? lib.name : '(private saved query)') : null;
      libLatest = lib && visible ? Number(lib.version) : null;
      sql = lib && visible ? lib.sql : null;
    }
    return {
      id: job.id, name: job.name, kind: job.kind, cron: job.cron, timezone: job.timezone, connectionId: job.connection_id, connectionName: conn.name,
      sql, libraryId: job.library_id, libraryName: libName, libraryVersion: job.library_version, libraryLatest: libLatest, params: job.params, integrationId: job.integration_id, options: opts(job.options),
      state: job.state, nextRunAt: job.state === 'active' ? job.next_run_at : null, canManage: canManage(user, job),
      nextRuns: (() => { try { return nextRuns(job.cron, job.timezone, new Date(), 5); } catch { return []; } })(),
      history: history.map((h) => ({ ...h, id: Number(h.id), retry_of: h.retry_of ? Number(h.retry_of) : null, rows: h.rows === null ? null : Number(h.rows) })),
    };
  });

  app.get('/jobs/runs/:runId', async (req) => {
    const user = userOf(req);
    const { runId } = parse(z.object({ runId: z.coerce.number().int().positive() }), req.params);
    const r = await one('select * from sched_job_runs where id = $1', [runId]);
    if (!r) throw notFound('Run not found');
    const { job } = await loadJob(user, r.job_id);
    void job;
    return { ...r, id: Number(r.id), rows: r.rows === null ? null : Number(r.rows) };
  });

  app.post('/jobs', async (req) => {
    const user = userOf(req);
    const body = parse(jobBody, req.body);
    const { conn, libraryVersion } = await validateJob(req, user, body);
    const next = body.state === 'active' ? nextRuns(body.cron, body.timezone, new Date(), 1)[0] : null;
    const row = await one(
      `insert into sched_jobs (name, kind, cron, timezone, connection_id, sql, library_id, library_version, params, integration_id, options, owner_id, state, next_run_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [body.name, body.kind, body.cron, body.timezone, body.connectionId, body.sql, body.libraryId, libraryVersion, body.params, body.integrationId, body.options, user.id, body.state, next ?? null],
    );
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'JOB', target: body.name, status: 'ok', ip: req.ip,
      detail: { action: 'create', id: row.id, cron: body.cron, kind: body.kind } });
    return { id: row.id };
  });

  app.put('/jobs/:id', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const { job } = await loadJob(user, id);
    if (!canManage(user, job)) throw forbidden('Only the owner or an Admin can edit this job');
    const body = parse(jobBody, req.body);
    // Saving makes the editor the owner: runs execute with the access level (and masking) of whoever
    // last chose the SQL, so an Admin can never borrow another user's access through their job.
    const { conn, libraryVersion } = await validateJob(req, user, body);
    const next = body.state === 'active' ? nextRuns(body.cron, body.timezone, new Date(), 1)[0] : null;
    await q(
      `update sched_jobs set name=$2, kind=$3, cron=$4, timezone=$5, connection_id=$6, sql=$7, library_id=$8, library_version=$9, params=$10, integration_id=$11, options=$12, state=$13, next_run_at=$14, owner_id=$15, updated_at=now() where id = $1`,
      [id, body.name, body.kind, body.cron, body.timezone, body.connectionId, body.sql, body.libraryId, libraryVersion, body.params, body.integrationId, body.options, body.state, next ?? null, user.id],
    );
    const reassigned = job.owner_id !== user.id;
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'JOB', target: body.name, status: 'ok', ip: req.ip,
      detail: { action: 'update', id, ...(reassigned ? { ownerFrom: job.owner_id, ownerTo: user.id } : {}) } });
    return { ok: true, ownerChanged: reassigned };
  });

  app.patch('/jobs/:id/state', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ state: z.enum(['active', 'paused']) }), req.body);
    const { job, conn } = await loadJob(user, id);
    if (!canManage(user, job)) throw forbidden('Only the owner or an Admin can pause or resume this job');
    const next = body.state === 'active' ? nextRuns(job.cron, job.timezone, new Date(), 1)[0] ?? null : null;
    await q('update sched_jobs set state = $2, next_run_at = $3, updated_at = now() where id = $1', [id, body.state, next]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'JOB', target: job.name, status: 'ok', ip: req.ip, detail: { action: body.state === 'active' ? 'resume' : 'pause', id } });
    return { state: body.state, nextRunAt: next };
  });

  app.delete('/jobs/:id', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const { job, conn } = await loadJob(user, id);
    if (!canManage(user, job)) throw forbidden('Only the owner or an Admin can delete this job');
    await q('delete from sched_jobs where id = $1', [id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'JOB', target: job.name, status: 'ok', ip: req.ip, detail: { action: 'delete', id } });
    return { ok: true };
  });

  // Ad-hoc run (does not shift the schedule). Runs as the job owner, inline, and returns the run.
  app.post('/jobs/:id/run', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const { job, conn } = await loadJob(user, id);
    if (!canManage(user, job)) throw forbidden('Only the owner or an Admin can run this job');
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'JOB', target: job.name, status: 'ok', ip: req.ip, detail: { action: 'run', id } });
    const runId = await executeJob({ jobId: id, trigger: 'manual' });
    return one('select id::int, status, rows::int, ms, error, delivery, started_at, finished_at from sched_job_runs where id = $1', [runId]);
  });

  app.post('/jobs/runs/:runId/retry', async (req) => {
    const user = userOf(req);
    const { runId } = parse(z.object({ runId: z.coerce.number().int().positive() }), req.params);
    const r = await one('select job_id from sched_job_runs where id = $1', [runId]);
    if (!r) throw notFound('Run not found');
    const { job, conn } = await loadJob(user, r.job_id);
    if (!canManage(user, job)) throw forbidden('Only the owner or an Admin can retry this job');
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'JOB', target: job.name, status: 'ok', ip: req.ip, detail: { action: 'retry', id: job.id, runId } });
    const id = await executeJob({ jobId: job.id, trigger: 'retry', retryOf: runId });
    return one('select id::int, status, rows::int, ms, error, delivery, started_at, finished_at from sched_job_runs where id = $1', [id]);
  });
}
