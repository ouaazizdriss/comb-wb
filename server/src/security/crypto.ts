import crypto from 'node:crypto';
import { config } from '../config.ts';

/*
 * Envelope encryption for stored secrets (database passwords, AI keys, MFA seeds).
 * Each secret gets a fresh data key; the data key is wrapped with the master key.
 * The associated data (e.g. "connection:<id>:password") binds the ciphertext to its
 * row, so a ciphertext copied into another row fails to decrypt.
 *
 * Layout v1: [1 byte version][12 iv][16 tag][48 wrapped dek (12 iv + 32 key... see below)]
 * Encoded as JSON for clarity and future rotation.
 */

interface Envelope {
  v: 1;
  wk: string; // wrapped data key: iv.tag.ciphertext, base64
  ct: string; // payload: iv.tag.ciphertext, base64
}

function gcmEncrypt(key: Buffer, plain: Buffer, aad: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

function gcmDecrypt(key: Buffer, packed: string, aad: string): Buffer {
  const [iv, tag, ct] = packed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function encryptSecret(plain: string, aad: string): Buffer {
  const dek = crypto.randomBytes(32);
  const env: Envelope = {
    v: 1,
    wk: gcmEncrypt(config.masterKey, dek, 'dek:' + aad),
    ct: gcmEncrypt(dek, Buffer.from(plain, 'utf8'), aad),
  };
  dek.fill(0);
  return Buffer.from(JSON.stringify(env), 'utf8');
}

export function decryptSecret(blob: Buffer | null | undefined, aad: string): string | null {
  if (!blob) return null;
  const env = JSON.parse(blob.toString('utf8')) as Envelope;
  if (env.v !== 1) throw new Error('unknown secret envelope version');
  const dek = gcmDecrypt(config.masterKey, env.wk, 'dek:' + aad);
  try {
    return gcmDecrypt(dek, env.ct, aad).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function hmacSha256(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
