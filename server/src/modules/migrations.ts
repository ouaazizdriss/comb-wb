import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { parseSync } from 'libpg-query';
import { q, one } from '../db/meta.ts';
import { parse, badRequest, notFound, forbidden, HttpError } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { sha256 } from '../security/crypto.ts';
import { userOf, hasRole, levelAtLeast, requireConn, requireRole, connectionLevel, type AuthUser, type ConnRow } from '../security/authz.ts';
import { classify, redactLiterals, SqlSyntaxError, type Classified } from '../targets/classify.ts';
import { checkout, withTarget } from '../targets/pool.ts';
import { runSql, plan } from '../targets/exec.ts';
import { getPolicy } from '../core/settings.ts';
import { emit } from '../core/events.ts';

/*
 * Migrations: versioned SQL scripts stored in Comb. Applied state is tracked per connection in
 * Comb's metadata (never in the target database), with the checksum of the up SQL so an edit
 * after apply shows as drift, and a catalog snapshot so "Check drift" can compare the live schema
 * with what the applied set produced. Apply and rollback go through runSql (source 'migration'),
 * which keeps approvals in force. Dry runs execute inside a transaction that is always rolled back.
 */

// ── Catalog snapshot + diff ───────────────────────────────────

export interface Snapshot {
  tables: Array<{ n: string; k: string; fn: string; sz: number }>;
  columns: Array<{ t: string; n: string; ty: string; nn: boolean; d: string | null }>;
  indexes: Array<{ n: string; t: string; def: string; sz: number }>;
  constraints: Array<{ n: string; t: string; def: string; v: boolean }>;
  enums: Array<{ n: string; labels: string[] }>;
}

const USER_NS = `n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`;
const SNAPSHOT_SQL = `select json_build_object(
  'tables', (select coalesce(json_agg(json_build_object('n', n.nspname||'.'||c.relname, 'k', c.relkind, 'fn', c.relfilenode::text,
      'sz', case when c.relkind in ('r','m') then pg_total_relation_size(c.oid) else 0 end) order by 1), '[]')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p','v','m','f') and ${USER_NS}),
  'columns', (select coalesce(json_agg(json_build_object('t', n.nspname||'.'||c.relname, 'n', a.attname, 'ty', format_type(a.atttypid, a.atttypmod),
      'nn', a.attnotnull, 'd', pg_get_expr(ad.adbin, ad.adrelid))), '[]')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','p','v','m','f') and ${USER_NS}),
  'indexes', (select coalesce(json_agg(json_build_object('n', n.nspname||'.'||i.relname, 't', n.nspname||'.'||t.relname, 'def', pg_get_indexdef(i.oid),
      'sz', pg_relation_size(i.oid))), '[]')
    from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid join pg_namespace n on n.oid = i.relnamespace where ${USER_NS}),
  'constraints', (select coalesce(json_agg(json_build_object('n', con.conname, 't', n.nspname||'.'||c.relname, 'def', pg_get_constraintdef(con.oid), 'v', con.convalidated)), '[]')
    from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where ${USER_NS}),
  'enums', (select coalesce(json_agg(json_build_object('n', n.nspname||'.'||t.typname,
      'labels', (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid))), '[]')
    from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'e' and ${USER_NS})
) as s`;

async function snapshotWith(c: Pick<pg.PoolClient, 'query'>): Promise<Snapshot> {
  const r = await c.query(SNAPSHOT_SQL);
  return r.rows[0].s as Snapshot;
}

async function snapshot(conn: ConnRow, actor: string): Promise<Snapshot> {
  return withTarget(conn, { readOnly: true, actor }, (c) => snapshotWith(c));
}

export interface DiffLine { sign: '+' | '-' | '~'; text: string; note: string }

function bytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

/** Before/after catalog diff. `drift` mode ignores sizes and storage (relfilenode). */
export function diffSnapshots(a: Snapshot, b: Snapshot, drift = false): DiffLine[] {
  const out: DiffLine[] = [];
  const keyed = <T>(xs: T[], k: (x: T) => string) => new Map(xs.map((x) => [k(x), x]));
  const KIND: Record<string, string> = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table' };
  const ta = keyed(a.tables, (x) => x.n), tb = keyed(b.tables, (x) => x.n);
  for (const [k, t] of tb) {
    const o = ta.get(k);
    if (!o) out.push({ sign: '+', text: `${KIND[t.k] ?? 'relation'} ${k}`, note: drift ? '' : bytes(t.sz) });
    else if (!drift && o.fn !== t.fn && (t.k === 'r' || t.k === 'm')) out.push({ sign: '~', text: `${KIND[t.k]} ${k} — rewritten`, note: bytes(t.sz) });
  }
  for (const [k, t] of ta) if (!tb.has(k)) out.push({ sign: '-', text: `${KIND[t.k] ?? 'relation'} ${k}`, note: drift ? '' : bytes(t.sz) });

  const ca = keyed(a.columns, (x) => x.t + '.' + x.n), cb = keyed(b.columns, (x) => x.t + '.' + x.n);
  for (const [k, c] of cb) {
    const o = ca.get(k);
    if (!o) {
      if (ta.has(c.t)) out.push({ sign: '+', text: `column ${k} ${c.ty}${c.nn ? ' not null' : ''}${c.d ? ' default ' + c.d : ''}`, note: '' });
      continue;
    }
    const ch: string[] = [];
    if (o.ty !== c.ty) ch.push(`${o.ty} → ${c.ty}`);
    if (o.nn !== c.nn) ch.push(c.nn ? 'set not null' : 'drop not null');
    if ((o.d ?? '') !== (c.d ?? '')) ch.push(c.d ? `default ${c.d}` : 'drop default');
    if (ch.length) out.push({ sign: '~', text: `column ${k}: ${ch.join(', ')}`, note: '' });
  }
  for (const [k, c] of ca) if (!cb.has(k) && tb.has(c.t)) out.push({ sign: '-', text: `column ${k}`, note: '' });

  const ia = keyed(a.indexes, (x) => x.n), ib = keyed(b.indexes, (x) => x.n);
  const short = (def: string) => def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON (ONLY )?/, (_m, u) => (u ? 'unique on ' : 'on '));
  for (const [k, i] of ib) {
    const o = ia.get(k);
    if (!o) out.push({ sign: '+', text: `index ${k} ${short(i.def)}`, note: drift ? '' : bytes(i.sz) });
    else if (o.def !== i.def) out.push({ sign: '~', text: `index ${k} ${short(i.def)}`, note: '' });
  }
  for (const [k] of ia) if (!ib.has(k)) out.push({ sign: '-', text: `index ${k}`, note: '' });

  const ka = keyed(a.constraints, (x) => x.t + '.' + x.n), kb = keyed(b.constraints, (x) => x.t + '.' + x.n);
  for (const [k, c] of kb) {
    const o = ka.get(k);
    if (!o) out.push({ sign: '+', text: `constraint ${k} ${c.def}`, note: c.v ? '' : 'not valid' });
    else if (o.def !== c.def || o.v !== c.v) out.push({ sign: '~', text: `constraint ${k} ${c.def}`, note: c.v ? (o.v ? '' : 'validated') : 'not valid' });
  }
  for (const [k] of ka) if (!kb.has(k)) out.push({ sign: '-', text: `constraint ${k}`, note: '' });

  const ea = keyed(a.enums, (x) => x.n), eb = keyed(b.enums, (x) => x.n);
  for (const [k, e] of eb) {
    const o = ea.get(k);
    if (!o) out.push({ sign: '+', text: `enum ${k} (${(e.labels ?? []).join(', ')})`, note: '' });
    else if ((o.labels ?? []).join('\u0000') !== (e.labels ?? []).join('\u0000')) out.push({ sign: '~', text: `enum ${k} (${(e.labels ?? []).join(', ')})`, note: '' });
  }
  for (const [k] of ea) if (!eb.has(k)) out.push({ sign: '-', text: `enum ${k}`, note: '' });
  return out;
}

// ── Lock analysis ─────────────────────────────────────────────

const LOCKS = ['none', 'ACCESS SHARE', 'ROW EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE', 'SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE', 'ACCESS EXCLUSIVE'] as const;
type Lock = (typeof LOCKS)[number];
const VOLATILE = new Set(['random', 'gen_random_uuid', 'uuid_generate_v1', 'uuid_generate_v4', 'clock_timestamp', 'timeofday', 'nextval', 'txid_current', 'uuidv7', 'uuidv4']);
const SERIAL = new Set(['serial', 'serial4', 'bigserial', 'serial8', 'smallserial', 'serial2']);

export interface Warning { title: string; body: string; severity: 'warn' | 'info' }
export interface Analysis {
  statements: number;
  lock: Lock;
  risk: 'safe' | 'locking' | 'concurrent';
  estSeconds: number | null;
  reversible: boolean;
  warnings: Warning[];
  targets: string[];
  noTxn: boolean;
}

function relName(r: any): string {
  return r ? (r.schemaname ? r.schemaname + '.' : '') + r.relname : '';
}

function funcNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) { for (const n of node) funcNames(n, out); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'FuncCall') {
        const parts = ((v as any).funcname ?? []).map((x: any) => x?.String?.sval).filter(Boolean);
        if (parts.length) out.add(String(parts[parts.length - 1]).toLowerCase());
      }
      funcNames(v, out);
    }
  }
}

function fmtSeconds(s: number | null): string {
  if (s === null) return '—';
  if (s < 1) return '< 1 s';
  if (s < 90) return '~' + Math.round(s) + ' s';
  if (s < 5400) return '~' + Math.round(s / 60) + ' min';
  return '~' + (s / 3600).toFixed(1) + ' h';
}

/** Lock and rewrite analysis from the parse tree, with table sizes from the target catalog. */
async function analyze(conn: ConnRow, actor: string, up: string, down: string): Promise<Analysis> {
  let stmts: any[];
  try {
    stmts = (parseSync(up) as any).stmts ?? [];
  } catch (e: any) {
    return { statements: 0, lock: 'none', risk: 'safe', estSeconds: null, reversible: !!down.trim(), warnings: [{ title: 'The up SQL does not parse', body: String(e?.message ?? e), severity: 'warn' }], targets: [], noTxn: false };
  }
  // Pass 1: collect relations and function names that need a catalog lookup.
  const rels = new Set<string>();
  const fns = new Set<string>();
  for (const s of stmts) {
    const [type, n] = Object.entries(s.stmt ?? {})[0] as [string, any];
    if (n?.relation) rels.add(relName(n.relation));
    if (type === 'VacuumStmt') for (const r of n.rels ?? []) rels.add(relName(r?.VacuumRelation?.relation));
    if (type === 'AlterTableStmt') for (const c of n.cmds ?? []) funcNames(c, fns);
  }
  rels.delete('');
  const size = new Map<string, number>();
  const volatileFns = new Set<string>();
  try {
    await withTarget(conn, { readOnly: true, actor }, async (c) => {
      for (const r of rels) {
        // to_regclass never raises for a missing relation; a malformed name is just skipped.
        const x = await c.query(`select coalesce(pg_total_relation_size(to_regclass($1)), 0)::bigint as sz`, [r]).catch(() => null);
        size.set(r, Number(x?.rows[0]?.sz ?? 0));
      }
      if (fns.size) {
        const v = await c.query(`select distinct lower(proname) as n from pg_proc where lower(proname) = any($1::text[]) and provolatile = 'v'`, [[...fns]]);
        for (const r of v.rows) volatileFns.add(r.n);
      }
    });
  } catch {
    /* sizes are best effort */
  }
  const sz = (r: string) => size.get(r) ?? 0;
  const REWRITE = 150 * 1024 * 1024, SCAN = 400 * 1024 * 1024;
  let lock: Lock = 'none';
  let est = 0;
  let noTxn = false;
  const warnings: Warning[] = [];
  const raise = (l: Lock) => { if (LOCKS.indexOf(l) > LOCKS.indexOf(lock)) lock = l; };
  const warn = (title: string, body: string, severity: Warning['severity'] = 'warn') => warnings.push({ title, body, severity });

  for (const s of stmts) {
    const [type, n] = Object.entries(s.stmt ?? {})[0] as [string, any];
    const t = relName(n?.relation);
    const tsize = sz(t);
    switch (type) {
      case 'IndexStmt':
        if (n.concurrent) {
          raise('SHARE UPDATE EXCLUSIVE');
          noTxn = true;
          est += (tsize / REWRITE) * 2;
          warn('Runs outside a transaction', 'CREATE INDEX CONCURRENTLY cannot be wrapped in BEGIN, so it must be the only statement of its migration and cannot be dry-run. A failure leaves an invalid index behind that you must drop by hand — that is Postgres, not Comb.');
        } else {
          raise('SHARE');
          est += tsize / REWRITE;
          warn(`CREATE INDEX blocks writes on ${t}`, `Without CONCURRENTLY the build holds a SHARE lock: reads continue, but every INSERT, UPDATE and DELETE on ${t} (${bytes(tsize)}) waits until it finishes (${fmtSeconds(tsize / REWRITE)}). Use CREATE INDEX CONCURRENTLY in a migration of its own.`);
        }
        break;
      case 'AlterTableStmt': {
        const cmds = (n.cmds ?? []).map((c: any) => c.AlterTableCmd);
        const onlyValidate = cmds.every((c: any) => c?.subtype === 'AT_ValidateConstraint');
        raise(onlyValidate ? 'SHARE UPDATE EXCLUSIVE' : 'ACCESS EXCLUSIVE');
        for (const c of cmds) {
          switch (c?.subtype) {
            case 'AT_AddColumn': {
              const def = c.def?.ColumnDef ?? {};
              const typ = (def.typeName?.names ?? []).map((x: any) => x?.String?.sval).pop() ?? '';
              const cons = (def.constraints ?? []).map((x: any) => x.Constraint);
              const f = new Set<string>();
              funcNames(cons.filter((x: any) => x?.contype === 'CONSTR_DEFAULT'), f);
              const volatileDefault = [...f].some((x) => VOLATILE.has(x) || volatileFns.has(x));
              const rewrite = SERIAL.has(String(typ).toLowerCase()) || volatileDefault || cons.some((x: any) => x?.contype === 'CONSTR_IDENTITY' || x?.contype === 'CONSTR_GENERATED');
              if (rewrite) {
                est += tsize / REWRITE;
                warn(`ADD COLUMN ${def.colname} rewrites ${t}`, `A volatile default (or serial, identity, generated column) is evaluated for every existing row, so Postgres rewrites ${t} (${bytes(tsize)}) under an ACCESS EXCLUSIVE lock: reads and writes block for ${fmtSeconds(tsize / REWRITE)}. Add the column without a default, then backfill in batches.`);
              }
              break;
            }
            case 'AT_AlterColumnType':
              est += tsize / REWRITE;
              warn(`ALTER COLUMN ${c.name} TYPE rewrites ${t}`, `Changing a column type usually rewrites the table and its indexes under ACCESS EXCLUSIVE: reads and writes on ${t} (${bytes(tsize)}) block for ${fmtSeconds(tsize / REWRITE)}. Only binary-compatible changes (e.g. varchar(n) → text) skip the rewrite.`);
              break;
            case 'AT_SetNotNull':
              est += tsize / SCAN;
              warn(`SET NOT NULL scans ${t}`, `Postgres checks every row while holding ACCESS EXCLUSIVE (${fmtSeconds(tsize / SCAN)} on ${bytes(tsize)}). On a big table, add CHECK (${c.name} is not null) NOT VALID, VALIDATE it, then SET NOT NULL — it reuses the validated check.`);
              break;
            case 'AT_ValidateConstraint':
              est += tsize / SCAN;
              warn(`VALIDATE CONSTRAINT scans ${t}`, `Takes SHARE UPDATE EXCLUSIVE: reads and writes continue while every row is checked (${fmtSeconds(tsize / SCAN)}).`, 'info');
              break;
            case 'AT_AddConstraint': {
              const k = c.def?.Constraint ?? {};
              if ((k.contype === 'CONSTR_FOREIGN' || k.contype === 'CONSTR_CHECK') && !k.skip_validation) {
                est += tsize / SCAN;
                warn(`ADD CONSTRAINT ${k.conname ?? ''} validates every row of ${t}`.replace('  ', ' '), `The check runs while the lock is held. Add it NOT VALID first, then VALIDATE CONSTRAINT in a second step (that only takes SHARE UPDATE EXCLUSIVE).`);
              }
              if ((k.contype === 'CONSTR_PRIMARY' || k.contype === 'CONSTR_UNIQUE') && !k.indexname) {
                est += tsize / REWRITE;
                warn(`ADD ${k.contype === 'CONSTR_PRIMARY' ? 'PRIMARY KEY' : 'UNIQUE'} builds an index under ACCESS EXCLUSIVE`, `Build a unique index CONCURRENTLY first, then ADD CONSTRAINT … USING INDEX.`);
              }
              break;
            }
            case 'AT_DropColumn':
              warn(`DROP COLUMN ${c.name} on ${t}`, 'Fast (the column is only marked dropped), but takes ACCESS EXCLUSIVE briefly and breaks any query or application code that still selects it. Ship the code change first.');
              break;
          }
        }
        if (!warnings.length && !onlyValidate) {
          warn(`Takes an ACCESS EXCLUSIVE lock on ${t}`, `Brief, but reads and writes on ${t} queue behind it, and behind any long transaction already holding a lock there.`, 'info');
        }
        break;
      }
      case 'RefreshMatViewStmt':
        raise(n.concurrent ? 'EXCLUSIVE' : 'ACCESS EXCLUSIVE');
        if (!n.concurrent) warn(`REFRESH blocks reads of ${t}`, 'Without CONCURRENTLY, readers of the materialized view wait until the refresh completes.');
        break;
      case 'VacuumStmt': {
        const full = (n.options ?? []).some((o: any) => o?.DefElem?.defname === 'full');
        if (n.is_vacuumcmd) noTxn = true;
        raise(full ? 'ACCESS EXCLUSIVE' : 'SHARE UPDATE EXCLUSIVE');
        if (full) warn('VACUUM FULL rewrites the table', 'Reads and writes block for the whole rewrite. Prefer pg_repack, or plain VACUUM.');
        break;
      }
      case 'ClusterStmt':
        raise('ACCESS EXCLUSIVE');
        est += tsize / REWRITE;
        warn(`CLUSTER rewrites ${t}`, 'Reads and writes block for the whole rewrite.');
        break;
      case 'DropStmt':
        raise('ACCESS EXCLUSIVE');
        if (n.concurrent) noTxn = true;
        warn(`${String(n.removeType ?? '').replace(/^OBJECT_/, '').replace(/_/g, ' ')} is dropped`, 'Destructive. The down migration is the only way back, and it cannot restore data.');
        break;
      case 'RenameStmt':
        raise('ACCESS EXCLUSIVE');
        warn('RENAME breaks callers that use the old name', 'Takes ACCESS EXCLUSIVE briefly; deploy code that tolerates both names first.', 'info');
        break;
      case 'InsertStmt':
      case 'UpdateStmt':
      case 'DeleteStmt':
        raise('ROW EXCLUSIVE');
        if ((type === 'UpdateStmt' || type === 'DeleteStmt') && !n.whereClause) warn(`${type === 'UpdateStmt' ? 'UPDATE' : 'DELETE'} without WHERE locks every row of ${t}`, 'Backfill in batches so concurrent writers are not blocked for the whole statement.');
        break;
      case 'SelectStmt':
        raise('ACCESS SHARE');
        break;
      default:
        if (type.startsWith('Alter')) raise('ACCESS EXCLUSIVE');
    }
  }
  const lk = lock as Lock;
  const risk: Analysis["risk"] = noTxn && lk !== 'ACCESS EXCLUSIVE' ? 'concurrent' : ['ACCESS EXCLUSIVE', 'EXCLUSIVE', 'SHARE ROW EXCLUSIVE', 'SHARE'].includes(lk) ? 'locking' : 'safe';
  return { statements: stmts.length, lock, risk, estSeconds: Math.round(est * 10) / 10, reversible: !!down.trim(), warnings, targets: [...rels], noTxn };
}

// ── State ─────────────────────────────────────────────────────

interface MigRow {
  id: string; project: string; version: string; name: string; up_sql: string; down_sql: string; author_id: string | null; author_label: string;
  created_at: Date; updated_at: Date;
}
interface StateRow {
  migration_id: string; connection_id: string; state: 'applied' | 'failed' | 'pending_approval' | 'rolled_back'; checksum: string | null;
  applied_at: Date | null; applied_by: string | null; ms: number | null; error: string | null; approval_id: string | null; approval_dir: string | null; updated_at?: Date;
}

const checksum = (sql: string) => sha256(Buffer.from(sql, 'utf8')).toString('hex');

async function projectOf(connId: string): Promise<string> {
  const r = await one('select project from wf_migration_projects where connection_id = $1', [connId]);
  return r?.project ?? 'default';
}

async function loadMig(project: string, id: string): Promise<MigRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Migration not found');
  const m = await one<MigRow>('select * from wf_migrations where id = $1 and project = $2', [id, project]);
  if (!m) throw notFound('Migration not found');
  return m;
}

async function upsertState(migId: string, connId: string, s: Partial<StateRow> & { state: StateRow['state'] }, snap?: Snapshot | null): Promise<void> {
  await q(
    `insert into wf_migration_state (migration_id, connection_id, state, checksum, applied_at, applied_by, ms, error, approval_id, approval_dir, snapshot, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (migration_id, connection_id) do update set state = excluded.state, checksum = excluded.checksum, applied_at = excluded.applied_at,
       applied_by = excluded.applied_by, ms = excluded.ms, error = excluded.error, approval_id = excluded.approval_id, approval_dir = excluded.approval_dir,
       snapshot = excluded.snapshot, updated_at = now()`,
    [migId, connId, s.state, s.checksum ?? null, s.applied_at ?? null, s.applied_by ?? null, s.ms ?? null, s.error ?? null, s.approval_id ?? null,
      s.approval_dir ?? null, snap ? JSON.stringify(snap) : null],
  );
  // Only the newest snapshot per connection is kept; drift compares against it.
  if (snap) await q(`update wf_migration_state set snapshot = null where connection_id = $1 and migration_id <> $2 and snapshot is not null`, [connId, migId]);
}

/** Folds the outcome of approvals back into migration state (the approvals module applies them). */
async function reconcile(connId: string, actor: string): Promise<void> {
  // The checksum comes from the SQL stored on the approval, which is what actually ran, not from the current migration text.
  const waiting = await q<StateRow & { a_state: string; a_result: any; a_sql: string }>(
    `select s.*, a.state as a_state, a.result as a_result, a.sql as a_sql from wf_migration_state s join approvals a on a.id = s.approval_id
     join wf_migrations m on m.id = s.migration_id where s.connection_id = $1 and s.state = 'pending_approval'`, [connId]);
  for (const w of waiting) {
    if (w.a_state === 'pending' || w.a_state === 'approved') continue;
    const up = w.approval_dir !== 'down';
    if (w.a_state === 'applied') {
      let snap: Snapshot | null = null;
      if (up) {
        const conn = await one<ConnRow>('select * from connections where id = $1', [connId]);
        snap = conn ? await snapshot(conn, actor).catch(() => null) : null;
      }
      await upsertState(w.migration_id, connId, up
        ? { state: 'applied', checksum: checksum(w.a_sql), applied_at: new Date(), applied_by: `approval ap-${w.approval_id}` }
        : { state: 'rolled_back', applied_by: `approval ap-${w.approval_id}` }, snap);
    } else if (w.a_state === 'failed') {
      await upsertState(w.migration_id, connId, { state: up ? 'failed' : 'applied', checksum: up ? null : w.checksum, error: String(w.a_result?.error ?? 'The approved run failed').slice(0, 1000) });
    } else {
      // rejected or withdrawn: back to where it was
      if (up) await q('delete from wf_migration_state where migration_id = $1 and connection_id = $2', [w.migration_id, connId]);
      else await upsertState(w.migration_id, connId, { state: 'applied', checksum: w.checksum, applied_by: w.applied_by, applied_at: w.applied_at });
    }
  }
}

function displayState(s: StateRow | undefined): 'pending' | 'applied' | 'failed' | 'awaiting approval' {
  if (!s || s.state === 'rolled_back') return 'pending';
  if (s.state === 'pending_approval') return 'awaiting approval';
  return s.state;
}

// ── Dry run ───────────────────────────────────────────────────

interface DryRunResult {
  ok: boolean;
  ms: number;
  statements: Array<{ index: number; command: string; ok: boolean; ms: number; rowCount: number | null; error?: string; line?: number }>;
  diff: DiffLine[];
  rolledBack: true;
  note: string;
}

async function auditText(sql: string): Promise<string> {
  return ((await getPolicy()).redactLiterals ? redactLiterals(sql) : sql).slice(0, 20_000);
}

async function dryRun(req: FastifyRequest, user: AuthUser, conn: ConnRow, level: Parameters<typeof plan>[0]['level'], mig: MigRow, sql: string): Promise<DryRunResult> {
  // Same policy as a real apply (blocked statements, read-only connections, access level) — minus the approval gate, since nothing is kept.
  const { stmts } = await plan({ user, conn, level, sql, source: 'migration', bypassApproval: true });
  const nt = stmts.find((s) => s.noTxn);
  if (nt) {
    throw badRequest(`${nt.command} cannot run inside a transaction, so it cannot be dry-run: a dry run is a transaction that is rolled back. Apply it on a non-production connection first.`, { code: 'COMB_NO_DRYRUN' });
  }
  const client = await checkout(conn);
  const t0 = Date.now();
  const out: DryRunResult['statements'] = [];
  let diff: DiffLine[] = [];
  let broken: Error | undefined;
  try {
    await client.query('begin');
    await client.query(`select set_config('statement_timeout', '60000', true), set_config('lock_timeout', '2s', true), set_config('application_name', $1, true)`,
      [('comb:' + user.email).slice(0, 63)]);
    const before = await snapshotWith(client);
    let failed = false;
    for (let i = 0; i < stmts.length; i++) {
      const s: Classified = stmts[i];
      const t = Date.now();
      try {
        // Extended protocol: the server accepts exactly one statement per message.
        const r = await client.query({ text: s.sql, queryMode: 'extended' } as any);
        out.push({ index: i, command: s.command, ok: true, ms: Date.now() - t, rowCount: (r as any).rowCount ?? null });
      } catch (e: any) {
        out.push({ index: i, command: s.command, ok: false, ms: Date.now() - t, rowCount: null, error: String(e?.message ?? e),
          line: sql.slice(0, s.start).split('\n').length });
        failed = true;
        break;
      }
    }
    if (!failed) diff = diffSnapshots(before, await snapshotWith(client));
  } finally {
    await client.query('rollback').catch((e) => { broken = e; });
    if (!broken) await client.query('discard all').catch((e) => { broken = e; });
    client.release(broken);
  }
  const ok = out.every((s) => s.ok) && out.length === stmts.length;
  await audit({
    actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATE', target: mig.version,
    sql: await auditText(sql), ms: Date.now() - t0, status: ok ? 'ok' : 'error', ip: req.ip,
    detail: { source: 'migration', dryRun: true, migration: mig.version, statements: out.length, ...(ok ? {} : { error: out.find((s) => !s.ok)?.error?.slice(0, 300) }) },
  });
  return {
    ok, ms: Date.now() - t0, statements: out, diff, rolledBack: true,
    note: ok ? `${out.length} statement${out.length === 1 ? '' : 's'} ran · rolled back · nothing was kept` : 'Stopped at the first error · rolled back · nothing was kept',
  };
}

// ── Routes ────────────────────────────────────────────────────

const connParam = z.object({ connId: z.string().uuid() });
const migParam = z.object({ connId: z.string().uuid(), id: z.string().uuid() });
const VERSION = /^\d{8}_\d{4,6}$/;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function checkScript(sql: string, label: string, required: boolean): void {
  if (!sql.trim()) {
    if (required) throw badRequest(`The ${label} SQL is empty`);
    return;
  }
  let stmts: Classified[];
  try {
    stmts = classify(sql);
  } catch (e) {
    if (e instanceof SqlSyntaxError) throw badRequest(`The ${label} SQL does not parse: ${e.message}`, { position: e.position });
    throw e;
  }
  if (stmts.some((s) => s.kind === 'transaction')) {
    throw badRequest(`Remove BEGIN/COMMIT from the ${label} SQL: Comb runs each migration in its own transaction.`);
  }
  const nt = stmts.find((s) => s.noTxn);
  if (nt && stmts.length > 1) throw badRequest(`${nt.command} must run outside a transaction, so it has to be the only statement of its migration.`);
}

const migBody = z.object({
  version: z.string().trim().regex(VERSION, 'use YYYYMMDD_HHMM').optional(),
  name: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, _ . - only'),
  up: z.string().max(500_000),
  down: z.string().max(500_000).default(''),
});

export default async function migrationsModule(app: FastifyInstance): Promise<void> {
  app.get('/migrations/:connId', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user, level } = await requireConn(req, connId, 'read');
    await reconcile(connId, user.email);
    const project = await projectOf(connId);
    const migs = await q<MigRow>('select * from wf_migrations where project = $1 order by version desc', [project]);
    const states = await q<StateRow>('select * from wf_migration_state where connection_id = $1', [connId]);
    const list = migs.map((m) => {
      const s = states.find((x) => x.migration_id === m.id);
      const st = displayState(s);
      let n = 0;
      let risk: Analysis['risk'] = 'safe';
      try {
        const cs = classify(m.up_sql);
        n = cs.length;
        if (cs.some((c) => c.noTxn)) risk = 'concurrent';
        else if (cs.some((c) => c.kind === 'ddl' && c.command !== 'CREATE TABLE' && c.command !== 'COMMENT')) risk = 'locking';
      } catch { /* shown in detail */ }
      return {
        id: m.id, version: m.version, name: m.name, author: m.author_label, createdAt: m.created_at, statements: n, risk, state: st,
        appliedAt: s?.state === 'applied' ? s.applied_at : null, error: s?.state === 'failed' ? s.error : null,
        drift: s?.state === 'applied' && !!s.checksum && s.checksum !== checksum(m.up_sql), approvalId: s?.approval_id ? Number(s.approval_id) : null,
      };
    });
    return {
      project, connection: { id: conn.id, name: conn.name, env: conn.env, readOnly: conn.read_only, requireApproval: conn.require_approval }, level,
      canAdmin: hasRole(user, 'Admin'),
      migrations: list,
      summary: {
        applied: list.filter((m) => m.state === 'applied').length, pending: list.filter((m) => m.state === 'pending').length,
        failed: list.filter((m) => m.state === 'failed').length, awaiting: list.filter((m) => m.state === 'awaiting approval').length,
        drift: list.filter((m) => m.drift).length,
      },
    };
  });

  app.get('/migrations/:connId/:id', async (req) => {
    const { connId, id } = parse(migParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'read');
    await reconcile(connId, user.email);
    const project = await projectOf(connId);
    const m = await loadMig(project, id);
    const analysis = await analyze(conn, user.email, m.up_sql, m.down_sql);
    // Promotion: every connection following the same project that the caller can see.
    const conns = await q<ConnRow & { project: string | null }>(
      `select c.*, p.project from connections c left join wf_migration_projects p on p.connection_id = c.id where coalesce(p.project, 'default') = $1
       order by array_position(array['local','dev','staging','prod'], c.env), c.name`, [project]);
    const states = await q<StateRow>('select * from wf_migration_state where migration_id = $1', [id]);
    const envs = [];
    for (const c of conns) {
      if ((await connectionLevel(user, c)) === 'none') continue;
      const s = states.find((x) => x.connection_id === c.id);
      envs.push({ id: c.id, name: c.name, color: c.color, env: c.env, state: displayState(s), at: s?.state === 'applied' ? s.applied_at : s?.updated_at ?? null,
        drift: s?.state === 'applied' && !!s.checksum && s.checksum !== checksum(m.up_sql) });
    }
    const mine = states.find((x) => x.connection_id === connId);
    return {
      id: m.id, version: m.version, name: m.name, up: m.up_sql, down: m.down_sql, author: m.author_label, createdAt: m.created_at, updatedAt: m.updated_at,
      state: displayState(mine), appliedAt: mine?.applied_at ?? null, appliedBy: mine?.applied_by ?? null, error: mine?.error ?? null, ms: mine?.ms ?? null,
      approvalId: mine?.approval_id ? Number(mine.approval_id) : null,
      drift: mine?.state === 'applied' && !!mine.checksum && mine.checksum !== checksum(m.up_sql),
      analysis: { ...analysis, est: fmtSeconds(analysis.estSeconds) }, envs,
      canEdit: m.author_id === user.id || hasRole(user, 'Admin'),
    };
  });

  app.post('/migrations/:connId', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'write');
    const body = parse(migBody, req.body);
    checkScript(body.up, 'up', true);
    checkScript(body.down, 'down', false);
    const project = await projectOf(connId);
    const version = body.version ?? stamp();
    const row = await one(
      `insert into wf_migrations (project, version, name, up_sql, down_sql, author_id, author_label) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [project, version, body.name, body.up, body.down, user.id, user.email],
    ).catch((e) => {
      if (e.code === '23505') throw badRequest(`Version ${version} already exists in project ${project}`);
      throw e;
    });
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATION', target: version, status: 'ok', ip: req.ip,
      detail: { action: 'create', project, name: body.name } });
    return { id: row.id, version };
  });

  app.put('/migrations/:connId/:id', async (req) => {
    const { connId, id } = parse(migParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'write');
    const project = await projectOf(connId);
    const m = await loadMig(project, id);
    if (m.author_id !== user.id && !hasRole(user, 'Admin')) throw forbidden('Only the author or an Admin can edit this migration');
    const body = parse(migBody.omit({ version: true }), req.body);
    checkScript(body.up, 'up', true);
    checkScript(body.down, 'down', false);
    const pending = await one(`select count(*)::int as n from wf_migration_state where migration_id = $1 and state = 'pending_approval'`, [id]);
    if (pending?.n && (body.up !== m.up_sql || body.down !== m.down_sql)) {
      throw badRequest('This migration is waiting for approval somewhere; withdraw that request before changing its SQL');
    }
    await q('update wf_migrations set name = $2, up_sql = $3, down_sql = $4, updated_at = now() where id = $1', [id, body.name, body.up, body.down]);
    const applied = await one(`select count(*)::int as n from wf_migration_state where migration_id = $1 and state = 'applied'`, [id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATION', target: m.version, status: 'ok', ip: req.ip,
      detail: { action: 'update', upChanged: body.up !== m.up_sql, appliedOn: applied?.n ?? 0 } });
    return { ok: true, drift: body.up !== m.up_sql && (applied?.n ?? 0) > 0 };
  });

  app.delete('/migrations/:connId/:id', async (req) => {
    const { connId, id } = parse(migParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'write');
    const m = await loadMig(await projectOf(connId), id);
    if (m.author_id !== user.id && !hasRole(user, 'Admin')) throw forbidden('Only the author or an Admin can delete this migration');
    const used = await one(`select count(*)::int as n from wf_migration_state where migration_id = $1 and state in ('applied','pending_approval')`, [id]);
    if (used?.n) throw badRequest('This migration is applied (or awaiting approval) somewhere; roll it back there first');
    await q('delete from wf_migrations where id = $1', [id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATION', target: m.version, status: 'ok', ip: req.ip, detail: { action: 'delete' } });
    return { ok: true };
  });

  app.post('/migrations/:connId/:id/dry-run', async (req) => {
    const { connId, id } = parse(migParam, req.params);
    const body = parse(z.object({ direction: z.enum(['up', 'down']).default('up') }), req.body ?? {});
    const { conn, level, user } = await requireConn(req, connId, 'write');
    // A dry run executes the SQL for real before rolling back, and some effects survive a rollback (sequences,
    // dblink, signalling other backends). On approval-required connections only an approver may do that,
    // as with dry runs of approval requests.
    if (conn.require_approval && !hasRole(user, 'Admin') && !levelAtLeast(level, 'admin')) {
      throw forbidden(`${conn.name} requires approval for writes, so only an Admin or a connection admin can dry-run here`);
    }
    const m = await loadMig(await projectOf(connId), id);
    const sql = body.direction === 'up' ? m.up_sql : m.down_sql;
    if (!sql.trim()) throw badRequest('There is no down SQL to dry-run');
    return dryRun(req, user, conn, level, m, sql);
  });

  const runDirection = async (req: FastifyRequest, dir: 'up' | 'down') => {
    const { connId, id } = parse(migParam, req.params);
    const body = parse(z.object({ confirm: z.string().max(200).optional() }), req.body ?? {});
    const { conn, level, user } = await requireConn(req, connId, 'write');
    await reconcile(connId, user.email);
    const m = await loadMig(await projectOf(connId), id);
    const cur = await one<StateRow>('select * from wf_migration_state where migration_id = $1 and connection_id = $2', [id, connId]);
    if (cur?.state === 'pending_approval') throw badRequest(`Already waiting for approval ap-${cur.approval_id}`);
    if (dir === 'up' && cur?.state === 'applied') throw badRequest(`${m.version} is already applied on ${conn.name}`);
    if (dir === 'down' && cur?.state !== 'applied') throw badRequest(`${m.version} is not applied on ${conn.name}`);
    const sql = dir === 'up' ? m.up_sql : m.down_sql;
    if (dir === 'down' && !sql.trim()) throw badRequest('This migration has no down SQL; write one before rolling back');
    if (conn.env === 'prod') {
      if (dir === 'up' && !m.down_sql.trim()) throw badRequest('Write a down migration before applying to prod');
      if (body.confirm !== m.version) {
        throw new HttpError(409, `Type ${m.version} to ${dir === 'up' ? 'apply' : 'roll back'} on ${conn.name}`, {
          code: 'COMB_CONFIRM', confirm: { word: m.version, kind: dir === 'up' ? 'APPLY MIGRATION' : 'ROLLBACK MIGRATION', target: `${m.version} on ${conn.name}`, sql },
        });
      }
    }
    const t0 = Date.now();
    let res;
    try {
      res = await runSql({ user, conn, level, sql, source: 'migration', ip: req.ip, confirm: body.confirm });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 1000);
      if (dir === 'up') await upsertState(id, connId, { state: 'failed', error: msg });
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATE', target: m.version, status: 'error', ip: req.ip,
        detail: { direction: dir, error: msg.slice(0, 300) } });
      throw e;
    }
    if (res.approvalId) {
      await upsertState(id, connId, { state: 'pending_approval', approval_id: String(res.approvalId), approval_dir: dir, checksum: cur?.checksum ?? null,
        applied_at: cur?.applied_at ?? null, applied_by: cur?.applied_by ?? null });
      return { state: 'awaiting approval', approvalId: res.approvalId };
    }
    const ms = Date.now() - t0;
    if (dir === 'up') {
      const snap = await snapshot(conn, user.email).catch(() => null);
      await upsertState(id, connId, { state: 'applied', checksum: checksum(m.up_sql), applied_at: new Date(), applied_by: user.email, ms }, snap);
      emit('migration.applied', { connection: conn.name, version: m.version, statements: res.statements.length });
    } else {
      await upsertState(id, connId, { state: 'rolled_back', applied_by: user.email, ms });
    }
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATE', target: m.version, ms, status: 'ok', ip: req.ip,
      detail: { direction: dir, statements: res.statements.length } });
    return { state: dir === 'up' ? 'applied' : 'pending', ms, statements: res.statements };
  };
  app.post('/migrations/:connId/:id/apply', (req) => runDirection(req, 'up'));
  app.post('/migrations/:connId/:id/rollback', (req) => runDirection(req, 'down'));

  // Compares the live catalog with the snapshot recorded at the last apply, and checksums with the stored up SQL.
  app.post('/migrations/:connId/drift', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'read');
    const project = await projectOf(connId);
    const rows = await q<StateRow & { version: string; up_sql: string; snapshot: Snapshot | null }>(
      `select s.*, m.version, m.up_sql from wf_migration_state s join wf_migrations m on m.id = s.migration_id
       where s.connection_id = $1 and m.project = $2 and s.state = 'applied' order by s.applied_at desc nulls last`, [connId, project]);
    const edited = rows.filter((r) => r.checksum && r.checksum !== checksum(r.up_sql)).map((r) => ({ version: r.version, appliedAt: r.applied_at }));
    const base = rows.find((r) => r.snapshot);
    const current = await snapshot(conn, user.email);
    const schema = base?.snapshot ? diffSnapshots(base.snapshot, current, true) : [];
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATION', target: conn.name, status: 'ok', ip: req.ip,
      detail: { action: 'drift-check', edited: edited.length, schema: schema.length } });
    return {
      baseline: base ? { version: base.version, at: base.applied_at } : null, edited, schema,
      checked: { tables: current.tables.length, indexes: current.indexes.length, constraints: current.constraints.length },
      clean: !edited.length && !schema.length,
    };
  });

  app.put('/migrations/:connId/project', async (req) => {
    const user = requireRole(req, 'Admin');
    const { connId } = parse(connParam, req.params);
    const { conn } = await requireConn(req, connId, 'read');
    const body = parse(z.object({ project: z.string().trim().min(1).max(63).regex(/^[A-Za-z0-9_.-]+$/) }), req.body);
    await q(`insert into wf_migration_projects (connection_id, project) values ($1,$2) on conflict (connection_id) do update set project = excluded.project`, [connId, body.project]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'MIGRATION', target: conn.name, status: 'ok', ip: req.ip,
      detail: { action: 'project', project: body.project } });
    return { project: body.project };
  });
}
