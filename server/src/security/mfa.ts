import { generateSecret, generateURI, verifySync } from 'otplib';
import { one, q } from '../db/meta.ts';
import { encryptSecret, decryptSecret } from './crypto.ts';

export function newMfaSecret(email: string): { secret: string; uri: string } {
  const secret = generateSecret();
  return { secret, uri: generateURI({ secret, label: email, issuer: 'Comb' }) };
}

export function checkTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return verifySync({ secret, token: code, epochTolerance: 30 }).valid;
  } catch {
    return false;
  }
}

export async function verifyUserTotp(userId: string, code: string): Promise<boolean> {
  const row = await one('select mfa_secret_enc from users where id = $1 and mfa_enabled', [userId]);
  if (!row) return false;
  const secret = decryptSecret(row.mfa_secret_enc, 'user:' + userId + ':mfa');
  return !!secret && checkTotp(secret, code);
}

export async function storeMfaSecret(userId: string, secret: string, enabled: boolean): Promise<void> {
  await q('update users set mfa_secret_enc = $2, mfa_enabled = $3 where id = $1', [
    userId, encryptSecret(secret, 'user:' + userId + ':mfa'), enabled,
  ]);
}
