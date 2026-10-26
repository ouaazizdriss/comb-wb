import { q, one } from '../db/meta.ts';
import { encryptSecret, decryptSecret } from '../security/crypto.ts';

/*
 * Workspace settings in app_settings. Plain values live in `value` (jsonb);
 * secrets live encrypted in `secret_enc` and are never returned to the browser.
 * A short in-memory cache keeps per-request checks (IP allowlist, policies) cheap.
 */

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 5_000;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return (hit.value ?? fallback) as T;
  const row = await one('select value from app_settings where key = $1', [key]);
  const value = row ? row.value : undefined;
  cache.set(key, { at: Date.now(), value });
  return (value ?? fallback) as T;
}

export async function setSetting(key: string, value: unknown, userId?: string | null): Promise<void> {
  await q(
    `insert into app_settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId ?? null],
  );
  cache.delete(key);
}

export async function setSecretSetting(key: string, secret: string | null, userId?: string | null): Promise<void> {
  const enc = secret ? encryptSecret(secret, 'setting:' + key) : null;
  await q(
    `insert into app_settings (key, value, secret_enc, updated_by, updated_at) values ($1, '{}'::jsonb, $2, $3, now())
     on conflict (key) do update set secret_enc = excluded.secret_enc, updated_by = excluded.updated_by, updated_at = now()`,
    [key, enc, userId ?? null],
  );
}

export async function getSecretSetting(key: string): Promise<string | null> {
  const row = await one('select secret_enc from app_settings where key = $1', [key]);
  return row ? decryptSecret(row.secret_enc, 'setting:' + key) : null;
}

export async function hasSecretSetting(key: string): Promise<boolean> {
  const row = await one('select secret_enc is not null as has from app_settings where key = $1', [key]);
  return !!row?.has;
}

/** Security policy defaults; the Security screen edits these. */
export interface SecurityPolicy {
  requireMfa: boolean;
  ssoOnly: boolean;
  sessionIdleMinutes: number;
  blockExportOnProd: boolean;
  /** Settings → Safety: "Confirm destructive statements". */
  requireTypedConfirm: boolean;
  /** Settings → Safety: "Typed confirmation on prod connections" (every write on prod). */
  typedConfirmProd: boolean;
  /** Settings → Safety: "Block UPDATE / DELETE without WHERE". */
  blockWhereless: boolean;
  /** Settings → Safety: "Redact literal values in query history" (audit stores $1, $2...). */
  redactLiterals: boolean;
}

export const DEFAULT_POLICY: SecurityPolicy = {
  requireMfa: false,
  ssoOnly: false,
  sessionIdleMinutes: 8 * 60,
  blockExportOnProd: true,
  requireTypedConfirm: true,
  typedConfirmProd: true,
  blockWhereless: true,
  redactLiterals: false,
};

export async function getPolicy(): Promise<SecurityPolicy> {
  return { ...DEFAULT_POLICY, ...(await getSetting<Partial<SecurityPolicy>>('security.policy', {})) };
}
