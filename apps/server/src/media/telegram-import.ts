import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { db } from '../db.js';
import { assertQuota, ensureStorage, QuotaError, saveContent, temporaryPath } from './storage.js';
import { validateTgs, validateWebmSticker, validateWebpSticker } from './validation.js';

/**
 * Import a Telegram sticker pack through the OPERATOR's Bot API token (TELEGRAM_BOT_TOKEN).
 * The token only ever lives in this module's closure-free env read; it is never logged,
 * returned, or placed in an error message (everything is redacted and mapped to fixed codes).
 */
export const MAX_STICKERS = 120;
export const MAX_FILE_BYTES = 512 * 1024;
const FILE_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const PARALLEL = 4;
const MAX_ACTIVE_JOBS = 2;
export const IMPORTS_PER_HOUR = 5;
const JOB_TTL_MS = 10 * 60_000;

export type ImportCode = 'telegram_not_configured' | 'invalid_pack' | 'pack_not_found' | 'too_large' | 'telegram_unreachable'
  | 'rate_limited' | 'busy' | 'nothing_imported' | 'timeout' | 'quota_packs' | 'quota_bytes' | 'internal';
export type ImportJob = {
  id: string; userId: string; state: 'running' | 'done' | 'error'; title: string; total: number; processed: number;
  imported: number; skipped: number; failed: number; code?: ImportCode; packId?: string; finishedAt?: number;
};

class ImportError extends Error {
  constructor(readonly code: ImportCode) { super(code); }
}

const warned = new Set<string>();
/** One fixed, token-free warning line per reason (botConfig runs on every request). */
const warnOnce = (reason: string): void => {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(`[telegram-import] disabled: ${reason}`);
};

/** Only literal loopback addresses (127.0.0.0/8, ::1). Names such as "localhost" are rejected: their resolution can change. */
const isLoopbackHost = (hostname: string): boolean => /^127(\.\d{1,3}){3}$/.test(hostname) || hostname === '[::1]' || hostname === '::1';

const botConfig = (): { token: string; base: string } | null => {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d{3,}:[A-Za-z0-9_-]{10,}$/.test(token)) return null;
  let base = (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(/\/+$/, '');
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { warnOnce('TELEGRAM_API_BASE is not a plain http(s) URL'); return null; }
    if (url.protocol === 'http:') {
      if (process.env.TELEGRAM_API_ALLOW_LOCAL_HTTP !== '1') { warnOnce('TELEGRAM_API_BASE uses http: (set TELEGRAM_API_ALLOW_LOCAL_HTTP=1 only for a loopback Bot API server)'); return null; }
      if (!isLoopbackHost(url.hostname)) { warnOnce('http: TELEGRAM_API_BASE is allowed only for a literal loopback address (127.x.x.x or [::1])'); return null; }
    }
    base = url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
  } catch { warnOnce('TELEGRAM_API_BASE is not a valid URL'); return null; }
  return { token, base };
};

export const telegramImportEnabled = (): boolean => botConfig() !== null;

/** Remove the token and any Bot API "bot<id>:<secret>" URL segment from text. */
export const redact = (text: string): string => {
  let out = text;
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (token) out = out.split(token).join('[redacted]');
  return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]');
};

/** Accepts t.me/addstickers/NAME, telegram.me/addstickers/NAME, tg://addstickers?set=NAME or a bare NAME. */
export const parsePackName = (input: unknown): string | null => {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 300) return null;
  let name = text;
  if (/^tg:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.hostname.toLowerCase() !== 'addstickers') return null;
      name = url.searchParams.get('set') ?? '';
    } catch { return null; }
  } else if (/^https?:\/\//i.test(text) || /^(?:t|telegram)\.me\//i.test(text)) {
    try {
      const url = new URL(/^https?:/i.test(text) ? text : `https://${text}`);
      if (url.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
      const match = url.pathname.match(/^\/addstickers\/([^/]+)\/?$/);
      if (!match) return null;
      name = match[1];
    } catch { return null; }
  }
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : null;
};

// ---- Bot API access -------------------------------------------------------------------------

const readLimited = async (response: Response, limit: number): Promise<Buffer> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => undefined); throw new ImportError('too_large'); }
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => undefined); throw new ImportError('too_large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

const request = async (url: string, limit: number, deadline: number): Promise<{ status: number; body: Buffer }> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ImportError('timeout');
  let response: Response;
  try {
    // redirect:'manual' -> a 3xx is never followed, so we can only ever talk to the configured host.
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(FILE_TIMEOUT_MS, remaining)), headers: { accept: '*/*' } });
  } catch { throw new ImportError('telegram_unreachable'); }
  try { return { status: response.status, body: await readLimited(response, limit) }; }
  catch (error) { throw error instanceof ImportError ? error : new ImportError('telegram_unreachable'); }
};

type TgSticker = { file_id?: unknown; is_animated?: unknown; is_video?: unknown; emoji?: unknown };

const api = async (cfg: { token: string; base: string }, method: string, query: Record<string, string>, deadline: number): Promise<Record<string, unknown>> => {
  const url = `${cfg.base}/bot${cfg.token}/${method}?${new URLSearchParams(query)}`;
  const { status, body } = await request(url, MAX_JSON_BYTES, deadline);
  let parsed: { ok?: unknown; result?: unknown; error_code?: unknown } | undefined;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ }
  if (parsed?.ok === true && parsed.result && typeof parsed.result === 'object') return parsed.result as Record<string, unknown>;
  if (parsed && (parsed.error_code === 400 || parsed.error_code === 404 || status === 400 || status === 404)) throw new ImportError('pack_not_found');
  throw new ImportError('telegram_unreachable');
};

const download = async (cfg: { token: string; base: string }, fileId: string, deadline: number): Promise<Buffer> => {
  const file = await api(cfg, 'getFile', { file_id: fileId }, deadline);
  const path = file.file_path;
  // Only a plain relative path under the configured file endpoint; no scheme, no dot segments.
  if (typeof path !== 'string' || !/^[A-Za-z0-9_\-./]{1,200}$/.test(path) || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new ImportError('telegram_unreachable');
  }
  const { status, body } = await request(`${cfg.base}/file/bot${cfg.token}/${path}`, MAX_FILE_BYTES, deadline);
  if (status !== 200 || !body.length) throw new ImportError('telegram_unreachable');
  return body;
};

// ---- Validation + storage -------------------------------------------------------------------

type Prepared = { bytes: Buffer; format: 'tgs' | 'webm' | 'webp'; w: number; h: number; emoji: string; filePath: string; sort: number };

const prepare = async (bytes: Buffer, format: Prepared['format']): Promise<{ w: number; h: number }> => {
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const webm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if ((format === 'tgs' && !gzip) || (format === 'webm' && !webm) || (format === 'webp' && !webp)) throw new Error('content mismatch');
  if (format === 'tgs') return validateTgs(bytes);
  const temporary = temporaryPath(`${randomUUID()}${extname(`x.${format}`)}`);
  await writeFile(temporary, bytes, { mode: 0o600 });
  try { return format === 'webm' ? await validateWebmSticker(temporary, bytes.length) : await validateWebpSticker(temporary, bytes.length); }
  finally { await rm(temporary, { force: true }); }
};

const persist = async (job: ImportJob, title: string, name: string, items: Prepared[]): Promise<void> => {
  // Idempotency key: one pack per (user, Telegram name). The slug is globally unique, so it carries the user id.
  const slug = `tg-${job.userId}-${name.toLowerCase()}`.slice(0, 80);
  const existing = await db.query<{ id: string }>('SELECT id FROM sticker_packs WHERE slug = $1 AND owner_id = $2', [slug, job.userId]);
  let packId: string | undefined = existing.rows[0]?.id;
  const known = new Set<string>();
  if (packId) {
    for (const row of (await db.query<{ file_path: string }>('SELECT file_path FROM stickers WHERE pack_id = $1', [packId])).rows) known.add(row.file_path);
  } else {
    await assertQuota(job.userId, { packs: 1 });
  }
  const fresh = items.filter((item) => !known.has(item.filePath));
  job.skipped += items.length - fresh.length;
  if (!fresh.length) return;
  await assertQuota(job.userId, { bytes: fresh.reduce((sum, item) => sum + item.bytes.length, 0) });
  for (const item of fresh) await saveContent(item.filePath, item.bytes);
  // Only one import per user runs at a time, so nothing else creates this pack between the lookup above and here.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!packId) {
      const created = await client.query<{ id: string }>('INSERT INTO sticker_packs (slug, title, thumb_path, owner_id) VALUES ($1, $2, $3, $4) RETURNING id', [slug, title, fresh[0].filePath, job.userId]);
      packId = created.rows[0].id;
      await client.query('INSERT INTO user_sticker_packs (user_id, pack_id, sort) VALUES ($1, $2, COALESCE((SELECT max(sort) + 1 FROM user_sticker_packs WHERE user_id = $1), 0))', [job.userId, packId]);
    } else {
      await client.query('UPDATE sticker_packs SET title = $1 WHERE id = $2', [title, packId]);
    }
    for (const item of fresh) {
      await client.query('INSERT INTO stickers (pack_id, file_path, format, emoji, w, h, sort, byte_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING',
        [packId, item.filePath, item.format, item.emoji, item.w, item.h, item.sort, item.bytes.length]);
    }
    await client.query('COMMIT');
    job.imported += fresh.length;
    job.packId = packId;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
};

// ---- Jobs -----------------------------------------------------------------------------------

const jobs = new Map<string, ImportJob>();
const history = new Map<string, number[]>();

const sweep = (): void => {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
};

const run = async (job: ImportJob, name: string, log: (message: string) => void): Promise<void> => {
  const cfg = botConfig();
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  try {
    if (!cfg) throw new ImportError('telegram_not_configured');
    await ensureStorage();
    const set = await api(cfg, 'getStickerSet', { name }, deadline);
    const list = Array.isArray(set.stickers) ? set.stickers as TgSticker[] : [];
    if (!list.length) throw new ImportError('pack_not_found');
    if (list.length > MAX_STICKERS) throw new ImportError('too_large');
    const title = (typeof set.title === 'string' ? set.title.replace(/[\u0000-\u001f]/g, '').trim() : '').slice(0, 120) || name;
    job.title = title; job.total = list.length;
    const prepared: Array<Prepared | undefined> = new Array(list.length);
    let next = 0;
    let timedOut = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= list.length) return;
        const item = list[index];
        try {
          if (typeof item.file_id !== 'string' || !item.file_id || item.file_id.length > 200) throw new Error('bad item');
          const format: Prepared['format'] = item.is_animated === true ? 'tgs' : item.is_video === true ? 'webm' : 'webp';
          const bytes = await download(cfg, item.file_id, deadline);
          const size = await prepare(bytes, format);
          prepared[index] = { bytes, format, ...size, emoji: typeof item.emoji === 'string' ? item.emoji.slice(0, 32) : '', sort: index, filePath: `stickers/${createHash('sha256').update(bytes).digest('hex')}.${format}` };
        } catch (error) {
          if (error instanceof ImportError && error.code === 'timeout') timedOut = true;
          job.failed += 1;
        }
        job.processed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
    const seen = new Set<string>();
    const items = prepared.filter((entry): entry is Prepared => {
      if (!entry) return false;
      if (seen.has(entry.filePath)) { job.skipped += 1; return false; }
      seen.add(entry.filePath); return true;
    });
    if (!items.length) throw new ImportError(timedOut ? 'timeout' : 'nothing_imported');
    await persist(job, title, name, items);
    if (timedOut) job.code = 'timeout';
    job.state = 'done';
  } catch (error) {
    job.state = 'error';
    job.code = error instanceof ImportError ? error.code : error instanceof QuotaError && error.code !== 'quota_gifs' ? error.code : 'internal';
    if (job.code === 'internal') log(`telegram import failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  } finally { job.finishedAt = Date.now(); }
};

export type StartResult = { ok: true; job: ImportJob } | { ok: false; status: number; code: ImportCode };

export const startTelegramImport = (userId: string, link: unknown, log: (message: string) => void): StartResult => {
  if (!botConfig()) return { ok: false, status: 503, code: 'telegram_not_configured' };
  const name = parsePackName(link);
  if (!name) return { ok: false, status: 400, code: 'invalid_pack' };
  sweep();
  const running = [...jobs.values()].filter((job) => job.state === 'running');
  if (running.some((job) => job.userId === userId) || running.length >= MAX_ACTIVE_JOBS) return { ok: false, status: 429, code: 'busy' };
  const now = Date.now();
  const recent = (history.get(userId) ?? []).filter((time) => now - time < 3_600_000);
  if (recent.length >= IMPORTS_PER_HOUR) { history.set(userId, recent); return { ok: false, status: 429, code: 'rate_limited' }; }
  history.set(userId, [...recent, now]);
  const job: ImportJob = { id: randomUUID(), userId, state: 'running', title: name, total: 0, processed: 0, imported: 0, skipped: 0, failed: 0 };
  jobs.set(job.id, job);
  void run(job, name, log);
  return { ok: true, job };
};

export const getTelegramImport = (userId: string, id: string): ImportJob | undefined => {
  const job = jobs.get(id);
  return job && job.userId === userId ? job : undefined;
};

export const publicJob = (job: ImportJob) => ({ id: job.id, state: job.state, title: job.title, total: job.total, processed: job.processed, imported: job.imported, skipped: job.skipped, failed: job.failed, ...(job.code ? { code: job.code } : {}), ...(job.packId ? { packId: job.packId } : {}) });
