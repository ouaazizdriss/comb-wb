import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AccessLevel } from '@comb/shared';
import { parse, badRequest, notFound, HttpError } from '../core/http.ts';
import { audit } from '../security/audit.ts';
import { requireConn, levelAtLeast, type AuthUser, type ConnRow } from '../security/authz.ts';
import { withTarget, escapeIdent, escapeLit } from '../targets/pool.ts';
import { runSql, plan } from '../targets/exec.ts';

/*
 * Roles & privileges (gov module). Everything here acts on the TARGET database's real roles:
 * pg_roles, pg_auth_members, relation ACLs (aclexplode) and has_table_privilege().
 *
 * Reads need connection level `read`. Every change is generated server-side from a structured,
 * validated request (identifiers checked against the catalog, then quoted with escapeIdent) and
 * runs through runSql(source 'roles'), so classification (privilege → admin level), read-only
 * connections, approvals, typed confirmation on prod and the audit all apply.
 *
 * The one exception is a statement carrying a password (see runSecretStatement).
 */

const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const ATTRS = ['LOGIN', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS'] as const;

const connParam = z.object({ connId: z.string().uuid() });
const roleName = z.string().min(1).max(63);
const ident = z.string().min(1).max(63);

const change = z.discriminatedUnion('type', [
  z.object({ type: z.literal('grant'), on: z.boolean(), role: roleName, schema: ident, table: ident, privilege: z.enum(PRIVS) }),
  z.object({ type: z.literal('attr'), on: z.boolean(), role: roleName, attr: z.enum(ATTRS) }),
  z.object({ type: z.literal('member'), on: z.boolean(), role: roleName, group: roleName }),
  z.object({ type: z.literal('validUntil'), role: roleName, value: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/).nullable() }),
]);
type Change = z.infer<typeof change>;
const changesBody = z.object({ changes: z.array(change).min(1).max(200), confirm: z.string().max(200).optional() });

const read = (conn: ConnRow, user: AuthUser) => ({ readOnly: true, actor: user.email });

// ── Passwords ───────────────────────────────────────────────────────────────

/** 24 characters from a 56-symbol alphabet (~139 bits), unbiased via rejection sampling. */
function strongPassword(len = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(64)) {
      if (b < 224 && out.length < len) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/**
 * SCRAM-SHA-256 verifier in the format Postgres stores (RFC 5802/7677, 4096 iterations).
 * Sending the verifier instead of the cleartext means the password never reaches the target server,
 * so it cannot leak through log_statement / pg_stat_statements on the database side either.
 */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Runs one statement that embeds a password verifier.
 *
 * Why not runSql: runSql audits the statement text (and, on approval-required connections, stores it
 * in `approvals.sql`), so the secret would end up in the immutable audit trail. Until core accepts a
 * redacted audit text (see the gov report for the proposed exec.ts diff), this path:
 *   1. runs the exact policy checks of runSql via plan() on the REDACTED text (same parse tree shape:
 *      blocked statements, read-only connections, privilege → admin level, typed confirmation on prod),
 *   2. refuses approval-required connections outright, since queuing would have to store the secret,
 *   3. executes the real text in a Comb-controlled write transaction (withTarget readOnly:false) as the
 *      single statement it is, over the extended protocol,
 *   4. writes the audit event itself with the password replaced by '***'.
 */
async function runSecretStatement(opts: {
  req: FastifyRequest; conn: ConnRow; level: AccessLevel; user: AuthUser; sql: string; redacted: string; target: string; action: string; confirm?: string;
}): Promise<{ ms: number }> {
  const { req, conn, level, user } = opts;
  let p;
  try {
    p = await plan({ user, conn, level, sql: opts.redacted, source: 'roles', confirm: opts.confirm, ip: req.ip });
  } catch (e) {
    if (e instanceof HttpError && e.extra?.code === 'COMB_BLOCKED') {
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'BLOCKED', target: opts.target,
        sql: opts.redacted, status: 'blocked', ip: req.ip, detail: { reason: e.message, source: 'roles', action: opts.action } });
    }
    throw e;
  }
  if (p.stmts.length !== 1) throw badRequest('Exactly one statement expected');
  if (p.needsApproval) {
    throw badRequest(`${conn.name} requires approval for writes, and an approval request would have to store the password. Set it from a connection without that requirement, or have an Owner lift it for this change.`);
  }
  const t0 = Date.now();
  try {
    await withTarget(conn, { readOnly: false, actor: user.email }, (c) => c.query({ text: opts.sql, queryMode: 'extended' } as any));
  } catch (e: any) {
    const ms = Date.now() - t0;
    const msg = String(e?.message ?? '').split(opts.sql).join(opts.redacted).replace(/SCRAM-SHA-256\$[^'\s]+/g, '***');
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: p.stmts[0].command.split(' ')[0],
      target: opts.target, sql: opts.redacted, ms, status: 'error', ip: req.ip, detail: { source: 'roles', action: opts.action, code: e?.code ?? null, message: msg.slice(0, 500) } });
    throw new HttpError(400, msg || 'Statement failed', { code: e?.code });
  }
  const ms = Date.now() - t0;
  await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: p.stmts[0].command.split(' ')[0],
    target: opts.target, sql: opts.redacted, ms, status: 'ok', ip: req.ip, detail: { source: 'roles', action: opts.action, secret: 'redacted' } });
  return { ms };
}

// ── Catalog validation and SQL generation ───────────────────────────────────

async function existingRoles(conn: ConnRow, user: AuthUser, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  return withTarget(conn, read(conn, user), async (c) => {
    const r = await c.query('select rolname from pg_roles where rolname = any($1::text[])', [names]);
    return new Set(r.rows.map((x) => x.rolname as string));
  });
}

/** Validates every identifier in the change set against the catalog, then builds the statements. */
async function buildStatements(conn: ConnRow, user: AuthUser, changes: Change[]): Promise<string[]> {
  const roles = new Set<string>();
  const tables: Array<[string, string]> = [];
  for (const ch of changes) {
    roles.add(ch.role);
    if (ch.type === 'member') roles.add(ch.group);
    if (ch.type === 'grant') tables.push([ch.schema, ch.table]);
  }
  const known = await existingRoles(conn, user, [...roles]);
  for (const r of roles) if (!known.has(r)) throw badRequest(`Role ${r} does not exist on ${conn.name}`);
  if (tables.length) {
    const found = await withTarget(conn, read(conn, user), async (c) => {
      const r = await c.query(
        `select u.s, u.t from unnest($1::text[], $2::text[]) u(s, t)
          where exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = u.s and c.relname = u.t and c.relkind in ('r','p','v','m','f'))`,
        [tables.map((t) => t[0]), tables.map((t) => t[1])]);
      return new Set(r.rows.map((x) => x.s + '\u0000' + x.t));
    });
    for (const [s, t] of tables) if (!found.has(s + '\u0000' + t)) throw badRequest(`Table ${s}.${t} does not exist on ${conn.name}`);
  }
  return changes.map((ch) => {
    const role = escapeIdent(ch.role);
    switch (ch.type) {
      case 'grant': {
        const rel = `${escapeIdent(ch.schema)}.${escapeIdent(ch.table)}`;
        return ch.on ? `grant ${ch.privilege.toLowerCase()} on table ${rel} to ${role}` : `revoke ${ch.privilege.toLowerCase()} on table ${rel} from ${role}`;
      }
      case 'attr':
        return `alter role ${role} with ${ch.on ? '' : 'no'}${ch.attr.toLowerCase()}`;
      case 'member':
        return ch.on ? `grant ${escapeIdent(ch.group)} to ${role}` : `revoke ${escapeIdent(ch.group)} from ${role}`;
      case 'validUntil':
        return `alter role ${role} valid until ${escapeLit(ch.value ?? 'infinity')}`;
    }
  });
}

function hms(s: number): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export default async function rolesModule(app: FastifyInstance): Promise<void> {
  app.get('/roles/:connId', async (req) => {
    const { connId } = parse(connParam, req.params);
    const { conn, level, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, read(conn, user), async (c) => {
      const r = await c.query(`
        select r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
               to_char(r.rolvaliduntil, 'YYYY-MM-DD HH24:MI') as valid_until, r.rolvaliduntil = 'infinity' as valid_forever,
               (select count(*) from pg_stat_activity a where a.usename = r.rolname)::int as conns,
               array(select g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid order by 1) as member_of,
               exists (select 1 from pg_auth_members m where m.roleid = r.oid) as has_members
          from pg_roles r where r.rolname !~ '^pg_' order by r.rolname`);
      const all = await c.query(`select rolname from pg_roles order by rolname ~ '^pg_', rolname`);
      const meta = await c.query(`select current_user as me, has_table_privilege('pg_authid', 'select') as can_read_authid`);
      const pw = new Map<string, string>();
      if (meta.rows[0].can_read_authid) {
        // Only the kind of stored secret leaves this query, never the verifier itself.
        const a = await c.query(`select rolname, case when rolpassword is null then 'none' when rolpassword like 'SCRAM-SHA-256$%' then 'set · scram-sha-256'
                                   when rolpassword like 'md5%' then 'set · md5' else 'set' end as pw from pg_authid`);
        for (const x of a.rows) pw.set(x.rolname, x.pw);
      }
      const roles = r.rows.map((x) => {
        const attrs: string[] = [];
        if (x.rolsuper) attrs.push('SUPERUSER');
        if (x.rolcreatedb) attrs.push('CREATEDB');
        if (x.rolcreaterole) attrs.push('CREATEROLE');
        if (x.rolreplication) attrs.push('REPLICATION');
        if (x.rolbypassrls) attrs.push('BYPASSRLS');
        attrs.push(x.rolcanlogin ? 'LOGIN' : 'NOLOGIN');
        if (!x.rolcanlogin && x.has_members) attrs.push('GROUP');
        return {
          name: x.rolname, attrs, superuser: x.rolsuper, login: x.rolcanlogin, createdb: x.rolcreatedb, createrole: x.rolcreaterole,
          replication: x.rolreplication, bypassrls: x.rolbypassrls, conns: x.conns, memberOf: x.member_of, connLimit: x.rolconnlimit,
          validUntil: x.valid_forever ? null : x.valid_until, password: pw.get(x.rolname) ?? (meta.rows[0].can_read_authid ? 'none' : 'unknown · needs superuser to read'),
        };
      });
      return {
        connection: conn.name, cluster: `${conn.host}:${conn.port}`, connUser: meta.rows[0].me, level, readOnly: conn.read_only,
        requireApproval: conn.require_approval, canAdmin: levelAtLeast(level, 'admin') && !conn.read_only, roles, allRoles: all.rows.map((x) => x.rolname),
      };
    });
  });

  app.get('/roles/:connId/privileges', async (req) => {
    const { connId } = parse(connParam, req.params);
    const qs = parse(z.object({ role: roleName, schema: ident.default('public') }), req.query);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, read(conn, user), async (c) => {
      const role = await c.query('select oid, rolsuper from pg_roles where rolname = $1', [qs.role]);
      if (!role.rows[0]) throw notFound('Role not found');
      const schemas = await c.query(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1`);
      const r = await c.query(`
        select c.relname, c.relkind, p.priv, c.relowner = $1 as owner,
               exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where x.grantee = $1 and x.privilege_type = p.priv) as direct,
               has_table_privilege($1::oid, c.oid, p.priv) as effective
          from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join unnest($3::text[]) with ordinality p(priv, ord)
         where n.nspname = $2 and c.relkind in ('r','p','v','m','f')
         order by c.relname, p.ord limit 3500`, [role.rows[0].oid, qs.schema, PRIVS]);
      const tables = new Map<string, { name: string; kind: string; cells: Record<string, string> }>();
      for (const x of r.rows) {
        const t = tables.get(x.relname) ?? { name: x.relname, kind: x.relkind, cells: {} as Record<string, string> };
        t.cells[x.priv] = x.owner ? 'owner' : x.direct ? 'direct' : x.effective ? (role.rows[0].rolsuper ? 'superuser' : 'inherited') : 'none';
        tables.set(x.relname, t);
      }
      return { schema: qs.schema, schemas: schemas.rows.map((s) => s.nspname), privileges: PRIVS, tables: [...tables.values()] };
    });
  });

  app.get('/roles/:connId/sessions', async (req) => {
    const { connId } = parse(connParam, req.params);
    const qs = parse(z.object({ role: roleName }), req.query);
    const { conn, user } = await requireConn(req, connId, 'read');
    return withTarget(conn, read(conn, user), async (c) => {
      const r = await c.query(`
        select pid, coalesce(state, '') as state, left(coalesce(query, ''), 300) as query, application_name,
               extract(epoch from now() - coalesce(state_change, backend_start))::int as age_s,
               pid = pg_backend_pid() as self, application_name ~ '^comb' as comb
          from pg_stat_activity where usename = $1 and backend_type = 'client backend' order by backend_start limit 200`, [qs.role]);
      return r.rows.map((x) => ({ pid: x.pid, state: x.state, query: x.query, app: x.application_name, age: hms(Math.max(0, x.age_s ?? 0)), comb: x.self || x.comb }));
    });
  });

  app.post('/roles/:connId/preview', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(changesBody, req.body);
    const { conn, user } = await requireConn(req, connId, 'read');
    const stmts = await buildStatements(conn, user, body.changes);
    const runAs = await withTarget(conn, read(conn, user), async (c) => (await c.query('select current_user as u')).rows[0].u as string);
    return { statements: stmts, sql: 'begin;\n' + stmts.map((s) => s + ';').join('\n') + '\ncommit;', runAs };
  });

  app.post('/roles/:connId/apply', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(changesBody, req.body);
    const { conn, level, user } = await requireConn(req, connId, 'admin');
    const stmts = await buildStatements(conn, user, body.changes);
    // runSql runs every statement inside one Comb-controlled BEGIN … COMMIT, so the set applies atomically.
    return runSql({ user, conn, level, sql: stmts.map((s) => s + ';').join('\n'), source: 'roles', confirm: body.confirm, ip: req.ip });
  });

  app.post('/roles/:connId/create', async (req, reply) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({
      name: roleName.regex(/^[A-Za-z_][A-Za-z0-9_$.-]*$/, 'letters, digits, _ $ . - only').refine((n) => !/^pg_/i.test(n), 'pg_ names are reserved'),
      login: z.boolean().default(true), password: z.boolean().default(true), confirm: z.string().max(200).optional(),
    }), req.body);
    const { conn, level, user } = await requireConn(req, connId, 'admin');
    if ((await existingRoles(conn, user, [body.name])).has(body.name)) throw badRequest(`Role ${body.name} already exists`);
    const base = `create role ${escapeIdent(body.name)} with ${body.login ? 'login' : 'nologin'}`;
    if (!body.password) {
      return runSql({ user, conn, level, sql: base, source: 'roles', confirm: body.confirm, ip: req.ip });
    }
    const password = strongPassword();
    await runSecretStatement({ req, conn, level, user, sql: `${base} password ${escapeLit(scramVerifier(password))}`, redacted: `${base} password '***'`,
      target: body.name, action: 'create-role', confirm: body.confirm });
    reply.header('cache-control', 'no-store');
    return { ok: true, role: body.name, password, note: 'Shown once. Comb does not store it.' };
  });

  app.post('/roles/:connId/password', async (req, reply) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ role: roleName, confirm: z.string().max(200).optional() }), req.body);
    const { conn, level, user } = await requireConn(req, connId, 'admin');
    if (!(await existingRoles(conn, user, [body.role])).has(body.role)) throw notFound('Role not found');
    const password = strongPassword();
    const base = `alter role ${escapeIdent(body.role)} with password`;
    await runSecretStatement({ req, conn, level, user, sql: `${base} ${escapeLit(scramVerifier(password))}`, redacted: `${base} '***'`,
      target: body.role, action: 'password-reset', confirm: body.confirm });
    reply.header('cache-control', 'no-store');
    return { ok: true, role: body.role, password, note: 'Shown once. Comb does not store it.' };
  });

  app.post('/roles/:connId/drop', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ role: roleName, confirm: z.string().max(200).optional() }), req.body);
    const { conn, level, user } = await requireConn(req, connId, 'admin');
    if (!(await existingRoles(conn, user, [body.role])).has(body.role)) throw notFound('Role not found');
    const me = await withTarget(conn, read(conn, user), async (c) => (await c.query('select current_user as u')).rows[0].u as string);
    if (me === body.role) throw badRequest(`${body.role} is the role Comb connects as; dropping it would cut this connection off.`);
    // DROP ROLE is destructive: runSql answers 409 COMB_CONFIRM until the role name is typed.
    return runSql({ user, conn, level, sql: `drop role ${escapeIdent(body.role)}`, source: 'roles', confirm: body.confirm, ip: req.ip });
  });

  app.post('/roles/:connId/terminate', async (req) => {
    const { connId } = parse(connParam, req.params);
    const body = parse(z.object({ pid: z.number().int().positive().max(2 ** 31 - 1), role: roleName }), req.body);
    const { conn, user } = await requireConn(req, connId, 'admin');
    const denied = async (reason: string, status = 400) => {
      await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'TERMINATE', target: `pid ${body.pid}`,
        status: 'denied', ip: req.ip, detail: { role: body.role, reason } });
      return new HttpError(status, reason);
    };
    if (conn.read_only) throw await denied(`${conn.name} is read-only; terminating backends is disabled.`);
    const t0 = Date.now();
    const result = await withTarget(conn, read(conn, user), async (c) => {
      const r = await c.query(`select pid, usename, application_name, pid = pg_backend_pid() as self, application_name ~ '^comb' as comb
                                 from pg_stat_activity where pid = $1`, [body.pid]);
      const row = r.rows[0];
      if (!row) return { error: 'No backend with that pid (it may have ended already).', status: 404 };
      // Comb's own connections (target pools, metadata pool, job runner) are never terminated from here:
      // killing them would break other users' runs mid-transaction. Use Cancel on a query instead.
      if (row.self || row.comb) return { error: `pid ${body.pid} is one of Comb's own connections; Comb will not terminate itself.`, status: 400 };
      if (row.usename !== body.role) return { error: `pid ${body.pid} does not belong to ${body.role}.`, status: 400 };
      const k = await c.query('select pg_terminate_backend($1) as ok', [body.pid]);
      return { ok: !!k.rows[0].ok };
    });
    if ('error' in result) throw await denied(result.error!, result.status);
    await audit({ actorId: user.id, actorLabel: user.email, connectionId: conn.id, connectionName: conn.name, kind: 'TERMINATE', target: `pid ${body.pid}`,
      sql: `select pg_terminate_backend(${body.pid})`, ms: Date.now() - t0, status: result.ok ? 'ok' : 'error', ip: req.ip, detail: { role: body.role, source: 'roles' } });
    if (!result.ok) throw badRequest('Postgres refused to terminate that backend (the connection user may lack pg_signal_backend).');
    return { ok: true };
  });
}
