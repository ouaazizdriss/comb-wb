import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../core/http.ts';
import { requireConn } from '../security/authz.ts';
import { withTarget } from '../targets/pool.ts';

/*
 * ERD data for one schema, from the catalog only (parameterised, read-only):
 *   tables with estimated rows and columns (pk / fk marks, types),
 *   real foreign keys (pg_constraint contype 'f') with cardinality,
 *   inferred edges: a column named <table>_id or <singular>_id whose type matches the
 *   target's single-column primary key, where no foreign key covers that column.
 */

const params = z.object({ connId: z.string().uuid() });
const query = z.object({ schema: z.string().min(1).max(63).default('public') });

export interface ErdColumn { name: string; type: string; pk: boolean; fk: boolean; nullable: boolean }
export interface ErdTable { name: string; kind: string; est: number | null; columns: ErdColumn[] }
export interface ErdEdge {
  id: string;
  from: string; // referenced (parent) table: the "1" side
  to: string; // referencing (child) table: the "many" side
  fromColumns: string[];
  toColumns: string[];
  cardinality: '1:1' | '1:n';
  inferred: boolean;
  name: string | null;
}

/** Candidate table names a "<x>_id" column may point to. */
export function targetsFor(col: string): string[] {
  const m = /^(.+)_id$/i.exec(col);
  if (!m) return [];
  const x = m[1].toLowerCase();
  const out = new Set([x, x + 's', x + 'es']);
  if (/[^aeiou]y$/.test(x)) out.add(x.slice(0, -1) + 'ies');
  return [...out];
}

export default async function erdModule(app: FastifyInstance): Promise<void> {
  app.get('/erd/:connId', async (req) => {
    const { connId } = parse(params, req.params);
    const { schema } = parse(query, req.query);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const ns = await c.query(`select oid from pg_namespace where nspname = $1 and has_schema_privilege(oid, 'USAGE')`, [schema]);
      if (!ns.rows.length) throw notFound(`Schema ${schema} not found`);
      const nsOid = ns.rows[0].oid;

      const rels = await c.query(
        `select c.oid::int as oid, c.relname as name, c.relkind as kind, c.reltuples::float8 as est
         from pg_class c
         where c.relnamespace = $1 and c.relkind in ('r','p','f') and not c.relispartition
           and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
         order by c.relname limit 500`, [nsOid]);
      const oids = rels.rows.map((r) => r.oid);
      const cols = await c.query(
        `select a.attrelid::int as rel, a.attnum::int as num, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
                a.atttypid::int as typid, not a.attnotnull as nullable
         from pg_attribute a where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
         order by a.attrelid, a.attnum`, [oids]);
      const cons = await c.query(
        `select con.conname as name, con.contype as type, con.conrelid::int as rel, con.confrelid::int as frel,
                con.conkey::int[] as keys, con.confkey::int[] as fkeys, fn.nspname as fschema, fc.relname as ftable
         from pg_constraint con
         left join pg_class fc on fc.oid = con.confrelid
         left join pg_namespace fn on fn.oid = fc.relnamespace
         where con.conrelid = any($1::oid[]) and con.contype in ('p','u','f')`, [oids]);
      const uniqIdx = await c.query(
        `select i.indrelid::int as rel, i.indkey::int2[]::int[] as keys
         from pg_index i where i.indrelid = any($1::oid[]) and i.indisunique and i.indpred is null`, [oids]);

      const relName = new Map<number, string>(rels.rows.map((r) => [r.oid, r.name]));
      const colsBy = new Map<number, Array<{ num: number; name: string; type: string; typid: number; nullable: boolean }>>();
      for (const r of cols.rows) {
        if (!colsBy.has(r.rel)) colsBy.set(r.rel, []);
        colsBy.get(r.rel)!.push(r);
      }
      const colName = (rel: number, num: number) => colsBy.get(rel)?.find((x) => x.num === num)?.name ?? String(num);
      const pkBy = new Map<number, number[]>();
      const fkCols = new Map<number, Set<number>>();
      const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
      for (const k of cons.rows) {
        if (k.type === 'p') pkBy.set(k.rel, k.keys);
        if (k.type === 'f') {
          if (!fkCols.has(k.rel)) fkCols.set(k.rel, new Set());
          for (const n of k.keys) fkCols.get(k.rel)!.add(n);
        }
      }
      const isUnique = (rel: number, keys: number[]) =>
        sameSet(pkBy.get(rel) ?? [], keys) || uniqIdx.rows.some((u) => u.rel === rel && sameSet(u.keys, keys));

      const tables: ErdTable[] = rels.rows.map((r) => ({
        name: r.name,
        kind: r.kind === 'p' ? 'partitioned' : r.kind === 'f' ? 'foreign' : 'table',
        est: r.est >= 0 ? Math.round(r.est) : null,
        columns: (colsBy.get(r.oid) ?? []).map((col) => ({
          name: col.name, type: col.type, nullable: col.nullable,
          pk: (pkBy.get(r.oid) ?? []).includes(col.num),
          fk: fkCols.get(r.oid)?.has(col.num) ?? false,
        })),
      }));

      const edges: ErdEdge[] = [];
      let external = 0;
      for (const k of cons.rows) {
        if (k.type !== 'f') continue;
        if (!relName.has(k.frel)) { external++; continue; }
        edges.push({
          id: 'fk:' + k.name + ':' + k.rel,
          from: relName.get(k.frel)!, to: relName.get(k.rel)!,
          fromColumns: k.fkeys.map((n: number) => colName(k.frel, n)),
          toColumns: k.keys.map((n: number) => colName(k.rel, n)),
          cardinality: isUnique(k.rel, k.keys) ? '1:1' : '1:n',
          inferred: false, name: k.name,
        });
      }

      // Inferred edges: <x>_id columns that match a same-schema table's single-column PK type.
      const byName = new Map<string, number>(rels.rows.map((r) => [r.name.toLowerCase(), r.oid]));
      for (const r of rels.rows) {
        for (const col of colsBy.get(r.oid) ?? []) {
          if (fkCols.get(r.oid)?.has(col.num)) continue;
          for (const cand of targetsFor(col.name)) {
            const target = byName.get(cand);
            if (target === undefined) continue;
            const pk = pkBy.get(target);
            if (!pk || pk.length !== 1) continue;
            if (target === r.oid && pk[0] === col.num) continue;
            const pkCol = colsBy.get(target)?.find((x) => x.num === pk[0]);
            if (!pkCol || pkCol.typid !== col.typid) continue;
            edges.push({
              id: 'inf:' + r.name + '.' + col.name,
              from: relName.get(target)!, to: r.name,
              fromColumns: [pkCol.name], toColumns: [col.name],
              cardinality: isUnique(r.oid, [col.num]) ? '1:1' : '1:n',
              inferred: true, name: null,
            });
            break;
          }
        }
      }

      return { schema, tables, edges, externalEdges: external, truncated: rels.rows.length >= 500 };
    });
  });
}
