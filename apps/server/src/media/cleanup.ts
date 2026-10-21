import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../db.js';
import { mediaDir } from './storage.js';

// Orphan cleanup for end-to-end encrypted chat media (media/encrypted/<uuid>.bin):
//  - after MIN_AGE, only live messages keep a file; deleted tombstones have no readable payload;
//  - a file without a DB row is removed only when its mtime is older than MIN_AGE (rows disappear by cascade
//    when a chat/group/channel is deleted, which leaves the file behind).
// Stickers, GIFs, avatars and attachments live in other folders/tables and are never touched here.
export const ENCRYPTED_MEDIA_MIN_AGE_MS = 48 * 3_600_000;
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/u;

export const cleanupEncryptedMedia = async (now = Date.now(), minAgeMs = ENCRYPTED_MEDIA_MIN_AGE_MS): Promise<{ rows: number; strays: number }> => {
  const cutoff = new Date(now - minAgeMs).toISOString();
  let rows = 0;
  let strays = 0;
  const candidates = await db.query<{ id: string; file_path: string }>(
    `SELECT em.id, em.file_path FROM encrypted_chat_media em
     WHERE em.created_at < $1 AND NOT EXISTS (
       SELECT 1 FROM messages m WHERE m.encrypted_media_id = em.id AND m.deleted_at IS NULL) LIMIT 500`,
    [cutoff]
  );
  for (const row of candidates.rows) {
    const client = await db.connect();
    let deleted = false;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE messages SET encrypted_media_id = NULL WHERE encrypted_media_id = $1 AND deleted_at IS NOT NULL', [row.id]);
      const result = await client.query(
        'DELETE FROM encrypted_chat_media WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.encrypted_media_id = $1)',
        [row.id]
      );
      deleted = result.rowCount === 1;
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
    } finally { client.release(); }
    if (deleted) { await rm(join(mediaDir, row.file_path), { force: true }); rows += 1; }
  }
  const names = await readdir(join(mediaDir, 'encrypted')).catch(() => [] as string[]);
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    const file = join(mediaDir, 'encrypted', name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.mtimeMs > now - minAgeMs) continue;
    const known = await db.query('SELECT 1 FROM encrypted_chat_media WHERE file_path = $1', [`encrypted/${name}`]);
    if (known.rowCount === 0) { await rm(file, { force: true }); strays += 1; }
  }
  return { rows, strays };
};
