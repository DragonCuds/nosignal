// Key backup: passphrase-encrypted export/import of the E2EE identity (M7.1).
// Standalone (no app imports) so it can be tested under node.
import type { BackupPins } from '../pins.js';

export type BackupPayload = {
  userId: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey; // ECDH P-256 private JWK
  groupKeys?: Record<string, string>; // optional: chatId -> base64url raw chat key
  /** Optional: this user's pin history per contact (contact id -> accepted fingerprints, oldest first, current last). Backups made before it exist without it. */
  pins?: BackupPins;
};
export type BackupFile = { app: 'tel-messenger-key-backup'; v: 1; kdf: 'PBKDF2-SHA256'; iter: number; salt: string; iv: string; ct: string };

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;
const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};
const fromB64 = (v: string): Uint8Array => {
  const p = v.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - v.length % 4) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};
const aad = (iter: number) => enc.encode(`tel:key-backup:v1:PBKDF2-SHA256:${iter}`);

const deriveKey = async (pass: string, salt: Uint8Array, iter: number, usage: KeyUsage): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
};

export const passphraseProblem = (pass: string): string | null =>
  pass.length < MIN_PASSPHRASE ? `رمز باید حداقل ${MIN_PASSPHRASE} نویسه باشد.` : null;

/** Encrypt the identity into a JSON string (save as .telkey file). */
export const encryptBackup = async (payload: BackupPayload, passphrase: string, iter = PBKDF2_ITERATIONS): Promise<string> => {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iter, 'encrypt');
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad(iter)) }, key, buf(enc.encode(JSON.stringify(payload))));
  const file: BackupFile = { app: 'tel-messenger-key-backup', v: 1, kdf: 'PBKDF2-SHA256', iter, salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
  return JSON.stringify(file);
};

/** Decrypt a backup file. Throws Error('bad-file') or Error('bad-passphrase'). */
export const decryptBackup = async (text: string, passphrase: string): Promise<BackupPayload> => {
  let f: BackupFile;
  try { f = JSON.parse(text) as BackupFile; } catch { throw new Error('bad-file'); }
  if (f?.app !== 'tel-messenger-key-backup' || f.v !== 1 || f.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(f.iter) || f.iter < 100_000 || f.iter > 10_000_000
    || typeof f.salt !== 'string' || typeof f.iv !== 'string' || typeof f.ct !== 'string') throw new Error('bad-file');
  let plain: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, fromB64(f.salt), f.iter, 'decrypt');
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromB64(f.iv)), additionalData: buf(aad(f.iter)) }, key, buf(fromB64(f.ct)));
  } catch { throw new Error('bad-passphrase'); }
  const p = JSON.parse(dec.decode(plain)) as BackupPayload;
  if (typeof p.userId !== 'string' || p.privateKey?.kty !== 'EC' || p.privateKey.crv !== 'P-256' || !p.privateKey.d || !p.publicKey?.x) throw new Error('bad-file');
  return p;
};

/** Generate an identity pair as exportable JWKs. The key is exportable on purpose, so it can be backed up; e2ee.ts then stores it via toExtractable (see there). */
// Newer Chromium adds key_ops/ext to exported public JWKs; the server accepts only kty/crv/x/y.
const slimPublic = (jwk: JsonWebKey): JsonWebKey => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

export const generateBackupablePair = async (): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: slimPublic(await crypto.subtle.exportKey('jwk', pair.publicKey)) };
};

/** Import a private JWK as a non-extractable CryptoKey. NOT what e2ee.ts stores: it uses toExtractable (below). Kept as a helper and covered by tests. */
export const toNonExtractable = (privateJwk: JsonWebKey): Promise<CryptoKey> =>
  crypto.subtle.importKey('jwk', { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

export const backupFileName = (userId: string): string => `tel-key-backup-${userId}.telkey`;

/**
 * Like toNonExtractable but the key can be exported again later. This is what e2ee.ts stores in IndexedDB for new and
 * restored identities (needed for the automatic server backup and the recovery key). Consequence: script running in
 * the same origin, or anyone with access to the browser profile, can export the private key.
 */
export const toExtractable = (privateJwk: JsonWebKey): Promise<CryptoKey> =>
  crypto.subtle.importKey('jwk', { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);

// ---- Automatic (password-protected) server backup -------------------------------------------------
// The key is derived in the browser from the login password; the server only stores the opaque result.
export type ServerBackupBlob = { salt: string; iterations: number; wrapped: string; version: 1 };
const serverAad = (iter: number, userId: string) => enc.encode(`tel:server-key-backup:v1:PBKDF2-SHA256:${iter}:${userId}`);

export const wrapForServer = async (payload: BackupPayload, password: string, iter = PBKDF2_ITERATIONS): Promise<ServerBackupBlob> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iter, 'encrypt');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(serverAad(iter, payload.userId)) }, key, buf(enc.encode(JSON.stringify(payload)))));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv); joined.set(ct, iv.length);
  return { salt: toB64(salt), iterations: iter, wrapped: toB64(joined), version: 1 };
};

/** Throws Error('bad-passphrase') for a wrong password / foreign blob and Error('bad-file') for a malformed one. */
export const unwrapFromServer = async (blob: ServerBackupBlob, password: string, userId: string): Promise<BackupPayload> => {
  if (!blob || blob.version !== 1 || !Number.isInteger(blob.iterations) || blob.iterations < 100_000 || blob.iterations > 10_000_000
    || typeof blob.salt !== 'string' || typeof blob.wrapped !== 'string') throw new Error('bad-file');
  let plain: ArrayBuffer;
  try {
    const joined = fromB64(blob.wrapped);
    const key = await deriveKey(password, fromB64(blob.salt), blob.iterations, 'decrypt');
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(joined.subarray(0, 12)), additionalData: buf(serverAad(blob.iterations, userId)) }, key, buf(joined.subarray(12)));
  } catch { throw new Error('bad-passphrase'); }
  const p = JSON.parse(dec.decode(plain)) as BackupPayload;
  if (p.userId !== userId || p.privateKey?.kty !== 'EC' || p.privateKey.crv !== 'P-256' || !p.privateKey.d || !p.publicKey?.x) throw new Error('bad-file');
  return p;
};

// ---- Recovery key (text form of the identity key, for "more security" mode) ------------------------
const RECOVERY_PREFIX = 'TELKEY1-';
export const toRecoveryKey = (payload: BackupPayload): string => {
  const body = toB64(enc.encode(JSON.stringify({ x: payload.publicKey.x, y: payload.publicKey.y, d: payload.privateKey.d })));
  return RECOVERY_PREFIX + (body.match(/.{1,8}/gu) ?? []).join(' ');
};
export const fromRecoveryKey = (text: string, userId: string): BackupPayload => {
  const compact = text.replace(/\s+/gu, '');
  if (!compact.startsWith(RECOVERY_PREFIX)) throw new Error('bad-file');
  let parsed: { x?: unknown; y?: unknown; d?: unknown };
  try { parsed = JSON.parse(dec.decode(fromB64(compact.slice(RECOVERY_PREFIX.length)))) as typeof parsed; } catch { throw new Error('bad-file'); }
  if (typeof parsed.x !== 'string' || typeof parsed.y !== 'string' || typeof parsed.d !== 'string') throw new Error('bad-file');
  return { userId, publicKey: { kty: 'EC', crv: 'P-256', x: parsed.x, y: parsed.y }, privateKey: { kty: 'EC', crv: 'P-256', x: parsed.x, y: parsed.y, d: parsed.d } };
};
