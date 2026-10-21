import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { assertQuota, ensureStorage, MAX_PACKS_PER_USER, PACK_COUNT_SQL, packQuotaMessage, QuotaError, saveContent, temporaryPath } from './storage.js';
import { validateTgs, validateWebmSticker, validateWebpSticker } from './validation.js';

const execFileAsync = promisify(execFile);
const supported = new Set(['.tgs', '.webm', '.webp']);
const maxZipBytes = 12 * 1024 * 1024;
const maxManifestBytes = 64 * 1024;
const maxStickerBytes = 512 * 1024;
const maxPackExpandedBytes = 32 * 1024 * 1024;
const maxStickerCount = 120;

type ManifestItem = { file?: string; emoji?: string; sort?: number };
type Manifest = { slug?: string; title?: string; stickers?: ManifestItem[]; thumb?: string };
type ImportedSticker = { byteSize: number; filePath: string; format: 'tgs' | 'webm' | 'webp'; emoji: string; sort: number; w: number; h: number };

const safeSlug = (input: string): string => {
  const slug = input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug || slug.length > 80) throw new Error('Pack slug must contain 1–80 letters, numbers, or hyphens');
  return slug;
};

const zipEntries = async (zipPath: string): Promise<string[]> => {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-Z1', zipPath], { maxBuffer: 512 * 1024, timeout: 10_000, killSignal: 'SIGKILL' });
  const names = stdout.split(/\r?\n/).filter(Boolean);
  if (!names.length || names.length > 200) throw new Error('The zip must contain 1–200 files');
  if (new Set(names).size !== names.length) throw new Error('The zip contains duplicate entries');
  if (names.some((name) => name.split('/').includes('..') || name.startsWith('/') || name.includes('\\') || /[\0-\x1f*?\[]/.test(name))) throw new Error('Unsafe zip entry');
  return names.filter((name) => !name.endsWith('/'));
};

const readZipEntry = async (zipPath: string, name: string, maxBytes: number): Promise<Buffer> => {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', zipPath, name], {
    encoding: 'buffer', maxBuffer: maxBytes, timeout: 10_000, killSignal: 'SIGKILL'
  });
  if (stdout.length > maxBytes) throw new Error('Zip entry is too large');
  return stdout;
};

const parseManifest = async (zipPath: string, entries: string[]): Promise<Manifest> => {
  const manifestName = entries.find((entry) => entry.toLowerCase() === 'pack.json');
  if (!manifestName) return {};
  try {
    const value = JSON.parse((await readZipEntry(zipPath, manifestName, maxManifestBytes)).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Manifest;
  } catch { throw new Error('pack.json must be valid JSON'); }
};

export const importStickerPack = async (zipPath: string, ownerId: string, overrides: { slug?: string; title?: string } = {}): Promise<{ id: string; slug: string; title: string; count: number }> => {
  await ensureStorage();
  await assertQuota(ownerId, { packs: 1 });
  if ((await stat(zipPath)).size > maxZipBytes) throw new Error('Sticker pack uploads are limited to 12 MB');
  const entries = await zipEntries(zipPath);
  const manifest = await parseManifest(zipPath, entries);
  const assetNames = entries.filter((entry) => supported.has(extname(entry).toLowerCase()));
  if (!assetNames.length) throw new Error('The zip contains no .tgs, .webm, or .webp stickers');
  if (assetNames.length > maxStickerCount) throw new Error(`A sticker pack may contain at most ${maxStickerCount} stickers`);
  const title = (overrides.title || manifest.title || basename(zipPath, extname(zipPath))).trim();
  if (!title || title.length > 120) throw new Error('Pack title must be 1–120 characters');
  const slug = safeSlug(overrides.slug || manifest.slug || title);
  const metadata = new Map((manifest.stickers ?? []).filter((item) => item.file).map((item) => [item.file!.replace(/\\/g, '/'), item]));
  const stickers: ImportedSticker[] = [];
  const stickersByPath = new Map<string, ImportedSticker>();
  const stickersBySourceName = new Map<string, ImportedSticker>();
  let expandedBytes = 0;
  const pendingFiles: Array<[string, Buffer]> = [];
  for (let index = 0; index < assetNames.length; index += 1) {
    const name = assetNames[index];
    const bytes = await readZipEntry(zipPath, name, maxStickerBytes);
    expandedBytes += bytes.length;
    if (expandedBytes > maxPackExpandedBytes) throw new Error('The expanded sticker pack is too large');
    const extension = extname(name).toLowerCase().slice(1) as ImportedSticker['format'];
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const isWebm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    const isWebp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if ((extension === 'tgs' && !isGzip) || (extension === 'webm' && !isWebm) || (extension === 'webp' && !isWebp)) {
      throw new Error(`Sticker content does not match its .${extension} extension`);
    }
    const temporary = temporaryPath(`${randomUUID()}${extname(name)}`);
    let dimensions: { w: number; h: number };
    try {
      if (extension === 'tgs') dimensions = validateTgs(bytes);
      else {
        await writeFile(temporary, bytes);
        dimensions = extension === 'webm' ? await validateWebmSticker(temporary, bytes.length) : await validateWebpSticker(temporary, bytes.length);
      }
    } finally { await rm(temporary, { force: true }); }
    const filePath = `stickers/${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    const duplicate = stickersByPath.get(filePath);
    if (duplicate) {
      stickersBySourceName.set(name, duplicate);
      continue;
    }
    pendingFiles.push([filePath, bytes]);
    const item = metadata.get(name);
    const sticker = { byteSize: bytes.length, filePath, format: extension, emoji: typeof item?.emoji === 'string' ? item.emoji.slice(0, 32) : '', sort: typeof item?.sort === 'number' && Number.isInteger(item.sort) ? item.sort : index, ...dimensions };
    stickers.push(sticker);
    stickersByPath.set(filePath, sticker);
    stickersBySourceName.set(name, sticker);
  }
  await assertQuota(ownerId, { bytes: stickers.reduce((sum, sticker) => sum + sticker.byteSize, 0) });
  for (const [filePath, bytes] of pendingFiles) await saveContent(filePath, bytes);
  const thumbName = typeof manifest.thumb === 'string' ? manifest.thumb : assetNames[0];
  const thumb = stickersBySourceName.get(thumbName) ?? stickers[0];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query<{ n: number }>(`SELECT ${PACK_COUNT_SQL} AS n`, [ownerId]);
    if (Number(owned.rows[0].n) >= MAX_PACKS_PER_USER) throw new QuotaError('quota_packs', packQuotaMessage);
    // slug is globally unique; never reveal that another user has the same one, just make ours distinct.
    let finalSlug = slug;
    if ((await client.query('SELECT 1 FROM sticker_packs WHERE slug = $1', [finalSlug])).rowCount) {
      finalSlug = `${slug.slice(0, 70)}-${randomUUID().slice(0, 8)}`;
    }
    const pack = await client.query<{ id: string }>('INSERT INTO sticker_packs (slug, title, thumb_path, owner_id) VALUES ($1, $2, $3, $4) RETURNING id', [finalSlug, title, thumb.filePath, ownerId]);
    const packId = pack.rows[0].id;
    for (const sticker of stickers) await client.query(
      'INSERT INTO stickers (pack_id, file_path, format, emoji, w, h, sort, byte_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [packId, sticker.filePath, sticker.format, sticker.emoji, sticker.w, sticker.h, sticker.sort, sticker.byteSize]
    );
    await client.query('INSERT INTO user_sticker_packs (user_id, pack_id, sort) VALUES ($1, $2, COALESCE((SELECT max(sort) + 1 FROM user_sticker_packs WHERE user_id = $1), 0))', [ownerId, packId]);
    await client.query('COMMIT');
    return { id: packId, slug: finalSlug, title, count: stickers.length };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

const cli = async (): Promise<void> => {
  const [zipPath, ownerId, slug, title] = process.argv.slice(2);
  if (!zipPath || !ownerId) throw new Error('Usage: tsx src/media/import-pack.ts <pack.zip> <owner-id> [slug] [title]');
  process.stdout.write(`${JSON.stringify(await importStickerPack(zipPath, ownerId, { slug, title }))}\n`);
};

if (process.argv[1]?.endsWith('import-pack.ts') || process.argv[1]?.endsWith('import-pack.js')) {
  cli().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => db.end());
}
