import { tx, q } from '../db/meta.ts';
import { sha256 } from './crypto.ts';

export interface AuditEntry {
  actorId?: string | null;
  actorLabel: string;
  connectionId?: string | null;
  connectionName?: string | null;
  /** SELECT, UPDATE, INSERT, DELETE, TRUNCATE, DROP, GRANT, MIGRATE, EXPORT, LOGIN, ... */
  kind: string;
  target?: string | null;
  sql?: string | null;
  rows?: number | null;
  ms?: number | null;
  /** ok | error | blocked | pending | denied */
  status: string;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

const GENESIS = Buffer.alloc(32, 0);

/** JSON with recursively sorted keys, so jsonb's key reordering cannot change the hash. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Canonical serialisation hashed into the chain. Field order is fixed. */
export function canonical(e: AuditEntry & { at: string }): string {
  return JSON.stringify([
    e.at,
    e.actorId ?? null,
    e.actorLabel,
    e.connectionId ?? null,
    e.connectionName ?? null,
    e.kind,
    e.target ?? null,
    e.sql ?? null,
    e.rows ?? null,
    e.ms ?? null,
    e.status,
    stable(e.detail ?? null),
    e.ip ?? null,
  ]);
}

/**
 * Appends one event. The advisory lock serialises writers so each row's prev_hash
 * is the previous row's hash; the table itself rejects UPDATE/DELETE/TRUNCATE.
 */
export async function audit(e: AuditEntry): Promise<number> {
  return tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(7240312)');
    const last = await c.query('select hash from audit_log order by id desc limit 1');
    const prev: Buffer = last.rows[0]?.hash ?? GENESIS;
    const at = new Date().toISOString();
    const hash = sha256(Buffer.concat([prev, Buffer.from(canonical({ ...e, at }), 'utf8')]));
    const r = await c.query(
      `insert into audit_log (at, actor_id, actor_label, connection_id, connection_name, kind, target, sql, rows, ms, status, detail, ip, prev_hash, hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [at, e.actorId ?? null, e.actorLabel, e.connectionId ?? null, e.connectionName ?? null, e.kind, e.target ?? null, e.sql ?? null,
        e.rows ?? null, e.ms ?? null, e.status, e.detail ?? null, e.ip ?? null, prev, hash],
    );
    return Number(r.rows[0].id);
  });
}

/** Recomputes the chain. Returns the first broken id, or null when intact. */
export async function verifyChain(): Promise<{ ok: boolean; checked: number; brokenAt: number | null; head: string | null }> {
  const rows = await q(
    `select id, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, actor_id, actor_label, connection_id, connection_name, kind, target, sql, rows, ms, status, detail, host(ip) as ip, prev_hash, hash
     from audit_log order by id`,
  );
  let prev = GENESIS;
  for (const r of rows) {
    const expect = sha256(Buffer.concat([prev, Buffer.from(canonical({
      at: r.at, actorId: r.actor_id, actorLabel: r.actor_label, connectionId: r.connection_id, connectionName: r.connection_name,
      kind: r.kind, target: r.target, sql: r.sql, rows: r.rows === null ? null : Number(r.rows), ms: r.ms, status: r.status, detail: r.detail, ip: r.ip,
    }), 'utf8')]));
    if (!prev.equals(r.prev_hash) || !expect.equals(r.hash)) {
      return { ok: false, checked: rows.length, brokenAt: Number(r.id), head: null };
    }
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null, head: rows.length ? prev.toString('hex') : null };
}
