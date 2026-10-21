import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../auth.js';
import { db } from '../db.js';
import { cleanupEncryptedMedia } from './cleanup.js';
import { importStickerPack } from './import-pack.js';
import { getTelegramImport, publicJob, startTelegramImport, telegramImportEnabled } from './telegram-import.js';
import { assertQuota, contentPath, ensureStorage, mediaDir, mediaUrl, moveContent, QuotaError, removeUnreferencedFiles, temporaryPath } from './storage.js';
import { probeMedia } from './validation.js';

const execFileAsync = promisify(execFile);
const MAX_GIF_BYTES = 10 * 1024 * 1024;
const MAX_PACK_BYTES = 12 * 1024 * 1024;
const MAX_GIF_DURATION_MS = 30_000;
const MAX_GIF_DIMENSION = 4_096;
const MAX_GIF_PIXELS = 8_388_608;
const MAX_GENERATED_BYTES = 20 * 1024 * 1024;
const MAX_ENCRYPTED_MEDIA_BYTES = 25 * 1024 * 1024 + 16;
const MEDIA_READ_RATE_LIMIT = { max: 600, timeWindow: '1 minute' } as const;
const MEDIA_WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
// Per authenticated user (never per IP: CGNAT/proxy users would share one bucket), evaluated after requireUser.
const userKey = (request: FastifyRequest): string => request.user ? `u:${request.user.id}` : `ip:${request.ip}`;
const tooMany = (_request: FastifyRequest, context: { after: string; ttl: number }) =>
  Object.assign(new Error(`Too many uploads. Try again in ${Math.max(1, Math.ceil(context.ttl / 1000))} s.`), {
    statusCode: 429, code: 'RATE_LIMITED', retryAfter: Math.max(1, Math.ceil(context.ttl / 1000))
  });
const MEDIA_UPLOAD_RATE_LIMIT = { max: 30, timeWindow: '1 hour', hook: 'preHandler', keyGenerator: userKey, errorResponseBuilder: tooMany } as const;
// Every sticker/GIF/image send is one encrypted upload: small blobs get a generous bucket, big ones (video/files) a stricter one.
const SMALL_MEDIA_BYTES = 2 * 1024 * 1024;
const isBigUpload = (request: FastifyRequest): boolean => {
  const length = Number(request.headers['content-length']);
  return !Number.isFinite(length) || length > SMALL_MEDIA_BYTES;
};
const ENCRYPTED_MEDIA_RATE_LIMIT = {
  max: (request: FastifyRequest) => isBigUpload(request) ? 20 : 120,
  timeWindow: '10 minutes',
  hook: 'preHandler',
  keyGenerator: (request: FastifyRequest) => `${userKey(request)}:${isBigUpload(request) ? 'big' : 'small'}`,
  errorResponseBuilder: tooMany
} as const;
const mimeTypes: Record<string, string> = { '.tgs': 'application/gzip', '.webm': 'video/webm', '.webp': 'image/webp', '.mp4': 'video/mp4' };

type PackRow = { id: string; slug: string; title: string; thumb_path: string | null };
type StickerRow = { id: string; pack_id: string; file_path: string; format: 'tgs' | 'webm' | 'webp'; emoji: string; w: number; h: number; sort: number };
type GifRow = { id: string; mp4_path: string; poster_path: string; w: number; h: number; duration_ms: number; tags: string[] };

const packOutput = (pack: PackRow) => ({ id: pack.id, slug: pack.slug, title: pack.title, thumbUrl: mediaUrl(pack.thumb_path) });
const stickerOutput = (sticker: StickerRow) => ({ id: sticker.id, packId: sticker.pack_id, fileUrl: mediaUrl(sticker.file_path), format: sticker.format, emoji: sticker.emoji, w: sticker.w, h: sticker.h, sort: sticker.sort });
const gifOutput = (gif: GifRow) => ({ id: gif.id, mp4Url: mediaUrl(gif.mp4_path), posterUrl: mediaUrl(gif.poster_path), w: gif.w, h: gif.h, durationMs: gif.duration_ms, tags: gif.tags });
const parseId = (value: unknown): string | null => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;

const errorStatus = (error: unknown): number => error instanceof QuotaError ? 413 : 400;
const errorBody = (error: unknown, fallback: string) => ({ error: error instanceof Error ? error.message : fallback, ...(error instanceof QuotaError ? { code: error.code } : {}) });

// SQL: sticker row `s` is visible to user `$N` when they own its pack or a live message in one of their chats shows it.
const stickerVisible = (user: string, sticker = 's'): string => `(
  EXISTS (SELECT 1 FROM sticker_packs sp WHERE sp.id = ${sticker}.pack_id AND sp.owner_id = ${user})
  OR EXISTS (
    SELECT 1 FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id
    WHERE cm.user_id = ${user} AND m.deleted_at IS NULL
      AND m.kind = 'sticker' AND CAST(json_extract(m.payload, '$.stickerId') AS TEXT) = CAST(${sticker}.id AS TEXT)
  ))`;
const gifVisible = (user: string, gif = 'g'): string => `(
  ${gif}.owner_id = ${user}
  OR EXISTS (SELECT 1 FROM saved_gifs sg WHERE sg.gif_id = ${gif}.id AND sg.user_id = ${user})
  OR EXISTS (
    SELECT 1 FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id
    WHERE cm.user_id = ${user} AND m.deleted_at IS NULL
      AND m.kind = 'gif' AND CAST(json_extract(m.payload, '$.gifId') AS TEXT) = CAST(${gif}.id AS TEXT)
  ))`;
const oneUpload = async (request: FastifyRequest, allowedExtensions: string[], maxBytes: number): Promise<{ filename: string; tempPath: string; fields: Record<string, { value?: unknown }> }> => {
  const upload = await request.file({ limits: { files: 1, fileSize: maxBytes } });
  if (!upload) throw new Error('A file is required');
  const extension = extname(upload.filename).toLowerCase();
  if (!allowedExtensions.includes(extension)) throw new Error(`Expected ${allowedExtensions.join(', ')}`);
  const bytes = await upload.toBuffer();
  if (upload.file.truncated) throw new Error(`The upload exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  if (!bytes.length || bytes.length > maxBytes) throw new Error('The upload is empty or too large');
  const isZip = bytes.subarray(0, 2).toString('ascii') === 'PK';
  const isGif = bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  const isMp4 = bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if ((extension === '.zip' && !isZip) || (extension === '.gif' && !isGif) || (extension === '.mp4' && !isMp4)) {
    throw new Error(`Upload content does not match its ${extension} extension`);
  }
  await ensureStorage();
  const tempPath = temporaryPath(`${randomUUID()}${extension}`);
  await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 });
  return { filename: upload.filename, tempPath, fields: upload.fields as Record<string, { value?: unknown }> };
};

const ffmpeg = async (input: string, mp4: string, poster: string): Promise<void> => {
  const options = { maxBuffer: 256 * 1024, timeout: 45_000, killSignal: 'SIGKILL' as const };
  const head = ['-nostdin', '-y', '-i', input, '-map', '0:v:0', '-an', '-t', '30', '-vf', 'scale=min(480\\,iw):-2'];
  const tail = ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  try {
    await execFileAsync('/usr/bin/ffmpeg', [...head, '-c:v', 'libx264', ...tail, '-preset', 'veryfast', '-crf', '23', mp4], options);
  } catch {
    // LGPL ffmpeg builds (the bundled one) have no libx264: fall back to OpenH264, same H.264/MP4 output
    await execFileAsync('/usr/bin/ffmpeg', [...head, '-c:v', 'libopenh264', ...tail, '-b:v', '1M', mp4], options);
  }
  await execFileAsync('/usr/bin/ffmpeg', ['-nostdin', '-y', '-i', mp4, '-frames:v', '1', '-c:v', 'libwebp', '-q:v', '80', poster], options);
};

const parseTags = (value: unknown): string[] => typeof value === 'string'
  ? [...new Set(value.split(',').map((tag) => tag.trim().toLowerCase()).filter((tag) => /^[\p{L}\p{N}_-]{1,40}$/u.test(tag)))].slice(0, 12)
  : [];

export const registerMediaRoutes = async (app: FastifyInstance): Promise<void> => {
  await ensureStorage();
  // Hourly (and once shortly after start) removal of encrypted media nobody references; see cleanup.ts.
  const sweep = (): void => { cleanupEncryptedMedia().catch((error: unknown) => app.log.warn({ err: error }, 'encrypted media cleanup failed')); };
  const sweepTimer = setInterval(sweep, 3_600_000);
  const sweepFirst = setTimeout(sweep, 120_000);
  sweepTimer.unref(); sweepFirst.unref();
  app.addHook('onClose', async () => { clearInterval(sweepTimer); clearTimeout(sweepFirst); });
  await app.register(fastifyMultipart, { limits: { files: 1, fileSize: MAX_PACK_BYTES, fieldSize: 2_048, fields: 4, parts: 5 } });

  app.post<{ Params: { id: string } }>('/api/chats/:id/encrypted-media', {
    preHandler: requireUser,
    config: { rateLimit: ENCRYPTED_MEDIA_RATE_LIMIT }
  }, async (request, reply) => {
    const chatId = parseId(request.params.id);
    if (!chatId) return reply.code(400).send({ error: 'Invalid chat id' });
    const membership = await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, request.user!.id]);
    if (membership.rowCount !== 1) return reply.code(404).send({ error: 'Chat not found' });
    const upload = await request.file({ limits: { files: 1, fileSize: MAX_ENCRYPTED_MEDIA_BYTES, fields: 0, parts: 1 } });
    if (!upload || upload.mimetype !== 'application/octet-stream') return reply.code(400).send({ error: 'Encrypted media blob is required' });
    const bytes = await upload.toBuffer();
    if (upload.file.truncated || bytes.length < 17 || bytes.length > MAX_ENCRYPTED_MEDIA_BYTES) return reply.code(413).send({ error: 'Encrypted media is empty or too large' });
    const id = randomUUID();
    const relativePath = `encrypted/${id}.bin`;
    await ensureStorage();
    const file = resolve(mediaDir, relativePath);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await db.query(
        'INSERT INTO encrypted_chat_media (id, chat_id, uploader_id, file_path, byte_size) VALUES ($1, $2, $3, $4, $5)',
        [id, chatId, request.user!.id, relativePath, bytes.length]
      );
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string } }>('/api/encrypted-media/:id', {
    preHandler: requireUser,
    config: { rateLimit: MEDIA_READ_RATE_LIMIT }
  }, async (request, reply) => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.params.id)) return reply.code(404).send({ error: 'Not found' });
    const result = await db.query<{ file_path: string; byte_size: number }>(
      `SELECT em.file_path, em.byte_size
       FROM encrypted_chat_media em
       JOIN chat_members cm ON cm.chat_id = em.chat_id AND cm.user_id = $2
       WHERE em.id = $1
         AND (EXISTS (SELECT 1 FROM messages m WHERE m.encrypted_media_id = em.id AND m.deleted_at IS NULL)
           OR (em.uploader_id = $2 AND em.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')))`,
      [request.params.id, request.user!.id]
    );
    const media = result.rows[0];
    if (!media || !/^encrypted\/[a-f0-9-]{36}\.bin$/.test(media.file_path)) return reply.code(404).send({ error: 'Not found' });
    const file = resolve(mediaDir, media.file_path);
    if (!file.startsWith(`${mediaDir}/`)) return reply.code(404).send({ error: 'Not found' });
    try {
      const details = await stat(file);
      if (!details.isFile() || details.size !== media.byte_size) throw new Error('Invalid encrypted media');
      return reply.headers({
        'Cache-Control': 'private, no-store',
        'Content-Length': details.size,
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin'
      }).type('application/octet-stream').send(createReadStream(file));
    } catch { return reply.code(404).send({ error: 'Not found' }); }
  });

  app.get('/media/*', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async (request, reply) => {
    const path = (request.params as { '*': string })['*'];
    if (!path || !/^(?:stickers|gifs)\/[a-f0-9]{64}\.(?:tgs|webm|webp|mp4)$/.test(path)) return reply.code(404).send({ error: 'Not found' });
    const file = resolve(mediaDir, path);
    if (!file.startsWith(`${mediaDir}/`)) return reply.code(404).send({ error: 'Not found' });
    try {
      const registered = await db.query(`SELECT 1
        WHERE EXISTS (SELECT 1 FROM stickers s WHERE s.file_path = $1 AND ${stickerVisible('$2')})
          OR EXISTS (SELECT 1 FROM sticker_packs p WHERE p.thumb_path = $1 AND (
            p.owner_id = $2 OR EXISTS (SELECT 1 FROM stickers s WHERE s.pack_id = p.id AND ${stickerVisible('$2')})))
          OR EXISTS (SELECT 1 FROM gifs g WHERE (g.mp4_path = $1 OR g.poster_path = $1) AND ${gifVisible('$2')})`, [path, request.user!.id]);
      if (registered.rowCount !== 1) return reply.code(404).send({ error: 'Not found' });
      const details = await stat(file);
      if (!details.isFile()) throw new Error('not a file');
      return reply
        .headers({
          'Cache-Control': 'private, no-store',
          'Content-Length': details.size,
          'Content-Disposition': 'inline',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin'
        })
        .type(mimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream')
        .send(createReadStream(file));
    } catch { return reply.code(404).send({ error: 'Not found' }); }
  });

  app.post('/api/media/packs/import', { preHandler: requireUser, config: { rateLimit: MEDIA_UPLOAD_RATE_LIMIT } }, async (request, reply) => {
    let upload: { filename: string; tempPath: string; fields: Record<string, { value?: unknown }> } | undefined;
    try {
      upload = await oneUpload(request, ['.zip'], MAX_PACK_BYTES);
      const pack = await importStickerPack(upload.tempPath, request.user!.id, {
        slug: typeof upload.fields.slug?.value === 'string' ? upload.fields.slug.value : undefined,
        title: typeof upload.fields.title?.value === 'string' ? upload.fields.title.value : basename(upload.filename, '.zip')
      });
      return reply.code(201).send(pack);
    } catch (error) { return reply.code(errorStatus(error)).send(errorBody(error, 'Unable to import pack'));
    } finally { if (upload) await rm(upload.tempPath, { force: true }); }
  });

  app.get('/api/stickers/import/telegram/status', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async () => ({ enabled: telegramImportEnabled() }));

  app.post<{ Body: { pack?: unknown } }>('/api/stickers/import/telegram', { preHandler: requireUser, config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const started = startTelegramImport(request.user!.id, request.body?.pack, (message) => request.log.error(message));
    if (!started.ok) return reply.code(started.status).send({ error: started.code, code: started.code });
    return reply.code(202).send(publicJob(started.job));
  });

  app.get<{ Params: { id: string } }>('/api/stickers/import/telegram/:id', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async (request, reply) => {
    const job = getTelegramImport(request.user!.id, request.params.id);
    if (!job) return reply.code(404).send({ error: 'not_found', code: 'not_found' });
    return publicJob(job);
  });

  app.get('/api/media/packs', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async (request) => {
    const result = await db.query<PackRow>(`SELECT p.id, p.slug, p.title, p.thumb_path FROM user_sticker_packs up
      JOIN sticker_packs p ON p.id = up.pack_id WHERE up.user_id = $1 AND p.owner_id = $1 ORDER BY up.sort, p.id`, [request.user!.id]);
    return result.rows.map(packOutput);
  });

  app.get<{ Params: { id: string } }>('/api/media/packs/:id', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async (request, reply) => {
    const packId = parseId(request.params.id);
    if (!packId) return reply.code(400).send({ error: 'Invalid pack id' });
    const pack = await db.query<PackRow>(`SELECT p.id, p.slug, p.title, p.thumb_path FROM sticker_packs p
      JOIN user_sticker_packs up ON up.pack_id = p.id WHERE p.id = $1 AND up.user_id = $2 AND p.owner_id = $2`, [packId, request.user!.id]);
    if (!pack.rows[0]) return reply.code(404).send({ error: 'Pack not found' });
    const stickers = await db.query<StickerRow>('SELECT id, pack_id, file_path, format, emoji, w, h, sort FROM stickers WHERE pack_id = $1 ORDER BY sort, id', [packId]);
    return { ...packOutput(pack.rows[0]), stickers: stickers.rows.map(stickerOutput) };
  });

  app.get('/api/media/stickers/recent', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async (request) => {
    const result = await db.query<StickerRow>(`SELECT s.id, s.pack_id, s.file_path, s.format, s.emoji, s.w, s.h, s.sort FROM recent_stickers r
      JOIN stickers s ON s.id = r.sticker_id WHERE r.user_id = $1 AND ${stickerVisible('$1')} ORDER BY r.used_at DESC LIMIT 50`, [request.user!.id]);
    return result.rows.map(stickerOutput);
  });

  app.post<{ Params: { id: string } }>('/api/media/stickers/:id/recent', { preHandler: requireUser, config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const stickerId = parseId(request.params.id);
    if (!stickerId) return reply.code(400).send({ error: 'Invalid sticker id' });
    const sticker = await db.query(`SELECT s.id FROM stickers s WHERE s.id = $1 AND ${stickerVisible('$2')}`, [stickerId, request.user!.id]);
    if (!sticker.rows[0]) return reply.code(404).send({ error: 'Sticker not found' });
    await db.query(`INSERT INTO recent_stickers (user_id, sticker_id, used_at) VALUES ($1, $2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (user_id, sticker_id) DO UPDATE SET used_at = EXCLUDED.used_at`, [request.user!.id, stickerId]);
    return reply.code(204).send();
  });

  app.post('/api/media/gifs/upload', { preHandler: requireUser, config: { rateLimit: MEDIA_UPLOAD_RATE_LIMIT } }, async (request, reply) => {
    let upload: { filename: string; tempPath: string; fields: Record<string, { value?: unknown }> } | undefined;
    let convertedMp4: string | undefined;
    let convertedPoster: string | undefined;
    try {
      await assertQuota(request.user!.id, { gifs: 1 });
      upload = await oneUpload(request, ['.gif', '.mp4'], MAX_GIF_BYTES);
      if ((await stat(upload.tempPath)).size > MAX_GIF_BYTES) throw new Error('GIF uploads are limited to 10 MB');
      const sourceInfo = await probeMedia(upload.tempPath);
      if (!sourceInfo.durationMs || sourceInfo.durationMs <= 0 || sourceInfo.durationMs > MAX_GIF_DURATION_MS) throw new Error('GIF uploads must be 30 seconds or shorter');
      if (sourceInfo.w > MAX_GIF_DIMENSION || sourceInfo.h > MAX_GIF_DIMENSION || sourceInfo.w * sourceInfo.h > MAX_GIF_PIXELS) throw new Error('GIF dimensions are too large');
      convertedMp4 = temporaryPath(`${randomUUID()}.mp4`);
      convertedPoster = temporaryPath(`${randomUUID()}.webp`);
      await ffmpeg(upload.tempPath, convertedMp4, convertedPoster);
      const [mp4Stat, posterStat] = await Promise.all([stat(convertedMp4), stat(convertedPoster)]);
      if (mp4Stat.size > MAX_GENERATED_BYTES || posterStat.size > MAX_GENERATED_BYTES) throw new Error('Converted GIF output is too large');
      const [info, mp4Bytes, posterBytes] = await Promise.all([probeMedia(convertedMp4), readFile(convertedMp4), readFile(convertedPoster)]);
      if (!info.durationMs || info.durationMs <= 0) throw new Error('The video duration could not be determined');
      await assertQuota(request.user!.id, { gifs: 1, bytes: mp4Bytes.length + posterBytes.length });
      const mp4Path = contentPath('gifs', mp4Bytes, 'mp4');
      const posterPath = contentPath('gifs', posterBytes, 'webp');
      await moveContent(mp4Path, convertedMp4); convertedMp4 = undefined;
      await moveContent(posterPath, convertedPoster); convertedPoster = undefined;
      const tags = parseTags(upload.fields.tags?.value);
      const result = await db.query<GifRow>(`INSERT INTO gifs (owner_id, mp4_path, poster_path, w, h, duration_ms, tags, byte_size)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, mp4_path, poster_path, w, h, duration_ms, tags`,
      [request.user!.id, mp4Path, posterPath, info.w, info.h, info.durationMs, JSON.stringify(tags), mp4Bytes.length + posterBytes.length]);
      return reply.code(201).send(gifOutput(result.rows[0]));
    } catch (error) { return reply.code(errorStatus(error)).send(errorBody(error, 'Unable to upload GIF'));
    } finally { await Promise.all([upload && rm(upload.tempPath, { force: true }), convertedMp4 && rm(convertedMp4, { force: true }), convertedPoster && rm(convertedPoster, { force: true })]); }
  });

  app.get<{ Querystring: { tag?: string } }>('/api/media/gifs', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async (request, reply) => {
    const tag = request.query.tag?.trim().toLowerCase();
    if (tag && !/^[\p{L}\p{N}_-]{1,40}$/u.test(tag)) return reply.code(400).send({ error: 'Invalid GIF tag' });
    const result = await db.query<GifRow>(`SELECT g.id, g.mp4_path, g.poster_path, g.w, g.h, g.duration_ms, g.tags
      FROM gifs g
      WHERE ($1 IS NULL OR EXISTS (SELECT 1 FROM json_each(g.tags) WHERE json_each.value = $1))
        AND (g.owner_id = $2 OR EXISTS (SELECT 1 FROM saved_gifs sg WHERE sg.gif_id = g.id AND sg.user_id = $2))
      ORDER BY g.id DESC LIMIT 100`, [tag || null, request.user!.id]);
    return result.rows.map(gifOutput);
  });

  app.get('/api/media/gifs/saved', { preHandler: requireUser, config: { rateLimit: MEDIA_READ_RATE_LIMIT } }, async (request) => {
    const result = await db.query<GifRow>(`SELECT g.id, g.mp4_path, g.poster_path, g.w, g.h, g.duration_ms, g.tags FROM saved_gifs sg
      JOIN gifs g ON g.id = sg.gif_id WHERE sg.user_id = $1 ORDER BY sg.created_at DESC`, [request.user!.id]);
    return result.rows.map(gifOutput);
  });

  app.put<{ Params: { id: string } }>('/api/media/gifs/:id/save', { preHandler: requireUser, config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const gifId = parseId(request.params.id);
    if (!gifId) return reply.code(400).send({ error: 'Invalid GIF id' });
    const accessible = await db.query(`SELECT 1 FROM gifs g WHERE g.id = $1 AND ${gifVisible('$2')}`, [gifId, request.user!.id]);
    if (!accessible.rows[0]) return reply.code(404).send({ error: 'GIF not found' });
    await db.query('INSERT INTO saved_gifs (user_id, gif_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [request.user!.id, gifId]);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/media/gifs/:id/save', { preHandler: requireUser, config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const gifId = parseId(request.params.id);
    if (!gifId) return reply.code(400).send({ error: 'Invalid GIF id' });
    await db.query('DELETE FROM saved_gifs WHERE user_id = $1 AND gif_id = $2', [request.user!.id, gifId]);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/media/packs/:id', { preHandler: requireUser, config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const packId = parseId(request.params.id);
    if (!packId) return reply.code(400).send({ error: 'Invalid pack id' });
    const owned = await db.query<{ thumb_path: string | null }>('SELECT thumb_path FROM sticker_packs WHERE id = $1 AND owner_id = $2', [packId, request.user!.id]);
    if (!owned.rows[0]) return reply.code(404).send({ error: 'Pack not found' });
    // Stickers already sent in chats must keep loading for those chats: then the pack is only released, not erased.
    const sent = await db.query(`SELECT 1 FROM stickers s JOIN messages m ON m.kind = 'sticker' AND m.deleted_at IS NULL
      AND CAST(json_extract(m.payload, '$.stickerId') AS TEXT) = CAST(s.id AS TEXT) WHERE s.pack_id = $1 LIMIT 1`, [packId]);
    await db.query('DELETE FROM user_sticker_packs WHERE pack_id = $1', [packId]);
    await db.query('DELETE FROM recent_stickers WHERE sticker_id IN (SELECT id FROM stickers WHERE pack_id = $1) AND user_id = $2', [packId, request.user!.id]);
    if (sent.rows[0]) {
      await db.query('UPDATE sticker_packs SET owner_id = NULL WHERE id = $1', [packId]);
    } else {
      const files = (await db.query<{ file_path: string }>('SELECT file_path FROM stickers WHERE pack_id = $1', [packId])).rows.map((row) => row.file_path);
      await db.query('DELETE FROM sticker_packs WHERE id = $1', [packId]);
      await removeUnreferencedFiles([...files, ...(owned.rows[0].thumb_path ? [owned.rows[0].thumb_path] : [])]);
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/media/gifs/:id', { preHandler: requireUser, config: { rateLimit: MEDIA_WRITE_RATE_LIMIT } }, async (request, reply) => {
    const gifId = parseId(request.params.id);
    if (!gifId) return reply.code(400).send({ error: 'Invalid GIF id' });
    const owned = await db.query<{ mp4_path: string; poster_path: string }>('SELECT mp4_path, poster_path FROM gifs WHERE id = $1 AND owner_id = $2', [gifId, request.user!.id]);
    if (!owned.rows[0]) return reply.code(404).send({ error: 'GIF not found' });
    await db.query('DELETE FROM saved_gifs WHERE gif_id = $1 AND user_id = $2', [gifId, request.user!.id]);
    const sent = await db.query(`SELECT 1 FROM messages m WHERE m.kind = 'gif' AND m.deleted_at IS NULL
      AND CAST(json_extract(m.payload, '$.gifId') AS TEXT) = $1 LIMIT 1`, [gifId]);
    const savedByOthers = await db.query('SELECT 1 FROM saved_gifs WHERE gif_id = $1 LIMIT 1', [gifId]);
    if (sent.rows[0] || savedByOthers.rows[0]) {
      // Still shown in someone's chat or library: release ownership only so those keep loading.
      await db.query('UPDATE gifs SET owner_id = NULL WHERE id = $1', [gifId]);
    } else {
      await db.query('DELETE FROM gifs WHERE id = $1', [gifId]);
      await removeUnreferencedFiles([owned.rows[0].mp4_path, owned.rows[0].poster_path]);
    }
    return reply.code(204).send();
  });
};
