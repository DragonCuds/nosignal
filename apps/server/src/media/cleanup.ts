import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../db.js';
import { mediaDir } from './storage.js';

// Orphan cleanup for end-to-end encrypted chat media (media/encrypted/<uuid>.bin). Deliberately conservative:
//  - a DB row is removed only when NO message references it (any message, even a soft-deleted one, keeps it)
//    and it is older than MIN_AGE;
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
     WHERE em.created_at < $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.encrypted_media_id = em.id) LIMIT 500`,
    [cutoff]
  );
  for (const row of candidates.rows) {
    // Re-check in the delete itself so a message created meanwhile (or a FK restriction) wins.
    const deleted = await db.query(
      'DELETE FROM encrypted_chat_media WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.encrypted_media_id = $1)',
      [row.id]
    ).catch(() => null);
    if (deleted?.rowCount === 1) { await rm(join(mediaDir, row.file_path), { force: true }); rows += 1; }
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
