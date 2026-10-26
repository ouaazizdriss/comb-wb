import type { FastifyRequest } from 'fastify';
import type { AccessLevel, WorkspaceRole, Environment } from '@comb/shared';
import { one } from '../db/meta.ts';
import { forbidden, notFound, HttpError } from '../core/http.ts';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  mfaEnabled: boolean;
  via: 'session' | 'token';
  /** Token scopes; sessions have every scope their role allows. */
  scopes: string[] | null;
  sessionId?: Buffer;
  csrfToken?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyContextConfig {
    /** Route needs no login (login, setup, SSO callbacks, health). */
    public?: boolean;
    /** Route is reachable while the session still waits for its MFA code. */
    mfaPending?: boolean;
    /** Route stays reachable when policy requires MFA but the user has not enrolled yet. */
    mfaEnroll?: boolean;
    /** Route accepts cross-site POSTs (the SAML ACS). Only honoured with `public`; the route must verify its own input. */
    crossOrigin?: boolean;
  }
}

const ROLE_RANK: Record<WorkspaceRole, number> = { Viewer: 1, Analyst: 2, Service: 2, Admin: 3, Owner: 4 };
const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function userOf(req: FastifyRequest): AuthUser {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}

export function hasRole(user: AuthUser, min: WorkspaceRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}

/** Throws 403 unless the caller's workspace role is at least `min`. */
export function requireRole(req: FastifyRequest, min: WorkspaceRole): AuthUser {
  const u = userOf(req);
  if (!hasRole(u, min)) throw forbidden(`Requires the ${min} role`);
  if (u.via === 'token' && min !== 'Viewer' && !u.scopes?.includes('admin')) throw forbidden('Token lacks the admin scope');
  return u;
}

/** Default connection access when no explicit row exists (the Team & access matrix overrides it). */
export function defaultLevel(role: WorkspaceRole, env: Environment): AccessLevel {
  switch (role) {
    case 'Owner': return 'admin';
    case 'Admin': return env === 'prod' ? 'read' : 'write';
    case 'Analyst': return env === 'prod' ? 'read' : 'write';
    case 'Service': return 'none';
    case 'Viewer': return 'read';
  }
}

export interface ConnRow {
  id: string;
  name: string;
  color: string;
  env: Environment;
  host: string;
  port: number;
  dbname: string;
  username: string;
  secret_enc: Buffer | null;
  sslmode: string;
  ssl_ca: string | null;
  ssh_host: string | null;
  ssh_port: number;
  ssh_user: string | null;
  ssh_auth: 'password' | 'key' | null;
  ssh_secret_enc: Buffer | null;
  ssh_host_key: string | null;
  read_only: boolean;
  require_approval: boolean;
  last_opened_at: Date | null;
}

export async function connectionLevel(user: AuthUser, conn: Pick<ConnRow, 'id' | 'env'>): Promise<AccessLevel> {
  const row = await one('select level from connection_access where user_id = $1 and connection_id = $2', [user.id, conn.id]);
  let level: AccessLevel = row ? row.level : defaultLevel(user.role, conn.env);
  // Tokens are capped by their scopes.
  if (user.via === 'token') {
    const s = user.scopes ?? [];
    const cap: AccessLevel = s.includes('admin') ? 'admin' : s.includes('write') ? 'write' : s.includes('read') ? 'read' : 'none';
    if (LEVEL_RANK[cap] < LEVEL_RANK[level]) level = cap;
  }
  return level;
}

export function levelAtLeast(level: AccessLevel, min: AccessLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

/** Loads a connection and checks the caller's access level on it. Unknown and no-access look the same (404). */
export async function requireConn(req: FastifyRequest, connId: string, min: AccessLevel): Promise<{ conn: ConnRow; level: AccessLevel; user: AuthUser }> {
  const user = userOf(req);
  if (!/^[0-9a-f-]{36}$/i.test(connId)) throw notFound('Connection not found');
  const conn = await one<ConnRow>('select * from connections where id = $1', [connId]);
  if (!conn) throw notFound('Connection not found');
  const level = await connectionLevel(user, conn);
  if (level === 'none') throw notFound('Connection not found');
  if (!levelAtLeast(level, min)) throw forbidden(`Requires ${min} access on ${conn.name}`);
  return { conn, level, user };
}
