import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

// Legacy key (v1): still used for recovery-code hashes and to read secrets not yet migrated.
const key = createHash('sha256').update('tel-messenger:mfa:v1\0').update(config.sessionSecret).digest();
// MFA secret key (v2): HKDF-SHA256 with its own label.
const mfaKey = Buffer.from(hkdfSync('sha256', config.sessionSecret, 'tel-messenger', 'tel-messenger:mfa-secret:v2', 32));
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const encryptWith = (k: Buffer, value: string): Buffer => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
};

const decryptWith = (k: Buffer, value: Buffer): string => {
  if (value.length < 29) throw new Error('Invalid encrypted MFA secret');
  const decipher = createDecipheriv('aes-256-gcm', k, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
};

export const encryptMfaSecret = (value: string): Buffer => encryptWith(mfaKey, value);

/** Reads v2 blobs, and falls back to the legacy key so unmigrated rows keep working. */
export const decryptMfaSecret = (value: Buffer): string => {
  try {
    return decryptWith(mfaKey, value);
  } catch {
    return decryptWith(key, value);
  }
};

/** Test helper: a blob in the old (v1) format. */
export const encryptMfaSecretLegacy = (value: string): Buffer => encryptWith(key, value);

const isV2 = (value: Buffer): boolean => {
  try { decryptWith(mfaKey, value); return true; } catch { return false; }
};

/** Re-encrypts every legacy-key MFA secret with the HKDF key. Idempotent; returns rows changed. */
export const migrateMfaSecrets = async (): Promise<number> => {
  let changed = 0;
  for (const [table, column, idColumn] of [['user_security', 'totp_secret_enc', 'user_id'], ['mfa_enrollments', 'secret_enc', 'session_id']] as const) {
    const rows = await db.query<{ id: string; blob: Buffer | null }>(`SELECT ${idColumn} AS id, ${column} AS blob FROM ${table} WHERE ${column} IS NOT NULL`);
    for (const row of rows.rows) {
      if (!row.blob || isV2(row.blob)) continue;
      let plain: string;
      try { plain = decryptWith(key, row.blob); } catch { continue; }
      await db.query(`UPDATE ${table} SET ${column} = $1 WHERE ${idColumn} = $2`, [encryptMfaSecret(plain), row.id]);
      changed += 1;
    }
  }
  return changed;
};

export const generateTotpSecret = (): string => {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let offset = 0; offset < bits.length; offset += 5) {
    result += alphabet[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, '0'), 2)];
  }
  return result;
};

const decodeBase32 = (value: string): Buffer => {
  let bits = '';
  for (const char of value.toUpperCase().replace(/=+$/u, '')) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
};

export const totpForStep = (secret: string, step: number): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, '0');
};

export const verifyTotp = (secret: string, candidate: string, now = Date.now()): number | null => {
  if (!/^\d{6}$/u.test(candidate)) return null;
  const step = Math.floor(now / 30_000);
  const supplied = Buffer.from(candidate);
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(totpForStep(secret, step + drift));
    if (timingSafeEqual(expected, supplied)) return step + drift;
  }
  return null;
};

export const recoveryCodeHash = (code: string): string =>
  createHmac('sha256', key).update(`recovery\0${code.replace(/[^a-zA-Z0-9]/gu, '').toUpperCase()}`).digest('hex');

export const generateRecoveryCodes = (count = 10): string[] =>
  Array.from({ length: count }, () => {
    const raw = randomBytes(10).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`;
  });
