import pg from 'pg';
import { decryptSecret } from '../security/crypto.ts';
import { config } from '../config.ts';
import type { ConnRow } from '../security/authz.ts';
import { tunnelStream, openTunnel, closeTunnel } from './tunnel.ts';

/*
 * One small pool per stored connection. Passwords are decrypted only here, in memory,
 * and never leave the server. Every checkout runs inside a transaction that Comb opens,
 * and every release discards session state so nothing leaks between users.
 */

export const escapeIdent = (s: string) => pg.escapeIdentifier(s);
export const escapeLit = (s: string) => pg.escapeLiteral(s);

interface Entry {
  pool: pg.Pool;
  stamp: string;
}
const pools = new Map<string, Entry>();

/*
 * libpq semantics: 'require' and 'prefer' encrypt without verifying the server certificate
 * (they stop passive sniffing, not an active man-in-the-middle). Only verify-ca and
 * verify-full authenticate the server; the UI says so next to the selector.
 */
function sslFor(mode: string, ca?: string | null): pg.ClientConfig['ssl'] {
  const caOpt = ca ? { ca } : {};
  switch (mode) {
    case 'disable': return false;
    case 'verify-full': return { rejectUnauthorized: true, ...caOpt };
    case 'verify-ca': return { rejectUnauthorized: true, ...caOpt, checkServerIdentity: () => undefined };
    case 'require': return { rejectUnauthorized: false };
    default: return { rejectUnauthorized: false }; // prefer: try TLS, fall back below
  }
}

export function clientConfig(c: Pick<ConnRow, 'id' | 'host' | 'port' | 'dbname' | 'username' | 'secret_enc' | 'sslmode' | 'ssl_ca'>, password?: string | null, sslOverride?: pg.ClientConfig['ssl']): pg.ClientConfig {
  return {
    host: c.host,
    port: c.port,
    database: c.dbname,
    user: c.username,
    password: password ?? decryptSecret(c.secret_enc, `connection:${c.id}:password`) ?? undefined,
    ssl: sslOverride !== undefined ? sslOverride : sslFor(c.sslmode, c.ssl_ca),
    connectionTimeoutMillis: 8_000,
    application_name: 'comb',
    statement_timeout: config.COMB_STATEMENT_TIMEOUT_MS,
  };
}

const NO_SSL = /does not support SSL|SSL connection is required|server does not support ssl/i;

function stampOf(c: ConnRow): string {
  return [c.host, c.port, c.dbname, c.username, c.sslmode, c.ssl_ca ?? '', c.secret_enc?.toString('base64') ?? '',
    c.ssh_host ?? '', c.ssh_port, c.ssh_user ?? '', c.ssh_host_key ?? '', c.ssh_secret_enc?.toString('base64') ?? ''].join('|');
}

export function sshConfigOf(c: Pick<ConnRow, 'id' | 'host' | 'port' | 'ssh_host' | 'ssh_port' | 'ssh_user' | 'ssh_auth' | 'ssh_secret_enc' | 'ssh_host_key'>) {
  return { id: c.id, host: c.host, port: c.port, dbHost: c.host, dbPort: c.port, ssh_host: c.ssh_host, ssh_port: c.ssh_port, ssh_user: c.ssh_user,
    ssh_auth: c.ssh_auth, ssh_secret_enc: c.ssh_secret_enc, ssh_host_key: c.ssh_host_key };
}

/** Through an SSH tunnel each pg socket is an SSH channel; host stays the real one, so TLS verifies it. */
async function routed(c: ConnRow, base: pg.ClientConfig): Promise<pg.ClientConfig> {
  if (!c.ssh_host) return base;
  const ssh = sshConfigOf(c);
  await openTunnel(ssh);
  return { ...base, stream: tunnelStream(ssh) as any };
}

async function poolFor(c: ConnRow, sslOff = false): Promise<pg.Pool> {
  const stamp = stampOf(c) + (sslOff ? '|nossl' : '');
  const hit = pools.get(c.id);
  // sslmode=prefer that already fell back to plaintext keeps that pool instead of rebuilding it on every checkout.
  if (hit && (hit.stamp === stamp || (!sslOff && c.sslmode === 'prefer' && hit.stamp === stamp + '|nossl'))) return hit.pool;
  if (hit) hit.pool.end().catch(() => {});
  const cfg = await routed(c, clientConfig(c, undefined, sslOff ? false : undefined));
  const pool = new pg.Pool({ ...cfg, max: 5, idleTimeoutMillis: 60_000 });
  pool.on('error', (e) => console.error('target pool error', c.name, e.message));
  pools.set(c.id, { pool, stamp });
  return pool;
}

/** Live pool sizes for the Deployment screen. Connection ids only, no credentials. */
export function poolStats(): Array<{ id: string; total: number; idle: number; waiting: number; max: number }> {
  return [...pools.entries()].map(([id, e]) => ({ id, total: e.pool.totalCount, idle: e.pool.idleCount, waiting: e.pool.waitingCount, max: 5 }));
}

export function dropPool(connId: string): void {
  const hit = pools.get(connId);
  if (hit) {
    pools.delete(connId);
    hit.pool.end().catch(() => {});
  }
  closeTunnel(connId);
}

export async function checkout(c: ConnRow): Promise<pg.PoolClient> {
  try {
    return await (await poolFor(c)).connect();
  } catch (e) {
    if (c.sslmode === 'prefer' && NO_SSL.test((e as Error).message)) return (await poolFor(c, true)).connect();
    throw e;
  }
}

export interface TargetOptions {
  readOnly: boolean;
  /** Shown in pg_stat_activity so DBAs can see who ran what. */
  actor: string;
  timeoutMs?: number;
}

/**
 * Runs fn inside a Comb-controlled transaction on the target database.
 * READ ONLY is enforced by Postgres itself, not by Comb's parsing alone.
 */
export async function withTarget<T>(c: ConnRow, opts: TargetOptions, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await checkout(c);
  let broken: Error | undefined;
  try {
    await client.query(opts.readOnly ? 'begin transaction read only' : 'begin');
    await client.query(`select set_config('statement_timeout', $1, true), set_config('application_name', $2, true)`, [
      String(opts.timeoutMs ?? config.COMB_STATEMENT_TIMEOUT_MS),
      ('comb:' + opts.actor).slice(0, 63),
    ]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch((err) => { broken = err; });
    throw e;
  } finally {
    if (!broken) await client.query('discard all').catch((err) => { broken = err; });
    client.release(broken);
  }
}

/** For statements that cannot run in a transaction block (VACUUM, CREATE INDEX CONCURRENTLY). */
export async function withTargetNoTxn<T>(c: ConnRow, opts: TargetOptions, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await checkout(c);
  let broken: Error | undefined;
  try {
    await client.query(`select set_config('statement_timeout', $1, false), set_config('application_name', $2, false)`, [
      String(opts.timeoutMs ?? config.COMB_STATEMENT_TIMEOUT_MS),
      ('comb:' + opts.actor).slice(0, 63),
    ]);
    if (opts.readOnly) await client.query('set default_transaction_read_only = on');
    return await fn(client);
  } finally {
    await client.query('discard all').catch((err) => { broken = err; });
    client.release(broken);
  }
}

/** Opens a dedicated connection with explicit credentials, for "Test connection". */
export async function testConnection(cfg: pg.ClientConfig, sslmode: string, ca?: string | null): Promise<{ version: string; schemas: number; ms: number }> {
  const started = Date.now();
  const attempt = async (ssl: pg.ClientConfig['ssl']) => {
    const client = new pg.Client({ ...cfg, ssl });
    await client.connect();
    try {
      const r = await client.query(`select current_setting('server_version') as v, (select count(*)::int from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema') as n`);
      return { version: r.rows[0].v as string, schemas: r.rows[0].n as number, ms: Date.now() - started };
    } finally {
      await client.end().catch(() => {});
    }
  };
  try {
    return await attempt(sslFor(sslmode, ca));
  } catch (e) {
    if (sslmode === 'prefer' && NO_SSL.test((e as Error).message)) return attempt(false);
    throw e;
  }
}
