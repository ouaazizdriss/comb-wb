import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessLevel } from '@comb/shared';
import { q, one } from '../db/meta.ts';
import { parse, badRequest, forbidden, notFound, conflict, HttpError } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { emit, notify } from '../core/events.ts';
import { config } from '../config.ts';
import { userOf, hasRole, connectionLevel, levelAtLeast, type AuthUser, type ConnRow } from '../security/authz.ts';
import { classify, type Classified } from '../targets/classify.ts';
import { withTarget } from '../targets/pool.ts';
import { runSql, plan } from '../targets/exec.ts';

/*
 * Approvals (gov module).
 *
 * Core turns writes on approval-required connections into `approvals` rows. This module is the
 * review side: list, detail with facts/warnings/dry run, thread, and the decision.
 *
 * Policy: writes on prod need one approver who did not author them. An approver is an Admin/Owner
 * or a user with connection level admin, and is never the author (enforced here, server-side).
 * Approving applies the statements immediately through runSql(source 'approval', bypassApproval)
 * with the approver as executor; the author is recorded in the APPROVAL audit event.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });
const BIG_ESTIMATE = 1000;
const DRY_RUN_TIMEOUT_MS = 30_000;

interface ApprovalRow {
  id: string;
  connection_id: string;
  author_id: string;
  kind: string;
  title: string;
  sql: string;
  state: string;
  est_rows: string | null;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  applied_at: Date | null;
  result: any;
}

/** Approver: Admin/Owner by workspace role, or admin level on the connection. */
async function approverInfo(user: AuthUser, conn: ConnRow): Promise<{ level: AccessLevel; approver: boolean }> {
  const level = await connectionLevel(user, conn);
  const byRole = hasRole(user, 'Admin') && (user.via !== 'token' || !!user.scopes?.includes('admin'));
  return { level, approver: byRole || levelAtLeast(level, 'admin') };
}

/**
 * The level the approved statements run with. Approval by an Admin/Owner is itself the authorisation
 * for a data write (their default level on prod is read), so it is raised to at least `write`.
 * Privilege statements still need the approver to hold admin level; plan() enforces that.
 */
function executorLevel(level: AccessLevel): AccessLevel {
  return levelAtLeast(level, 'write') ? level : 'write';
}

async function loadVisible(req: FastifyRequest, id: number) {
  const user = userOf(req);
  const a = await one<ApprovalRow>('select * from approvals where id = $1', [id]);
  if (!a) throw notFound('Approval not found');
  const conn = await one<ConnRow>('select * from connections where id = $1', [a.connection_id]);
  if (!conn) throw notFound('Approval not found');
  const info = await approverInfo(user, conn);
  // Visible to its author, to approvers, and to nobody else (the SQL can contain sensitive literals).
  if (a.author_id !== user.id && !info.approver) throw notFound('Approval not found');
  return { user, a, conn, ...info };
}

function parseStatements(sql: string): Classified[] {
  try {
    return classify(sql);
  } catch {
    return [];
  }
}

function isWrite(s: Classified): boolean {
  return s.kind !== 'read' && s.kind !== 'session';
}

/** EXPLAIN (FORMAT JSON) per DML statement, read-only through runSql. Cached in approval_checks. */
async function estimate(a: ApprovalRow, conn: ConnRow, user: AuthUser, ip: string) {
  const stmts = parseStatements(a.sql).filter(isWrite);
  const out: Array<{ index: number; command: string; target: string | null; rows: number | null; error: string | null }> = [];
  for (const [i, s] of stmts.entries()) {
    const target = s.targets[0] ?? null;
    if (!['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(s.command)) {
      out.push({ index: i, command: s.command, target, rows: null, error: null });
      continue;
    }
    try {
      // EXPLAIN without ANALYZE is classified as a read and never executes the statement;
      // forceReadOnly makes Postgres itself refuse anything else.
      const r = await runSql({ user, conn, level: 'read', sql: `explain (format json) ${s.sql}`, source: 'approval', forceReadOnly: true, ip, approvalId: Number(a.id) });
      const doc = r.rows[0]?.[0] as any;
      const planJson = (typeof doc === 'string' ? JSON.parse(doc) : doc)?.[0]?.Plan;
      const node = planJson?.['Node Type'] === 'ModifyTable' && planJson.Plans?.[0] ? planJson.Plans[0] : planJson;
      out.push({ index: i, command: s.command, target, rows: node ? Math.round(Number(node['Plan Rows'])) : null, error: null });
    } catch (e) {
      out.push({ index: i, command: s.command, target, rows: null, error: (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}

async function warningsFor(a: ApprovalRow, conn: ConnRow, user: AuthUser, est: Array<{ rows: number | null; target: string | null; command: string }>) {
  const w: Array<{ title: string; body: string }> = [];
  const stmts = parseStatements(a.sql).filter(isWrite);
  const total = est.reduce((n, e) => n + (e.rows ?? 0), 0);
  if (total > BIG_ESTIMATE) w.push({ title: `Touches about ${total.toLocaleString('en-US')} rows`, body: `The planner estimates more than ${BIG_ESTIMATE.toLocaleString('en-US')} rows. Check the WHERE clause matches what the author intended.` });
  for (const s of stmts) {
    if (s.destructive && (s.destructive.kind === 'UPDATE' || s.destructive.kind === 'DELETE')) {
      w.push({ title: `${s.destructive.kind} without WHERE`, body: `${s.destructive.kind} on ${s.destructive.target} has no WHERE clause, so it applies to every row.` });
    }
    if (s.command.startsWith('DROP') || s.command === 'TRUNCATE') {
      w.push({ title: 'No down path', body: `${s.command} ${s.destructive?.target ?? s.targets.join(', ')} cannot be reverted from Comb. Make sure a recent backup exists before approving.` });
    }
  }
  const rels = [...new Set(stmts.filter((s) => ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(s.command)).flatMap((s) => s.targets))];
  if (rels.length) {
    try {
      const noPk = await withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
        const r = await c.query(
          `select u.name from unnest($1::text[]) u(name)
            where to_regclass(u.name) is not null
              and not exists (select 1 from pg_index i where i.indrelid = to_regclass(u.name) and i.indisprimary)`, [rels]);
        return r.rows.map((x) => x.name as string);
      });
      if (noPk.length) w.push({ title: `No primary key on ${noPk.join(', ')}`, body: 'Rows cannot be identified individually, so no row diff or compensating SQL can be produced for this change.' });
    } catch {
      /* identifiers the catalog cannot resolve are reported by the estimate/dry run instead */
    }
  }
  return w;
}

async function ensureChecks(a: ApprovalRow, conn: ConnRow, user: AuthUser, ip: string, refresh = false) {
  let c = await one('select * from approval_checks where approval_id = $1', [a.id]);
  if (!c || !c.estimated_at || refresh) {
    const est = await estimate(a, conn, user, ip);
    const warnings = await warningsFor(a, conn, user, est);
    const sum = est.some((e) => e.rows !== null) ? est.reduce((n, e) => n + (e.rows ?? 0), 0) : null;
    c = await one(
      `insert into approval_checks (approval_id, estimates, warnings, estimated_at) values ($1,$2,$3,now())
       on conflict (approval_id) do update set estimates = excluded.estimates, warnings = excluded.warnings, estimated_at = now() returning *`,
      [a.id, JSON.stringify(est), JSON.stringify(warnings)]);
    if (sum !== null) await q('update approvals set est_rows = $2 where id = $1', [a.id, sum]);
  }
  return c;
}

async function detail(req: FastifyRequest, id: number, refresh = false) {
  const { user, a, conn, approver } = await loadVisible(req, id);
  const fresh = (await one<ApprovalRow>('select * from approvals where id = $1', [id]))!;
  const checks = fresh.state === 'pending' ? await ensureChecks(fresh, conn, user, req.ip, refresh) : await one('select * from approval_checks where approval_id = $1', [id]);
  const after = (await one<ApprovalRow>('select * from approvals where id = $1', [id]))!;
  const people = await q('select id, email, name from users where id = any($1::uuid[])', [[a.author_id, after.decided_by].filter(Boolean)]);
  const who = (uid: string | null) => people.find((p) => p.id === uid) ?? null;
  const comments = await q(
    `select c.id, c.body, c.created_at, u.email, u.name, c.user_id from approval_comments c join users u on u.id = c.user_id where c.approval_id = $1 order by c.id`, [id]);
  const stmts = parseStatements(after.sql);
  const isAuthor = after.author_id === user.id;
  return {
    id: Number(after.id), kind: after.kind, title: after.title, sql: after.sql, state: after.state,
    estRows: after.est_rows === null ? null : Number(after.est_rows), createdAt: after.created_at, decidedAt: after.decided_at, appliedAt: after.applied_at,
    result: after.result, author: who(after.author_id), decidedBy: who(after.decided_by),
    connection: { id: conn.id, name: conn.name, env: conn.env, color: conn.color },
    statements: stmts.map((s) => ({ command: s.command, kind: s.kind, targets: s.targets })),
    estimates: checks?.estimates ?? [], warnings: checks?.warnings ?? [], dryRun: checks?.dry_run ?? null, dryRunAt: checks?.dry_run_at ?? null,
    comments: comments.map((c) => ({ id: Number(c.id), body: c.body, at: c.created_at, who: c.email, name: c.name, isAuthor: c.user_id === after.author_id })),
    can: {
      approve: after.state === 'pending' && approver && !isAuthor,
      reject: after.state === 'pending' && approver && !isAuthor,
      withdraw: after.state === 'pending' && isAuthor,
      dryRun: after.state === 'pending' && approver,
    },
    isAuthor,
  };
}

async function decided(a: { id: string | number; author_id: string; title: string }, conn: ConnRow, decision: string, by: AuthUser, extra = '') {
  await notify({ userId: a.author_id, kind: 'appr', title: `ap-${a.id} ${decision}: ${a.title}`, body: `${decision} by ${by.email} on ${conn.name}${extra ? ' · ' + extra : ''}`, target: 'approvals' });
  emit('approval.decided', { approvalId: Number(a.id), decision, connection: conn.name });
}

class DryRunRollback extends Error {
  constructor(public steps: any[]) {
    super('dry run rollback');
  }
}

export default async function approvalsModule(app: FastifyInstance): Promise<void> {
  app.get('/approvals', async (req) => {
    const user = userOf(req);
    const { filter } = parse(z.object({ filter: z.enum(['waiting-on-me', 'open', 'mine', 'decided', 'all']).default('waiting-on-me') }), req.query);
    const rows = await q(
      `select a.id, a.connection_id, a.author_id, a.kind, a.title, a.state, a.est_rows, a.created_at, a.decided_at,
              au.email as author, d.email as decided_by, c.name as conn_name, c.env, c.color
         from approvals a join connections c on c.id = a.connection_id join users au on au.id = a.author_id left join users d on d.id = a.decided_by
        where a.created_at > now() - interval '180 days' order by a.id desc limit 500`);
    const connCache = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      let approver = connCache.get(r.connection_id);
      if (approver === undefined) {
        const conn = await one<ConnRow>('select * from connections where id = $1', [r.connection_id]);
        approver = conn ? (await approverInfo(user, conn)).approver : false;
        connCache.set(r.connection_id, approver);
      }
      const mine = r.author_id === user.id;
      if (!mine && !approver) continue;
      const pending = r.state === 'pending';
      const keep = filter === 'all' || (filter === 'waiting-on-me' && pending && !mine && approver) || (filter === 'open' && pending) ||
        (filter === 'mine' && mine) || (filter === 'decided' && !pending);
      if (!keep) continue;
      out.push({
        id: Number(r.id), kind: r.kind, title: r.title, state: r.state, estRows: r.est_rows === null ? null : Number(r.est_rows), createdAt: r.created_at,
        decidedAt: r.decided_at, author: r.author, decidedBy: r.decided_by, connection: { id: r.connection_id, name: r.conn_name, env: r.env, color: r.color }, mine,
      });
    }
    const stats = await one(
      `select (select count(*) from approvals where state = 'pending')::int as pending,
              percentile_cont(0.5) within group (order by extract(epoch from decided_at - created_at)) as median_s
         from approvals where decided_at is not null and decided_at > now() - interval '30 days'`);
    return { rows: out, pending: stats?.pending ?? 0, medianDecisionSeconds: stats?.median_s === null || stats?.median_s === undefined ? null : Math.round(Number(stats.median_s)) };
  });

  app.get('/approvals/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { refresh } = parse(z.object({ refresh: z.enum(['1', '0']).optional() }), req.query);
    return detail(req, id, refresh === '1');
  });

  app.post('/approvals/:id/comments', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
    const { user, a, conn } = await loadVisible(req, id);
    await q('insert into approval_comments (approval_id, user_id, body) values ($1,$2,$3)', [id, user.id, body.body]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'APPROVAL', target: `ap-${id}`, status: 'ok', ip: req.ip,
      detail: { action: 'comment', approvalId: id } });
    if (a.author_id !== user.id) {
      await notify({ userId: a.author_id, kind: 'appr', title: `Comment on ap-${id}`, body: `${user.email}: ${body.body.slice(0, 140)}`, target: 'approvals' });
    }
    return detail(req, id);
  });

  app.post('/approvals/:id/withdraw', async (req) => {
    const { id } = parse(idParam, req.params);
    const { user, a, conn } = await loadVisible(req, id);
    if (a.author_id !== user.id) throw forbidden('Only the author can withdraw a request');
    const r = await one(`update approvals set state = 'withdrawn', decided_by = $2, decided_at = now() where id = $1 and state = 'pending' and author_id = $2 returning id`, [id, user.id]);
    if (!r) throw conflict(`ap-${id} is no longer pending`);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'APPROVAL', target: `ap-${id}`, status: 'ok', ip: req.ip,
      detail: { action: 'withdraw', approvalId: id } });
    emit('approval.decided', { approvalId: id, decision: 'withdrawn', connection: conn.name });
    return detail(req, id);
  });

  app.post('/approvals/:id/reject', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ note: z.string().trim().max(4000).optional() }), req.body ?? {});
    const { user, a, conn, approver } = await loadVisible(req, id);
    if (a.author_id === user.id) throw forbidden(`You authored ap-${id}. Withdraw it instead; someone else decides on it.`);
    if (!approver) throw forbidden('Only an Admin, Owner or connection admin can decide on approvals');
    const r = await one(`update approvals set state = 'rejected', decided_by = $2, decided_at = now() where id = $1 and state = 'pending' and author_id <> $2 returning id`, [id, user.id]);
    if (!r) throw conflict(`ap-${id} is no longer pending`);
    if (body.note) await q('insert into approval_comments (approval_id, user_id, body) values ($1,$2,$3)', [id, user.id, body.note]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'APPROVAL', target: `ap-${id}`, status: 'ok', ip: req.ip,
      detail: { action: 'reject', approvalId: id, authorId: a.author_id } });
    await decided(a, conn, 'rejected', user);
    return detail(req, id);
  });

  app.post('/approvals/:id/approve', async (req) => {
    const { id } = parse(idParam, req.params);
    const { user, a, conn, approver, level } = await loadVisible(req, id);
    if (a.author_id === user.id) throw forbidden(`You authored ap-${id}; someone else has to approve it.`);
    if (!approver) throw forbidden('Only an Admin, Owner or connection admin can approve');
    if (a.state !== 'pending') throw conflict(`ap-${id} is already ${a.state}`);
    const execLevel = executorLevel(level);
    const runOpts = { user, conn, level: execLevel, sql: a.sql, source: 'approval' as const, bypassApproval: true, approvalId: id, ip: req.ip };
    // Check policy before claiming the request, so an approval that could never run stays pending.
    try {
      await plan(runOpts);
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status === 409 ? 400 : e.status, `Cannot apply as ${user.email}: ${e.message}`, { code: e.extra?.code });
      throw e;
    }
    // Race-safe claim: exactly one approver flips pending → approved.
    const claimed = await one(`update approvals set state = 'approved', decided_by = $2, decided_at = now() where id = $1 and state = 'pending' and author_id <> $2 returning id`, [id, user.id]);
    if (!claimed) throw conflict(`ap-${id} was decided by someone else a moment ago`);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'APPROVAL', target: `ap-${id}`, status: 'ok', ip: req.ip,
      detail: { action: 'approve', approvalId: id, authorId: a.author_id, executor: user.email, level: execLevel } });
    try {
      const r = await runSql(runOpts);
      const result = { ok: true, statements: r.statements, ms: r.ms, notices: r.notices.slice(0, 20) };
      await q(`update approvals set state = 'applied', applied_at = now(), result = $2 where id = $1 and state = 'approved'`, [id, JSON.stringify(result)]);
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'APPROVAL', target: `ap-${id}`, status: 'ok', ip: req.ip,
        ms: r.ms, rows: r.statements.reduce((n, s) => n + (s.rowCount ?? 0), 0), detail: { action: 'apply', approvalId: id, authorId: a.author_id, executor: user.email } });
      await decided(a, conn, 'applied', user, `${r.statements.length} statement${r.statements.length === 1 ? '' : 's'} in ${r.ms} ms`);
    } catch (e: any) {
      const result = { ok: false, error: String(e?.message ?? e).slice(0, 1000), code: e?.extra?.code ?? e?.code ?? null, statementIndex: e?.extra?.statementIndex ?? null };
      await q(`update approvals set state = 'failed', applied_at = now(), result = $2 where id = $1 and state = 'approved'`, [id, JSON.stringify(result)]);
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'APPROVAL', target: `ap-${id}`, status: 'error', ip: req.ip,
        detail: { action: 'apply', approvalId: id, authorId: a.author_id, executor: user.email, error: result.error.slice(0, 300) } });
      await decided(a, conn, 'failed', user, result.error.slice(0, 120));
    }
    return detail(req, id);
  });

  /*
   * Dry run "against a branch of the schema": the request's statements run for real inside a
   * transaction that is ALWAYS rolled back (we throw DryRunRollback at the end, withTarget rolls back).
   * Why this is safe enough to offer on prod:
   *   - nothing commits: every row change, DDL and lock is undone by the rollback;
   *   - SET LOCAL lock_timeout = '2s' means it never queues behind (or in front of) other sessions
   *     for long; statement_timeout caps total runtime at 30 s;
   *   - statements that cannot run in a transaction block (VACUUM, CONCURRENTLY) are refused;
   *   - only approvers can trigger it, and it is audited as DRYRUN.
   * Caveats reported to the user: sequence values consumed by nextval() are not rolled back, and
   * row locks are held for the duration of the run.
   */
  app.post('/approvals/:id/dry-run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { user, a, conn, approver, level } = await loadVisible(req, id);
    if (!approver) throw forbidden('Only an Admin, Owner or connection admin can dry-run a request');
    if (a.state !== 'pending') throw conflict(`ap-${id} is already ${a.state}`);
    if (conn.read_only) throw badRequest(`${conn.name} is read-only, so a dry run (which writes, then rolls back) is not possible`);
    const planned = await plan({ user, conn, level: executorLevel(level), sql: a.sql, source: 'approval', bypassApproval: true, approvalId: id }).catch((e: Error) => {
      throw badRequest('Dry run refused: ' + e.message);
    });
    if (planned.stmts.some((s) => s.noTxn)) throw badRequest('Statements that must run outside a transaction cannot be dry-run');
    const t0 = Date.now();
    let steps: any[] = [];
    try {
      await withTarget(conn, { readOnly: false, actor: user.email, timeoutMs: Math.min(DRY_RUN_TIMEOUT_MS, config.COMB_STATEMENT_TIMEOUT_MS) }, async (c) => {
        await c.query(`set local lock_timeout = '2s'`);
        const out: any[] = [];
        for (const [i, s] of planned.stmts.entries()) {
          const s0 = Date.now();
          try {
            const r = await c.query({ text: s.sql, queryMode: 'extended' } as any);
            const locks = await c.query(
              `select distinct mode from pg_locks where pid = pg_backend_pid() and locktype = 'relation' and granted and relation is not null
                 and relation not in (select oid from pg_class where relnamespace = 'pg_catalog'::regnamespace)`);
            out.push({ index: i, command: s.command, target: s.targets[0] ?? null, ok: true, rows: r.rowCount ?? null, ms: Date.now() - s0, locks: locks.rows.map((x) => x.mode) });
          } catch (e: any) {
            out.push({ index: i, command: s.command, target: s.targets[0] ?? null, ok: false, ms: Date.now() - s0, code: e?.code ?? null,
              error: e?.code === '55P03' ? 'Lock wait exceeded 2 s: another session holds a conflicting lock.' : String(e?.message ?? e).slice(0, 300) });
            break;
          }
        }
        throw new DryRunRollback(out);
      });
    } catch (e) {
      if (e instanceof DryRunRollback) steps = e.steps;
      else steps = [{ index: 0, ok: false, error: String((e as Error).message).slice(0, 300) }];
    }
    const result = { ok: steps.length === planned.stmts.length && steps.every((s) => s.ok), steps, ms: Date.now() - t0, rolledBack: true };
    await q(
      `insert into approval_checks (approval_id, dry_run, dry_run_at, dry_run_by) values ($1,$2,now(),$3)
       on conflict (approval_id) do update set dry_run = excluded.dry_run, dry_run_at = now(), dry_run_by = excluded.dry_run_by`,
      [id, JSON.stringify(result), user.id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DRYRUN', target: `ap-${id}`,
      rows: steps.reduce((n, s) => n + (s.rows ?? 0), 0), ms: result.ms, status: result.ok ? 'ok' : 'error', ip: req.ip,
      detail: { approvalId: id, statements: steps.length, rolledBack: true } });
    return detail(req, id);
  });
}
