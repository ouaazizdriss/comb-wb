import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, HttpError } from '../core/http.ts';
import { requireConn } from '../security/authz.ts';
import { audit } from '../security/audit.ts';
import { getPolicy } from '../core/settings.ts';
import { withTarget } from '../targets/pool.ts';
import { runSql } from '../targets/exec.ts';
import { classify, SqlSyntaxError } from '../targets/classify.ts';

/*
 * Query tab support:
 *   GET  /query/:connId/completions  schema/table/column names for editor autocomplete (catalog read)
 *   POST /query/:connId/classify     statement kinds from the real parser (gates EXPLAIN ANALYZE in the UI)
 *   POST /query/:connId/export       runs a read-only query through runSql and streams CSV (EXPORT audited)
 * Running and cancelling use the core routes /connections/:id/query and /connections/:id/cancel.
 */

const connParam = z.object({ connId: z.string().uuid() });
const EXPORT_MAX_ROWS = 100_000;

/** CSV with formula-injection guard, mirroring toCsv in web/src/lib/format.ts. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? (v instanceof Date ? v.toISOString() : JSON.stringify(v)) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export default async function queryModule(app: FastifyInstance): Promise<void> {
  app.get('/query/:connId/completions', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const r = await c.query(`
        select n.nspname as schema, cl.relname as rel, cl.relkind as kind, a.attname as col, format_type(a.atttypid, a.atttypmod) as type
        from pg_class cl
        join pg_namespace n on n.oid = cl.relnamespace
        join pg_attribute a on a.attrelid = cl.oid and a.attnum > 0 and not a.attisdropped
        where cl.relkind in ('r','p','v','m','f') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
          and has_schema_privilege(n.oid, 'USAGE')
        order by 1, 2, a.attnum
        limit 20000`);
      const schemas = new Map<string, Map<string, { kind: string; columns: Array<[string, string]> }>>();
      for (const row of r.rows) {
        let s = schemas.get(row.schema);
        if (!s) schemas.set(row.schema, (s = new Map()));
        let t = s.get(row.rel);
        if (!t) s.set(row.rel, (t = { kind: row.kind === 'v' || row.kind === 'm' ? 'view' : 'table', columns: [] }));
        t.columns.push([row.col, row.type]);
      }
      return {
        schemas: [...schemas.entries()].map(([name, rels]) => ({
          name,
          relations: [...rels.entries()].map(([rel, v]) => ({ name: rel, kind: v.kind, columns: v.columns })),
        })),
      };
    });
  });

  app.post('/query/:connId/classify', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { sql } = parse(z.object({ sql: z.string().min(1).max(1_000_000) }), req.body);
    await requireConn(req, connId, 'read');
    try {
      return { statements: classify(sql).map((s) => ({ command: s.command, kind: s.kind, start: s.start, length: s.sql.length, blocked: s.blocked })) };
    } catch (e) {
      if (e instanceof SqlSyntaxError) return { statements: [], error: e.message, position: e.position };
      throw e;
    }
  });

  app.post('/query/:connId/export', async (req, reply) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ sql: z.string().min(1).max(1_000_000), format: z.literal('csv').default('csv') }), req.body);
    const { conn, level, user } = await requireConn(req, connId, 'read');
    const policy = await getPolicy();
    if (policy.blockExportOnProd && conn.env === 'prod') {
      await audit({
        actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'EXPORT',
        status: 'blocked', ip: req.ip, detail: { reason: 'blockExportOnProd', format: body.format },
      });
      throw new HttpError(403, `Exports from production connections are blocked by workspace policy (${conn.name}). An Admin can change this in Settings → Safety.`, { code: 'COMB_EXPORT_BLOCKED' });
    }
    const started = Date.now();
    const res = await runSql({ user, conn, level, sql: body.sql, source: 'query', maxRows: EXPORT_MAX_ROWS, forceReadOnly: true, allowLargeResult: true, ip: req.ip });
    if (!res.columns.length) throw new HttpError(400, 'The query returned no columns, so there is nothing to export.');
    const csv = toCsv(res.columns.map((c) => c.name), res.rows);
    await audit({
      actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'EXPORT',
      target: null, rows: res.rows.length, ms: Date.now() - started, status: 'ok', ip: req.ip,
      detail: { format: body.format, truncated: res.truncated, bytes: Buffer.byteLength(csv) },
    });
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${conn.name.replace(/[^A-Za-z0-9_.-]/g, '_')}-export.csv"`)
      .header('x-comb-rows', String(res.rows.length))
      .header('x-comb-truncated', res.truncated ? '1' : '0')
      .header('cache-control', 'no-store');
    return reply.send(csv);
  });
}
