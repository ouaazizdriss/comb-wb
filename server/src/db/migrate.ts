import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Applies every migrations/*.sql file once, in name order, as the owner role.
 * Each file runs in its own transaction under an advisory lock, so two servers
 * starting together cannot apply the same migration twice.
 */
export async function migrate(log: (m: string) => void = console.log): Promise<void> {
  const url = config.COMB_MIGRATION_DATABASE_URL ?? config.COMB_DATABASE_URL;
  const client = new pg.Client({ connectionString: url, application_name: 'comb-migrate' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(7240311)');
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    // Dev-only: COMB_MIGRATION_FILTER (a regex) limits which files run, so parallel module work
    // with a half-written migration does not block everyone else's server.
    const filter = process.env.COMB_MIGRATION_FILTER ? new RegExp(process.env.COMB_MIGRATION_FILTER) : null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && (!filter || filter.test(f))).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [f]);
        await client.query('commit');
        log('migrated ' + f);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(7240311)').catch(() => {});
    await client.end();
  }
}
