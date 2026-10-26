import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import { q, one } from '../db/meta.ts';
import { parse, notFound, badRequest, conflict } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import type { AccessLevel } from '@comb/shared';
import { requireConn, requireRole, hasRole, levelAtLeast, type ConnRow, type AuthUser } from '../security/authz.ts';
import { withTarget, escapeIdent } from '../targets/pool.ts';
import { registerResultFilter, type ResultField } from '../targets/exec.ts';
import { notify } from '../core/events.ts';
import { registerWorker } from '../core/jobs.ts';

/*
 * Data catalog.
 *
 *  - Columns come live from pg_catalog; Comb's own metadata (classification, masking, owner,
 *    description, tags) lives in catalog_columns in the metadata DB.
 *  - PII scan: column-name heuristics plus read-only value sampling (LIMIT 200 per column).
 *    It produces candidates a human confirms; it stores pattern match counts, never values.
 *  - Masking: a result filter registered at module load. Every row set that leaves the server
 *    through runSql (query tab, grid, exports, quality samples) passes through it.
 *
 * Masking limitation (also stated in the UI): Postgres attributes a result column to its source
 * (table OID + attnum) only for direct column references, including through views and
 * subqueries. An expression such as lower(email) has tableID 0. For unattributed columns we mask
 * any whose output name equals the name of a masked column on this connection, which catches
 * `select email ...` from CTEs/functions but not a renamed expression like `lower(email) as e`.
 */

export const CLASSIFICATIONS = ['UNCLASSIFIED', 'INTERNAL', 'FINANCIAL', 'PII', 'SECRET'] as const;
export const MASKINGS = ['none', 'partial', 'full'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export type Masking = (typeof MASKINGS)[number];

const connParam = z.object({ connId: z.string().uuid() });
const ident = z.string().min(1).max(63);
const colRef = z.object({ schema: ident, table: ident, column: ident });

// ── Masking ──────────────────────────────────────────────────────────────

interface MaskRule { mode: 'partial' | 'full'; secret: boolean; name: string; key: string }
interface MaskMap { at: number; byField: Map<string, MaskRule>; byName: Map<string, MaskRule>; secretByField: Set<string>; secretNames: Set<string> }
const MASK_TTL_MS = 30_000;
const maskCache = new Map<string, MaskMap>();
const EMPTY: MaskMap = { at: 0, byField: new Map(), byName: new Map(), secretByField: new Set(), secretNames: new Set() };

export function invalidateMasks(connId: string): void {
  maskCache.delete(connId);
}

/** Masks one value. Partial keeps an email's first character and domain, otherwise the last 4 characters. */
export function maskValue(v: unknown, mode: 'partial' | 'full'): string | null {
  if (v === null || v === undefined) return null;
  if (mode === 'full') return '***';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const m = /^([^@\s])[^@\s]*@([^@\s]+\.[^@\s]+)$/.exec(s);
  if (m) return `${m[1]}***@${m[2]}`;
  return s.length <= 4 ? '***' : '***' + s.slice(-4);
}

async function loadMaskMap(conn: ConnRow): Promise<MaskMap> {
  const hit = maskCache.get(conn.id);
  if (hit && Date.now() - hit.at < MASK_TTL_MS) return hit;
  const rows = await q(
    `select schema_name, table_name, column_name, masking, classification from catalog_columns
     where connection_id = $1 and (masking <> 'none' or classification = 'SECRET')`, [conn.id]);
  if (!rows.length) {
    const m = { ...EMPTY, at: Date.now() };
    maskCache.set(conn.id, m);
    return m;
  }
  const map: MaskMap = { at: Date.now(), byField: new Map(), byName: new Map(), secretByField: new Set(), secretNames: new Set() };
  const resolved = await withTarget(conn, { readOnly: true, actor: 'comb:masking', timeoutMs: 10_000 }, (c) => c.query(
    `with k as (select * from unnest($1::text[], $2::text[], $3::text[], $4::int[]) as k(s, t, col, idx)),
     base as (
       select k.idx, c.oid, a.attnum, a.attname from k
       join pg_namespace n on n.nspname = k.s
       join pg_class c on c.relnamespace = n.oid and c.relname = k.t
       join pg_attribute a on a.attrelid = c.oid and a.attname = k.col and a.attnum > 0 and not a.attisdropped)
     select idx, oid::int as oid, attnum::int as num from base
     union
     select distinct b.idx, v.oid::int, va.attnum::int from base b
       join pg_depend d on d.refobjid = b.oid and d.refobjsubid = b.attnum and d.classid = 'pg_rewrite'::regclass
       join pg_rewrite r on r.oid = d.objid
       join pg_class v on v.oid = r.ev_class and v.oid <> b.oid
       join pg_attribute va on va.attrelid = v.oid and va.attname = b.attname and va.attnum > 0 and not va.attisdropped`,
    [rows.map((r) => r.schema_name), rows.map((r) => r.table_name), rows.map((r) => r.column_name), rows.map((_, i) => i)],
  ));
  for (const r of resolved.rows) {
    const src = rows[r.idx];
    const key = `${r.oid}:${r.num}`;
    if (src.classification === 'SECRET') map.secretByField.add(key);
    if (src.masking !== 'none') map.byField.set(key, { mode: src.masking, secret: src.classification === 'SECRET', name: src.column_name, key: `${src.schema_name}.${src.table_name}.${src.column_name}` });
  }
  for (const src of rows) {
    const n = String(src.column_name).toLowerCase();
    if (src.classification === 'SECRET') map.secretNames.add(n);
    if (src.masking === 'none') continue;
    const prev = map.byName.get(n);
    // When two masked columns share a name, the stricter rule wins.
    if (!prev || (prev.mode === 'partial' && src.masking === 'full')) map.byName.set(n, { mode: src.masking, secret: src.classification === 'SECRET', name: src.column_name, key: `${src.schema_name}.${src.table_name}.${src.column_name}` });
  }
  maskCache.set(conn.id, map);
  return map;
}

/**
 * Attnums of the columns of one relation (table or view) that are masked for this caller; empty when the
 * caller is exempt (admin access on the connection). The table grid excludes them from filtering and
 * sorting, so masked values cannot be probed with ILIKE or ORDER BY.
 */
export async function maskedColumns(conn: ConnRow, level: AccessLevel, user: AuthUser, relOid: number): Promise<Set<number>> {
  void user;
  const out = new Set<number>();
  if (levelAtLeast(level, 'admin')) return out;
  const map = await loadMaskMap(conn);
  const prefix = `${relOid}:`;
  for (const k of map.byField.keys()) if (k.startsWith(prefix)) out.add(Number(k.slice(prefix.length)));
  return out;
}

/** Field metadata of row sets that went through the filter, so Comb's own callers (quality samples) can see it. */
const fieldsOf = new WeakMap<unknown[][], ResultField[]>();
export function fieldsFor(rows: unknown[][]): ResultField[] | undefined {
  return fieldsOf.get(rows);
}

function ruleFor(map: MaskMap, f: ResultField): MaskRule | undefined {
  if (f.tableID) {
    const r = map.byField.get(`${f.tableID}:${f.columnID}`);
    if (r) return r;
    // A direct reference to an unmasked column is fine; only unattributable output falls back to names.
    return undefined;
  }
  return map.byName.get(f.name.toLowerCase());
}

registerResultFilter(async ({ conn, level, fields, rows }) => {
  fieldsOf.set(rows, fields);
  if (levelAtLeast(level, 'admin')) return;
  const map = await loadMaskMap(conn);
  if (!map.byField.size && !map.byName.size) return;
  const rules = fields.map((f) => ruleFor(map, f));
  if (!rules.some(Boolean)) return;
  for (const row of rows) {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r) row[i] = maskValue(row[i], r.mode);
    }
  }
});

/**
 * Prepares rows for storage in the metadata DB (quality samples): always masked regardless of the
 * caller's level, SECRET columns dropped entirely, at most `max` rows.
 */
export async function sanitizeForStorage(conn: ConnRow, fields: ResultField[] | undefined, columns: string[], rows: unknown[][], max = 4): Promise<{ columns: string[]; rows: unknown[][] }> {
  const map = await loadMaskMap(conn);
  const keep: number[] = [];
  const rules: Array<MaskRule | undefined> = [];
  columns.forEach((name, i) => {
    const f = fields?.[i];
    const key = f && f.tableID ? `${f.tableID}:${f.columnID}` : null;
    const secret = key ? map.secretByField.has(key) : map.secretNames.has(name.toLowerCase());
    if (secret) return;
    keep.push(i);
    rules.push(f ? ruleFor(map, f) : map.byName.get(name.toLowerCase()));
  });
  return {
    columns: keep.map((i) => columns[i]),
    rows: rows.slice(0, max).map((r) => keep.map((i, j) => {
      const v = rules[j] ? maskValue(r[i], rules[j]!.mode) : r[i];
      return v instanceof Date ? v.toISOString() : v;
    })),
  };
}

// ── Catalog reads ────────────────────────────────────────────────────────

export interface TargetColumn { schema: string; table: string; column: string; num: number; oid: number; type: string; comment: string | null; nullable: boolean; kind: string }

export async function targetColumns(c: pg.PoolClient): Promise<TargetColumn[]> {
  const r = await c.query(
    `select n.nspname as schema, c.relname as "table", a.attname as "column", a.attnum::int as num, c.oid::int as oid,
            format_type(a.atttypid, a.atttypmod) as type, col_description(c.oid, a.attnum) as comment, not a.attnotnull as nullable, c.relkind as kind
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','p','m','f') and not c.relispartition
       and n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and has_schema_privilege(n.oid, 'USAGE')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     order by 1, 2, a.attnum limit 20000`);
  return r.rows;
}

export interface MetaColumn { schema_name: string; table_name: string; column_name: string; classification: Classification; masking: Masking; owner_id: string | null; description: string; tags: string[] }

export async function metaColumns(connId: string): Promise<Map<string, MetaColumn>> {
  const rows = await q<MetaColumn>('select schema_name, table_name, column_name, classification, masking, owner_id, description, tags from catalog_columns where connection_id = $1', [connId]);
  return new Map(rows.map((r) => [`${r.schema_name}.${r.table_name}.${r.column_name}`, r]));
}

/** Columns classified PII or SECRET on a connection (DSR planning, controls). */
export async function sensitiveColumns(connId: string): Promise<MetaColumn[]> {
  return q<MetaColumn>(`select schema_name, table_name, column_name, classification, masking, owner_id, description, tags from catalog_columns
    where connection_id = $1 and classification in ('PII','SECRET') order by 1, 2, 3`, [connId]);
}

// ── PII scan ─────────────────────────────────────────────────────────────

const NAME_RULES: Array<[RegExp, string, 'PII' | 'SECRET']> = [
  [/(^|_)(e_?mail|email_?address)($|_)/i, 'email', 'PII'],
  [/(^|_)(phone|mobile|msisdn|tel|telephone|fax)($|_)/i, 'phone', 'PII'],
  [/(^|_)(ssn|social_security(_number)?|national_id|nin|tax_id)($|_)/i, 'national id', 'PII'],
  [/(^|_)(dob|birth_?date|date_of_birth|birthday)($|_)/i, 'date of birth', 'PII'],
  [/(^|_)(address|street|addr|city|zip|zipcode|postcode|postal_code)($|_)/i, 'address', 'PII'],
  [/(^|_)(ip|ip_?addr(ess)?|remote_addr|client_ip)($|_)/i, 'ip address', 'PII'],
  [/(^|_)(card|card_?number|cc_?number|pan|credit_card)($|_)/i, 'card', 'PII'],
  [/(^|_)(iban|bic|swift|bank_account|account_number)($|_)/i, 'bank account', 'PII'],
  [/(^|_)passport(_no|_number)?($|_)/i, 'passport', 'PII'],
  [/(^|_)(first_?name|last_?name|full_?name|surname|given_name|family_name|middle_name|maiden_name)($|_)/i, 'name', 'PII'],
  [/(^|_)(password|passwd|password_hash|secret|token|api_?key|private_key|access_key)($|_)/i, 'secret', 'SECRET'],
];
const PERSON_TABLE = /(user|customer|person|people|member|employee|contact|client|patient|account|subscriber|student)/i;

export function nameHint(table: string, column: string): { hint: string; suggested: 'PII' | 'SECRET' } | null {
  for (const [re, hint, suggested] of NAME_RULES) if (re.test(column)) return { hint, suggested };
  if (/^name$/i.test(column) && PERSON_TABLE.test(table)) return { hint: 'name', suggested: 'PII' };
  return null;
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanOk(s: string): boolean {
  const r = (s.slice(4) + s.slice(0, 4)).toUpperCase().replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of r) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem === 1;
}

export const VALUE_PATTERNS: Record<string, (s: string) => boolean> = {
  email: (s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s),
  phone: (s) => /^\+?[0-9][0-9 ().-]{5,18}[0-9]$/.test(s) && /[+ ().-]/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 7 && (s.match(/\d/g)?.length ?? 0) <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(s),
  ipv4: (s) => net.isIPv4(s.replace(/\/\d{1,2}$/, '')),
  ipv6: (s) => s.includes(':') && net.isIPv6(s.replace(/\/\d{1,3}$/, '')),
  card: (s) => { if (!/^[0-9 -]{13,23}$/.test(s)) return false; const d = s.replace(/[ -]/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); },
  iban: (s) => { const d = s.replace(/ /g, ''); return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(d) && ibanOk(d); },
};

function stringLeaves(v: unknown, out: string[], depth = 0): void {
  if (out.length > 200 || depth > 6) return;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out, depth + 1));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringLeaves(x, out, depth + 1));
}

/** Counts, per pattern, how many sampled values match. Exported for tests. */
export function matchCounts(values: string[], json: boolean): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(Object.keys(VALUE_PATTERNS).map((k) => [k, 0]));
  for (const raw of values) {
    let leaves: string[] = [raw.trim()];
    if (json) {
      leaves = [];
      try { stringLeaves(JSON.parse(raw), leaves); } catch { leaves = [raw]; }
    }
    for (const [k, test] of Object.entries(VALUE_PATTERNS)) if (leaves.some((l) => l.length <= 320 && test(l.trim()))) counts[k]++;
  }
  return counts;
}

const SAMPLE_TYPES = /^(text|character varying|character|varchar|char|citext|json|jsonb|inet|cidr|bpchar)\b/;
const running = new Set<string>();

export interface ScanResult { columnsSeen: number; columnsSampled: number; newCandidates: number; candidates: number; ms: number }

/** Runs a PII scan on one connection. Values are sampled in memory and discarded; only counts are kept. */
export async function runPiiScan(conn: ConnRow, actor: string): Promise<ScanResult> {
  if (running.has(conn.id)) throw conflict('A PII scan is already running on this connection');
  running.add(conn.id);
  const started = Date.now();
  const scan = await one('insert into catalog_scans (connection_id, actor) values ($1, $2) returning id', [conn.id, actor]);
  try {
    const meta = await metaColumns(conn.id);
    const cols = await withTarget(conn, { readOnly: true, actor: 'comb:pii-scan' }, (c) => targetColumns(c));
    const findings: Array<{ col: TargetColumn; suggested: 'PII' | 'SECRET'; hint: string | null; matches: Record<string, number>; sampled: number }> = [];
    let sampledCols = 0;
    const byTable = new Map<string, TargetColumn[]>();
    for (const col of cols) {
      const k = `${col.schema}.${col.table}`;
      if (!byTable.has(k)) byTable.set(k, []);
      byTable.get(k)!.push(col);
    }
    for (const [, tcols] of byTable) {
      const sampleCols = tcols.filter((c) => SAMPLE_TYPES.test(c.type)).slice(0, 60);
      const samples = new Map<string, string[]>();
      if (sampleCols.length && sampledCols < 2000) {
        try {
          await withTarget(conn, { readOnly: true, actor: 'comb:pii-scan', timeoutMs: 15_000 }, async (c) => {
            for (const col of sampleCols) {
              const rel = `${escapeIdent(col.schema)}.${escapeIdent(col.table)}`;
              const r = await c.query({ text: `select ${escapeIdent(col.column)}::text as v from ${rel} where ${escapeIdent(col.column)} is not null limit 200`, rowMode: 'array' });
              samples.set(col.column, r.rows.map((x: unknown[]) => String(x[0])));
              sampledCols++;
            }
          });
        } catch (e) {
          // Permission denied or a timeout on one table must not stop the scan; that table falls back to names.
          console.warn('pii scan: sampling skipped for a table:', (e as Error).message.slice(0, 120));
        }
      }
      for (const col of tcols) {
        const m = meta.get(`${col.schema}.${col.table}.${col.column}`);
        if (m && (m.classification === 'PII' || m.classification === 'SECRET')) continue; // already classified by a human
        const hint = nameHint(col.table, col.column);
        const vals = samples.get(col.column);
        const matches = vals ? matchCounts(vals, /^json/.test(col.type)) : {};
        const best = Math.max(0, ...Object.values(matches));
        const valueHit = !!vals && vals.length > 0 && best >= Math.max(3, Math.ceil(vals.length * 0.2));
        if (!hint && !valueHit) continue;
        findings.push({ col, suggested: hint?.suggested ?? 'PII', hint: hint?.hint ?? null, matches, sampled: vals?.length ?? 0 });
        if (vals) vals.length = 0; // drop sampled values as soon as they are counted
      }
      samples.clear();
    }
    let fresh = 0;
    const freshNames: string[] = [];
    for (const f of findings) {
      const r = await one(
        `insert into catalog_pii_candidates (connection_id, schema_name, table_name, column_name, suggested, name_hint, matches, sampled)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (connection_id, schema_name, table_name, column_name) do update
           set suggested = excluded.suggested, name_hint = excluded.name_hint, matches = excluded.matches, sampled = excluded.sampled, last_seen_at = now()
         returning (xmax = 0) as inserted`,
        [conn.id, f.col.schema, f.col.table, f.col.column, f.suggested, f.hint, JSON.stringify(f.matches), f.sampled]);
      if (r?.inserted) { fresh++; freshNames.push(`${f.col.table}.${f.col.column}`); }
    }
    const ms = Date.now() - started;
    await q(`update catalog_scans set finished_at = now(), status = 'ok', columns_seen = $2, columns_sampled = $3, new_candidates = $4 where id = $1`, [scan.id, cols.length, sampledCols, fresh]);
    if (fresh) {
      const admins = await q(`select id from users where role in ('Owner','Admin') and status = 'active'`);
      for (const a of admins) {
        await notify({ userId: a.id, kind: 'cat', title: `PII scan: ${fresh} new candidate${fresh === 1 ? '' : 's'} on ${conn.name}`,
          body: freshNames.slice(0, 6).join(', ') + (freshNames.length > 6 ? ` and ${freshNames.length - 6} more` : '') + ' · confirm or dismiss in the Data catalog', target: 'catalog' });
      }
    }
    return { columnsSeen: cols.length, columnsSampled: sampledCols, newCandidates: fresh, candidates: findings.length, ms };
  } catch (e) {
    await q(`update catalog_scans set finished_at = now(), status = 'error', error = $2 where id = $1`, [scan.id, String((e as Error).message).slice(0, 500)]);
    throw e;
  } finally {
    running.delete(conn.id);
  }
}

// Weekly scan of every connection (Monday 03:00 UTC).
registerWorker('catalog.pii-scan-weekly', async () => {
  const conns = await q<ConnRow>('select * from connections');
  for (const c of conns) {
    try {
      const r = await runPiiScan(c, 'comb:weekly');
      await audit({ actorLabel: 'comb:weekly', connectionId: c.id, connectionName: c.name, kind: 'PII_SCAN', target: c.name, status: 'ok', detail: { ...r } });
    } catch (e) {
      await audit({ actorLabel: 'comb:weekly', connectionId: c.id, connectionName: c.name, kind: 'PII_SCAN', target: c.name, status: 'error', detail: { message: String((e as Error).message).slice(0, 300) } });
    }
  }
}, '0 3 * * 1');

// ── Routes ───────────────────────────────────────────────────────────────

const patchBody = colRef.extend({
  classification: z.enum(CLASSIFICATIONS).optional(),
  masking: z.enum(MASKINGS).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(40).regex(/^[\w .:-]+$/)).max(20).optional(),
});

function tableTargets(schema: string, table: string): string[] {
  return [table.toLowerCase(), `${schema}.${table}`.toLowerCase()];
}

export default async function catalogModule(app: FastifyInstance): Promise<void> {
  app.get('/catalog/:connId', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    const { cols, views } = await withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const cols = await targetColumns(c);
      const v = await c.query(
        `select d.refobjid::int as oid, d.refobjsubid::int as num, count(distinct r.ev_class)::int as n
         from pg_depend d join pg_rewrite r on r.oid = d.objid
         where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass and d.refobjsubid > 0 and r.ev_class <> d.refobjid
         group by 1, 2`);
      return { cols, views: new Map(v.rows.map((x) => [`${x.oid}:${x.num}`, x.n as number])) };
    });
    const meta = await metaColumns(conn.id);
    const cands = await q(`select id::int, schema_name, table_name, column_name, suggested, name_hint, matches, sampled, state, last_seen_at
      from catalog_pii_candidates where connection_id = $1 and state = 'candidate'`, [conn.id]);
    const candMap = new Map(cands.map((c) => [`${c.schema_name}.${c.table_name}.${c.column_name}`, c]));
    const usage = await q(`select lower(target) as target, count(*)::int as n from audit_log
      where connection_id = $1 and at > now() - interval '30 days' and target is not null group by 1`, [conn.id]);
    const usageMap = new Map(usage.map((u) => [u.target as string, u.n as number]));
    // The member directory is only for callers who can assign owners (as on Team & access, which is Admin-only);
    // everyone else gets just the owners already named in this catalog.
    const canAssign = hasRole(user, 'Admin') || levelAtLeast(level, 'write');
    const members = canAssign
      ? await q(`select id, name, email from users where status = 'active' order by name, email`)
      : await q(`select distinct u.id, u.name, u.email from users u join catalog_columns c on c.owner_id = u.id
          where c.connection_id = $1 order by u.name, u.email`, [conn.id]);
    const lastScan = await one(`select started_at, finished_at, status, columns_seen, columns_sampled, new_candidates from catalog_scans
      where connection_id = $1 order by started_at desc limit 1`, [conn.id]);
    const columns = cols.map((c) => {
      const key = `${c.schema}.${c.table}.${c.column}`;
      const m = meta.get(key);
      const cand = candMap.get(key);
      const [t1, t2] = tableTargets(c.schema, c.table);
      const queries = (usageMap.get(t1) ?? 0) + (t1 === t2 ? 0 : usageMap.get(t2) ?? 0);
      return {
        schema: c.schema, table: c.table, column: c.column, type: c.type, comment: c.comment,
        classification: m?.classification ?? 'UNCLASSIFIED', masking: m?.masking ?? 'none', ownerId: m?.owner_id ?? null,
        description: m?.description || c.comment || '', tags: m?.tags ?? [],
        candidate: cand ? { id: cand.id, suggested: cand.suggested, hint: cand.name_hint, matches: cand.matches, sampled: cand.sampled } : null,
        queries30d: queries, views: views.get(`${c.oid}:${c.num}`) ?? 0,
      };
    });
    const tables = new Set(cols.map((c) => `${c.schema}.${c.table}`)).size;
    return {
      columns, tables, members, lastScan: lastScan ?? null,
      can: { classify: hasRole(user, 'Admin'), mask: hasRole(user, 'Admin'), edit: hasRole(user, 'Admin') || levelAtLeast(level, 'write'), unmasked: levelAtLeast(level, 'admin') },
    };
  });

  app.get('/catalog/:connId/column', async (req) => {
    const { connId } = parse(connParam, req.params);
    const ref = parse(colRef, req.query);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    const m = (await metaColumns(conn.id)).get(`${ref.schema}.${ref.table}.${ref.column}`);
    const classification = m?.classification ?? 'UNCLASSIFIED';
    const masking = m?.masking ?? 'none';
    const sensitive = masking !== 'none' || classification === 'SECRET';
    const hideValues = sensitive && !levelAtLeast(level, 'admin');

    const target = await withTarget(conn, { readOnly: true, actor: user.email, timeoutMs: 20_000 }, async (c) => {
      const col = await c.query(
        `select c.oid::int as oid, a.attnum::int as num, format_type(a.atttypid, a.atttypmod) as type, c.reltuples::float8 as est
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = $3 and a.attnum > 0 and not a.attisdropped
         where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p','m','f') and has_schema_privilege(n.oid, 'USAGE')`,
        [ref.schema, ref.table, ref.column]);
      if (!col.rows.length) throw notFound('Column not found');
      const { oid, num, type, est } = col.rows[0];
      const fam = /^(smallint|integer|bigint|numeric|real|double|money)/.test(type) ? 'numeric'
        : /^(timestamp|date|time)/.test(type) ? 'temporal' : /^(text|character|varchar|citext|bpchar)/.test(type) ? 'text' : 'other';
      const rel = `${escapeIdent(ref.schema)}.${escapeIdent(ref.table)}`;
      const ci = escapeIdent(ref.column);
      // Profile of up to 10k sampled rows. Statistics only; masked values are never returned below admin.
      const sel = [`count(*)::int as n`, `count(${ci})::int as nonnull`];
      if (fam === 'numeric' || fam === 'temporal') sel.push(`min(${ci})::text as min`, `max(${ci})::text as max`);
      if (fam === 'text') sel.push(`round(avg(length(${ci}::text)))::int as avglen`, `max(length(${ci}::text))::int as maxlen`);
      let profile: Record<string, unknown> = {};
      try {
        const p = await c.query(`select ${sel.join(', ')} from (select ${ci} from ${rel} limit 10000) s`);
        profile = p.rows[0];
      } catch (e) {
        profile = { error: (e as Error).message.slice(0, 200) };
      }
      if (hideValues) { delete profile.min; delete profile.max; }
      const st = await c.query(
        `select null_frac::float8 as null_frac, n_distinct::float8 as n_distinct,
                array_to_json(most_common_vals::text::text[]) as mcv, array_to_json(most_common_freqs) as mcf
         from pg_stats where schemaname = $1 and tablename = $2 and attname = $3`, [ref.schema, ref.table, ref.column]).catch(() => ({ rows: [] as any[] }));
      const s = st.rows[0];
      const distinct = s ? (s.n_distinct >= 0 ? s.n_distinct : Math.round(-s.n_distinct * Math.max(0, est))) : null;
      const hist = s?.mcf ? (s.mcf as number[]).slice(0, 14).map((f, i) => ({ freq: f, value: sensitive ? null : (s.mcv?.[i] ?? null) })) : [];
      // Lineage: foreign keys out/in, views that reference the column.
      const fkOut = await c.query(
        `select con.conname as name, con.confrelid::regclass::text as ref,
                (select string_agg(a.attname, ', ' order by k.o) from unnest(con.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) as cols
         from pg_constraint con where con.contype = 'f' and con.conrelid = $1 and $2 = any(con.conkey)`, [oid, num]);
      const fkIn = await c.query(
        `select con.conname as name, con.conrelid::regclass::text as ref,
                (select string_agg(a.attname, ', ' order by k.o) from unnest(con.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) as cols
         from pg_constraint con where con.contype = 'f' and con.confrelid = $1 and $2 = any(con.confkey)`, [oid, num]);
      const vw = await c.query(
        `select distinct v.oid::regclass::text as name, v.relkind as kind
         from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = r.ev_class
         where d.classid = 'pg_rewrite'::regclass and d.refobjid = $1 and d.refobjsubid = $2 and v.oid <> $1 order by 1`, [oid, num]);
      return { type, fam, est, profile, distinct, nullFrac: s?.null_frac ?? null, hist, hasStats: !!s, fkOut: fkOut.rows, fkIn: fkIn.rows, views: vw.rows };
    });

    const lineage: Array<{ dir: 'in' | 'out' | 'self'; name: string; kind: string }> = [];
    for (const f of target.fkOut) lineage.push({ dir: 'out', name: `${f.ref}.${f.cols}`, kind: 'references' });
    lineage.push({ dir: 'self', name: `${ref.schema}.${ref.table}.${ref.column}`, kind: 'this column' });
    for (const f of target.fkIn) lineage.push({ dir: 'in', name: `${f.ref}.${f.cols}`, kind: 'referenced by' });
    for (const v of target.views) lineage.push({ dir: 'out', name: v.name, kind: v.kind === 'm' ? 'materialized view' : 'view' });
    // Saved queries and scheduled jobs in Comb itself, when those modules are installed.
    for (const ext of await savedReferences(user.id, conn.id, ref.table, ref.column)) lineage.push({ dir: 'out', name: ext.name, kind: ext.kind });
    const tests = await q(`select name from dq_tests where connection_id = $1 and schema_name = $2 and table_name = $3 and (column_name = $4 or kind = 'custom') order by name limit 10`,
      [conn.id, ref.schema, ref.table, ref.column]);
    for (const t of tests) lineage.push({ dir: 'out', name: t.name, kind: 'quality test' });

    const [t1, t2] = tableTargets(ref.schema, ref.table);
    const access = await q(`select actor_label as who, count(*)::int as n from audit_log
      where connection_id = $1 and at > now() - interval '30 days' and lower(target) in ($2, $3)
      group by 1 order by 2 desc limit 8`, [conn.id, t1, t2]);

    const pols = await q(`select keep_days, ts_column, last_over, last_checked_at from compliance_retention
      where connection_id = $1 and schema_name = $2 and table_name = $3`, [conn.id, ref.schema, ref.table]);
    let retention: string;
    if (pols.length) {
      retention = pols.map((p) => `Rows in ${ref.table} older than ${p.keep_days} days (by ${p.ts_column}) are reported daily` +
        (p.last_checked_at ? `; the last check found ${Number(p.last_over ?? 0).toLocaleString('en-US')} over the limit` : '') + '.').join(' ') +
        ' Deletion only happens through Enforce in Compliance, with approvals and confirmation.';
    } else if (classification === 'PII' || classification === 'SECRET') {
      retention = `No retention policy covers ${ref.table}. Personal data here lives until something deletes it. Add a policy in Compliance.`;
    } else {
      retention = 'No retention policy on this table. Rows live until something deletes them.';
    }

    return {
      schema: ref.schema, table: ref.table, column: ref.column, type: target.type, family: target.fam,
      classification, masking, ownerId: m?.owner_id ?? null, description: m?.description ?? '', tags: m?.tags ?? [],
      profile: { ...target.profile, distinct: target.distinct, nullFrac: target.nullFrac, hasStats: target.hasStats, sampled: 10000 },
      hist: target.hist, valuesHidden: sensitive, minMaxHidden: hideValues,
      lineage, access, retention,
    };
  });

  app.patch('/catalog/:connId/column', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(patchBody, req.body);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    if (body.classification !== undefined || body.masking !== undefined) requireRole(req, 'Admin');
    if ((body.ownerId !== undefined || body.description !== undefined || body.tags !== undefined) && !hasRole(user, 'Admin') && !levelAtLeast(level, 'write')) {
      requireRole(req, 'Admin');
    }
    const exists = await withTarget(conn, { readOnly: true, actor: user.email }, (c) => c.query(
      `select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and a.attname = $3 and a.attnum > 0 and not a.attisdropped`, [body.schema, body.table, body.column]));
    if (!exists.rows.length) throw notFound('Column not found');
    if (body.ownerId) {
      const u = await one('select id from users where id = $1', [body.ownerId]);
      if (!u) throw badRequest('Unknown owner');
    }
    const prev = (await metaColumns(conn.id)).get(`${body.schema}.${body.table}.${body.column}`);
    const next = {
      classification: body.classification ?? prev?.classification ?? 'UNCLASSIFIED',
      masking: body.masking ?? prev?.masking ?? 'none',
      owner_id: body.ownerId === undefined ? prev?.owner_id ?? null : body.ownerId,
      description: body.description ?? prev?.description ?? '',
      tags: body.tags ?? prev?.tags ?? [],
    };
    // A secret is never shown raw below admin: classifying as SECRET turns full masking on unless set explicitly.
    if (body.classification === 'SECRET' && body.masking === undefined && next.masking === 'none') next.masking = 'full';
    await q(
      `insert into catalog_columns (connection_id, schema_name, table_name, column_name, classification, masking, owner_id, description, tags, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       on conflict (connection_id, schema_name, table_name, column_name) do update set classification = excluded.classification, masking = excluded.masking,
         owner_id = excluded.owner_id, description = excluded.description, tags = excluded.tags, updated_by = excluded.updated_by, updated_at = now()`,
      [conn.id, body.schema, body.table, body.column, next.classification, next.masking, next.owner_id, next.description, next.tags, user.id]);
    invalidateMasks(conn.id);
    const changes: Record<string, unknown> = {};
    if (next.classification !== (prev?.classification ?? 'UNCLASSIFIED')) changes.classification = { from: prev?.classification ?? 'UNCLASSIFIED', to: next.classification };
    if (next.masking !== (prev?.masking ?? 'none')) changes.masking = { from: prev?.masking ?? 'none', to: next.masking };
    if (body.ownerId !== undefined) changes.owner = next.owner_id;
    if (body.description !== undefined) changes.description = true;
    if (body.tags !== undefined) changes.tags = next.tags;
    // A human decision on PII settles a pending candidate for the same column.
    if (body.classification) {
      await q(`update catalog_pii_candidates set state = $5, decided_by = $6, decided_at = now()
        where connection_id = $1 and schema_name = $2 and table_name = $3 and column_name = $4 and state = 'candidate'`,
        [conn.id, body.schema, body.table, body.column, body.classification === 'PII' || body.classification === 'SECRET' ? 'confirmed' : 'dismissed', user.id]);
    }
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'CATALOG',
      target: `${body.schema}.${body.table}.${body.column}`, status: 'ok', ip: req.ip, detail: { action: 'update', ...changes } });
    return { ok: true, classification: next.classification, masking: next.masking };
  });

  app.post('/catalog/:connId/scan', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { connId } = parse(connParam, req.params);
    const user = requireRole(req, 'Admin');
    const { conn } = await requireConn(req, connId, 'read');
    try {
      const r = await runPiiScan(conn, user.email);
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'PII_SCAN', target: conn.name, status: 'ok', ip: req.ip, detail: { ...r } });
      return r;
    } catch (e) {
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'PII_SCAN', target: conn.name, status: 'error', ip: req.ip,
        detail: { message: String((e as Error).message).slice(0, 300) } });
      throw e;
    }
  });

  app.post('/catalog/:connId/candidates/:id', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({ action: z.enum(['confirm', 'dismiss']), classification: z.enum(['PII', 'SECRET']).optional(), masking: z.enum(MASKINGS).optional() }), req.body);
    const user = requireRole(req, 'Admin');
    const { conn } = await requireConn(req, connId, 'read');
    const cand = await one(`select * from catalog_pii_candidates where id = $1 and connection_id = $2`, [id, conn.id]);
    if (!cand) throw notFound('Candidate not found');
    if (body.action === 'confirm') {
      const klass = body.classification ?? cand.suggested;
      const masking = body.masking ?? (klass === 'SECRET' ? 'full' : 'partial');
      await q(
        `insert into catalog_columns (connection_id, schema_name, table_name, column_name, classification, masking, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (connection_id, schema_name, table_name, column_name) do update set classification = excluded.classification, masking = excluded.masking, updated_by = excluded.updated_by, updated_at = now()`,
        [conn.id, cand.schema_name, cand.table_name, cand.column_name, klass, masking, user.id]);
      invalidateMasks(conn.id);
    }
    await q(`update catalog_pii_candidates set state = $2, decided_by = $3, decided_at = now() where id = $1`, [id, body.action === 'confirm' ? 'confirmed' : 'dismissed', user.id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'CATALOG',
      target: `${cand.schema_name}.${cand.table_name}.${cand.column_name}`, status: 'ok', ip: req.ip, detail: { action: 'candidate.' + body.action, suggested: cand.suggested } });
    return { ok: true };
  });
}

// Comb's own saved queries (workflow module, library_queries) and scheduled jobs (sched_jobs) that mention
// the column. Scoped like the library itself: the caller's own queries plus shared/readonly ones, on this
// connection or on none; jobs only on this connection. A job that runs a saved query matches on that query's SQL.
const likeEsc = (s: string) => `%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
async function savedReferences(userId: string, connId: string, table: string, column: string): Promise<Array<{ name: string; kind: string }>> {
  const [t, c] = [likeEsc(table), likeEsc(column)];
  const safe = <T>(p: Promise<T[]>) => p.catch((e: { code?: string }) => {
    // 42P01: the workflow module's migrations are not applied (isolated dev stacks). Anything else is a real error.
    if (e?.code === '42P01') return [] as T[];
    throw e;
  });
  const queries = await safe(q(`select name from library_queries
      where (owner_id = $1 or visibility in ('shared', 'readonly')) and (connection_id = $2 or connection_id is null)
        and sql ilike $3 and sql ilike $4
      order by name limit 10`, [userId, connId, t, c]));
  const jobs = await safe(q(`select j.name from sched_jobs j left join library_queries l on l.id = j.library_id
      where j.connection_id = $1 and coalesce(j.sql, l.sql) ilike $2 and coalesce(j.sql, l.sql) ilike $3
      order by j.name limit 10`, [connId, t, c]));
  return [...queries.map((r) => ({ name: String(r.name), kind: 'saved query' })), ...jobs.map((r) => ({ name: String(r.name), kind: 'scheduled job' }))];
}
