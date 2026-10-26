import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scanSync, fingerprintSync } from 'libpg-query';
import { q, one, tx } from '../db/meta.ts';
import { parse, badRequest, notFound, forbidden } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { userOf, hasRole, requireConn, connectionLevel, type AuthUser, type ConnRow } from '../security/authz.ts';
import { escapeLit } from '../targets/pool.ts';
import { classify, SqlSyntaxError } from '../targets/classify.ts';
import { runSql } from '../targets/exec.ts';

/*
 * Query library: saved, versioned, shareable queries with `:name` parameters.
 *
 * Parameters are bound, not interpolated: each `:name` placeholder is found with the real
 * Postgres scanner (so text inside strings, comments and dollar quotes is never touched),
 * replaced with an escaped literal, and the result is re-parsed. If the bound SQL does not have
 * exactly the statements of the template (count, command, kind and parse-tree fingerprint, which
 * ignores constant values), it is refused, so inputs can never turn a query into another statement.
 */

// ── Parameters ────────────────────────────────────────────────

export type ParamType = 'text' | 'number';
export interface ParamDef { type: ParamType; default?: string }
interface Placeholder { name: string; start: number; end: number }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Finds `:name` placeholders outside strings, comments, identifiers and `::` casts. */
export function placeholders(sql: string): Placeholder[] {
  let tokens;
  try {
    tokens = scanSync(sql).tokens;
  } catch {
    return [];
  }
  const out: Placeholder[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const n = tokens[i + 1];
    if (sql.slice(t.start, t.end) !== ':' || n.start !== t.end) continue;
    const word = sql.slice(n.start, n.end);
    if (!IDENT.test(word)) continue;
    out.push({ name: word, start: t.start, end: n.end });
    i++;
  }
  return out;
}

export function paramNames(sql: string): string[] {
  return [...new Set(placeholders(sql).map((p) => p.name))];
}

function substitute(sql: string, ph: Placeholder[], value: (name: string) => string): string {
  let out = '';
  let at = 0;
  for (const p of ph) {
    out += sql.slice(at, p.start) + value(p.name);
    at = p.end;
  }
  return out + sql.slice(at);
}

function shape(sql: string): Array<{ command: string; kind: string; fp: string }> {
  return classify(sql).map((s) => ({ command: s.command, kind: s.kind, fp: fingerprintSync(s.sql) }));
}

/**
 * Binds parameter values into a template. Text values become escaped literals; number values
 * must match a numeric literal and are parenthesised (so `-` can never start a comment).
 */
export function bindParams(template: string, values: Record<string, unknown>, defs: Record<string, ParamDef> = {}): string {
  const ph = placeholders(template);
  if (!ph.length) return template;
  const typeOf = (n: string): ParamType => defs[n]?.type ?? 'text';
  const lit = (n: string): string => {
    let v = values[n];
    if (v === undefined || v === null || v === '') v = defs[n]?.default;
    if (v === undefined || v === null) throw badRequest(`Parameter :${n} needs a value`);
    const s = String(v);
    if (s.length > 10_000) throw badRequest(`Parameter :${n} is too long`);
    if (typeOf(n) === 'number') {
      if (!NUMERIC.test(s.trim())) throw badRequest(`Parameter :${n} must be a number`);
      return '(' + s.trim() + ')';
    }
    return escapeLit(s);
  };
  const dummy = (n: string): string => (typeOf(n) === 'number' ? '(0)' : "''");
  let expected;
  try {
    expected = shape(substitute(template, ph, dummy));
  } catch (e) {
    if (e instanceof SqlSyntaxError) throw badRequest('The saved query does not parse: ' + e.message);
    throw e;
  }
  const bound = substitute(template, ph, lit);
  let got;
  try {
    got = shape(bound);
  } catch {
    throw badRequest('Parameter values changed the statement; refused.', { code: 'COMB_PARAM' });
  }
  const same = got.length === expected.length && got.every((g, i) => g.command === expected[i].command && g.kind === expected[i].kind && g.fp === expected[i].fp);
  if (!same) throw badRequest('Parameter values changed the statement; refused.', { code: 'COMB_PARAM' });
  return bound;
}

// ── Access ────────────────────────────────────────────────────

interface LibRow {
  id: string; name: string; description: string; sql: string; params: Record<string, ParamDef>; owner_id: string; owner_label: string;
  visibility: 'private' | 'shared' | 'readonly'; allow_schedule: boolean; tags: string[]; connection_id: string | null;
  version: number; runs: string; total_ms: string; last_run_at: Date | null; last_run_by: string | null; created_at: Date; updated_at: Date;
}

const SELECT = `select l.*, coalesce(nullif(u.name, ''), u.email) as owner_label from library_queries l join users u on u.id = l.owner_id`;

async function canSeeConn(user: AuthUser, connId: string | null, cache: Map<string, boolean>): Promise<boolean> {
  if (!connId) return true;
  if (!cache.has(connId)) {
    const c = await one<ConnRow>('select id, env from connections where id = $1', [connId]);
    cache.set(connId, !!c && (await connectionLevel(user, c)) !== 'none');
  }
  return cache.get(connId)!;
}

/** Private queries (and shared ones pinned to a connection the caller cannot reach) are 404 for others. */
export async function loadVisible(user: AuthUser, id: string): Promise<LibRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Query not found');
  const row = await one<LibRow>(SELECT + ' where l.id = $1', [id]);
  if (!row) throw notFound('Query not found');
  if (row.owner_id !== user.id) {
    if (row.visibility === 'private') throw notFound('Query not found');
    if (!(await canSeeConn(user, row.connection_id, new Map()))) throw notFound('Query not found');
  }
  return row;
}

function canEdit(user: AuthUser, r: LibRow): boolean {
  return r.owner_id === user.id || r.visibility === 'shared';
}

function summary(r: LibRow, user: AuthUser) {
  const runs = Number(r.runs);
  return {
    id: r.id, name: r.name, description: r.description, tags: r.tags, owner: { id: r.owner_id, label: r.owner_label },
    visibility: r.visibility, shared: r.visibility !== 'private', allowSchedule: r.allow_schedule, connectionId: r.connection_id,
    version: r.version, runs, avgMs: runs ? Math.round(Number(r.total_ms) / runs) : null, lastRunAt: r.last_run_at, lastRunBy: r.last_run_by,
    mine: r.owner_id === user.id, canEdit: canEdit(user, r), params: paramNames(r.sql), updatedAt: r.updated_at,
  };
}

// ── Diff ──────────────────────────────────────────────────────

/** Line diff (LCS). Fine for queries; capped so a huge paste cannot blow up memory. */
export function lineDiff(a: string, b: string): Array<{ op: ' ' | '+' | '-'; text: string }> {
  const x = a.split('\n').slice(0, 2000);
  const y = b.split('\n').slice(0, 2000);
  const m = x.length, n = y.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ op: ' ' | '+' | '-'; text: string }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < m) out.push({ op: '-', text: x[i++] });
  while (j < n) out.push({ op: '+', text: y[j++] });
  return out;
}

// ── Schemas ───────────────────────────────────────────────────

const idParam = z.object({ id: z.string().uuid() });
const paramDefs = z.record(z.string().regex(IDENT).max(63), z.object({ type: z.enum(['text', 'number']), default: z.string().max(1000).optional() })).refine((r) => Object.keys(r).length <= 50);
const base = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  sql: z.string().min(1).max(200_000),
  params: paramDefs.default({}),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  connectionId: z.string().uuid().nullable().default(null),
};
const createBody = z.object({
  ...base,
  visibility: z.enum(['private', 'shared', 'readonly']).default('private'),
  allowSchedule: z.boolean().default(true),
  note: z.string().max(300).default('first version'),
});
const updateBody = z.object({
  name: base.name.optional(), description: z.string().max(2000).optional(), sql: base.sql.optional(), params: paramDefs.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(), connectionId: z.string().uuid().nullable().optional(), note: z.string().max(300).default(''),
});
const values = z.record(z.string().max(63), z.union([z.string().max(10_000), z.number()])).default({});

function checkSql(sql: string): void {
  // The template must parse once placeholders are filled with dummies.
  const ph = placeholders(sql);
  try {
    const stmts = classify(substitute(sql, ph, () => "''"));
    if (!stmts.length) throw badRequest('The query is empty');
    if (stmts.length > 50) throw badRequest('At most 50 statements per saved query');
  } catch (e) {
    if (e instanceof SqlSyntaxError) throw badRequest('The query does not parse: ' + e.message);
    throw e;
  }
}

export default async function libraryModule(app: FastifyInstance): Promise<void> {
  // List. The sidebar and palette call `?limit=20` and need [{ id, name }].
  app.get('/library', async (req) => {
    const user = userOf(req);
    const qs = parse(z.object({
      limit: z.coerce.number().int().min(1).max(500).default(200),
      q: z.string().max(200).optional(),
      filter: z.enum(['All', 'Mine', 'Shared']).default('All'),
    }), req.query);
    const rows = await q<LibRow>(
      SELECT + ` where (l.owner_id = $1 or l.visibility <> 'private')
         and ($2::text is null or l.name ilike $2 or l.description ilike $2 or array_to_string(l.tags, ' ') ilike $2)
         and ($3 = 'All' or ($3 = 'Mine' and l.owner_id = $1) or ($3 = 'Shared' and l.visibility <> 'private'))
       order by l.last_run_at desc nulls last, l.updated_at desc limit 1000`,
      [user.id, qs.q ? '%' + qs.q.replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null, qs.filter],
    );
    const cache = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      if (out.length >= qs.limit) break;
      if (r.owner_id !== user.id && !(await canSeeConn(user, r.connection_id, cache))) continue;
      out.push(summary(r, user));
    }
    return out;
  });

  app.get('/library/:id', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const r = await loadVisible(user, id);
    const versions = await q(
      `select n, note, author_label, created_at from library_versions where query_id = $1 order by n desc limit 200`, [id]);
    return { ...summary(r, user), sql: r.sql, paramDefs: r.params, versions: versions.map((v) => ({ n: v.n, note: v.note, author: v.author_label, at: v.created_at })) };
  });

  app.post('/library', async (req) => {
    const user = userOf(req);
    const body = parse(createBody, req.body);
    checkSql(body.sql);
    if (body.connectionId) await requireConn(req, body.connectionId, 'read');
    const row = await tx(async (c) => {
      const r = await c.query(
        `insert into library_queries (name, description, sql, params, owner_id, visibility, allow_schedule, tags, connection_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [body.name, body.description, body.sql, body.params, user.id, body.visibility, body.allowSchedule, body.tags, body.connectionId],
      );
      const id = r.rows[0].id as string;
      await c.query(
        `insert into library_versions (query_id, n, name, description, sql, params, author_id, author_label, note) values ($1,1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, body.name, body.description, body.sql, body.params, user.id, user.email, body.note],
      );
      return id;
    });
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'LIBRARY', target: body.name, status: 'ok', ip: req.ip, detail: { action: 'create', id: row, visibility: body.visibility } });
    return { ...summary((await one<LibRow>(SELECT + ' where l.id = $1', [row]))!, user), sql: body.sql };
  });

  // Every save is a new, immutable version.
  app.put('/library/:id', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(updateBody, req.body);
    const cur = await loadVisible(user, id);
    if (!canEdit(user, cur)) throw forbidden('The SQL is locked; only the owner can edit it. Fork it to make your own copy.');
    if (body.sql !== undefined) checkSql(body.sql);
    if (body.connectionId) await requireConn(req, body.connectionId, 'read');
    const next = {
      name: body.name ?? cur.name, description: body.description ?? cur.description, sql: body.sql ?? cur.sql,
      params: body.params ?? cur.params, tags: body.tags ?? cur.tags, connectionId: body.connectionId === undefined ? cur.connection_id : body.connectionId,
    };
    const changed = next.name !== cur.name || next.description !== cur.description || next.sql !== cur.sql || JSON.stringify(next.params) !== JSON.stringify(cur.params);
    const n = await tx(async (c) => {
      const locked = await c.query('select version from library_queries where id = $1 for update', [id]);
      let v = Number(locked.rows[0].version);
      if (changed) {
        v += 1;
        await c.query(
          `insert into library_versions (query_id, n, name, description, sql, params, author_id, author_label, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, v, next.name, next.description, next.sql, next.params, user.id, user.email, body.note || 'edited'],
        );
      }
      await c.query(
        `update library_queries set name=$2, description=$3, sql=$4, params=$5, tags=$6, connection_id=$7, version=$8, updated_at=now() where id = $1`,
        [id, next.name, next.description, next.sql, next.params, next.tags, next.connectionId, v],
      );
      return v;
    });
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'LIBRARY', target: next.name, status: 'ok', ip: req.ip, detail: { action: 'update', id, version: n } });
    return { ...summary((await one<LibRow>(SELECT + ' where l.id = $1', [id]))!, user), sql: next.sql };
  });

  // Sharing settings: owner only.
  app.patch('/library/:id/sharing', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ visibility: z.enum(['private', 'shared', 'readonly']).optional(), allowSchedule: z.boolean().optional() }), req.body);
    const cur = await loadVisible(user, id);
    if (cur.owner_id !== user.id) throw forbidden('Only the owner can change sharing');
    await q('update library_queries set visibility = coalesce($2, visibility), allow_schedule = coalesce($3, allow_schedule), updated_at = now() where id = $1',
      [id, body.visibility ?? null, body.allowSchedule ?? null]);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'LIBRARY', target: cur.name, status: 'ok', ip: req.ip, detail: { action: 'sharing', id, ...body } });
    return summary((await one<LibRow>(SELECT + ' where l.id = $1', [id]))!, user);
  });

  app.delete('/library/:id', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const cur = await loadVisible(user, id);
    if (cur.owner_id !== user.id && !hasRole(user, 'Admin')) throw forbidden('Only the owner or an Admin can delete a saved query');
    await q('delete from library_queries where id = $1', [id]);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'LIBRARY', target: cur.name, status: 'ok', ip: req.ip, detail: { action: 'delete', id } });
    return { ok: true };
  });

  app.post('/library/:id/fork', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const cur = await loadVisible(user, id);
    const name = (cur.name + ' (fork)').slice(0, 120);
    const newId = await tx(async (c) => {
      const r = await c.query(
        `insert into library_queries (name, description, sql, params, owner_id, visibility, allow_schedule, tags, connection_id)
         values ($1,$2,$3,$4,$5,'private',true,$6,$7) returning id`,
        [name, cur.description, cur.sql, cur.params, user.id, cur.tags, cur.connection_id],
      );
      await c.query(
        `insert into library_versions (query_id, n, name, description, sql, params, author_id, author_label, note) values ($1,1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.rows[0].id, name, cur.description, cur.sql, cur.params, user.id, user.email, `forked from ${cur.name} v${cur.version}`],
      );
      return r.rows[0].id as string;
    });
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'LIBRARY', target: name, status: 'ok', ip: req.ip, detail: { action: 'fork', id: newId, from: id } });
    return { id: newId };
  });

  app.get('/library/:id/versions/:n', async (req) => {
    const user = userOf(req);
    const p = parse(z.object({ id: z.string().uuid(), n: z.coerce.number().int().min(1) }), req.params);
    await loadVisible(user, p.id);
    const v = await one(`select n, name, description, sql, params, author_label, note, created_at from library_versions where query_id = $1 and n = $2`, [p.id, p.n]);
    if (!v) throw notFound('Version not found');
    return { n: v.n, name: v.name, description: v.description, sql: v.sql, params: v.params, author: v.author_label, note: v.note, at: v.created_at };
  });

  app.get('/library/:id/diff', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const qs = parse(z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1).optional() }), req.query);
    const cur = await loadVisible(user, id);
    const to = qs.to ?? cur.version;
    const rows = await q('select n, sql from library_versions where query_id = $1 and n = any($2::int[])', [id, [qs.from, to]]);
    const a = rows.find((r) => r.n === qs.from);
    const b = rows.find((r) => r.n === to);
    if (!a || !b) throw notFound('Version not found');
    const lines = lineDiff(a.sql, b.sql);
    return { from: qs.from, to, added: lines.filter((l) => l.op === '+').length, removed: lines.filter((l) => l.op === '-').length, lines };
  });

  // Binds parameters server-side (Open in a tab carries them over without running anything).
  app.post('/library/:id/bind', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ params: values }), req.body);
    const cur = await loadVisible(user, id);
    return { sql: bindParams(cur.sql, body.params, cur.params) };
  });

  app.post('/library/:id/run', async (req) => {
    const user = userOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      connId: z.string().uuid(), params: values, confirm: z.string().max(200).optional(), maxRows: z.number().int().min(1).max(100_000).optional(),
    }), req.body);
    const cur = await loadVisible(user, id);
    const { conn, level } = await requireConn(req, body.connId, 'read');
    const sql = bindParams(cur.sql, body.params, cur.params);
    const t0 = Date.now();
    const res = await runSql({ user, conn, level, sql, confirm: body.confirm, maxRows: body.maxRows, source: 'library', ip: req.ip });
    if (!res.approvalId) {
      await q(`update library_queries set runs = runs + 1, total_ms = total_ms + $2, last_run_at = now(), last_run_by = $3 where id = $1`,
        [id, Date.now() - t0, user.email]);
    }
    return res;
  });
}
