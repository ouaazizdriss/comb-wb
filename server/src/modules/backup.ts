import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import pg from 'pg';
import { z } from 'zod';
import type { BackupOverview, BackupRow, OpsTask } from '@comb/shared/src/ops.ts';
import { config } from '../config.ts';
import { q, one, tx } from '../db/meta.ts';
import { parse, HttpError, badRequest, notFound } from '../core/http.ts';
import { requireConn, requireRole, type AuthUser, type ConnRow } from '../security/authz.ts';
import { clientConfig, escapeIdent, withTarget, withTargetNoTxn } from '../targets/pool.ts';
import { audit } from '../security/audit.ts';
import { encryptSecret, decryptSecret } from '../security/crypto.ts';
import { registerWorker, enqueue } from '../core/jobs.ts';
import { emit, notify } from '../core/events.ts';
import { getSetting } from '../core/settings.ts';

/*
 * Backups & recovery, two backends behind one interface:
 *   pgbackrest  when COMB_PGBACKREST_STANZA is set and the binary is on PATH: info/backup through
 *               the real tool. Restores need the database server stopped, so Comb shows the exact
 *               command instead of pretending to run it.
 *   logical     built in: pg_dump --format=custom into COMB_BACKUP_DIR (0700), sha256 + size +
 *               duration recorded; restore to scratch, in-place restore, nightly verification.
 * Every external program runs through execFile with an argument array (never a shell), with a
 * minimal environment; the password travels in PGPASSWORD, never on the command line.
 */

const ACTOR = 'comb-backup';
const MARK = '/* comb-backup */ ';
const connParam = z.object({ connId: z.string().uuid() });
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

// ── Environment and binaries ────────────────────────────────────

export function findBin(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

const stanza = (): string | null => {
  const s = process.env.COMB_PGBACKREST_STANZA?.trim();
  return s && /^[A-Za-z0-9_.-]{1,64}$/.test(s) ? s : null;
};

function backupRoot(): string {
  return path.resolve(config.COMB_BACKUP_DIR ?? './.comb-data/backups');
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
}

interface RunResult { code: number; stdout: string; stderr: string }

function run(bin: string, args: string[], env: Record<string, string>, timeoutMs = 6 * 3600_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code !== 0 ? err.message : '') });
    });
  });
}

/** libpq environment for one connection. Only what pg_dump/pg_restore need; no Comb secrets leak to children. */
async function pgEnv(conn: ConnRow): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PGAPPNAME: ACTOR, PGCONNECT_TIMEOUT: '10', PGSSLMODE: conn.sslmode,
  };
  const pw = decryptSecret(conn.secret_enc, `connection:${conn.id}:password`);
  if (pw) env.PGPASSWORD = pw;
  let tmp: string | null = null;
  if (conn.ssl_ca) {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'comb-ca-'));
    await fsp.chmod(tmp, 0o700);
    const f = path.join(tmp, 'ca.pem');
    await fsp.writeFile(f, conn.ssl_ca, { mode: 0o600 });
    env.PGSSLROOTCERT = f;
  }
  return { env, cleanup: async () => { if (tmp) await fsp.rm(tmp, { recursive: true, force: true }); } };
}

const connArgs = (conn: ConnRow, db: string) => [`--host=${conn.host}`, `--port=${conn.port}`, `--username=${conn.username}`, `--dbname=${db}`, '--no-password'];

async function sha256File(f: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(f)) h.update(chunk as Buffer);
  return h.digest('hex');
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 40) || 'db';

async function countTables(conn: ConnRow, db: string): Promise<number> {
  let client = new pg.Client({ ...clientConfig({ ...conn, dbname: db }), application_name: ACTOR });
  try {
    await client.connect();
  } catch (e) {
    // sslmode=prefer: fall back to plaintext like libpq does when the server has no TLS.
    if (conn.sslmode !== 'prefer' || !/does not support SSL/i.test((e as Error).message)) throw e;
    client = new pg.Client({ ...clientConfig({ ...conn, dbname: db }, undefined, false), application_name: ACTOR });
    await client.connect();
  }
  try {
    const r = await client.query(`${MARK}select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast'`);
    return r.rows[0].n;
  } finally {
    await client.end().catch(() => {});
  }
}

async function canCreateDb(conn: ConnRow): Promise<boolean> {
  return withTarget(conn, { readOnly: true, actor: ACTOR, timeoutMs: 5_000 }, async (c) =>
    !!(await c.query(MARK + 'select rolcreatedb or rolsuper as ok from pg_roles where rolname = current_user')).rows[0]?.ok);
}

async function dbExists(conn: ConnRow, db: string): Promise<boolean> {
  return withTarget(conn, { readOnly: true, actor: ACTOR, timeoutMs: 5_000 }, async (c) => (await c.query(MARK + 'select 1 from pg_database where datname = $1', [db])).rows.length > 0);
}

async function createDb(conn: ConnRow, db: string): Promise<void> {
  await withTargetNoTxn(conn, { readOnly: false, actor: ACTOR, timeoutMs: 60_000 }, (c) => c.query(`create database ${escapeIdent(db)}`));
}

async function dropDb(conn: ConnRow, db: string): Promise<void> {
  await withTargetNoTxn(conn, { readOnly: false, actor: ACTOR, timeoutMs: 60_000 }, (c) => c.query(`drop database if exists ${escapeIdent(db)} with (force)`));
}

// ── Rows ────────────────────────────────────────────────────────

function backupOut(r: any): BackupRow {
  return {
    id: Number(r.id), backend: r.backend, kind: r.kind, status: r.status, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at),
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), durationMs: r.duration_ms, sha256: r.sha256, destination: r.destination,
    tableCount: r.table_count, verified: r.verified, verifiedAt: iso(r.verified_at), verifyNote: r.verify_note, error: r.error, createdBy: r.created_label,
  };
}

function taskOut(r: any): OpsTask {
  return {
    id: Number(r.id), kind: r.kind, status: r.status, backupId: r.backup_id === null ? null : Number(r.backup_id), createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), error: r.error, result: r.result, createdBy: r.created_label,
  };
}

async function newTask(conn: ConnRow, kind: OpsTask['kind'], user: AuthUser | null, backupId: number | null, detail: Record<string, unknown> = {}): Promise<OpsTask> {
  const row = await one(
    `insert into ops_tasks (connection_id, kind, backup_id, detail, created_by, created_label) values ($1,$2,$3,$4,$5,$6) returning *`,
    [conn.id, kind, backupId, JSON.stringify(detail), user?.id ?? null, user?.email ?? 'system (nightly)'],
  );
  await enqueue('ops.task', { taskId: Number(row.id) });
  return taskOut(row);
}

// ── pgBackRest ──────────────────────────────────────────────────

async function pgbackrestInfo(): Promise<any | null> {
  const bin = findBin('pgbackrest');
  const st = stanza();
  if (!bin || !st) return null;
  const r = await run(bin, [`--stanza=${st}`, '--output=json', 'info'], { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, 60_000);
  if (r.code !== 0) throw new Error('pgbackrest info failed: ' + r.stderr.slice(0, 400));
  const j = JSON.parse(r.stdout);
  return Array.isArray(j) ? j.find((s: any) => s.name === st) ?? j[0] : j;
}

// ── Task execution ──────────────────────────────────────────────

async function finish(taskId: number, status: 'ok' | 'error', result: Record<string, unknown> | null, error: string | null): Promise<void> {
  await q('update ops_tasks set status = $2, result = $3, error = $4, finished_at = now() where id = $1', [taskId, status, result ? JSON.stringify(result) : null, error ? error.slice(0, 2000) : null]);
}

async function runBackup(task: any, conn: ConnRow): Promise<Record<string, unknown>> {
  const st = stanza();
  const brBin = findBin('pgbackrest');
  if (st && brBin) {
    const kind = task.detail?.kind === 'incr' ? 'incr' : task.detail?.kind === 'diff' ? 'diff' : 'full';
    const b = await one(`insert into backups (connection_id, backend, kind, destination, created_by, created_label) values ($1,'pgbackrest',$2,$3,$4,$5) returning id`,
      [conn.id, kind, `pgbackrest stanza ${st}`, task.created_by, task.created_label]);
    await q('update ops_tasks set backup_id = $2 where id = $1', [task.id, b.id]);
    const t0 = Date.now();
    const r = await run(brBin, [`--stanza=${st}`, `--type=${kind}`, 'backup'], { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' });
    if (r.code !== 0) {
      await q(`update backups set status = 'error', error = $2, finished_at = now(), duration_ms = $3 where id = $1`, [b.id, r.stderr.slice(0, 2000), Date.now() - t0]);
      throw new Error('pgbackrest backup failed: ' + r.stderr.slice(0, 600));
    }
    await q(`update backups set status = 'ok', finished_at = now(), duration_ms = $2 where id = $1`, [b.id, Date.now() - t0]);
    emit('backup.completed', { connectionId: conn.id, connection: conn.name, backupId: Number(b.id), backend: 'pgbackrest', kind });
    return { backupId: Number(b.id), backend: 'pgbackrest', kind };
  }

  const pgDump = findBin('pg_dump');
  const pgRestore = findBin('pg_restore');
  if (!pgDump) throw new Error('pg_dump not found on the Comb server. Install the PostgreSQL client tools (same or newer major version as the server).');
  const dir = path.join(backupRoot(), conn.id);
  await ensureDir(backupRoot());
  await ensureDir(dir);
  const started = new Date();
  const file = path.join(dir, `${safeName(conn.dbname)}_${stamp(started)}_${crypto.randomBytes(3).toString('hex')}.dump`);
  const ver = await withTarget(conn, { readOnly: true, actor: ACTOR, timeoutMs: 5_000 }, async (c) => (await c.query(`${MARK}select current_setting('server_version') as v`)).rows[0].v as string);
  const b = await one(
    `insert into backups (connection_id, backend, kind, path, destination, server_version, created_by, created_label) values ($1,'logical','logical',$2,$3,$4,$5,$6) returning id`,
    [conn.id, file, 'local · ' + path.relative(process.cwd(), file), String(ver).split(' ')[0], task.created_by, task.created_label],
  );
  await q('update ops_tasks set backup_id = $2 where id = $1', [task.id, b.id]);
  const { env, cleanup } = await pgEnv(conn);
  try {
    const r = await run(pgDump, ['--format=custom', `--file=${file}`, ...connArgs(conn, conn.dbname)], env);
    if (r.code !== 0) {
      await fsp.rm(file, { force: true });
      throw new Error(r.stderr.trim().slice(0, 1500) || 'pg_dump failed');
    }
    await fsp.chmod(file, 0o600);
    const size = (await fsp.stat(file)).size;
    const sum = await sha256File(file);
    let tables: number | null = null;
    if (pgRestore) {
      const l = await run(pgRestore, ['--list', file], env, 120_000);
      if (l.code === 0) tables = l.stdout.split('\n').filter((x) => /^\d+; 1259 \d+ TABLE /.test(x)).length;
    }
    const ms = Date.now() - started.getTime();
    await q(`update backups set status = 'ok', finished_at = now(), size_bytes = $2, duration_ms = $3, sha256 = $4, table_count = $5 where id = $1`, [b.id, size, ms, sum, tables]);
    emit('backup.completed', { connectionId: conn.id, connection: conn.name, backupId: Number(b.id), backend: 'logical', bytes: size });
    await applyRetention(conn);
    return { backupId: Number(b.id), sizeBytes: size, durationMs: ms, sha256: sum, tables };
  } catch (e) {
    await q(`update backups set status = 'error', error = $2, finished_at = now(), duration_ms = $3 where id = $1`, [b.id, String((e as Error).message).slice(0, 2000), Date.now() - started.getTime()]);
    throw e;
  } finally {
    await cleanup();
  }
}

async function applyRetention(conn: ConnRow): Promise<void> {
  const { keepLast } = await getSetting('backup.retention', { keepLast: 14 });
  const old = await q(
    `select id, path from backups where connection_id = $1 and backend = 'logical' and status = 'ok' order by started_at desc offset $2`,
    [conn.id, Math.max(1, keepLast)],
  );
  const root = backupRoot();
  for (const b of old) {
    if (b.path && path.resolve(b.path).startsWith(root + path.sep)) await fsp.rm(b.path, { force: true });
    await q(`update backups set status = 'expired' where id = $1`, [b.id]);
  }
}

async function backupFile(conn: ConnRow, backupId: number): Promise<any> {
  const b = await one(`select * from backups where id = $1 and connection_id = $2`, [backupId, conn.id]);
  if (!b) throw new Error('Backup not found');
  if (b.backend !== 'logical') throw new Error('Only logical backups can be restored by Comb; pgBackRest restores run on the database host.');
  if (b.status !== 'ok' || !b.path) throw new Error('That backup is not available (status ' + b.status + ')');
  const resolved = path.resolve(b.path);
  if (!resolved.startsWith(backupRoot() + path.sep)) throw new Error('Backup file is outside the backup directory');
  await fsp.access(resolved, fs.constants.R_OK).catch(() => { throw new Error('Backup file is missing on the Comb server'); });
  if (b.sha256 && (await sha256File(resolved)) !== b.sha256) throw new Error('Checksum mismatch: the backup file changed since it was taken');
  return { ...b, path: resolved };
}

/** pg_restore exits 1 when it ignored errors; keep the count so the result says so. */
function restoreWarnings(r: RunResult): number | null {
  const m = /errors ignored on restore: (\d+)/.exec(r.stderr);
  return m ? Number(m[1]) : null;
}

async function runVerify(task: any, conn: ConnRow): Promise<Record<string, unknown>> {
  const b = await backupFile(conn, Number(task.backup_id));
  const note = async (verified: boolean | null, text: string) => {
    await q('update backups set verified = $2, verified_at = now(), verify_note = $3 where id = $1', [b.id, verified, text]);
  };
  if (!(await canCreateDb(conn))) {
    await note(null, 'cannot verify: needs CREATEDB');
    throw new Error(`cannot verify: ${conn.username} needs CREATEDB to restore into a scratch database`);
  }
  const pgRestore = findBin('pg_restore');
  if (!pgRestore) {
    await note(null, 'cannot verify: pg_restore not found on the Comb server');
    throw new Error('pg_restore not found on the Comb server');
  }
  const scratch = `comb_verify_${crypto.randomBytes(5).toString('hex')}`;
  const t0 = Date.now();
  const { env, cleanup } = await pgEnv(conn);
  await createDb(conn, scratch);
  try {
    const r = await run(pgRestore, ['--no-owner', '--no-acl', ...connArgs(conn, scratch), b.path], env);
    const warn = restoreWarnings(r);
    if (r.code !== 0 && warn === null) throw new Error(r.stderr.trim().slice(0, 1500) || 'pg_restore failed');
    const n = await countTables(conn, scratch);
    const expected = b.table_count ?? null;
    const ok = expected === null ? n > 0 : n === expected;
    const text = `${ok ? 'restored' : 'MISMATCH:'} ${n}${expected !== null ? ' of ' + expected : ''} tables in ${((Date.now() - t0) / 1000).toFixed(1)} s${warn ? ` · ${warn} warnings` : ''}`;
    await note(ok, text);
    if (!ok) throw new Error('Verification failed: ' + text);
    return { backupId: Number(b.id), tables: n, expected, ms: Date.now() - t0, warnings: warn };
  } catch (e) {
    const cur = await one('select verified from backups where id = $1', [b.id]);
    if (cur?.verified === null) await note(false, 'restore failed: ' + String((e as Error).message).slice(0, 300));
    throw e;
  } finally {
    await dropDb(conn, scratch).catch((e) => console.error('backup: could not drop', scratch, (e as Error).message));
    await cleanup();
  }
}

async function runRestoreScratch(task: any, conn: ConnRow): Promise<Record<string, unknown>> {
  const b = await backupFile(conn, Number(task.backup_id));
  if (!(await canCreateDb(conn))) throw new Error(`${conn.username} needs CREATEDB to create the scratch database`);
  const pgRestore = findBin('pg_restore');
  if (!pgRestore) throw new Error('pg_restore not found on the Comb server');
  let db = `${safeName(conn.dbname)}_restore_${stamp()}`.slice(0, 60);
  for (let i = 2; await dbExists(conn, db); i++) db = `${safeName(conn.dbname)}_restore_${stamp()}_${i}`.slice(0, 63);
  const { env, cleanup } = await pgEnv(conn);
  const t0 = Date.now();
  await createDb(conn, db);
  try {
    const r = await run(pgRestore, ['--no-owner', '--no-acl', ...connArgs(conn, db), b.path], env);
    const warn = restoreWarnings(r);
    if (r.code !== 0 && warn === null) throw new Error(r.stderr.trim().slice(0, 1500) || 'pg_restore failed');
    const tables = await countTables(conn, db);
    // Register a read-only connection pointing at the restored copy. It holds the source's data, so it keeps
    // the source's environment, per-user access and catalog (classification and masking): a copy of prod must
    // not be more open than prod.
    let name = `${conn.name}_restore_${stamp()}`.slice(0, 63);
    for (let i = 2; await one('select 1 from connections where name = $1', [name]); i++) name = `${conn.name.slice(0, 50)}_restore_${i}`;
    const row = await tx(async (c) => {
      const ins = await c.query(
        `insert into connections (name, color, env, host, port, dbname, username, sslmode, ssl_ca, read_only, require_approval, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,false,$10) returning id`,
        [name, conn.color, conn.env, conn.host, conn.port, db, conn.username, conn.sslmode, conn.ssl_ca, task.created_by],
      );
      const id = ins.rows[0].id as string;
      await c.query(`insert into connection_access (user_id, connection_id, level)
        select user_id, $2, level from connection_access where connection_id = $1
        on conflict (user_id, connection_id) do update set level = excluded.level`, [conn.id, id]);
      await c.query(`insert into catalog_columns (connection_id, schema_name, table_name, column_name, classification, masking, owner_id, description, tags, updated_by)
        select $2, schema_name, table_name, column_name, classification, masking, owner_id, description, tags, updated_by
          from catalog_columns where connection_id = $1`, [conn.id, id]);
      return { id };
    });
    const pw = decryptSecret(conn.secret_enc, `connection:${conn.id}:password`);
    if (pw) await q('update connections set secret_enc = $2 where id = $1', [row.id, encryptSecret(pw, `connection:${row.id}:password`)]);
    await audit({ actorId: task.created_by, actorLabel: task.created_label, connectionId: row.id, connectionName: name, kind: 'CONNECTION', target: name, status: 'ok',
      detail: { action: 'restore-scratch', from: conn.name, backupId: Number(b.id), database: db } });
    return { database: db, connectionId: row.id, connectionName: name, tables, warnings: warn, ms: Date.now() - t0 };
  } catch (e) {
    await dropDb(conn, db).catch(() => {});
    throw e;
  } finally {
    await cleanup();
  }
}

function inplaceArgs(conn: ConnRow, file: string): string[] {
  return ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', ...connArgs(conn, conn.dbname), file];
}

async function runRestoreInPlace(task: any, conn: ConnRow): Promise<Record<string, unknown>> {
  if (conn.read_only) throw new Error(`${conn.name} is read-only; Comb will not restore over it`);
  const b = await backupFile(conn, Number(task.backup_id));
  const pgRestore = findBin('pg_restore');
  if (!pgRestore) throw new Error('pg_restore not found on the Comb server');
  const { env, cleanup } = await pgEnv(conn);
  const t0 = Date.now();
  try {
    const r = await run(pgRestore, inplaceArgs(conn, b.path), env);
    if (r.code !== 0) throw new Error((r.stderr.trim() || 'pg_restore failed').slice(0, 1500) + ' — the restore ran in one transaction, so nothing was changed.');
    const tables = await countTables(conn, conn.dbname);
    return { backupId: Number(b.id), tables, ms: Date.now() - t0 };
  } finally {
    await cleanup();
  }
}

async function runTask(taskId: number): Promise<void> {
  const task = await one(`update ops_tasks set status = 'running', started_at = now() where id = $1 and status = 'queued' returning *`, [taskId]);
  if (!task) return;
  const conn = await one<ConnRow>('select * from connections where id = $1', [task.connection_id]);
  if (!conn) return finish(taskId, 'error', null, 'Connection was removed');
  try {
    const result = task.kind === 'backup' ? await runBackup(task, conn)
      : task.kind === 'verify' ? await runVerify(task, conn)
        : task.kind === 'restore_scratch' ? await runRestoreScratch(task, conn)
          : await runRestoreInPlace(task, conn);
    await finish(taskId, 'ok', result, null);
    await audit({ actorId: task.created_by, actorLabel: task.created_label, connectionId: conn.id, connectionName: conn.name, kind: task.kind.toUpperCase(),
      target: conn.name, status: 'ok', detail: { taskId, ...result } });
    if (task.created_by && task.kind !== 'verify') {
      await notify({ userId: task.created_by, kind: 'job', title: `${label(task.kind)} finished on ${conn.name}`, body: summary(task.kind, result), target: 'backup' });
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    await finish(taskId, 'error', null, msg);
    await audit({ actorId: task.created_by, actorLabel: task.created_label, connectionId: conn.id, connectionName: conn.name, kind: task.kind.toUpperCase(),
      target: conn.name, status: 'error', detail: { taskId, error: msg.slice(0, 500) } });
    emit('job.failed', { kind: 'ops.' + task.kind, taskId, connectionId: conn.id });
    if (task.created_by) await notify({ userId: task.created_by, kind: 'err', title: `${label(task.kind)} failed on ${conn.name}`, body: msg.slice(0, 300), target: 'backup' });
  }
}

const label = (k: string) => ({ backup: 'Backup', verify: 'Restore verification', restore_scratch: 'Scratch restore', restore_inplace: 'In-place restore' }[k] ?? k);
const summary = (k: string, r: Record<string, unknown>) =>
  k === 'restore_scratch' ? `New read-only connection ${r.connectionName} (${r.tables} tables)` : k === 'backup' ? `${r.sizeBytes ?? ''} bytes · sha256 ${String(r.sha256 ?? '').slice(0, 12)}…` : `${r.tables ?? ''} tables`;

registerWorker<{ taskId: number }>('ops.task', async (d) => {
  if (d?.taskId) await runTask(Number(d.taskId));
});

/** Nightly: restore each connection's newest logical backup into a scratch database. */
registerWorker('backup.verify-nightly', async () => {
  const rows = await q(
    `select distinct on (connection_id) id, connection_id, verified_at from backups
     where backend = 'logical' and status = 'ok' order by connection_id, started_at desc`,
  );
  for (const r of rows) {
    if (r.verified_at && Date.now() - new Date(r.verified_at).getTime() < 20 * 3600_000) continue;
    const conn = await one<ConnRow>('select * from connections where id = $1', [r.connection_id]);
    if (conn) await newTask(conn, 'verify', null, Number(r.id));
  }
}, '17 3 * * *');

// ── Overview ────────────────────────────────────────────────────

async function overview(conn: ConnRow): Promise<BackupOverview> {
  const st = stanza();
  const brBin = findBin('pgbackrest');
  const pgDump = findBin('pg_dump');
  const pgRestore = findBin('pg_restore');
  const backend: BackupOverview['backend'] = st && brBin ? 'pgbackrest' : 'logical';
  const notes: string[] = [];
  let createdb: boolean | null = null;
  try {
    createdb = await canCreateDb(conn);
  } catch {
    createdb = null;
  }
  if (backend === 'logical') {
    notes.push(st ? `COMB_PGBACKREST_STANZA is set to ${st} but pgbackrest is not on the Comb server's PATH, so Comb uses logical backups.`
      : 'pgBackRest is not configured (set COMB_PGBACKREST_STANZA and install pgbackrest on the Comb server for continuous WAL archiving and real point-in-time recovery).');
    if (!pgDump) notes.push('pg_dump not found on the Comb server: backups cannot run until the PostgreSQL client tools are installed.');
    if (!pgRestore) notes.push('pg_restore not found on the Comb server: restores and verification cannot run.');
    if (createdb === false) notes.push(`${conn.username} lacks CREATEDB: nightly verification and scratch restores cannot run (cannot verify: needs CREATEDB).`);
  }
  const backups = (await q(`select * from backups where connection_id = $1 order by started_at desc limit 60`, [conn.id])).map(backupOut);
  const tasks = (await q(`select * from ops_tasks where connection_id = $1 and (status in ('queued','running') or created_at > now() - interval '1 day') order by created_at desc limit 12`, [conn.id])).map(taskOut);
  let window: BackupOverview['window'] = null;
  let br: BackupOverview['pgbackrest'] = null;
  let points: BackupOverview['points'] = [];
  if (backend === 'pgbackrest') {
    try {
      const info = await pgbackrestInfo();
      const arch = (info?.archive ?? [])[0];
      br = { status: info?.status?.message ?? 'unknown', archiveMin: arch?.min ?? null, archiveMax: arch?.max ?? null };
      const bk: any[] = info?.backup ?? [];
      points = bk.map((x, i) => ({ id: -(i + 1), at: new Date(Number(x.timestamp?.stop ?? x.timestamp?.start) * 1000).toISOString() }));
      for (const x of bk) {
        backups.push({
          id: -1 - backups.length, backend: 'pgbackrest', kind: x.type, status: x.error ? 'error' : 'ok', startedAt: new Date(Number(x.timestamp.start) * 1000).toISOString(),
          finishedAt: new Date(Number(x.timestamp.stop) * 1000).toISOString(), sizeBytes: Number(x.info?.repository?.delta ?? x.info?.size ?? 0),
          durationMs: (Number(x.timestamp.stop) - Number(x.timestamp.start)) * 1000, sha256: null, destination: `pgbackrest · ${x.label}`, tableCount: null,
          verified: null, verifiedAt: null, verifyNote: null, error: null, createdBy: 'pgbackrest',
        });
      }
      if (bk.length) window = { start: new Date(Number(bk[0].timestamp.start) * 1000).toISOString(), end: new Date().toISOString(), continuous: !!arch?.max };
    } catch (e) {
      notes.push(String((e as Error).message));
    }
  } else {
    points = backups.filter((b) => b.backend === 'logical' && b.status === 'ok').map((b) => ({ id: b.id, at: b.finishedAt ?? b.startedAt })).reverse();
    if (points.length) window = { start: points[0].at, end: points[points.length - 1].at, continuous: false };
  }
  return {
    backend,
    capabilities: { pgDump, pgRestore, pgbackrest: brBin, stanza: st, createdb, dir: path.relative(process.cwd(), backupRoot()) || '.', notes },
    backups, tasks, window, points, retention: await getSetting('backup.retention', { keepLast: 14 }), pgbackrest: br,
  };
}

// ── Routes ──────────────────────────────────────────────────────

const backupIdBody = z.object({ backupId: z.number().int().positive() });

export default async function backupModule(app: FastifyInstance): Promise<void> {
  app.get('/backup/:connId', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn } = await requireConn(req, connId, 'read');
    return overview(conn);
  });

  app.get('/backup/:connId/tasks/:id', async (req) => {
    const { connId, id } = parse(connParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    await requireConn(req, connId, 'read');
    const row = await one('select * from ops_tasks where id = $1 and connection_id = $2', [id, connId]);
    if (!row) throw notFound('Task not found');
    return taskOut(row);
  });

  app.post('/backup/:connId/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ kind: z.enum(['full', 'incr', 'diff', 'logical']).optional() }), req.body ?? {});
    const { conn, user } = await requireConn(req, connId, 'admin');
    const busy = await one(`select id from ops_tasks where connection_id = $1 and kind = 'backup' and status in ('queued','running')`, [connId]);
    if (busy) throw badRequest('A backup of this connection is already running');
    if (!(stanza() && findBin('pgbackrest')) && !findBin('pg_dump')) throw badRequest('pg_dump not found on the Comb server');
    const task = await newTask(conn, 'backup', user, null, { kind: body.kind ?? 'full' });
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'BACKUP', target: conn.name, status: 'pending', ip: req.ip,
      detail: { taskId: task.id, kind: body.kind ?? 'full' } });
    return task;
  });

  app.post('/backup/:connId/verify', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(backupIdBody, req.body);
    const { conn, user } = await requireConn(req, connId, 'admin');
    const b = await one(`select id from backups where id = $1 and connection_id = $2 and backend = 'logical' and status = 'ok'`, [body.backupId, connId]);
    if (!b) throw notFound('Backup not found');
    const task = await newTask(conn, 'verify', user, body.backupId);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'VERIFY', target: conn.name, status: 'pending', ip: req.ip,
      detail: { taskId: task.id, backupId: body.backupId } });
    return task;
  });

  app.post('/backup/:connId/restore-scratch', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(backupIdBody, req.body);
    const { conn, user } = await requireConn(req, connId, 'admin');
    requireRole(req, 'Admin');
    const b = await one(`select id from backups where id = $1 and connection_id = $2 and backend = 'logical' and status = 'ok'`, [body.backupId, connId]);
    if (!b) throw notFound('Backup not found');
    const task = await newTask(conn, 'restore_scratch', user, body.backupId);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'RESTORE', target: conn.name, status: 'pending', ip: req.ip,
      detail: { taskId: task.id, backupId: body.backupId, mode: 'scratch' } });
    return task;
  });

  app.post('/backup/:connId/restore-inplace', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(backupIdBody.extend({ confirm: z.string().max(100).optional() }), req.body);
    const { conn, user } = await requireConn(req, connId, 'admin');
    requireRole(req, 'Owner');
    if (conn.read_only) throw badRequest(`${conn.name} is read-only. Comb will not restore over it; restore to a scratch connection instead.`);
    const b = await one(`select * from backups where id = $1 and connection_id = $2 and backend = 'logical' and status = 'ok'`, [body.backupId, connId]);
    if (!b) throw notFound('Backup not found');
    if (body.confirm !== conn.name) {
      const argv = ['pg_restore', ...inplaceArgs(conn, path.basename(b.path))].join(' ');
      throw new HttpError(409, `Type ${conn.name} to restore it in place`, {
        code: 'COMB_CONFIRM',
        confirm: {
          word: conn.name, kind: 'RESTORE', target: conn.name,
          sql: `-- restore target: ${conn.dbname} on ${conn.host}:${conn.port}\n-- from: logical backup #${b.id} taken ${new Date(b.started_at).toISOString().slice(0, 16).replace('T', ' ')} UTC (${b.table_count ?? '?'} tables)\n${argv}\n-- every object in the dump is dropped and recreated with the dump's rows;\n-- rows written to those tables after the backup are gone.\n-- objects created after the backup are kept. Sessions are not disconnected,\n-- but they wait on locks. One transaction: on any error nothing changes.`,
        },
      });
    }
    const task = await newTask(conn, 'restore_inplace', user, body.backupId);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'RESTORE', target: conn.name, status: 'pending', ip: req.ip,
      detail: { taskId: task.id, backupId: body.backupId, mode: 'in-place' } });
    return task;
  });
}
