import { z } from 'zod';

export const WORKSPACE_ROLES = ['Owner', 'Admin', 'Analyst', 'Viewer', 'Service'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ACCESS_LEVELS = ['none', 'read', 'write', 'admin'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ENVIRONMENTS = ['local', 'dev', 'staging', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const CONNECTION_COLORS = ['slate', 'azure', 'teal', 'lime', 'amber', 'coral', 'violet', 'fuchsia'] as const;
export type ConnectionColor = (typeof CONNECTION_COLORS)[number];

export const SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;

/** Statement classes produced by the server-side SQL classifier. */
export const STATEMENT_KINDS = ['read', 'write', 'ddl', 'privilege', 'transaction', 'session', 'utility', 'unknown'] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export interface Me {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  mfaEnabled: boolean;
  csrfToken: string;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  color: ConnectionColor;
  env: Environment;
  host: string;
  port: number;
  db: string;
  user: string;
  sslmode: (typeof SSL_MODES)[number];
  readOnly: boolean;
  requireApproval: boolean;
  level: AccessLevel;
  lastOpenedAt: string | null;
  hasPassword: boolean;
  ssh: { host: string; port: number; user: string; auth: 'password' | 'key'; hostKey: string | null; hasSecret: boolean } | null;
}

export const connectionInput = z.object({
  name: z.string().trim().min(1).max(63).regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, _ . - only'),
  color: z.enum(CONNECTION_COLORS).default('slate'),
  env: z.enum(ENVIRONMENTS).default('local'),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  db: z.string().trim().min(1).max(63),
  user: z.string().trim().min(1).max(63),
  /** Omitted on edit means "keep the stored password". Empty string clears it. */
  password: z.string().max(1024).optional(),
  sslmode: z.enum(SSL_MODES).default('prefer'),
  readOnly: z.boolean().default(false),
  requireApproval: z.boolean().optional(),
  sshHost: z.string().trim().max(255).nullable().optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().trim().max(63).nullable().optional(),
  sshAuth: z.enum(['password', 'key']).nullable().optional(),
  /** Password or private key (PEM). Write-only; omitted means keep. */
  sshSecret: z.string().max(16384).optional(),
  /** SHA256 fingerprint the admin confirmed, e.g. SHA256:abc... */
  sshHostKey: z.string().max(100).nullable().optional(),
});
export type ConnectionInput = z.infer<typeof connectionInput>;

/** Edit payload: every field optional and, unlike connectionInput.partial(), no defaults filled in. */
export const connectionPatch = z.object({
  name: z.string().trim().min(1).max(63).regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, _ . - only').optional(),
  color: z.enum(CONNECTION_COLORS).optional(),
  env: z.enum(ENVIRONMENTS).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  db: z.string().trim().min(1).max(63).optional(),
  user: z.string().trim().min(1).max(63).optional(),
  password: z.string().max(1024).optional(),
  sslmode: z.enum(SSL_MODES).optional(),
  sslCa: z.string().max(65536).nullable().optional(),
  readOnly: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  sshHost: z.string().trim().max(255).nullable().optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().trim().max(63).nullable().optional(),
  sshAuth: z.enum(['password', 'key']).nullable().optional(),
  /** Password or private key (PEM). Write-only; omitted means keep. */
  sshSecret: z.string().max(16384).optional(),
  /** SHA256 fingerprint the admin confirmed, e.g. SHA256:abc... */
  sshHostKey: z.string().max(100).nullable().optional(),
});

export interface ColumnMeta {
  name: string;
  type: string;
  family: TypeFamily;
}

export type TypeFamily = 'numeric' | 'text' | 'temporal' | 'boolean' | 'structured' | 'identifier' | 'other';

export interface QueryResult {
  runId: string;
  statements: Array<{
    command: string;
    kind: StatementKind;
    rowCount: number | null;
    ms: number;
  }>;
  columns: ColumnMeta[];
  rows: unknown[][];
  truncated: boolean;
  notices: Array<{ severity: string; message: string }>;
  ms: number;
}

export interface QueryError {
  error: string;
  code?: string;
  position?: number;
  line?: number;
  detail?: string;
  hint?: string;
  /** Set when the server needs a typed confirmation before running. */
  confirm?: { word: string; kind: string; target: string };
  /** Set when the write was routed to the approvals queue instead of running. */
  approvalId?: string;
}

/** Maps a Postgres type name to the colour family the UI uses. */
export function typeFamily(type: string): TypeFamily {
  const t = type.toLowerCase();
  if (/^(int|bigint|smallint|numeric|decimal|real|double|float|money|serial|bigserial|oid)/.test(t)) return 'numeric';
  if (/^(timestamp|date|time|interval)/.test(t)) return 'temporal';
  if (/^bool/.test(t)) return 'boolean';
  if (/^(json|jsonb|xml|hstore|array|_)/.test(t) || t.endsWith('[]')) return 'structured';
  if (/^(uuid|inet|cidr|macaddr|tsvector)/.test(t)) return 'identifier';
  if (/^(text|varchar|char|character|name|citext|bpchar)/.test(t)) return 'text';
  return 'other';
}

/** Parses postgresql:// connection strings without ever logging the password. */
export function parseDsn(dsn: string): Partial<ConnectionInput> | null {
  const m = /^postgres(?:ql)?:\/\/(?:([^:@/]+)(?::([^@]*))?@)?([^:/?#]+)(?::(\d+))?(?:\/([^?#]+))?(?:\?([^#]*))?$/.exec(dsn.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[6] ?? '');
  const ssl = params.get('sslmode');
  const out: Partial<ConnectionInput> = {
    user: m[1] ? decodeURIComponent(m[1]) : undefined,
    password: m[2] !== undefined ? decodeURIComponent(m[2]) : undefined,
    host: m[3],
    port: m[4] ? Number(m[4]) : 5432,
    db: m[5] ? decodeURIComponent(m[5]) : undefined,
  };
  if (ssl && (SSL_MODES as readonly string[]).includes(ssl)) out.sslmode = ssl as ConnectionInput['sslmode'];
  return out;
}
