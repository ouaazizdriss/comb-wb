import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8080),
  COMB_DATABASE_URL: z.string().min(1),
  COMB_MIGRATION_DATABASE_URL: z.string().optional(),
  COMB_MASTER_KEY: z.string().min(1),
  COMB_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  COMB_TRUST_PROXY: z.string().optional(),
  COMB_DEMO_DSN: z.string().optional(),
  COMB_WEB_DIST: z.string().optional(),
  COMB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  COMB_MAX_RESULT_ROWS: z.coerce.number().int().min(100).default(5_000),
  COMB_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(24 * 7),
  COMB_BACKUP_DIR: z.string().optional(),
  COMB_VERSION: z.string().default('1.5.0'),
  COMB_ALLOWLIST_LOOPBACK_BYPASS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print only variable names, never values: they may contain secrets.
  console.error('Invalid configuration:', parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  process.exit(1);
}

const key = Buffer.from(parsed.data.COMB_MASTER_KEY, 'base64');
if (key.length !== 32) {
  console.error('COMB_MASTER_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).');
  process.exit(1);
}

export const config = {
  ...parsed.data,
  masterKey: key,
  isProd: parsed.data.NODE_ENV === 'production',
  cookieSecure: parsed.data.COMB_PUBLIC_URL.startsWith('https://'),
};
