// Server side of chunked E2EE attachments (docs/ATTACHMENTS.md). Stores opaque ciphertext only.
// Simplified for a personal server: no tus; one authenticated streaming PUT, GET with HTTP Range.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { commitChunkStorage, commitStorage, releaseStorage, reserveChunkStorage, reserveStorage, StorageQuotaError, userStorageLimit } from '../storage-quota.js';

const CHUNK_SIZE = 262_144;
const TAG_BYTES = 16;
const FULL_CHUNK = CHUNK_SIZE + TAG_BYTES;
const ORPHAN_GRACE = '-1 hour';

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export type AttachmentLimits = { maxCipherBytes: number; quotaBytes: number; retentionDays: number | null };

export const attachmentLimits = (): AttachmentLimits => {
  const maxPlain = Math.floor(envNumber('MAX_ATTACHMENT_MB', 100) * 1024 * 1024);
  const chunks = Math.max(1, Math.ceil(maxPlain / CHUNK_SIZE));
  const retention = Number(process.env.ATTACHMENT_RETENTION_DAYS);
  return {
    maxCipherBytes: maxPlain + chunks * TAG_BYTES,
    quotaBytes: userStorageLimit(),
    retentionDays: Number.isFinite(retention) && retention > 0 ? retention : null
  };
};

export const attachmentsDir = (): string => join(config.dataDir, 'attachments');
const filePath = (id: string): string => join(attachmentsDir(), `${id}.bin`);
const partPath = (id: string): string => join(attachmentsDir(), `${id}.part`);

/** Total ciphertext length -> is it a well-formed chunk sequence (each chunk plain+16, last may be short)? */
export const validCipherLength = (n: number): boolean => {
  if (!Number.isSafeInteger(n) || n < TAG_BYTES) return false;
  const chunks = Math.ceil(n / FULL_CHUNK);
  const plain = n - chunks * TAG_BYTES;
  return plain >= 0 && Math.max(1, Math.ceil(plain / CHUNK_SIZE)) === chunks;
};

export type ByteRange = { start: number; end: number };
/** Single-range parser. null = no/ignored Range header; 'invalid' = 416. */
export const parseRange = (header: string | undefined, size: number): ByteRange | 'invalid' | null => {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || start > end) return 'invalid';
  return { start, end };
};

/** Hourly job: orphans (no live message after 1 h), stale temp files, optional retention. Returns counts. */
export const cleanupAttachments = async (): Promise<{ orphans: number; expired: number; strays: number; uploads: number }> => {
  const limits = attachmentLimits();
  let orphans = 0;
  let expired = 0;
  let strays = 0;
  let uploads = 0;
  const gone = async (id: string): Promise<void> => { await rm(filePath(id), { force: true }); };

  const orphanRows = await db.query<{ id: string }>(
    `SELECT a.id FROM attachments a
     WHERE a.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${ORPHAN_GRACE}')
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.attachment_id = a.id AND m.deleted_at IS NULL)`
  );
  for (const row of orphanRows.rows) {
    await gone(row.id);
    await db.query('DELETE FROM attachments WHERE id = $1', [row.id]);
    orphans++;
  }

  if (limits.retentionDays) {
    const old = await db.query<{ id: string }>(
      `SELECT id FROM attachments WHERE expired_at IS NULL
         AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || $1 || ' days')`,
      [limits.retentionDays]
    );
    for (const row of old.rows) {
      await gone(row.id);
      await db.query(`UPDATE attachments SET expired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1`, [row.id]);
      expired++;
    }
  }

  // A worker may crash after renaming a complete file but before committing its row.
  // Recover that state before stale-upload cleanup releases the reserved bytes.
  const interrupted = await db.query<{ id: string; chat_id: string; uploader_id: string; total_bytes: number }>(
    `SELECT id, chat_id, uploader_id, total_bytes FROM attachment_uploads WHERE finalizing = 1
       AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')`
  );
  for (const upload of interrupted.rows) {
    const total = Number(upload.total_bytes);
    const committed = await db.query<{ chat_id: string; uploader_id: string; byte_size: number }>(
      'SELECT chat_id, uploader_id, byte_size FROM attachments WHERE id = $1', [upload.id]);
    if (committed.rowCount) {
      const row = committed.rows[0];
      if (row.chat_id === upload.chat_id && row.uploader_id === upload.uploader_id && Number(row.byte_size) === total) {
        await db.query('DELETE FROM attachment_uploads WHERE id = $1', [upload.id]);
      }
      continue;
    }
    try {
      if ((await stat(filePath(upload.id))).size !== total) continue;
    } catch { continue; }
    await commitChunkStorage(upload.id, total, async (client) => {
      await client.query('INSERT INTO attachments (id, chat_id, uploader_id, byte_size) VALUES ($1, $2, $3, $4)',
        [upload.id, upload.chat_id, upload.uploader_id, total]);
    });
  }

  // Reclaim incomplete uploads and finalization claims with no completed file.
  const stale = await db.query(
    `DELETE FROM attachment_uploads WHERE
      (finalizing = 0 AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${ORPHAN_GRACE}'))
      OR (finalizing = 1 AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'))`
  );
  uploads = stale.rowCount;

  let names: string[] = [];
  try { names = await readdir(attachmentsDir()); } catch { /* directory not created yet */ }
  const known = new Set((await db.query<{ id: string }>('SELECT id FROM attachments')).rows.map((r) => r.id));
  const live = new Set((await db.query<{ id: string }>('SELECT id FROM attachment_uploads')).rows.map((r) => r.id));
  for (const name of names) {
    const m = /^([0-9a-f]{32})\.(bin|part)$/u.exec(name);
    if (!m) continue;
    const path = join(attachmentsDir(), name);
    try {
      const details = await stat(path);
      if (Date.now() - details.mtimeMs < 3_600_000) continue;
      if (m[2] === 'part' ? !live.has(m[1]) : !known.has(m[1])) { await rm(path, { force: true }); strays++; }
    } catch { /* raced with another delete */ }
  }
  return { orphans, expired, strays, uploads };
};

const MEMBER_FRESH_OR_LIVE = `
  SELECT a.byte_size, a.expired_at FROM attachments a
  JOIN chat_members cm ON cm.chat_id = a.chat_id AND cm.user_id = $2
  WHERE a.id = $1
    AND (EXISTS (SELECT 1 FROM messages m WHERE m.attachment_id = a.id AND m.chat_id = a.chat_id AND m.deleted_at IS NULL)
      OR (a.uploader_id = $2 AND a.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${ORPHAN_GRACE}')))`;

export const registerAttachments = async (app: FastifyInstance): Promise<void> => {
  await mkdir(attachmentsDir(), { recursive: true, mode: 0o700 });
  const limits = attachmentLimits();

  await app.register(async (scope) => {
    // Keep the ciphertext as a raw stream; never buffer it.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

    scope.put<{ Params: { chatId: string; id: string } }>('/api/chats/:chatId/attachments/:id', {
      onRequest: requireUser,
      bodyLimit: limits.maxCipherBytes,
      config: { rateLimit: { max: 200, timeWindow: '1 hour' } }
    }, async (request, reply) => {
      const fail = (code: number, error: string) => reply.header('connection', 'close').code(code).send({ error });
      const { chatId, id } = request.params;
      const userId = request.user!.id;
      if (!/^[1-9]\d{0,17}$/u.test(chatId) || !/^[0-9a-f]{32}$/u.test(id)) return fail(400, 'Invalid id');
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return fail(415, 'Send application/octet-stream');
      const header = request.headers['content-length'];
      if (!header || !/^\d+$/u.test(header)) return fail(411, 'Content-Length required');
      const length = Number(header);
      if (length > limits.maxCipherBytes) return fail(413, 'File too large');
      if (!validCipherLength(length)) return fail(400, 'Malformed ciphertext length');

      const member = await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
      if (member.rowCount !== 1) return fail(404, 'Chat not found');
      if ((await db.query('SELECT 1 FROM attachments WHERE id = $1', [id])).rowCount) return fail(409, 'Upload id already used');

      let reservation: string;
      try { reservation = await reserveStorage(userId, length, id); }
      catch (error) {
        if (error instanceof StorageQuotaError) return fail(error.status, error.message);
        throw error;
      }
      const part = partPath(id);
      let received = 0;
      let ownsPart = false;
      try {
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            cb(received > length ? new Error('Body longer than Content-Length') : null, chunk);
          }
        });
        const output = createWriteStream(part, { flags: 'wx', mode: 0o600 });
        output.once('open', () => { ownsPart = true; });
        await pipeline(request.body as Readable, counter, output);
        if (received !== length) throw new Error('Incomplete upload');
        try {
          await commitStorage(reservation, length, async (client) => {
            await client.query('INSERT INTO attachments (id, chat_id, uploader_id, byte_size) VALUES ($1, $2, $3, $4)', [id, chatId, userId, length]);
          });
        } catch {
          await rm(part, { force: true });
          return fail(409, 'Upload id already used');
        }
        try { await rename(part, filePath(id)); } catch (error) {
          await db.query('DELETE FROM attachments WHERE id = $1', [id]);
          throw error;
        }
      } catch (error) {
        if (ownsPart) await rm(part, { force: true });
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail(409, 'Upload already in progress');
        request.log.warn({ err: error }, 'attachment upload failed');
        return fail(400, 'Upload failed');
      } finally {
        await releaseStorage(reservation);
      }
      return reply.code(201).send({ id, size: length });
    });

    // --- Chunked resumable upload (C4). One chunk = 262 160 cipher bytes; chunks may arrive in any order. ---
    const chunkCountOf = (total: number): number => Math.ceil(total / FULL_CHUNK);
    const chunkLength = (total: number, n: number): number => Math.min(FULL_CHUNK, total - n * FULL_CHUNK);
    type UploadRow = { uploader_id: string; chat_id: string; total_bytes: number; chunk_count: number };
    const receivedCount = async (id: string): Promise<number> =>
      Number((await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM attachment_upload_chunks WHERE upload_id = $1', [id])).rows[0]?.c ?? 0);

    const readBody = async (stream: Readable, limit: number): Promise<Buffer> => {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of stream) {
        const buf = part as Buffer;
        size += buf.length;
        if (size > limit) throw new Error('Chunk longer than expected');
        parts.push(buf);
      }
      return Buffer.concat(parts);
    };

    scope.put<{ Params: { chatId: string; id: string; n: string } }>('/api/chats/:chatId/attachments/:id/chunks/:n', {
      onRequest: requireUser,
      bodyLimit: FULL_CHUNK,
      config: { rateLimit: { max: 6_000, timeWindow: '1 hour' } }
    }, async (request, reply) => {
      const fail = (code: number, error: string) => reply.header('connection', 'close').code(code).send({ error });
      const { chatId, id } = request.params;
      const userId = request.user!.id;
      if (!/^[1-9]\d{0,17}$/u.test(chatId) || !/^[0-9a-f]{32}$/u.test(id) || !/^(0|[1-9]\d{0,6})$/u.test(request.params.n)) return fail(400, 'Invalid id');
      const n = Number(request.params.n);
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return fail(415, 'Send application/octet-stream');
      const totalHeader = request.headers['x-total-length'];
      if (typeof totalHeader !== 'string' || !/^\d{1,15}$/u.test(totalHeader)) return fail(400, 'X-Total-Length required');
      const total = Number(totalHeader);
      if (total > limits.maxCipherBytes) return fail(413, 'File too large');
      if (!validCipherLength(total)) return fail(400, 'Malformed ciphertext length');
      const count = chunkCountOf(total);
      if (n >= count) return fail(400, 'Chunk index out of range');
      const expected = chunkLength(total, n);
      const header = request.headers['content-length'];
      if (!header || !/^\d+$/u.test(header)) return fail(411, 'Content-Length required');
      if (Number(header) !== expected) return fail(400, 'Wrong chunk length');

      const member = await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
      if (member.rowCount !== 1) return fail(404, 'Chat not found');

      const done = (code: 200 | 201 = 200) => {
        const body = code === 201 ? { id, size: total, complete: true, received: count, total: count } : { received: count, total: count, complete: true };
        return reply.code(code).send(body);
      };
      const finished = (await db.query<{ uploader_id: string; chat_id: string; byte_size: number }>(
        'SELECT uploader_id, chat_id, byte_size FROM attachments WHERE id = $1', [id])).rows[0];
      if (finished) {
        if (finished.uploader_id !== userId || finished.chat_id !== chatId || Number(finished.byte_size) !== total) return fail(409, 'Upload id already used');
        await readBody(request.body as Readable, expected).catch(() => undefined);
        return done();
      }

      let upload = (await db.query<UploadRow>('SELECT uploader_id, chat_id, total_bytes, chunk_count FROM attachment_uploads WHERE id = $1', [id])).rows[0];
      if (!upload) {
        try { await reserveChunkStorage(id, chatId, userId, total, count); }
        catch (error) {
          if (error instanceof StorageQuotaError) return fail(error.status, error.message);
          throw error;
        }
        upload = (await db.query<UploadRow>('SELECT uploader_id, chat_id, total_bytes, chunk_count FROM attachment_uploads WHERE id = $1', [id])).rows[0];
      }
      if (!upload || upload.uploader_id !== userId || upload.chat_id !== chatId || Number(upload.total_bytes) !== total) return fail(409, 'Upload id already used');

      let body: Buffer;
      try { body = await readBody(request.body as Readable, expected); } catch { return fail(400, 'Upload failed'); }
      if (body.length !== expected) return fail(400, 'Wrong chunk length');

      const have = (await db.query('SELECT 1 FROM attachment_upload_chunks WHERE upload_id = $1 AND n = $2', [id, n])).rowCount === 1;
      if (!have) {
        const part = partPath(id);
        try {
          let handle;
          try { handle = await open(part, 'r+'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await (await open(part, 'a', 0o600)).close();
            handle = await open(part, 'r+');
          }
          try { await handle.write(body, 0, body.length, n * FULL_CHUNK); } finally { await handle.close(); }
        } catch (error) {
          request.log.warn({ err: error }, 'chunk write failed');
          return fail(500, 'Upload failed');
        }
        // Upload may have been finalized/cleaned by a racing duplicate while we wrote: drop any stray file.
        const still = (await db.query('SELECT 1 FROM attachment_uploads WHERE id = $1', [id])).rowCount === 1;
        if (!still) {
          await rm(part, { force: true });
          return (await db.query('SELECT 1 FROM attachments WHERE id = $1', [id])).rowCount ? done() : fail(404, 'Upload not found');
        }
        await db.query('INSERT INTO attachment_upload_chunks (upload_id, n) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, n]);
        await db.query(`UPDATE attachment_uploads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1`, [id]);
      }

      const received = await receivedCount(id);
      if (received < count) return reply.code(200).send({ received, total: count, complete: false });

      // Last chunk is in. Exactly one request wins the claim and finalizes.
      const claim = await db.query(`UPDATE attachment_uploads SET finalizing = 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1 AND finalizing = 0`, [id]);
      if (claim.rowCount !== 1) {
        const ready = (await db.query('SELECT 1 FROM attachments WHERE id = $1', [id])).rowCount === 1;
        return reply.code(200).send({ received, total: count, complete: ready });
      }
      const part = partPath(id);
      const final = filePath(id);
      let renamed = false;
      try {
        if ((await stat(part)).size !== total) throw new Error('Assembled size mismatch');
        await rename(part, final);
        renamed = true;
        await commitChunkStorage(id, total, async (client) => {
          await client.query('INSERT INTO attachments (id, chat_id, uploader_id, byte_size) VALUES ($1, $2, $3, $4)', [id, chatId, userId, total]);
        });
      } catch (error) {
        request.log.warn({ err: error }, 'attachment finalize failed');
        if (renamed) await rename(final, part).catch(() => undefined);
        await db.query('UPDATE attachment_uploads SET finalizing = 0 WHERE id = $1', [id]);
        return fail(500, 'Upload failed');
      }
      return done(201);
    });
  });

  app.get<{ Params: { chatId: string; id: string } }>('/api/chats/:chatId/attachments/:id/upload', {
    onRequest: requireUser,
    config: { rateLimit: { max: 1_200, timeWindow: '1 hour' } }
  }, async (request, reply) => {
    const { chatId, id } = request.params;
    const userId = request.user!.id;
    if (!/^[1-9]\d{0,17}$/u.test(chatId) || !/^[0-9a-f]{32}$/u.test(id)) return reply.code(404).send({ error: 'Not found' });
    const member = await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
    if (member.rowCount !== 1) return reply.code(404).send({ error: 'Not found' });
    reply.header('Cache-Control', 'no-store');
    const upload = (await db.query<{ uploader_id: string; chat_id: string; total_bytes: number; chunk_count: number }>(
      'SELECT uploader_id, chat_id, total_bytes, chunk_count FROM attachment_uploads WHERE id = $1', [id])).rows[0];
    if (upload) {
      if (upload.uploader_id !== userId || upload.chat_id !== chatId) return reply.code(404).send({ error: 'Not found' });
      const rows = (await db.query<{ n: number }>('SELECT n FROM attachment_upload_chunks WHERE upload_id = $1 ORDER BY n', [id])).rows;
      return { total: Number(upload.total_bytes), chunkBytes: FULL_CHUNK, received: rows.map((r) => Number(r.n)), complete: false };
    }
    const row = (await db.query<{ byte_size: number }>(
      'SELECT byte_size FROM attachments WHERE id = $1 AND uploader_id = $2 AND chat_id = $3', [id, userId, chatId])).rows[0];
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const total = Number(row.byte_size);
    return { total, chunkBytes: FULL_CHUNK, received: Array.from({ length: Math.ceil(total / FULL_CHUNK) }, (_, i) => i), complete: true };
  });

  app.get<{ Params: { id: string } }>('/api/attachments/:id', {
    onRequest: requireUser,
    config: { rateLimit: { max: 1_200, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const { id } = request.params;
    if (!/^[0-9a-f]{32}$/u.test(id)) return reply.code(404).send({ error: 'Not found' });
    const row = (await db.query<{ byte_size: number; expired_at: string | null }>(MEMBER_FRESH_OR_LIVE, [id, request.user!.id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (row.expired_at) return reply.code(410).send({ error: 'Attachment expired' });
    const size = Number(row.byte_size);
    try {
      const details = await stat(filePath(id));
      if (!details.isFile() || details.size !== size) throw new Error('size mismatch');
    } catch { return reply.code(404).send({ error: 'Not found' }); }

    const range = parseRange(request.headers.range, size);
    if (range === 'invalid') return reply.header('Content-Range', `bytes */${size}`).code(416).send({ error: 'Range not satisfiable' });
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    reply.headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Length': end - start + 1,
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin'
    }).type('application/octet-stream');
    if (range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    return reply.send(createReadStream(filePath(id), { start, end }));
  });

  const timer = setInterval(() => {
    cleanupAttachments().catch((error: unknown) => app.log.warn({ err: error }, 'attachment cleanup failed'));
  }, 3_600_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
};
