import pg from 'pg';
import Cursor from 'pg-cursor';
import type { AccessLevel, ColumnMeta, QueryResult, StatementKind } from '@comb/shared';
import { typeFamily } from '@comb/shared';
import { config } from '../config.ts';
import { audit } from '../security/audit.ts';
import { HttpError } from '../core/http.ts';
import { getPolicy } from '../core/settings.ts';
import { emit, notify } from '../core/events.ts';
import { q, one } from '../db/meta.ts';
import { randomToken } from '../security/crypto.ts';
import { levelAtLeast, type AuthUser, type ConnRow } from '../security/authz.ts';
import { classify, redactLiterals, SqlSyntaxError, type Classified } from './classify.ts';
import { checkout, withTarget, withTargetNoTxn } from './pool.ts';

/*
 * The single path by which user-originated SQL reaches a target database.
 * Decisions, in order:
 *   1. parse + classify every statement (syntax errors never reach the server)
 *   2. refuse blocked statements (transaction control, SET ROLE, COPY PROGRAM, ...)
 *   3. check the caller's access level for each statement's kind
 *   4. read-only connections and read-level users: only reads, inside BEGIN READ ONLY
 *   5. approval-required connections: writes become an approval request, reads run READ ONLY
 *   6. destructive statements need a typed confirmation of their target
 *   7. run each statement on its own over the extended protocol (one statement per message)
 *   8. audit every statement, ok or not
 */

export type RunSource = 'query' | 'grid' | 'approval' | 'job' | 'migration' | 'library' | 'quality' | 'roles' | 'system';

export interface RunOptions {
  user: AuthUser;
  conn: ConnRow;
  level: AccessLevel;
  sql: string;
  source: RunSource;
  /** Typed confirmation word sent by the client for destructive statements. */
  confirm?: string;
  maxRows?: number;
  ip?: string;
  /** Approval id when executing an approved request. */
  approvalId?: number;
  /** Lets a scheduled job or approval run writes on approval-required connections. */
  bypassApproval?: boolean;
  /** Runs everything inside a read-only transaction regardless of level. */
  forceReadOnly?: boolean;
  /** Lets exports exceed COMB_MAX_RESULT_ROWS (still bounded at 100k rows). */
  allowLargeResult?: boolean;
}

/** Field metadata handed to result filters (masking). tableID/columnID identify the source column. */
export interface ResultField {
  name: string;
  tableID: number;
  columnID: number;
  type: string;
}

/**
 * Result filters run on every row set before it leaves the server (query tab, grid, exports).
 * The data catalog registers one to apply column masking. Filters mutate rows in place.
 */
export type ResultFilter = (ctx: { conn: ConnRow; level: AccessLevel; user: AuthUser; fields: ResultField[]; rows: unknown[][] }) => Promise<void>;
const resultFilters: ResultFilter[] = [];
export function registerResultFilter(f: ResultFilter): void {
  resultFilters.push(f);
}
export async function applyResultFilters(ctx: Parameters<ResultFilter>[0]): Promise<void> {
  for (const f of resultFilters) await f(ctx);
}

interface Running {
  connId: string;
  userId: string;
  pid: number;
  conn: ConnRow;
}
const running = new Map<string, Running>();

const typeNames = new Map<string, Map<number, string>>();
async function typeName(conn: ConnRow, client: pg.PoolClient, oid: number): Promise<string> {
  let m = typeNames.get(conn.id);
  if (!m) typeNames.set(conn.id, (m = new Map()));
  if (!m.has(oid)) {
    const r = await client.query('select oid::int, format_type(oid, null) as name from pg_type where oid = any($1::oid[])', [[oid]]);
    for (const row of r.rows) m.set(row.oid, row.name);
    if (!m.has(oid)) m.set(oid, String(oid));
  }
  return m.get(oid)!;
}

function lineOf(text: string, pos: number): number {
  return text.slice(0, Math.max(0, pos - 1)).split('\n').length;
}

function blockedError(msg: string, pos?: number, sql?: string): HttpError {
  return new HttpError(400, msg, { code: 'COMB_BLOCKED', position: pos, line: pos && sql ? lineOf(sql, pos) : undefined });
}

function auditKind(c: Classified): string {
  return c.command.split(' ')[0] === 'EXPLAIN' ? 'EXPLAIN' : c.command.startsWith('DROP') ? 'DROP' : c.command.split(' ')[0];
}

/** Policy check without executing. Exported so the UI can preview what will happen. */
export async function plan(opts: RunOptions): Promise<{ stmts: Classified[]; readOnly: boolean; needsApproval: boolean }> {
  const { conn, level, sql } = opts;
  let stmts: Classified[];
  try {
    stmts = classify(sql);
  } catch (e) {
    if (e instanceof SqlSyntaxError) {
      throw new HttpError(400, e.message, { code: '42601', position: e.position, line: e.position ? lineOf(sql, e.position) : undefined });
    }
    throw e;
  }
  if (!stmts.length) throw new HttpError(400, 'Nothing to run');
  if (stmts.length > 50) throw new HttpError(400, 'At most 50 statements per run');

  const readOnly = !!opts.forceReadOnly || conn.read_only || level === 'read';
  const approvalGate = conn.require_approval && !opts.bypassApproval;
  let needsApproval = false;
  const policy = await getPolicy();

  for (const s of stmts) {
    const pos = s.start + 1;
    if (s.blocked) throw blockedError(s.blocked, pos, sql);
    const writes = s.kind !== 'read' && s.kind !== 'session';
    if (!writes) continue;
    if (readOnly) {
      const why = conn.read_only ? `${conn.name} is read-only` : opts.forceReadOnly ? 'This run is read-only' : `You have read access to ${conn.name}`;
      throw blockedError(`${why}; ${s.command} was not run.`, pos, sql);
    }
    if (s.kind === 'privilege' && !levelAtLeast(level, 'admin')) throw blockedError(`${s.command} needs admin access on ${conn.name}`, pos, sql);
    if (!levelAtLeast(level, 'write')) throw blockedError(`${s.command} needs write access on ${conn.name}`, pos, sql);
    if (s.noTxn && stmts.length > 1) throw blockedError(`${s.command} must run on its own`, pos, sql);
    if (policy.blockWhereless && s.destructive && (s.destructive.kind === 'UPDATE' || s.destructive.kind === 'DELETE')) {
      throw blockedError(`${s.destructive.kind} without WHERE is blocked by workspace policy. Add a WHERE clause (WHERE true if you mean every row, and an Admin can lift the policy).`, pos, sql);
    }
    const unattended = opts.source === 'approval' || opts.source === 'migration' || opts.source === 'job';
    if (approvalGate) needsApproval = true;
    else if (!unattended && s.destructive && policy.requireTypedConfirm) {
      const word = (s.destructive.target.split(', ')[0] ?? '').split('.').pop() ?? '';
      if (!opts.confirm || opts.confirm !== word) {
        throw new HttpError(409, `Type ${word} to confirm ${s.destructive.kind}`, {
          code: 'COMB_CONFIRM', confirm: { word, kind: s.destructive.kind, target: s.destructive.target, sql: s.sql },
        });
      }
    } else if (!unattended && conn.env === 'prod' && policy.typedConfirmProd && opts.confirm !== conn.name) {
      throw new HttpError(409, `Type ${conn.name} to write to production`, {
        code: 'COMB_CONFIRM', confirm: { word: conn.name, kind: s.command, target: conn.name, sql: s.sql },
      });
    }
  }
  return { stmts, readOnly: readOnly || (approvalGate && !needsApproval), needsApproval };
}

/**
 * Pre-write hooks run on the same client just before each write statement, and may return a finisher
 * that runs right after it, inside the same transaction. The audit module registers one to capture row
 * images; whatever a finisher returns is merged into that statement's audit detail. Hook errors never
 * fail the statement.
 */
type WriteFinisher = (client: pg.PoolClient) => Promise<Record<string, unknown> | null>;
export type PreWriteHook = (ctx: { conn: ConnRow; client: pg.PoolClient; stmt: Classified }) => Promise<WriteFinisher | null>;
const preWriteHooks: PreWriteHook[] = [];
export function registerPreWriteHook(h: PreWriteHook): void {
  preWriteHooks.push(h);
}

/** SQL as stored in the audit trail, honouring Settings → Safety → redact literals. */
async function auditSql(sql: string): Promise<string> {
  const text = (await getPolicy()).redactLiterals ? redactLiterals(sql) : sql;
  return text.slice(0, 20_000);
}

async function requestApproval(opts: RunOptions, stmts: Classified[]): Promise<number> {
  const writes = stmts.filter((s) => s.kind !== 'read');
  const kind = auditKind(writes[0]);
  const title = `${kind} ${writes[0].targets[0] ?? ''}`.trim() + (writes.length > 1 ? ` + ${writes.length - 1} more` : '');
  const row = await one(
    `insert into approvals (connection_id, author_id, kind, title, sql) values ($1,$2,$3,$4,$5) returning id`,
    [opts.conn.id, opts.user.id, kind, title, opts.sql],
  );
  const id = Number(row.id);
  await audit({
    actorId: opts.user.id, actorLabel: opts.user.email, connectionId: opts.conn.id, connectionName: opts.conn.name,
    kind, target: writes[0].targets[0] ?? null, sql: await auditSql(opts.sql), status: 'pending', ip: opts.ip, detail: { approvalId: id },
  });
  // Every Admin/Owner except the author is a potential approver.
  const approvers = await q(`select id from users where role in ('Owner','Admin') and status = 'active' and id <> $1`, [opts.user.id]);
  for (const a of approvers) {
    await notify({ userId: a.id, kind: 'appr', title: `Approval requested: ${title}`, body: `ap-${id} on ${opts.conn.name} by ${opts.user.email}`, target: 'approvals' });
  }
  emit('approval.requested', { approvalId: id, connection: opts.conn.name, kind, statements: writes.length });
  return id;
}

/** Runs SQL under the full policy. Returns the last row-returning statement's rows. */
export async function runSql(opts: RunOptions): Promise<QueryResult & { approvalId?: number }> {
  const { conn, user } = opts;
  const cap = opts.allowLargeResult ? 100_000 : config.COMB_MAX_RESULT_ROWS;
  const maxRows = Math.min(opts.maxRows ?? config.COMB_MAX_RESULT_ROWS, cap);
  let planned;
  try {
    planned = await plan(opts);
  } catch (e) {
    if (e instanceof HttpError && (e.extra?.code === 'COMB_BLOCKED' || e.status === 403)) {
      await audit({
        actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'BLOCKED',
        sql: await auditSql(opts.sql), status: 'blocked', ip: opts.ip, detail: { reason: e.message, source: opts.source },
      });
      emit('query.blocked', { connection: conn.name, reason: e.message.slice(0, 200) });
    }
    throw e;
  }
  const { stmts, readOnly, needsApproval } = planned;
  const runId = randomToken(12);

  if (needsApproval) {
    const approvalId = await requestApproval(opts, stmts);
    return { runId, statements: [], columns: [], rows: [], truncated: false, notices: [], ms: 0, approvalId };
  }

  const started = Date.now();
  const notices: QueryResult['notices'] = [];
  const statements: QueryResult['statements'] = [];
  let columns: ColumnMeta[] = [];
  let rows: unknown[][] = [];
  let truncated = false;

  const exec = async (client: pg.PoolClient) => {
    const onNotice = (n: { severity?: string; message?: string }) => notices.length < 200 && notices.push({ severity: n.severity ?? 'NOTICE', message: n.message ?? '' });
    client.on('notice', onNotice);
    const pid = (client as any).processID as number;
    running.set(runId, { connId: conn.id, userId: user.id, pid, conn });
    // Watchdog: statement_timeout is set per transaction, but cancel from outside as well in case
    // anything on the server side ignores it.
    const watchdog = setTimeout(() => {
      checkout(conn).then(async (c2) => {
        try {
          // Pooled backends are reused: only cancel while this exact run is still on that pid.
          if (running.get(runId)?.pid === pid) await c2.query('select pg_cancel_backend($1)', [pid]);
        } finally { c2.release(); }
      }).catch(() => {});
    }, config.COMB_STATEMENT_TIMEOUT_MS + 5_000);
    try {
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        const t0 = Date.now();
        try {
          const finishers = s.kind === 'read' || readOnly ? [] :
            (await Promise.all(preWriteHooks.map((h) => h({ conn, client, stmt: s }).catch(() => null)))).filter((f): f is WriteFinisher => !!f);
          // pg-cursor uses the extended protocol: the server accepts exactly one statement.
          const cur = client.query(new Cursor(s.sql, [], { rowMode: 'array' }));
          const got: unknown[][] = await cur.read(maxRows + 1);
          const result = (cur as any)._result as pg.QueryResult | undefined;
          const fields = result?.fields ?? [];
          await new Promise<void>((res) => cur.close(() => res()));
          const rowCount = result?.rowCount ?? (fields.length ? got.length : null);
          const ms = Date.now() - t0;
          statements.push({ command: s.command, kind: s.kind as StatementKind, rowCount: got.length > maxRows ? null : rowCount, ms });
          if (fields.length) {
            truncated = got.length > maxRows;
            rows = truncated ? got.slice(0, maxRows) : got;
            columns = [];
            const rf: ResultField[] = [];
            for (const f of fields) {
              const tn = await typeName(conn, client, f.dataTypeID);
              columns.push({ name: f.name, type: tn, family: typeFamily(tn) });
              rf.push({ name: f.name, tableID: f.tableID, columnID: f.columnID, type: tn });
            }
            await applyResultFilters({ conn, level: opts.level, user, fields: rf, rows });
          }
          const hookDetail: Record<string, unknown> = {};
          for (const f of finishers) Object.assign(hookDetail, (await f(client).catch(() => null)) ?? {});
          await audit({
            actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: auditKind(s),
            target: s.targets[0] ?? null, sql: await auditSql(s.sql), rows: fields.length ? rows.length : rowCount, ms, status: 'ok', ip: opts.ip,
            detail: { ...hookDetail, source: opts.source, ...(opts.approvalId ? { approvalId: opts.approvalId } : {}) },
          });
        } catch (e: any) {
          const ms = Date.now() - t0;
          // Error messages can quote values (e.g. a duplicate key); drop them when literals are redacted.
          const redact = (await getPolicy()).redactLiterals;
          await audit({
            actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: auditKind(s),
            target: s.targets[0] ?? null, sql: await auditSql(s.sql), ms, status: 'error', ip: opts.ip,
            detail: { source: opts.source, code: e?.code ?? null, ...(redact ? {} : { message: String(e?.message ?? '').slice(0, 500) }) },
          });
          const posInStmt = e?.position ? Number(e.position) : undefined;
          const absolute = posInStmt ? s.start + posInStmt : s.start + 1;
          throw new HttpError(400, e?.message ?? 'Query failed', {
            code: e?.code, position: absolute, line: lineOf(opts.sql, absolute), detail: e?.detail, hint: e?.hint, statementIndex: i,
          });
        }
      }
    } finally {
      clearTimeout(watchdog);
      running.delete(runId);
      client.off('notice', onNotice);
    }
  };

  const tOpts = { readOnly, actor: user.email };
  if (stmts.length === 1 && stmts[0].noTxn) await withTargetNoTxn(conn, tOpts, exec);
  else await withTarget(conn, tOpts, exec);

  return { runId, statements, columns, rows, truncated, notices, ms: Date.now() - started };
}

/** Lets the client learn the run id before results arrive, so Stop can work. */
export function newRunId(): string {
  return randomToken(12);
}

export function runningFor(userId: string): string[] {
  return [...running.entries()].filter(([, r]) => r.userId === userId).map(([id]) => id);
}

/** Cancels the caller's own running statements on a connection. */
export async function cancelRuns(user: AuthUser, connId: string): Promise<number> {
  const mine = [...running.entries()].filter(([, r]) => r.userId === user.id && r.connId === connId);
  for (const [runId, r] of mine) {
    // A second pooled connection, same database role, so pg_cancel_backend is permitted.
    const c = await checkout(r.conn);
    try {
      // Re-check after checkout: the run may have finished and its backend been handed to someone else.
      if (running.get(runId)?.pid === r.pid) await c.query('select pg_cancel_backend($1)', [r.pid]);
    } finally {
      c.release();
    }
  }
  return mine.length;
}

export { checkout };
