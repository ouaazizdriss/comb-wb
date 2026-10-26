import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { typeFamily, type AccessLevel } from '@comb/shared';
import {
  editBody, rowsQuery, PAGE_SIZE, type EditBody, type EditPreview, type RelKind, type RowsResult, type TableColumn, type TableMeta,
  type ConstraintRow, type IndexRow, type TriggerRow, type PolicyRow,
} from '@comb/shared/src/table.ts';
import { parse, badRequest, notFound, HttpError } from '../core/http.ts';
import { requireConn, levelAtLeast, type AuthUser, type ConnRow } from '../security/authz.ts';
import { audit } from '../security/audit.ts';
import { withTarget, escapeIdent, escapeLit } from '../targets/pool.ts';
import { runSql } from '../targets/exec.ts';
import { maskedColumns } from './catalog.ts';

/*
 * Table tab: catalog reads (structure, constraints, indexes, triggers, DDL) go through
 * withTarget read-only with bound parameters. Row data and edits go through runSql with
 * source 'grid', so read-only connections, approvals, typed confirmation, masking and the
 * audit trail all apply. Every identifier spliced into SQL comes from the catalog and goes
 * through escapeIdent (or is a plain lower-case name Postgres itself left unquoted);
 * every value goes through escapeLit. The client never sends SQL text.
 */

const connParam = z.object({ connId: z.string().uuid() });
const relQuery = z.object({ schema: z.string().min(1).max(63), table: z.string().min(1).max(63) });

interface Rel {
  oid: string;
  schema: string;
  table: string;
  qschema: string;
  qtable: string;
  relkind: string;
  kind: RelKind;
  rowsecurity: boolean;
  forcerls: boolean;
  reltuples: number;
  comment: string | null;
  ispartition: boolean;
}
interface Col extends TableColumn {
  qname: string;
  /** Default expression, or the generation expression for generated columns. */
  expr: string | null;
}
interface Catalog {
  rel: Rel;
  cols: Col[];
  pk: Col[];
  policies: number;
}

const KIND: Record<string, RelKind> = { r: 'table', p: 'partitioned', v: 'view', m: 'matview', f: 'foreign' };
const SIMPLE = /^[a-z_][a-z0-9_]*$/;

/** Identifier for generated SQL: plain when Postgres itself would not quote it, escapeIdent otherwise. */
function qi(name: string, pgQuoted: string): string {
  return SIMPLE.test(name) && pgQuoted === name ? name : escapeIdent(name);
}

async function readCatalog(c: pg.PoolClient, schema: string, table: string): Promise<Catalog> {
  const r = await c.query(
    `select c.oid::text as oid, n.nspname as schema, c.relname as table, quote_ident(n.nspname) as qschema, quote_ident(c.relname) as qtable,
            c.relkind::text as relkind, c.relrowsecurity as rowsecurity, c.relforcerowsecurity as forcerls, c.reltuples::float8 as reltuples,
            obj_description(c.oid, 'pg_class') as comment, c.relispartition as ispartition,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p','v','m','f')`,
    [schema, table],
  );
  if (!r.rows.length) throw notFound(`Relation ${schema}.${table} not found`);
  const row = r.rows[0];
  const rel: Rel = {
    oid: row.oid, schema: row.schema, table: row.table, qschema: qi(row.schema, row.qschema), qtable: qi(row.table, row.qtable),
    relkind: row.relkind, kind: KIND[row.relkind], rowsecurity: row.rowsecurity, forcerls: row.forcerls, reltuples: Number(row.reltuples),
    comment: row.comment, ispartition: row.ispartition,
  };
  const cr = await c.query(
    `select a.attnum::int as attnum, a.attname as name, quote_ident(a.attname) as qname, format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as def, col_description(a.attrelid, a.attnum) as comment,
            a.attidentity::text as identity, a.attgenerated::text as generated
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    [rel.oid],
  );
  const kr = await c.query(
    `select k.contype::text as contype, k.conkey::int[] as conkey, k.confrelid::regclass::text as ref,
            (select string_agg(quote_ident(fa.attname), ', ' order by array_position(k.confkey, fa.attnum))
               from pg_attribute fa where fa.attrelid = k.confrelid and fa.attnum = any(k.confkey)) as refcols
     from pg_constraint k where k.conrelid = $1::oid and k.contype in ('p','f')`,
    [rel.oid],
  );
  const pkAtt: number[] = kr.rows.find((k) => k.contype === 'p')?.conkey ?? [];
  const fkOf = new Map<number, string>();
  for (const k of kr.rows) if (k.contype === 'f') for (const a of k.conkey as number[]) fkOf.set(a, `${k.ref}(${k.refcols})`);
  const cols: Col[] = cr.rows.map((a) => {
    const generated = !!a.generated;
    const identity = (a.identity || '') as '' | 'a' | 'd';
    return {
      name: a.name, qname: qi(a.name, a.qname), expr: a.def, attnum: a.attnum, type: a.type, family: typeFamily(a.type),
      notNull: a.notnull, default: generated ? null : a.def, comment: a.comment, pk: pkAtt.includes(a.attnum), fk: fkOf.get(a.attnum) ?? null,
      identity, generated, required: a.notnull && !a.def && !identity && !generated,
    };
  });
  const pk = pkAtt.map((n) => cols.find((x) => x.attnum === n)!).filter(Boolean);
  return { rel, cols, pk, policies: Number(row.policies) };
}

async function catalogFor(user: AuthUser, conn: ConnRow, schema: string, table: string): Promise<Catalog> {
  return withTarget(conn, { readOnly: true, actor: user.email }, (c) => readCatalog(c, schema, table));
}

function editability(cat: Catalog, conn: ConnRow, level: AccessLevel): string | null {
  if (cat.rel.kind === 'view' || cat.rel.kind === 'matview') return `${cat.rel.table} is a ${cat.rel.kind === 'matview' ? 'materialized view' : 'view'}; views are browsable but not editable in the grid.`;
  if (cat.rel.kind === 'foreign') return `${cat.rel.table} is a foreign table; the grid does not edit foreign tables.`;
  if (!cat.pk.length) return `${cat.rel.table} has no primary key, so the grid cannot address single rows. Edit it from a query tab.`;
  if (conn.read_only) return `${conn.name} is a read-only connection: every session runs with default_transaction_read_only = on. An Admin can turn it off in the connection editor.`;
  if (!levelAtLeast(level, 'write')) return `You have read access to ${conn.name}. Ask an Admin for write access to edit rows.`;
  return null;
}

/** Literal for generated SQL. Numbers and booleans print bare only when they are syntactically plain. */
function lit(v: string | number | boolean | null, col: Col): string {
  if (v === null) return 'NULL';
  const s = String(v);
  if (col.family === 'numeric' && /^-?\d{1,30}(\.\d{1,30})?$/.test(s)) return s;
  if (col.family === 'boolean' && /^(true|false)$/i.test(s)) return s.toLowerCase();
  return escapeLit(s);
}

function colByName(cat: Catalog, name: string): Col {
  const c = cat.cols.find((x) => x.name === name);
  if (!c) throw badRequest(`Column ${JSON.stringify(name)} does not exist on ${cat.rel.schema}.${cat.rel.table}`);
  return c;
}

function pkWhere(cat: Catalog, pk: Record<string, string | number | boolean | null>): string {
  const keys = Object.keys(pk);
  if (keys.length !== cat.pk.length || !cat.pk.every((c) => keys.includes(c.name))) {
    throw badRequest(`Every primary-key column (${cat.pk.map((c) => c.name).join(', ')}) must be given, and nothing else`);
  }
  return cat.pk.map((c) => {
    const v = pk[c.name];
    if (v === null) throw badRequest('Primary-key values cannot be NULL');
    return `${c.qname} = ${lit(v, c)}`;
  }).join(' and ');
}

function pkTuple(cat: Catalog, pk: Record<string, string | number | boolean | null>): string {
  pkWhere(cat, pk); // validates
  const vals = cat.pk.map((c) => lit(pk[c.name], c));
  return cat.pk.length === 1 ? vals[0] : `(${vals.join(', ')})`;
}

function settable(cat: Catalog, name: string, forInsert: boolean): Col {
  const c = colByName(cat, name);
  if (c.generated) throw badRequest(`${name} is a generated column and cannot be written`);
  if (c.identity === 'a') throw badRequest(`${name} is GENERATED ALWAYS AS IDENTITY and cannot be ${forInsert ? 'inserted' : 'updated'}`);
  return c;
}

/** Builds the statements for a set of staged edits. Order: updates, deletes, inserts. */
function buildEdits(cat: Catalog, body: EditBody): EditPreview['statements'] {
  const target = `${cat.rel.qschema}.${cat.rel.qtable}`;
  const out: EditPreview['statements'] = [];
  const deleted = new Set(body.deletes.map((d) => JSON.stringify(cat.pk.map((c) => String(d.pk[c.name])))));
  for (const u of body.updates) {
    const where = pkWhere(cat, u.pk);
    if (deleted.has(JSON.stringify(cat.pk.map((c) => String(u.pk[c.name]))))) continue;
    const names = Object.keys(u.set);
    if (!names.length) continue;
    const sets = names.map((n) => { const c = settable(cat, n, false); return `${c.qname} = ${lit(u.set[n], c)}`; });
    out.push({ kind: 'UPDATE', sql: `update ${target} set ${sets.join(', ')}\nwhere ${where}` });
  }
  if (body.deletes.length) {
    const tuples = body.deletes.map((d) => pkTuple(cat, d.pk));
    const key = cat.pk.length === 1 ? cat.pk[0].qname : `(${cat.pk.map((c) => c.qname).join(', ')})`;
    out.push({ kind: 'DELETE', sql: tuples.length === 1 ? `delete from ${target}\nwhere ${pkWhere(cat, body.deletes[0].pk)}` : `delete from ${target}\nwhere ${key} in (${tuples.join(', ')})` });
  }
  // One multi-row INSERT per distinct column set.
  const groups = new Map<string, Array<Record<string, string | number | boolean | null>>>();
  for (const ins of body.inserts) {
    const names = Object.keys(ins.values).sort((a, b) => colByName(cat, a).attnum - colByName(cat, b).attnum);
    for (const n of names) settable(cat, n, true);
    const k = JSON.stringify(names);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(ins.values);
  }
  for (const [k, rows] of groups) {
    const names: string[] = JSON.parse(k);
    const cols = names.map((n) => colByName(cat, n));
    const values = rows.map((r) => `(${cols.map((c) => lit(r[c.name], c)).join(', ')})`);
    if (names.length) out.push({ kind: 'INSERT', sql: `insert into ${target} (${cols.map((c) => c.qname).join(', ')})\nvalues ${values.join(',\n       ')}` });
    else for (let i = 0; i < rows.length; i++) out.push({ kind: 'INSERT', sql: `insert into ${target} default values` });
  }
  if (!out.length) throw badRequest('Nothing to apply');
  if (out.length > 50) throw badRequest(`That is ${out.length} statements; apply at most 50 at a time (each updated row is one statement).`);
  return out;
}

/** JSON-safe cell value. */
function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, 64 * 1024).toString('hex');
    return '\\x' + hex + (v.length > 64 * 1024 ? '…' : '');
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  return v;
}

/** True when the masked/raw value and its text companion still agree (no result filter changed it). */
function sameAsText(raw: unknown, text: unknown): boolean {
  if (raw === null || raw === undefined) return text === null || text === undefined;
  if (text === null || text === undefined) return false;
  if (raw instanceof Date || typeof raw === 'boolean') return true;
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw) === String(text);
  return false;
}

const FAITHFUL = new Set(['text', 'numeric', 'identifier', 'boolean']);
function needsText(c: Col): boolean {
  if (c.type.endsWith('[]')) return true;
  if (/^jsonb?$/.test(c.type)) return false;
  return !FAITHFUL.has(c.family);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

async function approxCount(user: AuthUser, conn: ConnRow, cat: Catalog): Promise<{ n: number | null; exact: boolean }> {
  if (cat.rel.reltuples >= 0 && cat.rel.kind !== 'partitioned' && cat.rel.kind !== 'view') return { n: Math.round(cat.rel.reltuples), exact: false };
  // Never analyzed (or a view / partitioned parent): a capped count, read-only.
  try {
    const n = await withTarget(conn, { readOnly: true, actor: user.email, timeoutMs: 3000 }, async (c) => {
      const r = await c.query(`select count(*)::int as n from (select 1 from ${cat.rel.qschema}.${cat.rel.qtable} limit 100001) s`);
      return Number(r.rows[0].n);
    });
    return { n, exact: n <= 100000 };
  } catch {
    return { n: null, exact: false };
  }
}

function needRel(req: FastifyRequest): { schema: string; table: string } {
  return parse(relQuery, req.query);
}

export default async function tableModule(app: FastifyInstance): Promise<void> {
  // ── Meta: columns, key, estimate, RLS, editability ─────────────
  app.get('/table/:connId/meta', async (req): Promise<TableMeta> => {
    const { connId } = parse(connParam, req.params);
    const { schema, table } = needRel(req);
    const { conn, level, user } = await requireConn(req, connId, 'read');
    const cat = await catalogFor(user, conn, schema, table);
    const count = await approxCount(user, conn, cat);
    const reason = editability(cat, conn, level);
    return {
      schema: cat.rel.schema, table: cat.rel.table, kind: cat.rel.kind, comment: cat.rel.comment,
      columns: cat.cols.map(({ qname: _q, expr: _e, ...c }) => c),
      pk: cat.pk.map((c) => c.name), estimate: count.n, exactCount: count.exact,
      rls: { enabled: cat.rel.rowsecurity, forced: cat.rel.forcerls, policies: cat.policies },
      editable: !reason, readOnlyReason: reason, needsApproval: !!conn.require_approval && !reason, level,
    };
  });

  // ── Rows: server-side paging, sort and filter through runSql ───
  app.post('/table/:connId/rows', async (req): Promise<RowsResult> => {
    const { connId } = parse(connParam, req.params);
    const q = parse(rowsQuery, req.body);
    const { conn, level, user } = await requireConn(req, connId, 'read');
    const cat = await catalogFor(user, conn, q.schema, q.table);
    const target = `${cat.rel.qschema}.${cat.rel.qtable}`;
    // Masked columns stay out of the filter and the sort, so their raw values cannot be probed with ILIKE or ORDER BY.
    const masked = await maskedColumns(conn, level, user, Number(cat.rel.oid));
    const sortCol = q.sort ? colByName(cat, q.sort) : null;
    if (sortCol && masked.has(sortCol.attnum)) throw badRequest(`${sortCol.name} is masked and cannot be sorted`);
    const dir = q.dir === 'desc' ? 'desc' : 'asc';
    // A masked key column would turn the keyset cursor into a comparison oracle, so such tables page by offset.
    const pkMasked = cat.pk.some((c) => masked.has(c.attnum));
    if (pkMasked && q.after) throw badRequest('Bad cursor');
    const keyset = !pkMasked && cat.pk.length > 0 && (!sortCol || (cat.pk.length === 1 && sortCol.name === cat.pk[0].name));

    const select: string[] = cat.cols.map((c) => `t.${c.qname}`);
    // Text companions: node-pg turns dates, intervals, arrays, bytea... into JS objects and loses
    // their exact text. The companion is used only when the value is still such an object after
    // result filters ran (a masked value is a string or null, and then wins).
    const dateIdx = cat.cols.map((c, i) => (needsText(c) ? i : -1)).filter((i) => i >= 0);
    for (const i of dateIdx) {
      const c = cat.cols[i];
      select.push(`${c.type === 'bytea' ? `left(t.${c.qname}::text, 131074)` : `t.${c.qname}::text`} as ${escapeIdent('__comb_t' + i)}`);
    }
    cat.pk.forEach((c, i) => select.push(`t.${c.qname}::text as ${escapeIdent('__comb_k' + i)}`));

    const where: string[] = [];
    const f = (q.filter ?? '').trim();
    if (f) {
      const pat = escapeLit('%' + escapeLike(f) + '%');
      const searchable = cat.cols.filter((c) => !masked.has(c.attnum)).slice(0, 64);
      where.push(searchable.length ? '(' + searchable.map((c) => `t.${c.qname}::text ilike ${pat}`).join(' or ') + ')' : 'false');
    }
    let order: string;
    if (keyset) {
      const keyCols = cat.pk.map((c) => `t.${c.qname}`);
      if (q.after) {
        if (q.after.length !== cat.pk.length || q.after.some((v) => v === null)) throw badRequest('Bad cursor');
        const vals = cat.pk.map((c, i) => escapeLit(String(q.after![i])));
        const lhs = keyCols.length === 1 ? keyCols[0] : `(${keyCols.join(', ')})`;
        const rhs = vals.length === 1 ? vals[0] : `(${vals.join(', ')})`;
        where.push(`${lhs} ${dir === 'desc' ? '<' : '>'} ${rhs}`);
      }
      order = keyCols.map((k) => `${k} ${dir}`).join(', ');
    } else {
      const parts: string[] = [];
      if (sortCol) parts.push(`t.${sortCol.qname} ${dir} nulls last`);
      if (!pkMasked) for (const c of cat.pk) parts.push(`t.${c.qname}`);
      else parts.push('t.ctid');
      order = parts.join(', ');
    }
    let sql = `select ${select.join(', ')}\nfrom ${target} t`;
    if (where.length) sql += `\nwhere ${where.join(' and ')}`;
    if (order) sql += `\norder by ${order}`;
    sql += `\nlimit ${PAGE_SIZE + 1}`;
    if (!keyset && q.offset) sql += ` offset ${Math.floor(q.offset)}`;

    const res = await runSql({ user, conn, level, sql, source: 'grid', ip: req.ip, forceReadOnly: true, maxRows: PAGE_SIZE + 1 });
    const n = cat.cols.length;
    const hasMore = res.rows.length > PAGE_SIZE;
    const raw = res.rows.slice(0, PAGE_SIZE);
    let keysOk = cat.pk.length > 0;
    const rows: unknown[][] = [];
    const keys: unknown[][] = [];
    for (const r of raw) {
      const out = r.slice(0, n);
      dateIdx.forEach((ci, j) => {
        const text = r[n + j];
        const v = out[ci];
        if (v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') out[ci] = text;
      });
      const k = cat.pk.map((c, i) => {
        const text = r[n + dateIdx.length + i];
        if (!sameAsText(r[cat.cols.indexOf(c)], text)) keysOk = false;
        return text;
      });
      rows.push(out.map(cell));
      keys.push(k);
    }
    return {
      columns: cat.cols.map((c) => ({ name: c.name, type: c.type, family: c.family })),
      rows, keys: keysOk ? keys : null, hasMore, paging: keyset ? 'keyset' : 'offset', ms: res.ms,
    };
  });

  // ── Edits: structured in, statements built here, one runSql call ──
  async function prepare(req: FastifyRequest, apply: boolean) {
    const { connId } = parse(connParam, req.params);
    const body = parse(editBody, req.body);
    const { conn, level, user } = await requireConn(req, connId, apply ? 'write' : 'read');
    const cat = await catalogFor(user, conn, body.schema, body.table);
    const reason = editability(cat, conn, level);
    if (reason) {
      if (apply) {
        await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'BLOCKED',
          target: `${cat.rel.schema}.${cat.rel.table}`, status: 'blocked', ip: req.ip, detail: { source: 'grid', reason } });
      }
      throw new HttpError(403, reason, { code: 'COMB_READONLY' });
    }
    return { conn, level, user, cat, body, statements: buildEdits(cat, body) };
  }

  app.post('/table/:connId/preview', async (req): Promise<EditPreview> => {
    const { statements } = await prepare(req, false);
    return { statements: statements.map((s) => ({ kind: s.kind, sql: s.sql + ';' })) };
  });

  app.post('/table/:connId/apply', async (req) => {
    const { conn, level, user, body, statements } = await prepare(req, true);
    const sql = statements.map((s) => s.sql).join(';\n') + ';';
    const res = await runSql({ user, conn, level, sql, source: 'grid', confirm: body.confirm, ip: req.ip });
    if (res.approvalId) return { approvalId: res.approvalId, statements: [], ms: 0 };
    return { statements: res.statements.map((s) => ({ command: s.command, rowCount: s.rowCount, ms: s.ms })), ms: res.ms };
  });

  // ── Catalog panels ─────────────────────────────────────────────
  app.get('/table/:connId/constraints', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { schema, table } = needRel(req);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const cat = await readCatalog(c, schema, table);
      return { constraints: await constraintsOf(c, cat.rel.oid), policies: await policiesOf(c, cat.rel.oid) };
    });
  });

  app.get('/table/:connId/indexes', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { schema, table } = needRel(req);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const cat = await readCatalog(c, schema, table);
      return { indexes: await indexesOf(c, cat.rel.oid) };
    });
  });

  app.get('/table/:connId/triggers', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { schema, table } = needRel(req);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const cat = await readCatalog(c, schema, table);
      return { triggers: await triggersOf(c, cat.rel.oid) };
    });
  });

  app.get('/table/:connId/ddl', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { schema, table } = needRel(req);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const cat = await readCatalog(c, schema, table);
      return { ddl: await ddlOf(c, cat) };
    });
  });
}

const CONKIND: Record<string, string> = { p: 'primary key', u: 'unique', f: 'foreign key', c: 'check', x: 'exclusion', t: 'trigger', n: 'not null' };

async function constraintsOf(c: pg.PoolClient, oid: string): Promise<ConstraintRow[]> {
  const r = await c.query(
    `select conname as name, contype::text as contype, pg_get_constraintdef(oid, true) as def, condeferrable as deferrable, convalidated as validated
     from pg_constraint where conrelid = $1::oid
     order by case contype when 'p' then 0 when 'u' then 1 when 'f' then 2 when 'c' then 3 else 4 end, conname`,
    [oid],
  );
  return r.rows.map((x) => ({ name: x.name, kind: CONKIND[x.contype] ?? x.contype, def: x.def, deferrable: x.deferrable, validated: x.validated }));
}

async function indexesOf(c: pg.PoolClient, oid: string): Promise<IndexRow[]> {
  const r = await c.query(
    `select ic.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indisunique as unique, i.indisprimary as primary, i.indisvalid as valid,
            pg_relation_size(i.indexrelid)::float8 as size, s.idx_scan::float8 as scans, s.idx_tup_read::float8 as tupread,
            exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.conrelid = i.indrelid) as constraint
     from pg_index i join pg_class ic on ic.oid = i.indexrelid
     left join pg_stat_user_indexes s on s.indexrelid = i.indexrelid
     where i.indrelid = $1::oid order by i.indisprimary desc, ic.relname`,
    [oid],
  );
  return r.rows.map((x) => ({ name: x.name, def: x.def, unique: x.unique, primary: x.primary, valid: x.valid, size: Number(x.size),
    scans: x.scans === null ? null : Number(x.scans), tupRead: x.tupread === null ? null : Number(x.tupread), constraint: x.constraint }));
}

async function triggersOf(c: pg.PoolClient, oid: string): Promise<TriggerRow[]> {
  const r = await c.query(
    `select t.tgname as name, pg_get_triggerdef(t.oid, true) as def, t.tgenabled::text as enabled, t.tgfoid::regproc::text as func, t.tgtype::int as tgtype
     from pg_trigger t where t.tgrelid = $1::oid and not t.tgisinternal order by 1`,
    [oid],
  );
  const EN: Record<string, string> = { O: 'enabled', D: 'disabled', R: 'replica only', A: 'always' };
  return r.rows.map((x) => {
    const t = x.tgtype as number;
    const timing = (t & 2 ? 'before' : t & 64 ? 'instead of' : 'after') + (t & 1 ? ' · row' : ' · statement');
    const ev = [t & 4 && 'insert', t & 16 && 'update', t & 8 && 'delete', t & 32 && 'truncate'].filter(Boolean).join(' or ');
    return { name: x.name, def: x.def, enabled: EN[x.enabled] ?? x.enabled, func: x.func, timing, events: ev };
  });
}

async function policiesOf(c: pg.PoolClient, oid: string): Promise<PolicyRow[]> {
  const r = await c.query(
    `select p.polname as name, p.polcmd::text as cmd, p.polpermissive as permissive,
            case when p.polroles = '{0}'::oid[] then 'public'
                 else array_to_string(array(select quote_ident(rolname) from pg_roles r where r.oid = any(p.polroles) order by 1), ', ') end as roles,
            pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
     from pg_policy p where p.polrelid = $1::oid order by 1`,
    [oid],
  );
  const CMD: Record<string, string> = { r: 'select', a: 'insert', w: 'update', d: 'delete', '*': 'all' };
  return r.rows.map((x) => ({ name: x.name, cmd: CMD[x.cmd] ?? x.cmd, permissive: x.permissive, roles: x.roles, using: x.using, check: x.check }));
}

/** "(expr)" unless the expression is already one parenthesised group. */
function wrapped(expr: string): string {
  if (expr.startsWith('(') && expr.endsWith(')')) {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')' && --depth === 0 && i < expr.length - 1) return `(${expr})`;
    }
    return expr;
  }
  return `(${expr})`;
}

/** CREATE statements reconstructed from the catalog. Display only. */
async function ddlOf(c: pg.PoolClient, cat: Catalog): Promise<string> {
  const { rel } = cat;
  const name = `${rel.qschema}.${rel.qtable}`;
  const out: string[] = [];
  const qlit = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const extra = await c.query(
    `select pg_get_viewdef($1::oid, true) as viewdef,
            case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partkey,
            case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end as bound,
            (select i.inhparent::regclass::text from pg_inherits i where i.inhrelid = c.oid limit 1) as parent
     from pg_class c where c.oid = $1::oid`,
    [rel.oid],
  );
  const x = extra.rows[0];
  if (rel.kind === 'view' || rel.kind === 'matview') {
    out.push(`create ${rel.kind === 'matview' ? 'materialized view' : 'or replace view'} ${name} as`);
    out.push(...String(x.viewdef ?? '').replace(/^\s+/, '  ').replace(/;?\s*$/, ';').split('\n'));
  } else {
    if (rel.ispartition && x.parent) {
      out.push(`create table ${name} partition of ${x.parent}`, `  ${x.bound};`);
    } else {
      out.push(`create ${rel.kind === 'foreign' ? 'foreign table' : 'table'} ${name} (`);
      const width = Math.min(28, Math.max(...cat.cols.map((col) => col.qname.length), 4)) + 2;
      const lines = cat.cols.map((col) => {
        let s = `  ${col.qname.padEnd(width)}${col.type}`;
        if (col.generated) s += ` generated always as ${wrapped(col.expr ?? '')} stored`;
        if (col.identity === 'a') s += ' generated always as identity';
        else if (col.identity === 'd') s += ' generated by default as identity';
        if (col.notNull) s += ' not null';
        if (col.default && !col.generated && !col.identity) s += ` default ${col.default}`;
        return s;
      });
      const cons = await c.query(
        `select quote_ident(conname) as name, pg_get_constraintdef(oid, true) as def from pg_constraint where conrelid = $1::oid and contype in ('p','u','f','c','x')
         order by case contype when 'p' then 0 when 'u' then 1 when 'f' then 2 when 'c' then 3 else 4 end, conname`,
        [rel.oid],
      );
      for (const k of cons.rows) lines.push(`  constraint ${k.name} ${k.def}`);
      out.push(lines.join(',\n'));
      out.push(x.partkey ? `) partition by ${x.partkey};` : ');');
    }
  }
  const text = out.join('\n');

  const tail: string[] = [];
  if (rel.comment) tail.push(`comment on ${rel.kind === 'view' ? 'view' : rel.kind === 'matview' ? 'materialized view' : 'table'} ${name} is ${qlit(rel.comment)};`);
  for (const col of cat.cols) if (col.comment) tail.push(`comment on column ${name}.${col.qname} is ${qlit(col.comment)};`);
  const idx = await c.query(
    `select pg_get_indexdef(i.indexrelid) as def from pg_index i
     where i.indrelid = $1::oid and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.conrelid = i.indrelid)
     order by 1`,
    [rel.oid],
  );
  if (idx.rows.length) tail.push('', ...idx.rows.map((r) => r.def.replace(/^CREATE (UNIQUE )?INDEX/, (_m: string, u: string) => `create ${u ? 'unique ' : ''}index`).replace(' ON ', ' on ').replace(' USING ', ' using ') + ';'));
  const trg = await triggersOf(c, rel.oid);
  if (trg.length) tail.push('', ...trg.map((t) => t.def + ';'));
  if (rel.rowsecurity || rel.forcerls) {
    tail.push('');
    if (rel.rowsecurity) tail.push(`alter table ${name} enable row level security;`);
    if (rel.forcerls) tail.push(`alter table ${name} force row level security;`);
  }
  const pols = await policiesOf(c, rel.oid);
  for (const p of pols) {
    let s = `create policy ${SIMPLE.test(p.name) ? p.name : escapeIdent(p.name)} on ${name}${p.permissive ? '' : ' as restrictive'} for ${p.cmd} to ${p.roles}`;
    if (p.using) s += `\n  using (${p.using})`;
    if (p.check) s += `\n  with check (${p.check})`;
    tail.push(s + ';');
  }
  return [text, ...(tail.length ? ['', ...tail] : [])].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
