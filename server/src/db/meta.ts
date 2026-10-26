import pg from 'pg';
import { config } from '../config.ts';

// Return int8/numeric as strings would be annoying for counts; keep bigint ids as strings but
// parse int8 counts explicitly where needed.
export const meta = new pg.Pool({
  connectionString: config.COMB_DATABASE_URL,
  max: 10,
  application_name: 'comb-server',
});

meta.on('error', (err) => console.error('meta pool error', err.message));

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await meta.query<T>(sql, params as any[]);
  return r.rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await meta.query<T>(sql, params as any[]);
  return r.rows[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await meta.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
