#!/usr/bin/env node
// NoSignal sticker-zip bot: send a Telegram sticker pack link (or any sticker) and get back a ZIP
// that NoSignal's «افزودن بسته» accepts. Zero dependencies, Node 24+. See README.md.
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// ---- limits that mirror NoSignal's importer (apps/server/src/media/import-pack.ts, validation.ts) ----
export const MAX_ZIP_BYTES = 12 * 1024 * 1024;       // importer rejects larger zips
export const ZIP_MARGIN = 32 * 1024;                  // safety margin below the importer's limit
export const MAX_STICKERS = 120;                      // importer: at most 120 stickers (zip entries <= 200 incl. pack.json)
export const MAX_TITLE = 120;
export const FILE_LIMITS = { webp: 512 * 1024, webm: 256 * 1024, tgs: 64 * 1024 };
export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;  // Bot API getFile limit
export const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

// ---- helpers ----
export const redact = (text, token) => {
  let out = String(text);
  if (token) out = out.split(token).join('[redacted]');
  return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]');
};

/** Accepts t.me/addstickers/NAME, telegram.me/addstickers/NAME, tg://addstickers?set=NAME, or a bare NAME. */
export const parsePackName = (input) => {
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
  return NAME_RE.test(name) ? name : null;
};

// ---- tiny zip writer (stored for stickers, deflate for pack.json) ----
const crc32 = (buf) => zlibCrc32(buf);
const DOS_TIME = 0;               // 00:00:00
const DOS_DATE = (2024 - 1980) << 9 | 1 << 5 | 1; // 2024-01-01 (fixed => reproducible zips)

export const zipEntrySize = (name, dataLength) => 30 + name.length + dataLength + 46 + name.length;
export const ZIP_END_SIZE = 22;

/** files: [{ name (ASCII, no slashes), data: Buffer, deflate?: boolean }] */
export const buildZip = (files) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(file.name) || file.name.includes('..')) throw new Error('unsafe zip entry name');
    const name = Buffer.from(file.name, 'ascii');
    const raw = file.data;
    const packed = file.deflate ? deflateRawSync(raw, { level: 9 }) : raw;
    const method = file.deflate && packed.length < raw.length ? 8 : 0;
    const body = method === 8 ? packed : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0o100644 << 16 >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(ZIP_END_SIZE);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
};

// ---- sticker file checks (same magic-byte rules as the importer) ----
const matchesType = (ext, bytes) => {
  if (ext === 'tgs') return bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (ext === 'webm') return bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
};
const extensionOf = (sticker) => (sticker.is_animated ? 'tgs' : sticker.is_video ? 'webm' : 'webp');

/** Pure planning step: given downloaded stickers, decide what fits. Returns the zip and counts. */
export const assemblePack = (name, title, items) => {
  const cleanTitle = (String(title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim() || name).slice(0, MAX_TITLE);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'pack';
  const files = [];
  const meta = [];
  let used = ZIP_END_SIZE + 4096;   // reserve room for pack.json
  let invalid = 0; let leftOut = 0; let full = false;
  for (const item of items) {
    if (!item.bytes) { invalid += 1; continue; }
    if (full || files.length >= MAX_STICKERS) { leftOut += 1; continue; }
    const fileName = `${String(files.length + 1).padStart(3, '0')}.${item.ext}`;
    const cost = zipEntrySize(fileName, item.bytes.length);
    if (used + cost > MAX_ZIP_BYTES - ZIP_MARGIN) { full = true; leftOut += 1; continue; }
    used += cost;
    files.push({ name: fileName, data: item.bytes });
    meta.push({ file: fileName, emoji: typeof item.emoji === 'string' ? item.emoji.slice(0, 32) : '', sort: files.length - 1 });
  }
  if (!files.length) return { zip: null, included: 0, leftOut, invalid, title: cleanTitle, slug };
  const manifest = Buffer.from(JSON.stringify({ slug, title: cleanTitle, thumb: files[0].name, stickers: meta }), 'utf8');
  const zip = buildZip([{ name: 'pack.json', data: manifest, deflate: true }, ...files]);
  return { zip, included: files.length, leftOut, invalid, title: cleanTitle, slug };
};

// ---- Persian messages ----
export const fa = {
  help: 'سلام! من بسته‌های استیکر تلگرام را برای نوسیگنال به‌صورت فایل ZIP درمی‌آورم.\n\n'
    + 'یک پیوند مثل t.me/addstickers/NAME یا فقط نام بسته را بفرستید، یا هر استیکری را برایم بفرستید. '
    + 'من فایل ZIP را برمی‌گردانم؛ آن را در نوسیگنال از «افزودن بسته» آپلود کنید.\n\n'
    + `حداکثر ${MAX_STICKERS} استیکر و ۱۲ مگابایت در هر بسته. هر کاربر ساعتی حداکثر ۵ بسته.`,
  badLink: 'این پیوند یا نام بسته معتبر نیست. نمونه: t.me/addstickers/NAME یا فقط NAME (حرف انگلیسی، عدد و _).',
  noSet: 'این استیکر به هیچ بسته‌ای وصل نیست. پیوند بسته را بفرستید.',
  notFound: 'چنین بسته‌ای در تلگرام پیدا نشد. نام یا پیوند را بررسی کنید.',
  rate: 'سقف ۵ بسته در ساعت پر شده است. کمی بعد دوباره امتحان کنید.',
  busy: 'ربات الان مشغول است. چند لحظه بعد دوباره بفرستید.',
  already: 'بستهٔ قبلی شما هنوز در حال ساخت است. صبر کنید.',
  denied: 'شما اجازهٔ استفاده از این ربات را ندارید.',
  unreachable: 'ارتباط با تلگرام برقرار نشد. کمی بعد دوباره امتحان کنید.',
  tooBig: 'هیچ استیکری از این بسته در محدودیت‌های نوسیگنال (حجم هر فایل و کل ۱۲ مگابایت) نمی‌گنجد.',
  internal: 'خطای غیرمنتظره رخ داد. دوباره امتحان کنید.',
  progress: (title, total) => `در حال دریافت «${title}» (${total} استیکر)…`,
  done: (title, included, total, leftOut, invalid) => {
    let text = `بستهٔ «${title}» آماده شد: ${included} استیکر از ${total}.`;
    if (leftOut) text += `\n${leftOut} استیکر به‌خاطر محدودیت تعداد (${MAX_STICKERS}) یا حجم کل (۱۲ مگابایت) کنار گذاشته شد.`;
    if (invalid) text += `\n${invalid} استیکر به‌خاطر بزرگ‌بودن فایل یا نامعتبر بودن کنار گذاشته شد.`;
    return `${text}\nاین فایل را در نوسیگنال از «افزودن بسته» آپلود کنید.`;
  }
};

// ---- bot ----
class ApiError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export const createBot = (options) => {
  const token = options.token;
  const base = String(options.base || 'https://api.telegram.org').replace(/\/+$/, '');
  const allowed = options.allowedUserIds ?? null;               // Set<string> | null
  const perHour = options.packsPerHour ?? 5;
  const maxActive = options.maxActive ?? 3;
  const pollSeconds = options.pollSeconds ?? 25;
  const apiTimeoutMs = options.apiTimeoutMs ?? 20_000;
  const fileTimeoutMs = options.fileTimeoutMs ?? 20_000;
  const packDeadlineMs = options.packDeadlineMs ?? 120_000;
  const parallel = 4;
  const now = options.now ?? (() => Date.now());
  const logger = options.log ?? ((line) => console.log(line));
  const log = (...parts) => logger(redact(parts.map((p) => (p instanceof Error ? p.message : String(p))).join(' '), token));
  const hits = new Map();         // userId -> timestamps
  const busyUsers = new Set();
  let active = 0;
  let stopped = false;
  let pollAbort = null;

  const readLimited = async (response, limit) => {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => {}); throw new ApiError('too_large', response.status); }
    const chunks = []; let size = 0;
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new ApiError('too_large', response.status); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  };

  const http = async (url, init, timeoutMs, limit) => {
    try {
      const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      return { status: response.status, body: await readLimited(response, limit) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('unreachable', 0);   // never carry the original message (it may contain the URL with the token)
    }
  };

  const call = async (method, params = {}, timeoutMs = apiTimeoutMs) => {
    const isForm = params instanceof FormData;
    const { status, body } = await http(`${base}/bot${token}/${method}`, {
      method: 'POST', headers: isForm ? {} : { 'content-type': 'application/json' }, body: isForm ? params : JSON.stringify(params)
    }, timeoutMs, 2 * 1024 * 1024);
    let json; try { json = JSON.parse(body.toString('utf8')); } catch { throw new ApiError('bad_response', status); }
    if (!json?.ok) throw new ApiError(status === 400 || status === 404 ? 'not_found' : 'api_error', status);
    return json.result;
  };

  const send = (chatId, text) => call('sendMessage', { chat_id: chatId, text }).catch((error) => log('sendMessage failed:', error.code ?? error));

  const downloadSticker = async (sticker, deadline) => {
    const ext = extensionOf(sticker);
    const limit = FILE_LIMITS[ext];
    const base0 = { ext, emoji: sticker.emoji, bytes: null };
    if (typeof sticker.file_id !== 'string' || (Number.isFinite(sticker.file_size) && sticker.file_size > limit)) return base0;
    try {
      if (now() > deadline) throw new ApiError('timeout', 0);
      const info = await call('getFile', { file_id: sticker.file_id });
      const path = info?.file_path;
      if (typeof path !== 'string' || !/^[A-Za-z0-9_\-./]{1,200}$/.test(path) || path.split('/').includes('..') || path.startsWith('/')) return base0;
      if (Number.isFinite(info.file_size) && (info.file_size > limit || info.file_size > TELEGRAM_FILE_LIMIT)) return base0;
      const { status, body } = await http(`${base}/file/bot${token}/${path}`, { method: 'GET' }, fileTimeoutMs, limit);
      if (status !== 200 || !matchesType(ext, body)) return base0;
      return { ...base0, bytes: body };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'too_large') return base0;
      if (error instanceof ApiError && error.code === 'timeout') throw error;
      log('sticker skipped:', error.code ?? 'error');
      return base0;
    }
  };

  const buildPack = async (chatId, name) => {
    let set;
    try { set = await call('getStickerSet', { name }); }
    catch (error) { await send(chatId, error.code === 'not_found' ? fa.notFound : fa.unreachable); return; }
    const stickers = Array.isArray(set?.stickers) ? set.stickers : [];
    if (!stickers.length) { await send(chatId, fa.notFound); return; }
    await send(chatId, fa.progress(String(set.title ?? name).slice(0, 80), stickers.length));
    const deadline = now() + packDeadlineMs;
    const items = [];
    let usedGuess = 0;   // stop downloading once the zip is certainly full
    for (let i = 0; i < stickers.length; i += parallel) {
      const real = items.filter((it) => it.bytes).length;
      if (real >= MAX_STICKERS || usedGuess > MAX_ZIP_BYTES) { for (const s of stickers.slice(i)) items.push({ ext: extensionOf(s), emoji: s.emoji, bytes: Buffer.alloc(0), skipped: true }); break; }
      let batch;
      try { batch = await Promise.all(stickers.slice(i, i + parallel).map((s) => downloadSticker(s, deadline))); }
      catch { await send(chatId, fa.unreachable); return; }
      for (const item of batch) { items.push(item); usedGuess += item.bytes?.length ?? 0; }
    }
    // Entries marked skipped are counted as left out (not as invalid); real stickers are re-checked by assemblePack.
    const real = items.filter((it) => !it.skipped);
    const skipped = items.length - real.length;
    const result = assemblePack(name, set.title, real);
    result.leftOut += skipped;
    if (!result.zip) { await send(chatId, fa.tooBig); return; }
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', fa.done(result.title, result.included, stickers.length, result.leftOut, result.invalid).slice(0, 1000));
    form.set('document', new Blob([result.zip], { type: 'application/zip' }), `${result.slug}.zip`);
    try { await call('sendDocument', form, 60_000); }
    catch (error) { log('sendDocument failed:', error.code ?? error); await send(chatId, fa.unreachable); return; }
    log(`pack ${name}: ${result.included}/${stickers.length}, ${result.zip.length} bytes`);
  };

  const handleMessage = async (message) => {
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    if (chatId === undefined || userId === undefined || message.chat.type !== 'private') return;
    if (allowed && !allowed.has(String(userId))) { await send(chatId, fa.denied); return; }
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/(start|help)(@\w+)?(\s|$)/i.test(text)) { await send(chatId, fa.help); return; }
    let name = null;
    if (message.sticker) {
      name = message.sticker.set_name;
      if (typeof name !== 'string' || !NAME_RE.test(name)) { await send(chatId, fa.noSet); return; }
    } else {
      name = parsePackName(text);
      if (!name) { await send(chatId, fa.badLink); return; }
    }
    if (busyUsers.has(userId)) { await send(chatId, fa.already); return; }
    if (active >= maxActive) { await send(chatId, fa.busy); return; }
    const t = now();
    const recent = (hits.get(userId) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= perHour) { hits.set(userId, recent); await send(chatId, fa.rate); return; }
    recent.push(t); hits.set(userId, recent);
    busyUsers.add(userId); active += 1;
    try { await buildPack(chatId, name); }
    catch (error) { log('pack failed:', error); await send(chatId, fa.internal); }
    finally { busyUsers.delete(userId); active -= 1; }
  };

  const inflight = new Set();
  const start = async () => {
    let offset = 0;
    while (!stopped) {
      try {
        pollAbort = new AbortController();
        const updates = await call('getUpdates', { offset, timeout: pollSeconds, allowed_updates: ['message'] }, (pollSeconds + 15) * 1000);
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          const task = handleMessage(update.message).catch((error) => log('update failed:', error)).finally(() => inflight.delete(task));
          inflight.add(task);
        }
      } catch (error) {
        if (stopped) break;
        log('poll error:', error.code ?? 'error');
        await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 5000));
      }
    }
    await Promise.allSettled([...inflight]);
  };
  const stop = () => { stopped = true; };
  return { start, stop, handleMessage, call };
};

// ---- entrypoint ----
const main = async () => {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!/^\d{3,}:[A-Za-z0-9_-]{10,}$/.test(token)) {
    console.error('TELEGRAM_BOT_TOKEN تنظیم نشده یا شکل آن درست نیست. README.md را ببینید.');
    process.exit(1);
  }
  const allowedRaw = (process.env.ALLOWED_USER_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const bot = createBot({ token, base: process.env.TELEGRAM_API_BASE?.trim() || undefined, allowedUserIds: allowedRaw.length ? new Set(allowedRaw) : null });
  process.on('SIGINT', () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  console.log('sticker zip bot started');
  await bot.start();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(redact(error?.message ?? error, process.env.TELEGRAM_BOT_TOKEN)); process.exit(1); });
}
