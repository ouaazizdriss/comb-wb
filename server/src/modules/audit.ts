import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { parseSync, scanSync } from 'libpg-query';
import { z } from 'zod';
import type { AccessLevel } from '@comb/shared';
import { q, one } from '../db/meta.ts';
import { parse, forbidden, notFound } from '../core/http.ts';
import { audit, verifyChain } from '../security/audit.ts';
import { encryptSecret, decryptSecret } from '../security/crypto.ts';
import { userOf, hasRole, connectionLevel, type AuthUser, type ConnRow } from '../security/authz.ts';
import { getPolicy, getSetting, setSetting } from '../core/settings.ts';
import { registerWorker } from '../core/jobs.ts';
import { initClassifier, type Classified } from '../targets/classify.ts';
import { escapeIdent, escapeLit } from '../targets/pool.ts';
import * as exec from '../targets/exec.ts';

/*
 * Audit trail (gov module).
 *
 * audit_log is append-only and hash-chained (security/audit.ts). This module only reads it:
 * search with keyset pagination, event detail, chain verification, CSV export, the caller's own
 * history for the sidebar, and an archiving job. Nothing here updates or deletes audit rows.
 *
 * Who sees what: Admin and Owner see every event; an Analyst sees only their own events;
 * Viewer and Service get 403.
 */

const RETENTION_DAYS = 400;
const WRITES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'MERGE', 'COPY', 'CALL', 'DO', 'LOCK'];
const READS = ['SELECT', 'EXPLAIN', 'EXPORT', 'SHOW', 'VALUES'];
const SCHEMA = ['CREATE', 'ALTER', 'DROP', 'MIGRATE', 'GRANT', 'REVOKE', 'COMMENT', 'REFRESH', 'REINDEX', 'TERMINATE'];
const WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', all: null } as const;

const listQuery = z.object({
  q: z.string().max(200).optional(),
  actor: z.string().max(320).optional(),
  kind: z.enum(['All', 'Writes', 'Reads', 'Schema']).default('All'),
  window: z.enum(['24h', '7d', '30d', '90d', 'all']).default('7d'),
  connectionId: z.string().uuid().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
type ListQuery = z.infer<typeof listQuery>;

/** Admin+ see everything; Analysts only their own events; everyone else is refused. */
function auditScope(req: FastifyRequest): { user: AuthUser; ownOnly: boolean } {
  const user = userOf(req);
  if (hasRole(user, 'Admin') && (user.via !== 'token' || user.scopes?.includes('admin'))) return { user, ownOnly: false };
  if (user.role === 'Analyst') return { user, ownOnly: true };
  throw forbidden('The audit trail needs the Admin role (Analysts see their own events)');
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

/** Builds the WHERE clause for list/export. Every value is a bind parameter. */
function filters(f: ListQuery, scope: { user: AuthUser; ownOnly: boolean }): { where: string; params: unknown[] } {
  const w: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    w.push(sql.replace(/\$\?/g, '$' + p.length));
  };
  if (scope.ownOnly) add('a.actor_id = $?', scope.user.id);
  const win = WINDOWS[f.window];
  if (win) add(`a.at > now() - $?::interval`, win);
  if (f.actor && f.actor !== 'All') add('a.actor_label = $?', f.actor);
  if (f.connectionId) add('a.connection_id = $?', f.connectionId);
  if (f.kind === 'Writes') add('a.kind = any($?::text[])', WRITES);
  if (f.kind === 'Reads') add('a.kind = any($?::text[])', READS);
  if (f.kind === 'Schema') add('a.kind = any($?::text[])', SCHEMA);
  if (f.q?.trim()) {
    add(`(a.sql ilike $? or a.actor_label ilike $? or a.target ilike $? or a.kind ilike $? or a.connection_name ilike $?)`, '%' + likeEscape(f.q.trim()) + '%');
  }
  return { where: w.length ? 'where ' + w.join(' and ') : '', params: p };
}

function rowOut(r: any) {
  return {
    id: Number(r.id), at: r.at, actor: r.actor_label, actorId: r.actor_id, connectionId: r.connection_id, connection: r.connection_name,
    color: r.color ?? null, env: r.env ?? null, kind: r.kind, target: r.target, rows: r.rows === null ? null : Number(r.rows), ms: r.ms,
    status: r.status, source: r.detail?.source ?? null, approvalId: r.detail?.approvalId ?? null,
  };
}

/** CSV with the same formula-injection guard as web/src/lib/format.ts toCsv. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

let verifyCache: { at: number; value: Awaited<ReturnType<typeof verifyChain>> } | null = null;
async function verifyCached() {
  if (!verifyCache || Date.now() - verifyCache.at > 15_000) verifyCache = { at: Date.now(), value: await verifyChain() };
  return verifyCache.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row-level diffs
//
// captureDiff() selects the rows an UPDATE or DELETE is about to touch, inside the same
// transaction and just before the write, then (after the write) the new images of those rows.
// For INSERT it finds the rows created by the current transaction (xmin = current xid).
// It needs core to call a pre-write hook from runSql; see the registration at the bottom and the
// proposed exec.ts diff in the gov report. Capture is best effort and never blocks a write:
// every query runs inside a savepoint, and any failure just means "no diff recorded".
// ─────────────────────────────────────────────────────────────────────────────

const DIFF_CAP = 1000;
const INSERT_SCAN_MAX_ROWS = 500_000;
/** Functions that are safe to evaluate a second time while re-running a WHERE clause. */
const SAFE_FUNCS = new Set([
  'now', 'lower', 'upper', 'length', 'char_length', 'trim', 'btrim', 'ltrim', 'rtrim', 'abs', 'round', 'floor', 'ceil', 'date_trunc', 'date_part',
  'extract', 'to_date', 'to_timestamp', 'to_char', 'coalesce', 'nullif', 'greatest', 'least', 'any', 'array_length', 'cardinality', 'jsonb_extract_path_text',
  'json_extract_path_text', 'position', 'substring', 'substr', 'left', 'right', 'concat', 'md5', 'statement_timestamp', 'transaction_timestamp',
  'make_interval', 'make_date', 'age', 'timezone', 'starts_with', 'regexp_like', 'array_position',
]);

export interface DiffField {
  name: string;
  type: string;
  tableID: number;
  columnID: number;
  generated: boolean;
  identityAlways: boolean;
}

export interface DiffCapture {
  /** Called after the write succeeded, on the same client. Returns the stored diff id. */
  finish: (client: pg.PoolClient) => Promise<{ diffId: string } | null>;
}

function walkNodes(node: unknown, visit: (key: string, value: any) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walkNodes(n, visit);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      visit(k, v);
      walkNodes(v, visit);
    }
  }
}

/** True when every function called in the subtree is known to be side-effect free. */
function onlySafeFunctions(node: unknown): boolean {
  let ok = true;
  walkNodes(node, (k, v) => {
    if (k === 'FuncCall') {
      const name = (v?.funcname ?? []).map((n: any) => n?.String?.sval).filter(Boolean).pop();
      if (!name || !SAFE_FUNCS.has(String(name).toLowerCase())) ok = false;
    }
    if (k === 'InsertStmt' || k === 'UpdateStmt' || k === 'DeleteStmt' || k === 'MergeStmt' || k === 'RangeFunction') ok = false;
  });
  return ok;
}

/** Splits an UPDATE/DELETE into its FROM/USING text and WHERE text, using the real scanner. */
function clauses(sql: string, kind: 'UPDATE' | 'DELETE'): { from: string | null; where: string | null } {
  const toks = scanSync(sql).tokens as Array<{ start: number; end: number; text: string; keywordKind: number }>;
  let depth = 0;
  const marks: Record<string, number> = {};
  let prev = '';
  let sawSet = kind === 'DELETE';
  let sawFirstFrom = kind === 'UPDATE';
  for (const t of toks) {
    const w = t.keywordKind ? t.text.toLowerCase() : '';
    if (t.text === '(' || t.text === '[') depth++;
    else if (t.text === ')' || t.text === ']') depth--;
    else if (depth === 0 && w) {
      if (w === 'set') sawSet = true;
      else if (w === 'from' && kind === 'DELETE' && !sawFirstFrom) sawFirstFrom = true; // DELETE FROM <rel>
      else if (w === 'from' && kind === 'UPDATE' && sawSet && prev !== 'distinct' && marks.from === undefined && marks.where === undefined) marks.from = t.end;
      else if (w === 'using' && kind === 'DELETE' && marks.from === undefined && marks.where === undefined) marks.from = t.end;
      else if (w === 'where' && marks.where === undefined) marks.where = t.start;
      else if (w === 'returning' && marks.ret === undefined) marks.ret = t.start;
    }
    prev = w;
  }
  const end = marks.ret ?? sql.replace(/;\s*$/, '').length;
  const whereStart = marks.where;
  const fromText = marks.from !== undefined ? sql.slice(marks.from, whereStart ?? end).trim() : null;
  const whereText = whereStart !== undefined ? sql.slice(whereStart + 'where'.length, end).trim() : null;
  if (whereText && /^current\s+of\b/i.test(whereText)) throw new Error('WHERE CURRENT OF is not captured');
  return { from: fromText || null, where: whereText || null };
}

async function savepointed<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T | null> {
  await client.query('savepoint comb_diff');
  try {
    const out = await fn();
    await client.query('release savepoint comb_diff');
    return out;
  } catch {
    await client.query('rollback to savepoint comb_diff').catch(() => {});
    await client.query('release savepoint comb_diff').catch(() => {});
    return null;
  }
}

/**
 * Prepares a row diff for one classified write statement. Returns null when the statement is not
 * an UPDATE/DELETE/INSERT on a table with a primary key, or when re-evaluating its WHERE clause
 * could have side effects (non-allowlisted functions, data-modifying CTEs).
 */
export async function captureDiff(client: pg.PoolClient, stmt: Classified, connectionId: string | null): Promise<DiffCapture | null> {
  if (!['UPDATE', 'DELETE', 'INSERT'].includes(stmt.command)) return null;
  await initClassifier();
  const tree: any = parseSync(stmt.sql);
  const [type, node] = Object.entries(tree.stmts?.[0]?.stmt ?? {})[0] ?? [];
  const n = node as any;
  if (!n?.relation || n.withClause) return null;
  const op = type === 'UpdateStmt' ? 'UPDATE' : type === 'DeleteStmt' ? 'DELETE' : type === 'InsertStmt' ? 'INSERT' : null;
  if (!op) return null;
  if (op !== 'INSERT') {
    if (n.whereClause && !onlySafeFunctions(n.whereClause)) return null;
    if (!onlySafeFunctions(n.fromClause ?? n.usingClause ?? [])) return null;
  }
  const rel = n.relation as { schemaname?: string; relname: string; inh?: boolean; alias?: { aliasname?: string } };
  const written = (rel.schemaname ? escapeIdent(rel.schemaname) + '.' : '') + escapeIdent(rel.relname);

  return savepointed(client, async () => {
    const meta = await client.query(
      `select c.oid::int as oid, n.nspname, c.relname, greatest(c.reltuples, 0)::bigint as est
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = to_regclass($1)`, [written]);
    const t = meta.rows[0];
    if (!t) throw new Error('relation not found');
    const pkr = await client.query(
      `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1 and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`, [t.oid]);
    const pk: string[] = pkr.rows.map((r) => r.attname);
    if (!pk.length) throw new Error('no primary key');
    const fr = await client.query(
      `select attname as name, format_type(atttypid, atttypmod) as type, attnum::int as num, attgenerated <> '' as generated, attidentity = 'a' as ident
         from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped order by attnum`, [t.oid]);
    const fields: DiffField[] = fr.rows.map((r) => ({ name: r.name, type: r.type, tableID: t.oid, columnID: r.num, generated: r.generated, identityAlways: r.ident }));
    const relation = `${t.nspname}.${t.relname}`;
    const qualified = escapeIdent(t.nspname) + '.' + escapeIdent(t.relname);
    const pkList = (alias: string) => pk.map((c) => `${alias}.${escapeIdent(c)}`).join(', ');
    const keyArr = 'array[' + pk.map((c) => `x.${escapeIdent(c)}::text`).join(', ') + ']';

    let before: Array<{ r: Record<string, unknown>; k: string[] }> = [];
    let total = 0;
    if (op === 'UPDATE' || op === 'DELETE') {
      const { from, where } = clauses(stmt.sql, op);
      const ref = escapeIdent(rel.alias?.aliasname ?? rel.relname);
      const target = (rel.inh === false ? 'only ' : '') + written + (rel.alias?.aliasname ? ' as ' + escapeIdent(rel.alias.aliasname) : '');
      const inner = `select ${pkList(ref)} from ${target}${from ? ', ' + from : ''}${where ? ' where ' + where : ''}`;
      const r = await client.query(
        `select count(*) over () as total, to_jsonb(x) as r, ${keyArr} as k from ${qualified} x
          where (${pkList('x')}) in (${inner}) order by ${pkList('x')} limit ${DIFF_CAP}`);
      before = r.rows.map((row) => ({ r: row.r, k: row.k }));
      total = r.rows.length ? Number(r.rows[0].total) : 0;
      if (!total) throw new Error('no rows matched');
    } else if (Number(t.est) > INSERT_SCAN_MAX_ROWS) {
      throw new Error('table too large to locate inserted rows');
    }

    const capture: DiffCapture = {
      finish: async (c) => {
        const got = await savepointed(c, async () => {
          let after: Array<{ r: Record<string, unknown>; k: string[] }> = [];
          if (op === 'UPDATE' && before.length) {
            const tuples = before.map((b) => '(' + b.k.map((v, i) => `${escapeLit(v)}::${pkType(fields, pk[i])}`).join(', ') + ')').join(', ');
            const r = await c.query(`select to_jsonb(x) as r, ${keyArr} as k from ${qualified} x where (${pkList('x')}) in (${tuples}) order by ${pkList('x')}`);
            after = r.rows.map((row) => ({ r: row.r, k: row.k }));
          } else if (op === 'INSERT') {
            const r = await c.query(
              `select count(*) over () as total, to_jsonb(x) as r, ${keyArr} as k from ${qualified} x
                where x.xmin = pg_current_xact_id()::xid order by ${pkList('x')} limit ${DIFF_CAP}`);
            after = r.rows.map((row) => ({ r: row.r, k: row.k }));
            total = r.rows.length ? Number(r.rows[0].total) : 0;
          }
          return after;
        });
        if (got === null || (op === 'INSERT' && !got.length)) return null;
        const id = randomUUID();
        const data = JSON.stringify({ before, after: got });
        await q(
          `insert into audit_row_diffs (id, connection_id, relation, op, pk, total, captured, fields, data_enc) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, connectionId, relation, op, pk, total, op === 'INSERT' ? got.length : before.length, JSON.stringify(fields), encryptSecret(data, `audit-diff:${id}`)],
        );
        return { diffId: id };
      },
    };
    return capture;
  });
}

function pkType(fields: DiffField[], name: string): string {
  return fields.find((f) => f.name === name)?.type ?? 'text';
}

interface StoredDiff {
  id: string;
  relation: string;
  op: 'UPDATE' | 'DELETE' | 'INSERT';
  pk: string[];
  total: number;
  captured: number;
  fields: DiffField[];
  before: Array<{ r: Record<string, unknown>; k: string[] }>;
  after: Array<{ r: Record<string, unknown>; k: string[] }>;
}

async function loadDiff(id: string): Promise<StoredDiff | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await one('select * from audit_row_diffs where id = $1', [id]);
  if (!row) return null;
  const plain = decryptSecret(row.data_enc, `audit-diff:${row.id}`);
  if (!plain) return null;
  const data = JSON.parse(plain);
  return { id: row.id, relation: row.relation, op: row.op, pk: row.pk, total: Number(row.total), captured: row.captured, fields: row.fields, before: data.before ?? [], after: data.after ?? [] };
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return "'" + v.replace(/'/g, "''") + "'";
  return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
}

/** Applies registered result filters (catalog masking) to diff rows for this viewer. */
async function maskedRows(d: StoredDiff, rows: Array<Record<string, unknown>>, conn: ConnRow, level: AccessLevel, user: AuthUser): Promise<{ rows: unknown[][]; masked: boolean }> {
  const arrays = rows.map((r) => d.fields.map((f) => r[f.name] ?? null));
  const before = JSON.stringify(arrays);
  await exec.applyResultFilters({ conn, level, user, fields: d.fields.map((f) => ({ name: f.name, tableID: f.tableID, columnID: f.columnID, type: f.type })), rows: arrays });
  return { rows: arrays, masked: JSON.stringify(arrays) !== before };
}

/** Builds the inverse of a recorded write from its row images. Never executed by Comb. */
export function compensatingSql(d: StoredDiff, eventId: number): { sql: string | null; reason?: string } {
  if (d.captured < d.total) return { sql: null, reason: `Only ${d.captured} of ${d.total} rows were captured, so a complete inverse cannot be generated.` };
  const [schema, ...rest] = d.relation.split('.');
  const rel = escapeIdent(schema) + '.' + escapeIdent(rest.join('.'));
  const pkCols = d.pk.map(escapeIdent).join(', ');
  const pkTuple = (k: string[]) => '(' + k.map((v, i) => `${escapeLit(v)}::${pkType(d.fields, d.pk[i])}`).join(', ') + ')';
  const head = `-- Compensating SQL for audit event #${eventId} (${d.op} on ${d.relation}, ${d.total} row${d.total === 1 ? '' : 's'}).\n-- Drafted from the recorded row images. Nothing has been run; review before running.\n`;
  if (d.op === 'INSERT') {
    return { sql: head + `delete from ${rel}\n where (${pkCols}) in (\n  ${d.after.map((a) => pkTuple(a.k)).join(',\n  ')}\n);` };
  }
  const writable = d.fields.filter((f) => !f.generated);
  if (d.op === 'DELETE') {
    const cols = writable.map((f) => escapeIdent(f.name)).join(', ');
    const override = writable.some((f) => f.identityAlways) ? ' overriding system value' : '';
    const json = JSON.stringify(d.before.map((b) => b.r));
    return { sql: head + `insert into ${rel} (${cols})${override}\nselect ${cols}\n  from jsonb_populate_recordset(null::${rel}, ${escapeLit(json)}::jsonb);` };
  }
  // UPDATE: restore the columns that changed, row by row, matched on the primary key.
  const afterByKey = new Map(d.after.map((a) => [JSON.stringify(a.k), a.r]));
  const out: string[] = [];
  for (const b of d.before) {
    const a = afterByKey.get(JSON.stringify(b.k));
    if (!a) return { sql: null, reason: 'A row was not found after the update (its primary key probably changed), so the inverse cannot be matched by key.' };
    const changed = writable.filter((f) => JSON.stringify(b.r[f.name] ?? null) !== JSON.stringify(a[f.name] ?? null));
    if (!changed.length) continue;
    const sets = changed.map((f) => `${escapeIdent(f.name)} = o.${escapeIdent(f.name)}`).join(', ');
    const where = d.pk.map((c, i) => `t.${escapeIdent(c)} = ${escapeLit(b.k[i])}::${pkType(d.fields, c)}`).join(' and ');
    out.push(`update ${rel} t set ${sets}\n  from jsonb_populate_record(null::${rel}, ${escapeLit(JSON.stringify(b.r))}::jsonb) o\n where ${where};`);
  }
  if (!out.length) return { sql: null, reason: 'The update did not change any stored value, so there is nothing to revert.' };
  return { sql: head + out.join('\n') };
}

/** The pre-write hook core calls for each write statement (registered with exec.registerPreWriteHook). */
export async function diffHook(ctx: { conn: ConnRow; client: pg.PoolClient; stmt: Classified }): Promise<((client: pg.PoolClient) => Promise<Record<string, unknown> | null>) | null> {
  // With literal redaction on, the workspace asked for no values in history; row images would contradict that.
  if ((await getPolicy()).redactLiterals) return null;
  const cap = await captureDiff(ctx.client, ctx.stmt, ctx.conn.id).catch(() => null);
  if (!cap) return null;
  return async (client) => (await cap.finish(client).catch(() => null)) ?? null;
}

exec.registerPreWriteHook(diffHook);

// ─────────────────────────────────────────────────────────────────────────────
// Retention: archive, never delete.
//
// audit_log is immutable for comb_app (no UPDATE/DELETE/TRUNCATE grant, plus a trigger that raises).
// The daily job copies events older than the retention window to COMB_AUDIT_ARCHIVE_DIR as JSONL
// (with their hashes, so the archive can be verified against the chain) and records progress.
// Pruning the table afterwards is a deliberate ops action: it needs the comb_owner role, dropping
// the immutability trigger for the duration, and re-anchoring verification on the archived head.
// Comb never does it on its own.
// ─────────────────────────────────────────────────────────────────────────────

export async function archiveOldEvents(): Promise<{ archived: number; file: string | null }> {
  const dir = process.env.COMB_AUDIT_ARCHIVE_DIR;
  if (!dir) return { archived: 0, file: null };
  const lastId = Number(await getSetting<number>('audit.archive.lastId', 0)) || 0;
  const rows = await q(
    `select id, at, actor_id, actor_label, connection_id, connection_name, kind, target, sql, rows, ms, status, detail, host(ip) as ip,
            encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash
       from audit_log where id > $1 and at < now() - make_interval(days => $2) order by id limit 50000`,
    [lastId, RETENTION_DAYS],
  );
  if (!rows.length) return { archived: 0, file: null };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const first = Number(rows[0].id);
  const last = Number(rows[rows.length - 1].id);
  const file = path.join(dir, `comb-audit-${first}-${last}.jsonl`);
  await writeFile(file, rows.map((r) => JSON.stringify({ ...r, id: Number(r.id) })).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  await setSetting('audit.archive.lastId', last, null);
  await audit({ actorLabel: 'system', kind: 'ARCHIVE', target: path.basename(file), rows: rows.length, status: 'ok', detail: { fromId: first, toId: last, retentionDays: RETENTION_DAYS } });
  return { archived: rows.length, file };
}

registerWorker('audit.archive', async () => {
  // Several batches per night if the backlog is large.
  for (let i = 0; i < 20; i++) {
    const r = await archiveOldEvents();
    if (r.archived < 50000) break;
  }
}, '17 3 * * *');

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export default async function auditModule(app: FastifyInstance): Promise<void> {
  app.get('/audit', async (req) => {
    const scope = auditScope(req);
    const f = parse(listQuery, req.query);
    const { where, params } = filters(f, scope);
    const page = [...params];
    let pageWhere = where;
    if (f.before) {
      page.push(f.before);
      pageWhere = (where ? where + ' and ' : 'where ') + `a.id < $${page.length}`;
    }
    page.push(f.limit + 1);
    const rows = await q(
      `select a.id, a.at, a.actor_id, a.actor_label, a.connection_id, a.connection_name, a.kind, a.target, a.rows, a.ms, a.status, a.detail, c.color, c.env
         from audit_log a left join connections c on c.id = a.connection_id
         ${pageWhere} order by a.id desc limit $${page.length}`,
      page,
    );
    const more = rows.length > f.limit;
    const list = rows.slice(0, f.limit).map(rowOut);
    const counts = await one(
      `select (select count(*) from audit_log a ${where})::bigint as matched,
              (select count(*) from audit_log a ${scope.ownOnly ? 'where a.actor_id = $' + (params.length + 1) : ''})::bigint as total`,
      scope.ownOnly ? [...params, scope.user.id] : params,
    );
    const actors = scope.ownOnly
      ? [scope.user.email]
      : (await q(`select actor_label, max(id) as last from audit_log where at > now() - interval '90 days' group by 1 order by 2 desc limit 8`)).map((r) => r.actor_label);
    return {
      rows: list, next: more ? list[list.length - 1].id : null, matched: Number(counts?.matched ?? 0), total: Number(counts?.total ?? 0),
      actors, ownOnly: scope.ownOnly, retentionDays: RETENTION_DAYS,
    };
  });

  app.get('/audit/mine', async (req) => {
    const user = userOf(req);
    const p = parse(z.object({ connectionId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(40) }), req.query);
    const rows = await q(
      `select id, at, sql, ms, status, kind from audit_log
        where actor_id = $1 and sql is not null and ($2::uuid is null or connection_id = $2) order by id desc limit $3`,
      [user.id, p.connectionId ?? null, p.limit],
    );
    return rows.map((r) => ({ id: Number(r.id), at: r.at, sql: r.sql, ms: r.ms, status: r.status, kind: r.kind }));
  });

  app.get('/audit/verify', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    auditScope(req);
    const v = await verifyCached();
    const text = v.ok
      ? v.head ? `chain verified · head ${v.head.slice(0, 4)}… · ${v.checked.toLocaleString('en-US')} events` : 'chain verified · empty'
      : `chain BROKEN at #${v.brokenAt}`;
    return { ...v, text };
  });

  app.get('/audit/export.csv', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = userOf(req);
    if (!hasRole(user, 'Admin')) throw forbidden('Exporting the audit trail needs the Admin role');
    const scope = auditScope(req);
    const f = parse(listQuery.omit({ before: true, limit: true }).extend({ limit: z.coerce.number().int().min(1).max(100_000).default(100_000) }), req.query);
    const { where, params } = filters({ ...f, limit: f.limit } as ListQuery, scope);
    const rows = await q(
      `select a.id, a.at, a.actor_label, host(a.ip) as ip, a.connection_name, a.kind, a.target, a.sql, a.rows, a.ms, a.status,
              a.detail->>'source' as source, a.detail->>'approvalId' as approval_id, encode(a.hash, 'hex') as hash
         from audit_log a ${where} order by a.id desc limit $${params.length + 1}`,
      [...params, f.limit],
    );
    const csv = toCsv(
      ['id', 'at', 'actor', 'ip', 'connection', 'kind', 'target', 'sql', 'rows', 'ms', 'status', 'source', 'approval_id', 'hash'],
      rows.map((r) => [r.id, r.at, r.actor_label, r.ip, r.connection_name, r.kind, r.target, r.sql, r.rows, r.ms, r.status, r.source, r.approval_id, r.hash]),
    );
    await audit({
      actorId: user.id, actorLabel: user.email, kind: 'EXPORT', target: 'audit_log', rows: rows.length, status: 'ok', ip: req.ip,
      detail: { format: 'csv', filters: { q: f.q ?? null, actor: f.actor ?? null, kind: f.kind, window: f.window, connectionId: f.connectionId ?? null } },
    });
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="comb-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    reply.header('cache-control', 'no-store');
    return reply.send(csv);
  });

  const idParam = z.object({ id: z.coerce.number().int().positive() });

  async function loadEvent(req: FastifyRequest) {
    const scope = auditScope(req);
    const { id } = parse(idParam, req.params);
    const r = await one(
      `select a.*, host(a.ip) as ip_text, encode(a.hash, 'hex') as hash_hex, encode(a.prev_hash, 'hex') as prev_hex, c.color, c.env
         from audit_log a left join connections c on c.id = a.connection_id where a.id = $1`, [id]);
    if (!r || (scope.ownOnly && r.actor_id !== scope.user.id)) throw notFound('Event not found');
    return { scope, r };
  }

  async function diffFor(r: any, user: AuthUser): Promise<{ diff: StoredDiff | null; conn: ConnRow | null; level: AccessLevel }> {
    const diffId = r.detail?.diffId;
    if (!diffId) return { diff: null, conn: null, level: 'none' };
    const diff = await loadDiff(String(diffId));
    const conn = r.connection_id ? await one<ConnRow>('select * from connections where id = $1', [r.connection_id]) : null;
    const level: AccessLevel = conn ? await connectionLevel(user, conn) : 'none';
    return { diff, conn: conn ?? null, level };
  }

  app.get('/audit/:id', async (req) => {
    const { scope, r } = await loadEvent(req);
    let approval = null;
    const approvalId = r.detail?.approvalId ? Number(r.detail.approvalId) : null;
    if (approvalId) {
      const a = await one(
        `select ap.id, ap.state, ap.decided_at, au.email as author, d.email as decided_by
           from approvals ap left join users au on au.id = ap.author_id left join users d on d.id = ap.decided_by where ap.id = $1`, [approvalId]);
      if (a) approval = { id: Number(a.id), state: a.state, author: a.author, decidedBy: a.decided_by, decidedAt: a.decided_at };
    }
    const actor = r.actor_id ? await one('select email, name, auth, mfa_enabled from users where id = $1', [r.actor_id]) : null;
    let diff: any = null;
    let diffNote: string | null = null;
    const { diff: d, conn, level } = await diffFor(r, scope.user);
    if (d && conn && level !== 'none') {
      const shown = d.before.length ? d.before.slice(0, 3) : [];
      const afterByKey = new Map(d.after.map((a) => [JSON.stringify(a.k), a.r]));
      const pairs: Array<{ sign: '-' | '+'; row: Record<string, unknown> }> = [];
      if (d.op === 'INSERT') for (const a of d.after.slice(0, 3)) pairs.push({ sign: '+', row: a.r });
      for (const b of shown) {
        pairs.push({ sign: '-', row: b.r });
        const a = afterByKey.get(JSON.stringify(b.k));
        if (d.op === 'UPDATE' && a) pairs.push({ sign: '+', row: a });
      }
      const m = await maskedRows(d, pairs.map((p) => p.row), conn, level, scope.user);
      diff = {
        relation: d.relation, op: d.op, total: d.total, captured: d.captured, columns: d.fields.map((f) => f.name), masked: m.masked,
        lines: pairs.map((p, i) => ({ sign: p.sign, text: '(' + m.rows[i].map(lit).join(', ') + ')' })),
      };
    } else if (r.detail?.diffId) {
      diffNote = d ? 'You have no access to this connection, so its row values are hidden.' : 'The recorded row images could not be read.';
    }
    return {
      id: Number(r.id), at: r.at, actor: r.actor_label, actorId: r.actor_id, actorName: actor?.name ?? null,
      auth: actor ? (actor.auth === 'token' ? 'service token' : actor.auth.toUpperCase() + (actor.mfa_enabled ? ' · MFA' : '')) : null,
      ip: r.ip_text, connectionId: r.connection_id, connection: r.connection_name, color: r.color, env: r.env, kind: r.kind, target: r.target,
      sql: r.sql, rows: r.rows === null ? null : Number(r.rows), ms: r.ms, status: r.status, source: r.detail?.source ?? null,
      detail: r.detail, approvalId, approval, hash: r.hash_hex, prevHash: r.prev_hex, diff, diffNote,
    };
  });

  app.get('/audit/:id/compensate', async (req) => {
    const { scope, r } = await loadEvent(req);
    const kind = String(r.kind);
    if (!['UPDATE', 'DELETE', 'INSERT'].includes(kind)) {
      return { sql: null, reason: `No compensating statement can be generated for ${kind}. Only UPDATE, DELETE and INSERT with a recorded row diff can be inverted.` };
    }
    if (r.status !== 'ok') return { sql: null, reason: 'This statement did not complete, so there is nothing to revert.' };
    const { diff: d, conn, level } = await diffFor(r, scope.user);
    if (!d) return { sql: null, reason: 'No row diff was recorded for this event, so the old values are unknown. Comb will not guess them.' };
    if (!conn || level === 'none') return { sql: null, reason: 'You have no access to this connection.' };
    const all = [...d.before.map((b) => b.r), ...d.after.map((a) => a.r)];
    const m = await maskedRows(d, all, conn, level, scope.user);
    if (m.masked) return { sql: null, reason: 'Some columns are masked for you, and compensating SQL needs their real values. Ask a data steward.' };
    const out = compensatingSql(d, Number(r.id));
    await audit({
      actorId: scope.user.id, actorLabel: scope.user.email, connectionId: r.connection_id, connectionName: r.connection_name, kind: 'DRAFT',
      target: d.relation, status: out.sql ? 'ok' : 'error', ip: req.ip, detail: { action: 'compensate', eventId: Number(r.id) },
    });
    return out;
  });
}
