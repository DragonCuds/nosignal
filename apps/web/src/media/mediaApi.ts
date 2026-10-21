export type Pack = { id: string; slug: string; title: string; thumbUrl: string | null; count?: number; /** false: added from a chat, so only the link is removed */ owned?: boolean };
export type Gif = { id: string; mp4Url: string | null; posterUrl: string | null; w: number; h: number; durationMs: number; tags: string[] };

export const MAX_PACKS = 20;
export const MAX_GIFS = 200;

export class MediaError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

const QUOTA_TEXT: Record<string, string> = {
  quota_packs: 'تعداد بسته‌های استیکر شما به سقف رسیده است. اول یکی را حذف کنید.',
  quota_gifs: 'تعداد گیف‌های شما به سقف رسیده است. اول چندتا را حذف کنید.',
  quota_bytes: 'فضای رسانه‌ی شما پر شده است. اول چیزی را حذف کنید.',
};

export const TG_TEXT: Record<string, string> = {
  telegram_not_configured: 'اپراتور سرور ربات تلگرام را تنظیم نکرده',
  invalid_pack: 'پیوند بسته معتبر نیست؛ پیوند را از تلگرام کپی و اینجا بچسبانید.',
  pack_not_found: 'این بسته در تلگرام پیدا نشد.',
  too_large: 'این بسته بیش از حد بزرگ است (حداکثر ۱۲۰ استیکر).',
  telegram_unreachable: 'سرور به تلگرام وصل نشد؛ کمی بعد دوباره امتحان کنید.',
  rate_limited: 'در هر ساعت حداکثر ۵ بسته می‌توانید وارد کنید؛ بعداً دوباره امتحان کنید.',
  busy: 'یک وارد کردن دیگر در جریان است؛ چند لحظه صبر کنید.',
  nothing_imported: 'هیچ استیکر قابل‌قبولی در این بسته نبود.',
  timeout: 'زمان وارد کردن تمام شد؛ بخشی از بسته ممکن است وارد نشده باشد.',
  internal: 'وارد کردن انجام نشد؛ دوباره امتحان کنید.',
};

const messageFor = (status: number, code?: string, fallback?: string): string => {
  if (code && TG_TEXT[code]) return TG_TEXT[code];
  if (code && QUOTA_TEXT[code]) return QUOTA_TEXT[code];
  if (status === 413) return 'حجم فایل یا سهمیه‌ی شما بیش از حد مجاز است.';
  if (status === 401) return 'دوباره وارد شوید.';
  if (status === 404) return 'پیدا نشد؛ شاید قبلاً حذف شده است.';
  if (status === 429) return 'درخواست‌ها زیاد بود؛ کمی بعد دوباره امتحان کنید.';
  if (status === 0) return 'اتصال به سرور قطع شد.';
  return fallback || 'کار انجام نشد؛ دوباره امتحان کنید.';
};

const parseError = (status: number, text: string): MediaError => {
  let code: string | undefined;
  try { code = (JSON.parse(text) as { code?: string }).code; } catch { /* not json */ }
  return new MediaError(messageFor(status, code), status, code);
};

export type TgJob = { id: string; state: 'running' | 'done' | 'error'; title: string; total: number; processed: number; imported: number; skipped: number; failed: number; code?: string; packId?: string };

const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'include', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  } catch { throw new MediaError(messageFor(0), 0); }
  if (!res.ok) throw parseError(res.status, await res.text().catch(() => ''));
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
};

/** Multipart upload with progress (fetch cannot report upload progress). */
const upload = <T>(path: string, file: File, fields: Record<string, string>, onProgress?: (pct: number) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new MediaError(messageFor(0), 0));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText) as T); } catch { resolve(undefined as T); } }
      else reject(parseError(xhr.status, xhr.responseText));
    };
    xhr.send(form);
  });

export const mediaApi = {
  packs: () => call<Pack[]>('/api/media/packs'),
  packDetail: (id: string) => call<Pack & { stickers: unknown[] }>(`/api/media/packs/${encodeURIComponent(id)}`),
  gifs: () => call<Gif[]>('/api/media/gifs'),
  savedGifs: () => call<Gif[]>('/api/media/gifs/saved'),
  deletePack: (id: string) => call<void>(`/api/media/packs/${encodeURIComponent(id)}`, 'DELETE'),
  removePack: (id: string) => call<void>(`/api/media/packs/${encodeURIComponent(id)}/library`, 'DELETE'),
  deleteGif: (id: string) => call<void>(`/api/media/gifs/${encodeURIComponent(id)}`, 'DELETE'),
  unsaveGif: (id: string) => call<void>(`/api/media/gifs/${encodeURIComponent(id)}/save`, 'DELETE'),
  importPack: (file: File, onProgress?: (pct: number) => void) =>
    upload<Pack>('/api/media/packs/import', file, { title: file.name.replace(/\.zip$/i, '') }, onProgress),
  telegramEnabled: () => call<{ enabled: boolean }>('/api/stickers/import/telegram/status').then((r) => r.enabled, () => false),
  telegramStart: (pack: string) => call<TgJob>('/api/stickers/import/telegram', 'POST', { pack }),
  telegramJob: (id: string) => call<TgJob>(`/api/stickers/import/telegram/${encodeURIComponent(id)}`),
  uploadGif: (file: File, onProgress?: (pct: number) => void) => upload<Gif>('/api/media/gifs/upload', file, {}, onProgress),
};
