import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { config } from './config.js';
import { db, type DbClient } from './db.js';

const mb = 1024 * 1024;
const setting = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value * mb) : fallback;
};

export const userStorageLimit = (): number => setting('USER_QUOTA_MB', 2048 * mb);
const serverStorageLimit = (): number => setting('SERVER_STORAGE_QUOTA_MB', 20 * 1024 * mb);
const minFreeStorage = (): number => setting('MIN_FREE_STORAGE_MB', 512 * mb);
const MAX_INFLIGHT_PER_USER = 4;
const MAX_INFLIGHT_SERVER = 16;

export class StorageQuotaError extends Error {
  constructor(public readonly status: 409 | 413 | 429 | 503, message: string) { super(message); }
}

type Usage = { committed: number; chunks: number; reserved: number; active: number };
const usageSql = `SELECT
  (SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE uploader_id = $1 AND expired_at IS NULL)
    + (SELECT COALESCE(SUM(byte_size), 0) FROM encrypted_chat_media WHERE uploader_id = $1) AS committed,
  (SELECT COALESCE(SUM(total_bytes), 0) FROM attachment_uploads WHERE uploader_id = $1) AS chunks,
  (SELECT COALESCE(SUM(byte_size), 0) FROM storage_reservations WHERE user_id = $1) AS reserved,
  (SELECT COUNT(*) FROM storage_reservations WHERE user_id = $1)
    + (SELECT COUNT(*) FROM attachment_uploads WHERE uploader_id = $1) AS active`;
const globalSql = `SELECT
  (SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE expired_at IS NULL)
    + (SELECT COALESCE(SUM(byte_size), 0) FROM encrypted_chat_media)
    + (SELECT COALESCE(SUM(total_bytes), 0) FROM attachment_uploads)
    + (SELECT COALESCE(SUM(byte_size), 0) FROM storage_reservations) AS total,
  (SELECT COALESCE(SUM(total_bytes), 0) FROM attachment_uploads)
    + (SELECT COALESCE(SUM(byte_size), 0) FROM storage_reservations) AS inflight,
  (SELECT COUNT(*) FROM attachment_uploads)
    + (SELECT COUNT(*) FROM storage_reservations) AS active`;

const checkCapacity = async (client: DbClient, userId: string, bytes: number): Promise<void> => {
  const row = (await client.query<Usage>(usageSql, [userId])).rows[0];
  const used = Number(row.committed) + Number(row.chunks) + Number(row.reserved);
  if (used + bytes > userStorageLimit()) throw new StorageQuotaError(413, 'Storage quota exceeded');
  if (Number(row.active) >= MAX_INFLIGHT_PER_USER) throw new StorageQuotaError(429, 'Too many uploads in progress');
  const global = (await client.query<{ total: number; inflight: number; active: number }>(globalSql)).rows[0];
  if (Number(global.active) >= MAX_INFLIGHT_SERVER) throw new StorageQuotaError(503, 'Server has too many uploads in progress');
  if (Number(global.total) + bytes > serverStorageLimit()) throw new StorageQuotaError(503, 'Server storage quota exceeded');
  const fs = await statfs(config.dataDir);
  if (Number(fs.bavail) * Number(fs.bsize) - Number(global.inflight) - bytes < minFreeStorage()) {
    throw new StorageQuotaError(503, 'Server storage is low');
  }
};

const transaction = async <T>(work: (client: DbClient) => Promise<T>): Promise<T> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN'); // db.ts translates this to BEGIN IMMEDIATE, including across processes.
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
};

// Reserve before buffering/streaming. An expired reservation can be reclaimed after a crashed worker.
export const reserveStorage = async (userId: string, bytes: number, uploadId?: string): Promise<string> => {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new StorageQuotaError(413, 'Invalid upload size');
  const id = uploadId ?? randomUUID();
  await transaction(async (client) => {
    await client.query(`DELETE FROM storage_reservations WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
    if (uploadId && ((await client.query('SELECT 1 FROM attachments WHERE id = $1', [id])).rowCount
      || (await client.query('SELECT 1 FROM attachment_uploads WHERE id = $1', [id])).rowCount
      || (await client.query('SELECT 1 FROM storage_reservations WHERE id = $1', [id])).rowCount)) {
      throw new StorageQuotaError(409, 'Upload id already used');
    }
    await checkCapacity(client, userId, bytes);
    await client.query(`INSERT INTO storage_reservations (id, user_id, byte_size, expires_at)
      VALUES ($1, $2, $3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 hours'))`, [id, userId, bytes]);
  });
  return id;
};

export const releaseStorage = async (id: string): Promise<void> => {
  await db.query('DELETE FROM storage_reservations WHERE id = $1', [id]);
};

// Insert the committed row and release its reservation in the same transaction.
export const commitStorage = async (id: string, bytes: number, insert: (client: DbClient) => Promise<void>): Promise<void> => {
  await transaction(async (client) => {
    const reservation = (await client.query<{ byte_size: number }>('SELECT byte_size FROM storage_reservations WHERE id = $1', [id])).rows[0];
    if (!reservation || bytes > Number(reservation.byte_size)) throw new Error('Storage reservation missing or too small');
    await insert(client);
    await client.query('DELETE FROM storage_reservations WHERE id = $1', [id]);
  });
};

// Chunk uploads reserve their declared total in attachment_uploads; creation must use the same lock/check.
export const reserveChunkStorage = async (id: string, chatId: string, userId: string, total: number, count: number): Promise<void> => {
  await transaction(async (client) => {
    if ((await client.query('SELECT 1 FROM attachment_uploads WHERE id = $1', [id])).rowCount) return;
    await client.query(`DELETE FROM storage_reservations WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
    if ((await client.query('SELECT 1 FROM attachments WHERE id = $1', [id])).rowCount
      || (await client.query('SELECT 1 FROM storage_reservations WHERE id = $1', [id])).rowCount) {
      throw new StorageQuotaError(409, 'Upload id already used');
    }
    await checkCapacity(client, userId, total);
    await client.query(`INSERT INTO attachment_uploads (id, chat_id, uploader_id, total_bytes, chunk_count)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`, [id, chatId, userId, total, count]);
  });
};

// Move a chunked upload from reserved to committed bytes without a double-counting window.
export const commitChunkStorage = async (id: string, total: number, insert: (client: DbClient) => Promise<void>): Promise<void> => {
  await transaction(async (client) => {
    const upload = (await client.query<{ total_bytes: number }>(
      'SELECT total_bytes FROM attachment_uploads WHERE id = $1 AND finalizing = 1', [id])).rows[0];
    if (!upload || Number(upload.total_bytes) !== total) throw new Error('Chunk reservation missing or changed');
    await insert(client);
    await client.query('DELETE FROM attachment_uploads WHERE id = $1', [id]);
  });
};
