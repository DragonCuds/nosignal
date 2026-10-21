import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

const LEGACY_ID = 'legacy-session-v1';
type ChannelKeyRow = { id: string; key_id: string; key_wrapped: string };

const parseKeyring = (): Map<string, Buffer> => {
  const keys = new Map<string, Buffer>();
  const value = config.channelKeyring;
  if (!value) return keys;
  for (const entry of value.split(',')) {
    const match = /^([a-zA-Z0-9_-]{1,48}):([a-zA-Z0-9_-]{43})$/.exec(entry.trim());
    if (!match || match[1] === LEGACY_ID || keys.has(match[1])) throw new Error('Invalid CHANNEL_KEYRING entry');
    const key = Buffer.from(match[2], 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== match[2]) throw new Error('CHANNEL_KEYRING keys must be 32 base64url bytes');
    keys.set(match[1], key);
  }
  return keys;
};

const keyring = parseKeyring();
const activeId = config.channelActiveKeyId;
if (activeId && !keyring.has(activeId)) throw new Error('CHANNEL_ACTIVE_KEY_ID is absent from CHANNEL_KEYRING');
if (keyring.size && !activeId) throw new Error('CHANNEL_ACTIVE_KEY_ID is required with CHANNEL_KEYRING');
if (activeId && !/^[a-zA-Z0-9_-]{1,48}$/.test(activeId)) throw new Error('Invalid CHANNEL_ACTIVE_KEY_ID');
if (config.isProduction && !activeId) throw new Error('CHANNEL_KEYRING and CHANNEL_ACTIVE_KEY_ID are required in production');

const legacyKey = createHash('sha256').update(`tel:channel-key:v1\0${config.sessionSecret}`).digest();
const keyFor = (id: string): Buffer => {
  const key = id === LEGACY_ID ? legacyKey : keyring.get(id);
  if (!key) throw new Error(`Channel wrapping key ${id} is unavailable`);
  return key;
};

export const wrapChannelKey = (plain: Buffer): { keyId: string; wrapped: string } => {
  if (!activeId) throw new Error('CHANNEL_KEYRING and CHANNEL_ACTIVE_KEY_ID are required to create channels');
  if (plain.length !== 32) throw new Error('Invalid channel key length');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(activeId), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { keyId: activeId, wrapped: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url') };
};

export const unwrapChannelKey = (keyId: string, wrapped: string): Buffer => {
  const raw = Buffer.from(wrapped, 'base64url');
  if (raw.length !== 60 || raw.toString('base64url') !== wrapped) throw new Error('Invalid wrapped channel key');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(keyId), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  if (plain.length !== 32) throw new Error('Invalid channel key length');
  return plain;
};

/** Rewraps rows one at a time. A crash leaves committed rows readable and a rerun resumes. */
export const migrateChannelKeys = async (): Promise<number> => {
  const rows = await db.query<ChannelKeyRow>('SELECT id, key_id, key_wrapped FROM channels ORDER BY id');
  if (rows.rowCount && !activeId) throw new Error('CHANNEL_KEYRING and CHANNEL_ACTIVE_KEY_ID are required for existing channels');
  let changed = 0;
  for (const row of rows.rows) {
    const plain = unwrapChannelKey(row.key_id, row.key_wrapped);
    if (row.key_id === activeId) continue;
    const replacement = wrapChannelKey(plain);
    if (!timingSafeEqual(plain, unwrapChannelKey(replacement.keyId, replacement.wrapped))) throw new Error('Channel key rewrap verification failed');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        'UPDATE channels SET key_id = $1, key_wrapped = $2 WHERE id = $3 AND key_id = $4 AND key_wrapped = $5',
        [replacement.keyId, replacement.wrapped, row.id, row.key_id, row.key_wrapped]
      );
      if (updated.rowCount !== 1) throw new Error(`Channel ${row.id} changed during key migration`);
      await client.query('COMMIT');
      changed += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return changed;
};
