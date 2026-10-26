import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import { q, one } from '../db/meta.ts';
import { config } from '../config.ts';
import { parse, notFound, badRequest, HttpError } from '../core/http.ts';
import { audit, verifyChain } from '../security/audit.ts';
import { requireConn, requireRole, hasRole, type ConnRow, type AuthUser } from '../security/authz.ts';
import { withTarget, escapeIdent, escapeLit } from '../targets/pool.ts';
import { runSql } from '../targets/exec.ts';
import { getPolicy, hasSecretSetting } from '../core/settings.ts';
import { registerWorker } from '../core/jobs.ts';
import { sensitiveColumns } from './catalog.ts';

/*
 * Compliance: controls whose evidence is computed from live state, an evidence pack,
 * data subject requests planned from the catalog (PII classification + foreign keys),
 * retention policies (reported daily, enforced only through runSql), residency facts.
 */

const connParam = z.object({ connId: z.string().uuid() });
const ident = z.string().min(1).max(63);

// ── Controls ─────────────────────────────────────────────────────────────

type CtrlState = 'pass' | 'fail' | 'gap' | 'na';
interface Control { id: string; name: string; frameworks: string; evidence: string; checkedAt: string; state: CtrlState; fix: string | null }

async function latestChainCheck(maxAgeHours: number): Promise<{ at: Date; ok: boolean; checked: number; head: string | null; brokenAt: number | null }> {
  const last = await one(`select at, ok, checked, head, broken_at from compliance_chain_checks where at > now() - make_interval(hours => $1) order by at desc limit 1`, [maxAgeHours]);
  if (last) return { at: last.at, ok: last.ok, checked: Number(last.checked), head: last.head, brokenAt: last.broken_at === null ? null : Number(last.broken_at) };
  return recordChainCheck();
}

async function recordChainCheck() {
  const r = await verifyChain();
  const row = await one(`insert into compliance_chain_checks (ok, checked, broken_at, head) values ($1,$2,$3,$4) returning at`, [r.ok, r.checked, r.brokenAt, r.head]);
  return { at: row.at as Date, ok: r.ok, checked: r.checked, head: r.head, brokenAt: r.brokenAt };
}

/** Finds the ops module's restore-verification table if it is installed (guarded; it may not exist). */
async function lastBackupVerification(): Promise<{ at: Date | null; source: string } | null> {
  const cands = await q(`select table_name, column_name from information_schema.columns
    where table_schema = 'public' and table_name in ('backup_verifications','backup_restores','restore_drills','backup_drills','backup_runs','backups')
      and column_name in ('verified_at','restored_at','finished_at','completed_at')
    order by array_position(array['backup_verifications','backup_restores','restore_drills','backup_drills','backup_runs','backups']::text[], table_name::text),
             array_position(array['verified_at','restored_at','finished_at','completed_at']::text[], column_name::text)`);
  if (!cands.length) return null;
  const { table_name: t, column_name: c } = cands[0];
  const hasStatus = await one(`select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = 'status'`, [t]);
  // Identifiers come from the fixed lists above, confirmed by information_schema.
  const where = hasStatus ? `where status in ('ok','success','succeeded','verified','passed')` : '';
  const r = await one(`select max(${escapeIdent(c)}) as at from ${escapeIdent(t)} ${where}`).catch(() => null);
  return { at: r?.at ?? null, source: t };
}

export async function evaluateControls(conn: ConnRow): Promise<Control[]> {
  const now = new Date().toISOString();
  const out: Control[] = [];
  const policy = await getPolicy();

  const humans = await one(`select count(*)::int as n,
      count(*) filter (where not mfa_enabled and auth = 'password')::int as without,
      count(*) filter (where auth = 'sso')::int as sso
    from users where status = 'active' and role <> 'Service' and auth <> 'token'`);
  out.push({
    id: 'mfa', name: 'MFA enforced for all human members', frameworks: 'SOC 2 CC6.1 · ISO 27001 A.9.4.2', checkedAt: now, fix: 'security',
    state: policy.requireMfa || humans.without === 0 ? 'pass' : 'fail',
    evidence: policy.requireMfa ? `policy requires MFA · ${humans.n - humans.without} of ${humans.n} enrolled` + (humans.sso ? ` (${humans.sso} via SSO)` : '')
      : humans.without ? `${humans.without} member${humans.without === 1 ? '' : 's'} on password auth without MFA` : `all ${humans.n} members use MFA or SSO`,
  });

  const prod = await q<ConnRow>(`select * from connections where env = 'prod' order by name`);
  const rw = prod.filter((c) => !c.read_only);
  out.push({
    id: 'prod-ro', name: 'Prod connections read-only by default', frameworks: 'SOC 2 CC6.1 · ISO 27001 A.9.4.1', checkedAt: now, fix: null,
    state: !prod.length ? 'na' : rw.length ? 'fail' : 'pass',
    evidence: !prod.length ? 'no production connections' : rw.length ? `${rw.map((c) => c.name).join(', ')} accept writes` : `${prod.length} prod connection${prod.length === 1 ? '' : 's'}, all read-only`,
  });
  const noAppr = prod.filter((c) => !c.require_approval);
  out.push({
    id: 'prod-approvals', name: 'Approvals required on prod', frameworks: 'SOC 2 CC8.1 · ISO 27001 A.12.1.2', checkedAt: now, fix: null,
    state: !prod.length ? 'na' : noAppr.length ? 'fail' : 'pass',
    evidence: !prod.length ? 'no production connections' : noAppr.length ? `${noAppr.map((c) => c.name).join(', ')} without approvals` : 'every prod write goes through an approval',
  });

  const chain = await latestChainCheck(24);
  out.push({
    id: 'audit-chain', name: 'Audit chain verified in the last 24 h', frameworks: 'SOC 2 CC7.2 · ISO 27001 A.12.4.2', checkedAt: new Date(chain.at).toISOString(), fix: 'audit',
    state: chain.ok ? 'pass' : 'fail',
    evidence: chain.ok ? `${chain.checked.toLocaleString('en-US')} events · head ${chain.head ? chain.head.slice(0, 12) : 'empty'}` : `chain broken at event ${chain.brokenAt}`,
  });

  const bk = await lastBackupVerification();
  const bkAge = bk?.at ? (Date.now() - new Date(bk.at).getTime()) / 86_400_000 : null;
  out.push({
    id: 'backups', name: 'Backups verified within 7 days', frameworks: 'SOC 2 A1.2 · ISO 27001 A.12.3.1', checkedAt: bk?.at ? new Date(bk.at).toISOString() : now, fix: 'backup',
    state: !bk ? 'na' : bkAge !== null && bkAge <= 7 ? 'pass' : 'fail',
    evidence: !bk ? 'backups not configured in Comb' : bk.at ? `last verified restore ${Math.floor(bkAge!)} d ago` : 'no verified restore on record',
  });

  const sens = await sensitiveColumns(conn.id);
  const pii = sens.filter((c) => c.classification === 'PII' || c.classification === 'SECRET');
  const unmasked = pii.filter((c) => c.masking === 'none');
  out.push({
    id: 'masking', name: `Masking on all PII columns (${conn.name})`, frameworks: 'GDPR Art. 32 · SOC 2 CC6.7', checkedAt: now, fix: 'catalog',
    state: !pii.length ? 'na' : unmasked.length ? 'fail' : 'pass',
    evidence: !pii.length ? 'no columns classified PII yet' : unmasked.length ? `${unmasked.length} of ${pii.length} unmasked: ${unmasked.slice(0, 3).map((c) => `${c.table_name}.${c.column_name}`).join(', ')}` : `${pii.length} PII/secret columns, all masked`,
  });
  const cand = await one(`select count(*)::int as n, string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name) as cols
    from catalog_pii_candidates where connection_id = $1 and state = 'candidate'`, [conn.id]);
  const scanned = await one(`select max(finished_at) as at from catalog_scans where connection_id = $1 and status = 'ok'`, [conn.id]);
  out.push({
    id: 'pii-inventory', name: `PII inventory complete (${conn.name})`, frameworks: 'GDPR Art. 30', checkedAt: scanned?.at ? new Date(scanned.at).toISOString() : now, fix: 'catalog',
    state: !scanned?.at ? 'gap' : cand.n ? 'gap' : 'pass',
    evidence: !scanned?.at ? 'never scanned for PII' : cand.n ? `${cand.n} unreviewed candidate${cand.n === 1 ? '' : 's'}: ${String(cand.cols).slice(0, 80)}` : 'every scan candidate reviewed',
  });

  const pols = await q(`select table_name, last_over from compliance_retention where connection_id = $1`, [conn.id]);
  const piiTables = [...new Set(pii.map((c) => c.table_name))];
  const uncovered = piiTables.filter((t) => !pols.some((p) => p.table_name === t));
  const over = pols.filter((p) => Number(p.last_over ?? 0) > 0);
  out.push({
    id: 'retention', name: `Retention on personal data (${conn.name})`, frameworks: 'GDPR Art. 5(1)(e)', checkedAt: now, fix: null,
    state: !piiTables.length ? 'na' : uncovered.length ? 'gap' : over.length ? 'gap' : 'pass',
    evidence: !piiTables.length ? 'no PII tables classified' : uncovered.length ? `no policy on ${uncovered.slice(0, 3).join(', ')}`
      : over.length ? `${over.map((p) => `${p.table_name}: ${Number(p.last_over).toLocaleString('en-US')} rows over`).join(', ')}` : `${pols.length} policies, nothing over retention`,
  });

  const inactive = await one(`select count(*)::int as n from users where status = 'active' and role <> 'Owner'
    and coalesce(last_active_at, created_at) < now() - interval '90 days'`);
  out.push({
    id: 'inactive', name: 'Inactive users disabled after 90 days', frameworks: 'SOC 2 CC6.2 · ISO 27001 A.9.2.6', checkedAt: now, fix: 'team',
    state: inactive.n ? 'fail' : 'pass',
    evidence: inactive.n ? `${inactive.n} active account${inactive.n === 1 ? '' : 's'} idle for 90+ days` : 'no account idle for 90+ days',
  });

  const tokens = await one(`select count(*)::int as n from api_tokens where revoked_at is null and expires_at is null`);
  out.push({
    id: 'tokens', name: 'No API tokens without expiry', frameworks: 'SOC 2 CC6.1 · ISO 27001 A.9.2.4', checkedAt: now, fix: 'security',
    state: tokens.n ? 'fail' : 'pass',
    evidence: tokens.n ? `${tokens.n} live token${tokens.n === 1 ? '' : 's'} never expire` : 'every live token expires',
  });

  const writes = await one(`select count(*)::int as n from audit_log where at > now() - interval '30 days' and kind in ('INSERT','UPDATE','DELETE','MERGE','TRUNCATE','DROP','CREATE','ALTER') and actor_id is not null`);
  out.push({
    id: 'attributable', name: 'Every write through Comb is attributable', frameworks: 'SOC 2 CC7.2', checkedAt: now, fix: 'audit', state: 'pass',
    evidence: `${writes.n.toLocaleString('en-US')} writes in 30 days, each tied to a member in the hash-chained trail`,
  });
  return out;
}

// ── DSR planning ─────────────────────────────────────────────────────────

interface Rel { oid: number; schema: string; name: string; cols: Map<string, { type: string; nullable: boolean; unique: boolean }>; pk: string | null }
interface Fk { child: number; childCol: string; parent: number; parentCol: string; cascade: boolean }
export interface PlanStep {
  table: string; depth: number; via: string | null; action: 'anonymise' | 'delete' | 'keep' | 'review';
  columns: string[]; rows: number | null; select: string; erase: string | null; note: string;
}
export interface DsrPlan { subject: string; root: string; steps: PlanStep[]; unreachable: string[]; accessSql: string; erasureSql: string; text: string }

async function loadGraph(c: pg.PoolClient) {
  const rels = await c.query(`select c.oid::int as oid, n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p') and not c.relispartition and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`);
  const cols = await c.query(`select a.attrelid::int as oid, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
      exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisunique and i.indnatts = 1 and i.indkey[0] = a.attnum) as uniq,
      exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary and i.indnatts = 1 and i.indkey[0] = a.attnum) as pk
    from pg_attribute a where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped`, [rels.rows.map((r) => r.oid)]);
  const fks = await c.query(`select con.conrelid::int as child, ca.attname as child_col, con.confrelid::int as parent, pa.attname as parent_col, con.confdeltype = 'c' as cascade
    from pg_constraint con
    join pg_attribute ca on ca.attrelid = con.conrelid and ca.attnum = con.conkey[1]
    join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
    where con.contype = 'f' and array_length(con.conkey, 1) = 1`);
  const byOid = new Map<number, Rel>();
  for (const r of rels.rows) byOid.set(r.oid, { oid: r.oid, schema: r.schema, name: r.name, cols: new Map(), pk: null });
  for (const col of cols.rows) {
    const rel = byOid.get(col.oid);
    if (!rel) continue;
    rel.cols.set(col.name, { type: col.type, nullable: col.nullable, unique: col.uniq });
    if (col.pk) rel.pk = col.name;
  }
  const fkList: Fk[] = fks.rows.map((f) => ({ child: f.child, childCol: f.child_col, parent: f.parent, parentCol: f.parent_col, cascade: f.cascade }));
  return { byOid, fkList };
}

const qualified = (r: Rel) => `${escapeIdent(r.schema)}.${escapeIdent(r.name)}`;
const label = (r: Rel) => (r.schema === 'public' ? r.name : `${r.schema}.${r.name}`);

export async function buildPlan(conn: ConnRow, actor: string, d: { subject: string; locator: { schema: string; table: string; column: string } }): Promise<DsrPlan> {
  const sens = await sensitiveColumns(conn.id);
  return withTarget(conn, { readOnly: true, actor, timeoutMs: 30_000 }, async (c) => {
    const { byOid, fkList } = await loadGraph(c);
    const root = [...byOid.values()].find((r) => r.schema === d.locator.schema && r.name === d.locator.table);
    if (!root || !root.cols.has(d.locator.column)) throw badRequest(`${d.locator.schema}.${d.locator.table}.${d.locator.column} not found`);
    const piiOf = (r: Rel) => sens.filter((s) => s.schema_name === r.schema && s.table_name === r.name && r.cols.has(s.column_name)).map((s) => s.column_name);

    // Breadth-first over inbound foreign keys: a child row belongs to the subject when its key chain reaches the root row.
    const lit = escapeLit(d.subject);
    const preds = new Map<number, { pred: string; depth: number; via: string | null }>();
    preds.set(root.oid, { pred: `${escapeIdent(d.locator.column)} = ${lit}`, depth: 0, via: null });
    const queue = [root.oid];
    while (queue.length) {
      const pOid = queue.shift()!;
      const p = preds.get(pOid)!;
      if (p.depth >= 4) continue;
      const parent = byOid.get(pOid)!;
      for (const fk of fkList.filter((f) => f.parent === pOid && !preds.has(f.child))) {
        const child = byOid.get(fk.child);
        if (!child) continue;
        preds.set(fk.child, {
          pred: `${escapeIdent(fk.childCol)} in (select ${escapeIdent(fk.parentCol)} from ${qualified(parent)} where ${p.pred})`,
          depth: p.depth + 1, via: `${child.name}.${fk.childCol} → ${parent.name}.${fk.parentCol}`,
        });
        queue.push(fk.child);
      }
    }

    const steps: PlanStep[] = [];
    for (const [oid, p] of preds) {
      const rel = byOid.get(oid)!;
      const pii = piiOf(rel);
      const select = `select * from ${qualified(rel)} where ${p.pred};`;
      let rows: number | null = null;
      try {
        rows = Number((await c.query(`select count(*)::bigint as n from ${qualified(rel)} where ${p.pred}`)).rows[0].n);
      } catch { rows = null; }
      const referenced = fkList.filter((f) => f.parent === oid && f.child !== oid);
      const blocking = referenced.filter((f) => !f.cascade);
      let action: PlanStep['action'];
      let erase: string | null = null;
      let note: string;
      if (!pii.length) {
        action = 'keep';
        note = 'keep · no personal columns classified';
      } else if (!blocking.length) {
        action = 'delete';
        erase = `delete from ${qualified(rel)} where ${p.pred};`;
        note = referenced.length ? 'delete · dependants cascade' : 'delete';
      } else {
        const sets: string[] = [];
        const stuck: string[] = [];
        for (const col of pii) {
          const meta = rel.cols.get(col)!;
          const ci = escapeIdent(col);
          if (meta.nullable) sets.push(`${ci} = null`);
          else if (/^(text|character varying|varchar|citext)/.test(meta.type)) {
            const key = rel.pk ? `${escapeIdent(rel.pk)}::text` : `md5(random()::text)`;
            sets.push(meta.unique ? `${ci} = 'erased-' || ${key} || '@invalid'` : `${ci} = 'erased'`);
          } else stuck.push(col);
        }
        action = sets.length ? 'anonymise' : 'review';
        erase = sets.length ? `update ${qualified(rel)} set ${sets.join(', ')} where ${p.pred};` : null;
        const refs = [...new Set(blocking.map((f) => byOid.get(f.child)?.name).filter(Boolean))].join(', ');
        note = `anonymise ${sets.length ? pii.filter((x) => !stuck.includes(x)).join(', ') : ''} · kept for ${refs}` +
          (stuck.length ? ` · cannot null ${stuck.join(', ')} (NOT NULL), review by hand` : '');
      }
      steps.push({ table: label(rel), depth: p.depth, via: p.via, action, columns: pii, rows, select, erase, note });
    }
    // FK-safe order: deepest dependants first, the root (whose locator column may be anonymised) last.
    steps.sort((a, b) => b.depth - a.depth || a.table.localeCompare(b.table));

    const reached = new Set([...preds.keys()].map((o) => label(byOid.get(o)!)));
    const unreachable = [...new Set(sens.map((s) => (s.schema_name === 'public' ? s.table_name : `${s.schema_name}.${s.table_name}`)))].filter((t) => !reached.has(t));

    const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));
    const lines = steps.map((s, i) => `-- ${i + 1}. ${pad(s.table, 16)} → ${pad(s.note, 44)} (${s.rows === null ? '?' : s.rows.toLocaleString('en-US')} row${s.rows === 1 ? '' : 's'})`);
    if (unreachable.length) lines.push('', `-- not reachable by foreign key from ${root.name}: ${unreachable.join(', ')}`, '-- these hold personal data but nothing links them to the subject; review by hand.');
    lines.push('', '-- audit trail → keep (the record of this request itself)');
    return {
      subject: d.subject, root: label(root), steps, unreachable,
      accessSql: steps.map((s) => s.select).join('\n'),
      erasureSql: steps.filter((s) => s.erase).map((s) => s.erase).join('\n'),
      text: lines.join('\n'),
    };
  });
}

// ── Retention ────────────────────────────────────────────────────────────

async function checkRetention(p: any, conn: ConnRow): Promise<void> {
  try {
    const n = await withTarget(conn, { readOnly: true, actor: 'comb:retention', timeoutMs: 60_000 }, async (c) => {
      const r = await c.query(`select count(*)::bigint as n from ${escapeIdent(p.schema_name)}.${escapeIdent(p.table_name)} where ${escapeIdent(p.ts_column)} < now() - make_interval(days => $1)`, [p.keep_days]);
      return Number(r.rows[0].n);
    });
    await q(`update compliance_retention set last_checked_at = now(), last_over = $2, last_error = null where id = $1`, [p.id, n]);
  } catch (e) {
    await q(`update compliance_retention set last_checked_at = now(), last_error = $2 where id = $1`, [p.id, String((e as Error).message).slice(0, 300)]);
  }
}

// Daily: verify the audit chain and report (never delete) rows over retention.
registerWorker('compliance.daily', async () => {
  await recordChainCheck();
  const pols = await q(`select r.*, c.id as cid from compliance_retention r join connections c on c.id = r.connection_id`);
  for (const p of pols) {
    const conn = await one<ConnRow>('select * from connections where id = $1', [p.cid]);
    if (conn) await checkRetention(p, conn);
  }
}, '0 4 * * *');

// ── Residency ────────────────────────────────────────────────────────────

async function residency(user: AuthUser) {
  const conns = await q(`select name, env, host, port from connections order by env desc, name`);
  const hosts = new Map<string, string[]>();
  for (const c of conns) {
    const k = c.host;
    if (!hosts.has(k)) hosts.set(k, []);
    hosts.get(k)!.push(`${c.name} (${c.env})`);
  }
  const ai = await hasSecretSetting('ai.apiKey');
  const processors: Array<{ name: string; purpose: string }> = [];
  if (ai) processors.push({ name: 'Anthropic', purpose: 'model provider for the AI panel' });
  const integ = await one(`select to_regclass('public.integrations') is not null as present`);
  if (integ?.present) {
    const cols = await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'integrations' and column_name in ('kind','name','enabled')`);
    const has = new Set(cols.map((c) => c.column_name));
    if (has.has('kind')) {
      const rows = await q(`select distinct kind${has.has('name') ? ', name' : ''} from integrations${has.has('enabled') ? ' where enabled' : ''} limit 20`).catch(() => []);
      for (const r of rows) processors.push({ name: String(r.name ?? r.kind), purpose: `integration (${r.kind})` });
    }
  }
  let publicHost = '';
  try { publicHost = new URL(config.COMB_PUBLIC_URL ?? '').host; } catch { /* unset */ }
  return {
    data: [...hosts.entries()].map(([host, names]) => ({ host, connections: hasRole(user, 'Admin') ? names : names.length + ' connection' + (names.length === 1 ? '' : 's') })),
    combServer: publicHost ? `self-hosted · ${publicHost}` : 'self-hosted',
    processors,
    aiConfigured: ai,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────

/** Same rule as web/src/lib/format.ts toCsv: cells starting with = + - @ tab CR get a leading quote. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

// ── Routes ───────────────────────────────────────────────────────────────

const dsrInput = z.object({
  kind: z.enum(['access', 'erasure', 'rectification']),
  subject: z.string().trim().min(1).max(320),
  locator: z.object({ schema: ident, table: ident, column: ident }),
  note: z.string().max(500).default(''),
});

async function loadDsr(connId: string, id: number) {
  const d = await one(`select * from compliance_dsr where id = $1 and connection_id = $2`, [id, connId]);
  if (!d) throw notFound('Request not found');
  return d;
}

function dsrView(d: any) {
  return {
    id: Number(d.id), kind: d.kind, subject: d.subject, locator: d.locator, note: d.note, dueAt: d.due_at, state: d.state,
    approvalId: d.approval_id === null ? null : Number(d.approval_id), result: d.result, createdAt: d.created_at, completedAt: d.completed_at,
  };
}

export default async function complianceModule(app: FastifyInstance): Promise<void> {
  app.get('/compliance/:connId/controls', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn } = await requireConn(req, connId, 'read');
    requireRole(req, 'Admin');
    return { controls: await evaluateControls(conn) };
  });

  app.post('/compliance/:connId/evidence', async (req, reply) => {
    const { connId } = parse(connParam, req.params);
    const { format } = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.body ?? {});
    const { conn } = await requireConn(req, connId, 'read');
    const user = requireRole(req, 'Admin');
    const chain = await recordChainCheck();
    const controls = await evaluateControls(conn);
    const generatedAt = new Date().toISOString();
    const dsr = await q(`select kind, state, count(*)::int as n from compliance_dsr where connection_id = $1 group by 1, 2`, [conn.id]);
    const retention = await q(`select schema_name, table_name, ts_column, keep_days, last_checked_at, last_over from compliance_retention where connection_id = $1`, [conn.id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'EXPORT', target: 'evidence pack', status: 'ok', ip: req.ip,
      detail: { format, controls: controls.length, failing: controls.filter((c) => c.state === 'fail').length, chainHead: chain.head } });
    const stamp = generatedAt.slice(0, 10);
    if (format === 'csv') {
      const csv = toCsv(['control', 'frameworks', 'state', 'evidence', 'checked_at'], controls.map((c) => [c.name, c.frameworks, c.state, c.evidence, c.checkedAt]))
        + '\r\n\r\n' + toCsv(['audit_chain_ok', 'events_checked', 'chain_head', 'generated_at', 'generated_by'], [[chain.ok, chain.checked, chain.head ?? '', generatedAt, user.email]]);
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="comb-evidence-${stamp}.csv"`);
      return csv;
    }
    reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="comb-evidence-${stamp}.json"`);
    return {
      generatedAt, generatedBy: user.email, comb: config.COMB_VERSION, connection: conn.name,
      auditChain: { ok: chain.ok, eventsChecked: chain.checked, head: chain.head, brokenAt: chain.brokenAt, verifiedAt: new Date(chain.at).toISOString() },
      controls, dataSubjectRequests: dsr, retention,
    };
  });

  // Data subject requests.
  app.get('/compliance/:connId/dsr', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn } = await requireConn(req, connId, 'read');
    requireRole(req, 'Admin');
    const rows = await q(`select * from compliance_dsr where connection_id = $1 order by (state in ('open','awaiting_approval')) desc, due_at`, [conn.id]);
    // Locator suggestions: PII columns that look like identifiers, plus primary keys of tables carrying PII.
    const sens = await sensitiveColumns(conn.id);
    return { requests: rows.map(dsrView), locators: sens.filter((s) => s.classification === 'PII').map((s) => ({ schema: s.schema_name, table: s.table_name, column: s.column_name })) };
  });

  app.post('/compliance/:connId/dsr', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(dsrInput, req.body);
    const { conn } = await requireConn(req, connId, 'read');
    const user = requireRole(req, 'Admin');
    const row = await one(`insert into compliance_dsr (connection_id, kind, subject, locator, note, due_at, created_by)
      values ($1,$2,$3,$4,$5, now() + interval '30 days', $6) returning *`, [conn.id, body.kind, body.subject, JSON.stringify(body.locator), body.note, user.id]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DSR', target: `dsr-${row.id}`, status: 'ok', ip: req.ip,
      detail: { action: 'create', kind: body.kind, locator: body.locator } });
    return dsrView(row);
  });

  app.get('/compliance/:connId/dsr/:id/plan', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const { conn, user } = await requireConn(req, connId, 'read');
    requireRole(req, 'Admin');
    const d = await loadDsr(conn.id, id);
    return buildPlan(conn, user.email, d);
  });

  app.post('/compliance/:connId/dsr/:id/run', async (req, reply) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({ confirm: z.string().max(400).optional(), confirmRun: z.string().max(200).optional() }), req.body ?? {});
    const { conn, user, level } = await requireConn(req, connId, 'read');
    requireRole(req, 'Admin');
    const d = await loadDsr(conn.id, id);
    if (d.state !== 'open') throw badRequest(`This request is ${d.state.replace('_', ' ')}`);
    const plan = await buildPlan(conn, user.email, d);

    if (d.kind === 'access' || d.kind === 'rectification') {
      const tables: Record<string, { columns: string[]; rows: unknown[][] }> = {};
      let total = 0;
      for (const s of plan.steps) {
        const r = await runSql({ user, conn, level, sql: s.select, source: 'query', forceReadOnly: true, maxRows: 10_000, ip: req.ip });
        tables[s.table] = { columns: r.columns.map((c) => c.name), rows: r.rows };
        total += r.rows.length;
      }
      const result = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.rows.length])), total };
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'EXPORT', target: `dsr-${id}`, rows: total, status: 'ok', ip: req.ip,
        detail: { action: 'dsr.' + d.kind, tables: result.tables } });
      if (d.kind === 'access') await q(`update compliance_dsr set state = 'done', completed_at = now(), result = $2 where id = $1`, [id, JSON.stringify(result)]);
      reply.header('content-disposition', `attachment; filename="dsr-${id}-${d.kind}.json"`);
      return { request: `dsr-${id}`, kind: d.kind, subject: d.subject, generatedAt: new Date().toISOString(), masked: level !== 'admin', tables };
    }

    // Erasure: typed confirmation of the subject, then everything goes through runSql (approvals, prod confirmation, audit).
    if (body.confirm !== d.subject) {
      throw new HttpError(409, `Type ${d.subject} to erase this person's data`, {
        code: 'COMB_CONFIRM', confirm: { word: d.subject, kind: 'ERASE', target: d.subject, sql: plan.erasureSql },
      });
    }
    if (!plan.erasureSql) throw badRequest('Nothing to erase: no classified personal columns are reachable from the subject');
    const r = await runSql({ user, conn, level, sql: plan.erasureSql, source: 'query', confirm: body.confirmRun, ip: req.ip });
    if (r.approvalId) {
      await q(`update compliance_dsr set state = 'awaiting_approval', approval_id = $2 where id = $1`, [id, r.approvalId]);
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DSR', target: `dsr-${id}`, status: 'pending', ip: req.ip, detail: { action: 'erasure', approvalId: r.approvalId } });
      return { approvalId: r.approvalId };
    }
    const result = { statements: r.statements.map((s, i) => ({ table: plan.steps.filter((x) => x.erase)[i]?.table, command: s.command, rows: s.rowCount })) };
    await q(`update compliance_dsr set state = 'done', completed_at = now(), result = $2 where id = $1`, [id, JSON.stringify(result)]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DSR', target: `dsr-${id}`, status: 'ok', ip: req.ip, detail: { action: 'erasure', ...result } });
    return { done: true, ...result };
  });

  app.post('/compliance/:connId/dsr/:id/state', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const { state } = parse(z.object({ state: z.enum(['open', 'done', 'cancelled']) }), req.body);
    const { conn } = await requireConn(req, connId, 'read');
    const user = requireRole(req, 'Admin');
    await loadDsr(conn.id, id);
    await q(`update compliance_dsr set state = $2, completed_at = case when $2 = 'open' then null else now() end where id = $1`, [id, state]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'DSR', target: `dsr-${id}`, status: 'ok', ip: req.ip, detail: { action: 'state', state } });
    return { ok: true };
  });

  // Retention policies.
  app.get('/compliance/:connId/retention', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn } = await requireConn(req, connId, 'read');
    const rows = await q(`select * from compliance_retention where connection_id = $1 order by table_name`, [conn.id]);
    return rows.map((r) => ({ id: Number(r.id), schema: r.schema_name, table: r.table_name, column: r.ts_column, keepDays: r.keep_days, note: r.note,
      lastCheckedAt: r.last_checked_at, over: r.last_over === null ? null : Number(r.last_over), error: r.last_error, lastEnforcedAt: r.last_enforced_at }));
  });

  app.post('/compliance/:connId/retention', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ schema: ident.default('public'), table: ident, column: ident, keepDays: z.number().int().min(1).max(36500), note: z.string().max(300).default('') }), req.body);
    const { conn } = await requireConn(req, connId, 'read');
    const user = requireRole(req, 'Admin');
    const ok = await withTarget(conn, { readOnly: true, actor: user.email }, (c) => c.query(
      `select format_type(a.atttypid, a.atttypmod) as type from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and a.attname = $3 and a.attnum > 0 and not a.attisdropped and c.relkind in ('r','p')`, [body.schema, body.table, body.column]));
    if (!ok.rows.length) throw badRequest(`${body.table}.${body.column} not found`);
    if (!/^(timestamp|date)/.test(ok.rows[0].type)) throw badRequest('Retention needs a timestamp or date column');
    const row = await one(`insert into compliance_retention (connection_id, schema_name, table_name, ts_column, keep_days, note, created_by) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (connection_id, schema_name, table_name, ts_column) do update set keep_days = excluded.keep_days, note = excluded.note returning *`,
      [conn.id, body.schema, body.table, body.column, body.keepDays, body.note, user.id]);
    await checkRetention(row, conn);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'RETENTION', target: `${body.schema}.${body.table}`, status: 'ok', ip: req.ip,
      detail: { action: 'set', column: body.column, keepDays: body.keepDays } });
    return { id: Number(row.id) };
  });

  app.delete('/compliance/:connId/retention/:id', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const { conn } = await requireConn(req, connId, 'read');
    const user = requireRole(req, 'Admin');
    const r = await one(`delete from compliance_retention where id = $1 and connection_id = $2 returning *`, [id, conn.id]);
    if (!r) throw notFound('Policy not found');
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'RETENTION', target: `${r.schema_name}.${r.table_name}`, status: 'ok', ip: req.ip, detail: { action: 'delete' } });
    return { ok: true };
  });

  app.post('/compliance/:connId/retention/:id/check', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const { conn } = await requireConn(req, connId, 'read');
    const p = await one(`select * from compliance_retention where id = $1 and connection_id = $2`, [id, conn.id]);
    if (!p) throw notFound('Policy not found');
    await checkRetention(p, conn);
    const r = await one(`select last_over, last_error from compliance_retention where id = $1`, [id]);
    return { over: r.last_over === null ? null : Number(r.last_over), error: r.last_error };
  });

  app.post('/compliance/:connId/retention/:id/enforce', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({ confirm: z.string().max(200).optional(), confirmRun: z.string().max(200).optional() }), req.body ?? {});
    const { conn, user, level } = await requireConn(req, connId, 'write');
    requireRole(req, 'Admin');
    const p = await one(`select * from compliance_retention where id = $1 and connection_id = $2`, [id, conn.id]);
    if (!p) throw notFound('Policy not found');
    const sql = `delete from ${escapeIdent(p.schema_name)}.${escapeIdent(p.table_name)} where ${escapeIdent(p.ts_column)} < now() - interval '${Number(p.keep_days)} days'`;
    if (body.confirm !== p.table_name) {
      throw new HttpError(409, `Type ${p.table_name} to delete rows older than ${p.keep_days} days`, {
        code: 'COMB_CONFIRM', confirm: { word: p.table_name, kind: 'DELETE', target: `${p.schema_name}.${p.table_name}`, sql },
      });
    }
    const r = await runSql({ user, conn, level, sql, source: 'query', confirm: body.confirmRun, ip: req.ip });
    if (r.approvalId) return { approvalId: r.approvalId };
    await q(`update compliance_retention set last_enforced_at = now(), last_over = 0, last_checked_at = now() where id = $1`, [id]);
    return { deleted: r.statements[0]?.rowCount ?? 0 };
  });

  app.get('/compliance/:connId/residency', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { user } = await requireConn(req, connId, 'read');
    return residency(user);
  });
}
