import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectionInput, connectionPatch, parseDsn, type ConnectionSummary } from '@comb/shared';
import { config } from '../config.ts';
import { q, one } from '../db/meta.ts';
import { parse, badRequest, notFound, HttpError } from './http.ts';
import { encryptSecret, decryptSecret } from '../security/crypto.ts';
import { audit } from '../security/audit.ts';
import { requireRole, requireConn, userOf, connectionLevel, type ConnRow } from '../security/authz.ts';
import { clientConfig, dropPool, testConnection, withTarget, sshConfigOf } from '../targets/pool.ts';
import { probeHostKey, tunnelStream, openTunnel, closeTunnel } from '../targets/tunnel.ts';
import { randomToken } from '../security/crypto.ts';
import { runSql, cancelRuns } from '../targets/exec.ts';

const MAX_CA = 64 * 1024;
const connBody = connectionInput.extend({ sslCa: z.string().max(MAX_CA).nullable().optional() });
const idParam = z.object({ id: z.string().uuid() });

function summary(c: ConnRow, level: ConnectionSummary['level']): ConnectionSummary & { sslCa: boolean } {
  return {
    id: c.id, name: c.name, color: c.color as ConnectionSummary['color'], env: c.env, host: c.host, port: c.port, db: c.dbname, user: c.username,
    sslmode: c.sslmode as ConnectionSummary['sslmode'], readOnly: c.read_only, requireApproval: c.require_approval, level,
    lastOpenedAt: c.last_opened_at ? new Date(c.last_opened_at).toISOString() : null, hasPassword: !!c.secret_enc, sslCa: !!c.ssl_ca,
    ssh: c.ssh_host ? { host: c.ssh_host, port: c.ssh_port, user: c.ssh_user ?? '', auth: c.ssh_auth ?? 'password', hostKey: c.ssh_host_key, hasSecret: !!c.ssh_secret_enc } : null,
  };
}

function pgErrorMessage(e: any): { text: string; hint?: string } {
  const msg = String(e?.message ?? e);
  if (/pg_hba\.conf/.test(msg)) return { text: msg, hint: 'The server refuses this host/user/database combination. Ask the DBA to add a pg_hba.conf entry, or connect through an SSH tunnel.' };
  if (/password authentication failed/.test(msg)) return { text: msg, hint: 'Check the user and password.' };
  if (/ECONNREFUSED|ENOTFOUND|timeout/i.test(msg)) return { text: msg, hint: 'The host did not answer. Check host, port and firewall rules.' };
  if (/self[- ]signed|certificate/i.test(msg)) return { text: msg, hint: 'The server certificate could not be verified. Paste the CA certificate, or use sslmode=require (encrypted, not verified).' };
  return { text: msg };
}

export async function coreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { public: true } }, async () => ({ ok: true, version: config.COMB_VERSION }));

  // ── Connections ────────────────────────────────────────────────
  app.get('/connections', async (req) => {
    const user = userOf(req);
    const rows = await q<ConnRow>('select * from connections order by last_opened_at desc nulls last, name');
    const out = [];
    for (const c of rows) {
      const level = await connectionLevel(user, c);
      if (level !== 'none') out.push(summary(c, level));
    }
    return out;
  });

  app.post('/connections', async (req) => {
    const user = requireRole(req, 'Admin');
    const body = parse(connBody, req.body);
    const prod = body.env === 'prod';
    const row = await one<ConnRow>(
      `insert into connections (name, color, env, host, port, dbname, username, sslmode, ssl_ca, read_only, require_approval, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [body.name, body.color, body.env, body.host, body.port, body.db, body.user, body.sslmode, body.sslCa ?? null,
        body.readOnly || prod, body.requireApproval ?? prod, user.id],
    ).catch((e) => {
      if (e.code === '23505') throw badRequest('A connection with that name already exists');
      throw e;
    });
    if (body.password) {
      await q('update connections set secret_enc = $2 where id = $1', [row!.id, encryptSecret(body.password, `connection:${row!.id}:password`)]);
    }
    if (body.sshHost) {
      await q(`update connections set ssh_host=$2, ssh_port=$3, ssh_user=$4, ssh_auth=$5, ssh_host_key=$6, ssh_secret_enc=$7 where id=$1`, [
        row!.id, body.sshHost, body.sshPort ?? 22, body.sshUser ?? null, body.sshAuth ?? 'password', body.sshHostKey ?? null,
        body.sshSecret ? encryptSecret(body.sshSecret, `connection:${row!.id}:ssh`) : null,
      ]);
    }
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: row!.id, connectionName: body.name, kind: 'CONNECTION', target: body.name, status: 'ok', ip: req.ip, detail: { action: 'create', env: body.env, host: body.host, ssh: !!body.sshHost } });
    const fresh = await one<ConnRow>('select * from connections where id = $1', [row!.id]);
    return summary(fresh!, await connectionLevel(user, fresh!));
  });

  app.patch('/connections/:id', async (req) => {
    const user = requireRole(req, 'Admin');
    const { id } = parse(idParam, req.params);
    const cur = await one<ConnRow>('select * from connections where id = $1', [id]);
    if (!cur) throw notFound('Connection not found');
    const body = parse(connectionPatch, req.body);
    // Any change to the bastion (adding, removing or moving it) changes where the database password goes.
    const sshMoved = (body.sshHost !== undefined && (body.sshHost || null) !== cur.ssh_host) || (body.sshUser !== undefined && body.sshUser !== cur.ssh_user) ||
      (body.sshPort !== undefined && body.sshPort !== cur.ssh_port) || (body.sshAuth !== undefined && body.sshAuth !== cur.ssh_auth);
    const moved = sshMoved || (body.host !== undefined && body.host !== cur.host) || (body.port !== undefined && body.port !== cur.port) ||
      (body.user !== undefined && body.user !== cur.username) || (body.db !== undefined && body.db !== cur.dbname);
    // Never send a stored password to a different server: a changed target needs the password again.
    if (moved && body.password === undefined && cur.secret_enc) throw badRequest('Re-enter the database password when changing host, port, database, user or SSH tunnel');
    const next = {
      name: body.name ?? cur.name, color: body.color ?? cur.color, env: body.env ?? cur.env, host: body.host ?? cur.host,
      port: body.port ?? cur.port, dbname: body.db ?? cur.dbname, username: body.user ?? cur.username, sslmode: body.sslmode ?? cur.sslmode,
      ssl_ca: body.sslCa === undefined ? cur.ssl_ca : body.sslCa, read_only: body.readOnly ?? cur.read_only,
      require_approval: body.requireApproval ?? cur.require_approval,
    };
    const secret = body.password === undefined ? cur.secret_enc : body.password ? encryptSecret(body.password, `connection:${id}:password`) : null;
    // SSH: a new bastion endpoint needs the SSH secret again and a fresh host-key confirmation.
    const removingTunnel = body.sshHost === null || body.sshHost === '';
    if (sshMoved && !removingTunnel && body.sshSecret === undefined && cur.ssh_secret_enc) throw badRequest('Re-enter the SSH password or key when changing the bastion');
    const ssh = {
      host: body.sshHost === undefined ? cur.ssh_host : body.sshHost || null,
      port: body.sshPort ?? cur.ssh_port,
      user: body.sshUser === undefined ? cur.ssh_user : body.sshUser,
      auth: body.sshAuth === undefined ? cur.ssh_auth : body.sshAuth,
      hostKey: body.sshHostKey !== undefined ? body.sshHostKey : sshMoved ? null : cur.ssh_host_key,
      secret: body.sshSecret === undefined ? cur.ssh_secret_enc : body.sshSecret ? encryptSecret(body.sshSecret, `connection:${id}:ssh`) : null,
    };
    const row = await one<ConnRow>(
      `update connections set name=$2, color=$3, env=$4, host=$5, port=$6, dbname=$7, username=$8, sslmode=$9, ssl_ca=$10, read_only=$11, require_approval=$12, secret_enc=$13,
         ssh_host=$14, ssh_port=$15, ssh_user=$16, ssh_auth=$17, ssh_host_key=$18, ssh_secret_enc=$19
       where id = $1 returning *`,
      [id, next.name, next.color, next.env, next.host, next.port, next.dbname, next.username, next.sslmode, next.ssl_ca, next.read_only, next.require_approval, secret,
        ssh.host, ssh.port, ssh.host ? ssh.user : null, ssh.host ? ssh.auth ?? 'password' : null, ssh.host ? ssh.hostKey : null, ssh.host ? ssh.secret : null],
    );
    dropPool(id);
    const changed = Object.keys(body).filter((k) => k !== 'password' && k !== 'sslCa' && k !== 'sshSecret');
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: id, connectionName: next.name, kind: 'CONNECTION', target: next.name, status: 'ok', ip: req.ip,
      detail: { action: 'update', fields: changed, passwordChanged: body.password !== undefined, sshSecretChanged: body.sshSecret !== undefined } });
    return summary(row!, await connectionLevel(user, row!));
  });

  app.delete('/connections/:id', async (req) => {
    const user = requireRole(req, 'Admin');
    const { id } = parse(idParam, req.params);
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body ?? {});
    const cur = await one<ConnRow>('select * from connections where id = $1', [id]);
    if (!cur) throw notFound('Connection not found');
    if (confirm !== cur.name) throw new HttpError(409, `Type ${cur.name} to confirm`, { code: 'COMB_CONFIRM', confirm: { word: cur.name, kind: 'REMOVE', target: cur.name } });
    await q('delete from connections where id = $1', [id]);
    dropPool(id);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: id, connectionName: cur.name, kind: 'CONNECTION', target: cur.name, status: 'ok', ip: req.ip, detail: { action: 'delete' } });
    return { ok: true };
  });

  app.post('/connections/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    requireRole(req, 'Admin');
    const body = parse(connectionPatch.extend({ id: z.string().uuid().optional() }), req.body);
    let cfgRow: ConnRow;
    let password: string | null | undefined = body.password;
    let sshSecret: string | null | undefined = body.sshSecret;
    if (body.id) {
      const cur = await one<ConnRow>('select * from connections where id = $1', [body.id]);
      if (!cur) throw notFound('Connection not found');
      const sshMoved = (body.sshHost !== undefined && (body.sshHost || null) !== cur.ssh_host) || (body.sshUser !== undefined && body.sshUser !== cur.ssh_user) ||
        (body.sshPort !== undefined && body.sshPort !== cur.ssh_port) || (body.sshAuth !== undefined && body.sshAuth !== cur.ssh_auth);
      const moved = sshMoved || (body.host !== undefined && body.host !== cur.host) || (body.port !== undefined && body.port !== cur.port) ||
        (body.user !== undefined && body.user !== cur.username) || (body.db !== undefined && body.db !== cur.dbname);
      if (moved && password === undefined && cur.secret_enc) throw badRequest('Re-enter the database password to test a different server or tunnel');
      const removingTunnel = body.sshHost === null || body.sshHost === '';
      if (sshMoved && !removingTunnel && sshSecret === undefined && cur.ssh_secret_enc) throw badRequest('Re-enter the SSH password or key to test a different bastion');
      cfgRow = { ...cur, host: body.host ?? cur.host, port: body.port ?? cur.port, dbname: body.db ?? cur.dbname, username: body.user ?? cur.username,
        sslmode: body.sslmode ?? cur.sslmode, ssl_ca: body.sslCa === undefined ? cur.ssl_ca : body.sslCa,
        ssh_host: body.sshHost === undefined ? cur.ssh_host : body.sshHost, ssh_port: body.sshPort ?? cur.ssh_port, ssh_user: body.sshUser === undefined ? cur.ssh_user : body.sshUser,
        ssh_auth: body.sshAuth === undefined ? cur.ssh_auth : body.sshAuth, ssh_host_key: body.sshHostKey === undefined ? cur.ssh_host_key : body.sshHostKey };
    } else {
      if (!body.host || !body.db || !body.user) throw badRequest('Host, database and user are required');
      cfgRow = { id: 'new', name: 'test', color: 'slate', env: 'local', host: body.host, port: body.port ?? 5432, dbname: body.db, username: body.user, secret_enc: null,
        sslmode: body.sslmode ?? 'prefer', ssl_ca: body.sslCa ?? null, read_only: true, require_approval: false, last_opened_at: null,
        ssh_host: body.sshHost ?? null, ssh_port: body.sshPort ?? 22, ssh_user: body.sshUser ?? null, ssh_auth: body.sshAuth ?? null, ssh_secret_enc: null, ssh_host_key: body.sshHostKey ?? null };
      password ??= null;
      sshSecret ??= null;
    }
    let tunnelId: string | null = null;
    try {
      let cfg = clientConfig(cfgRow, password);
      if (cfgRow.ssh_host) {
        if (!cfgRow.ssh_user) return { ok: false, text: 'SSH user is required' };
        // A throwaway id keeps the test tunnel separate from the live pool's tunnel.
        const probe = { ...sshConfigOf(cfgRow), id: body.id ?? 'new' };
        const secret = sshSecret !== undefined ? sshSecret : decryptSecret(cfgRow.ssh_secret_enc, `connection:${cfgRow.id}:ssh`);
        const key = await probeHostKey(probe, secret);
        if (!key.ok) {
          return { ok: false, hostKey: key.fingerprint, text: cfgRow.ssh_host_key
            ? `SSH host key changed: expected ${cfgRow.ssh_host_key}, got ${key.fingerprint}. Refusing to connect.`
            : `Bastion host key is ${key.fingerprint}. Confirm it with whoever runs ${cfgRow.ssh_host}, then test again.`,
            hint: cfgRow.ssh_host_key ? 'A changed host key can mean a man-in-the-middle. Do not accept it unless the bastion was rebuilt.' : undefined };
        }
        tunnelId = 'test-' + randomToken(6);
        const t = { ...probe, id: tunnelId, ssh_host_key: key.fingerprint };
        await openTunnel(t, secret);
        cfg = { ...cfg, stream: tunnelStream(t, secret) as any };
      }
      const r = await testConnection(cfg, cfgRow.sslmode, cfgRow.ssl_ca);
      return { ok: true, text: `Connected${cfgRow.ssh_host ? ' via ' + cfgRow.ssh_host : ''} · PostgreSQL ${r.version.split(' ')[0]} · ${r.ms} ms · ${r.schemas} schemas` };
    } catch (e) {
      const m = pgErrorMessage(e);
      return { ok: false, text: m.text, hint: m.hint };
    } finally {
      if (tunnelId) closeTunnel(tunnelId);
    }
  });

  // Creates the demo connection from COMB_DEMO_DSN (dev and evaluation installs).
  app.post('/connections/demo', async (req) => {
    const user = requireRole(req, 'Admin');
    if (!config.COMB_DEMO_DSN) throw badRequest('No demo database is configured on this server');
    const d = parseDsn(config.COMB_DEMO_DSN);
    if (!d?.host || !d.db || !d.user) throw badRequest('COMB_DEMO_DSN is not a valid connection string');
    const exists = await one('select id from connections where name = $1', ['shop_demo']);
    if (exists) return { id: exists.id };
    const row = await one(
      `insert into connections (name, color, env, host, port, dbname, username, sslmode, created_by) values ('shop_demo','teal','local',$1,$2,$3,$4,$5,$6) returning id`,
      [d.host, d.port ?? 5432, d.db, d.user, d.sslmode ?? 'prefer', user.id],
    );
    if (d.password) await q('update connections set secret_enc = $2 where id = $1', [row.id, encryptSecret(d.password, `connection:${row.id}:password`)]);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: row.id, connectionName: 'shop_demo', kind: 'CONNECTION', target: 'shop_demo', status: 'ok', ip: req.ip, detail: { action: 'demo' } });
    return { id: row.id };
  });

  app.post('/connections/:id/open', async (req) => {
    const { id } = parse(idParam, req.params);
    const { conn, level } = await requireConn(req, id, 'read');
    await q('update connections set last_opened_at = now() where id = $1', [id]);
    return summary(conn, level);
  });

  // ── Object tree ────────────────────────────────────────────────
  app.get('/connections/:id/tree', async (req) => {
    const { id } = parse(idParam, req.params);
    const { conn, user } = await requireConn(req, id, 'read');
    return withTarget(conn, { readOnly: true, actor: user.email }, async (c) => {
      const rel = await c.query(`
        select n.nspname as schema, c.relname as name, c.relkind as kind, greatest(c.reltuples, 0)::bigint as est
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p','v','m','f') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
          and has_schema_privilege(n.oid, 'USAGE')
          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
        order by 1, 2 limit 5000`);
      const fn = await c.query(`
        select n.nspname as schema, p.proname as name
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and p.prokind in ('f','p')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        order by 1, 2 limit 2000`);
      const en = await c.query(`
        select n.nspname as schema, t.typname as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where t.typtype = 'e' and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by 1, 2`);
      const sch = await c.query(`select nspname as name from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' and has_schema_privilege(oid, 'USAGE') order by 1`);
      const schemas = new Map<string, { name: string; tables: any[]; views: any[]; functions: string[]; enums: string[] }>();
      for (const s of sch.rows) schemas.set(s.name, { name: s.name, tables: [], views: [], functions: [], enums: [] });
      for (const r of rel.rows) {
        const s = schemas.get(r.schema);
        if (!s) continue;
        if (r.kind === 'v' || r.kind === 'm') s.views.push({ name: r.name, kind: r.kind === 'm' ? 'matview' : 'view' });
        else s.tables.push({ name: r.name, est: Number(r.est), kind: r.kind === 'p' ? 'partitioned' : r.kind === 'f' ? 'foreign' : 'table' });
      }
      for (const r of fn.rows) schemas.get(r.schema)?.functions.push(r.name);
      for (const r of en.rows) schemas.get(r.schema)?.enums.push(r.name);
      const ver = await c.query(`select current_setting('server_version') as v`);
      return { version: String(ver.rows[0].v).split(' ')[0], schemas: [...schemas.values()] };
    });
  });

  // ── Query ──────────────────────────────────────────────────────
  app.post('/connections/:id/query', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ sql: z.string().min(1).max(1_000_000), confirm: z.string().max(200).optional(), maxRows: z.number().int().min(1).max(100_000).optional() }), req.body);
    const { conn, level, user } = await requireConn(req, id, 'read');
    return runSql({ user, conn, level, sql: body.sql, confirm: body.confirm, maxRows: body.maxRows, source: 'query', ip: req.ip });
  });

  app.post('/connections/:id/cancel', async (req) => {
    const { id } = parse(idParam, req.params);
    const { user } = await requireConn(req, id, 'read');
    return { cancelled: await cancelRuns(user, id) };
  });

  // ── Notifications ──────────────────────────────────────────────
  app.get('/notifications', async (req) => {
    const user = userOf(req);
    const rows = await q(
      `select n.id, n.kind, n.title, n.body, n.target, n.created_at, (r.user_id is not null) as read
       from notifications n left join notification_reads r on r.notification_id = n.id and r.user_id = $1
       where (n.user_id = $1 or n.user_id is null) and n.created_at > now() - interval '30 days'
       order by n.created_at desc limit 50`,
      [user.id],
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });

  app.post('/notifications/read', async (req) => {
    const user = userOf(req);
    const body = parse(z.object({ ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional() }), req.body);
    if (body.all) {
      await q(
        `insert into notification_reads (notification_id, user_id)
         select id, $1 from notifications where user_id = $1 or user_id is null on conflict do nothing`, [user.id]);
    } else if (body.ids?.length) {
      await q(
        `insert into notification_reads (notification_id, user_id)
         select id, $1 from notifications where id = any($2::bigint[]) and (user_id = $1 or user_id is null) on conflict do nothing`, [user.id, body.ids]);
    }
    return { ok: true };
  });
}
