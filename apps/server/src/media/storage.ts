import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { db } from '../db.js';

export const dataDir = process.env.DATA_DIR || resolve(import.meta.dirname, '../../../../data');
export const mediaDir = join(dataDir, 'media');
export const tempDir = join(dataDir, '.media-tmp');

export const mediaUrl = (path: string | null): string | null => path ? `/media/${path}` : null;

export const contentPath = (kind: 'stickers' | 'gifs', bytes: Buffer, extension: string): string =>
  `${kind}/${createHash('sha256').update(bytes).digest('hex')}.${extension}`;

export const ensureStorage = async (): Promise<void> => {
  await Promise.all([mkdir(join(mediaDir, 'stickers'), { recursive: true }), mkdir(join(mediaDir, 'gifs'), { recursive: true }), mkdir(join(mediaDir, 'encrypted'), { recursive: true }), mkdir(tempDir, { recursive: true })]);
};

export const saveContent = async (relativePath: string, bytes: Buffer): Promise<void> => {
  const target = resolve(mediaDir, relativePath);
  if (!target.startsWith(`${mediaDir}/`)) throw new Error('Invalid media path');
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
};

export const moveContent = async (relativePath: string, temporaryFile: string): Promise<void> => {
  const target = resolve(mediaDir, relativePath);
  if (!target.startsWith(`${mediaDir}/`)) throw new Error('Invalid media path');
  await mkdir(resolve(target, '..'), { recursive: true });
  try {
    await rename(temporaryFile, target);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') await rm(temporaryFile, { force: true });
    else throw error;
  }
};

export const temporaryPath = (name: string): string => join(tempDir, basename(name));

export const MAX_PACKS_PER_USER = 20;
export const MAX_GIFS_PER_USER = 200;
export const MAX_MEDIA_BYTES_PER_USER = 50 * 1024 * 1024;

export class QuotaError extends Error {
  constructor(public readonly code: 'quota_packs' | 'quota_gifs' | 'quota_bytes', message: string) { super(message); }
}

export const mediaUsage = async (userId: string): Promise<{ packs: number; gifs: number; bytes: number }> => {
  const result = await db.query<{ packs: number; gifs: number; bytes: number }>(`SELECT
    (SELECT count(*) FROM sticker_packs WHERE owner_id = $1) AS packs,
    (SELECT count(*) FROM gifs WHERE owner_id = $1) AS gifs,
    (SELECT COALESCE(sum(s.byte_size), 0) FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE p.owner_id = $1)
      + (SELECT COALESCE(sum(byte_size), 0) FROM gifs WHERE owner_id = $1) AS bytes`, [userId]);
  const row = result.rows[0];
  return { packs: Number(row.packs), gifs: Number(row.gifs), bytes: Number(row.bytes) };
};

export const assertQuota = async (userId: string, add: { packs?: number; gifs?: number; bytes?: number }): Promise<void> => {
  const usage = await mediaUsage(userId);
  if (add.packs && usage.packs + add.packs > MAX_PACKS_PER_USER) throw new QuotaError('quota_packs', `You can keep at most ${MAX_PACKS_PER_USER} sticker packs. Delete a pack first.`);
  if (add.gifs && usage.gifs + add.gifs > MAX_GIFS_PER_USER) throw new QuotaError('quota_gifs', `You can keep at most ${MAX_GIFS_PER_USER} GIFs. Delete a GIF first.`);
  if (add.bytes && usage.bytes + add.bytes > MAX_MEDIA_BYTES_PER_USER) throw new QuotaError('quota_bytes', `Your sticker and GIF storage is limited to ${MAX_MEDIA_BYTES_PER_USER / 1024 / 1024} MB. Delete something first.`);
};

// Content files are shared by hash; remove one only when no row references it any more.
export const removeUnreferencedFiles = async (paths: string[]): Promise<void> => {
  for (const path of new Set(paths.filter(Boolean))) {
    const used = await db.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM stickers WHERE file_path = $1)
      OR EXISTS (SELECT 1 FROM sticker_packs WHERE thumb_path = $1)
      OR EXISTS (SELECT 1 FROM gifs WHERE mp4_path = $1 OR poster_path = $1)`, [path]);
    if (used.rowCount === 1) continue;
    const target = resolve(mediaDir, path);
    if (target.startsWith(`${mediaDir}/`)) await rm(target, { force: true });
  }
};
