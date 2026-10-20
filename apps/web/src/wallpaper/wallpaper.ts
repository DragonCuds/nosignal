// Custom chat wallpaper, stored on this device only (IndexedDB blob + localStorage settings).
// No React here so the pure logic can be unit-tested with node:test.

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_SIDE = 1600;
export const DIM_MAX = 80;
export const BLUR_MAX = 20;
export const SETTINGS_KEY = 'tel.wallpaper.settings';
const DB_NAME = 'tel-wallpaper';
const STORE = 'blobs';
const BLOB_KEY = 'current';

export interface WallpaperSettings { dim: number; blur: number; hasImage: boolean }
export interface WallpaperState extends WallpaperSettings { url: string | null }

export const DEFAULT_SETTINGS: WallpaperSettings = { dim: 20, blur: 0, hasImage: false };

export function clamp(n: unknown, min: number, max: number, fallback = min): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
export const clampDim = (n: unknown) => Math.round(clamp(n, 0, DIM_MAX, DEFAULT_SETTINGS.dim));
export const clampBlur = (n: unknown) => Math.round(clamp(n, 0, BLUR_MAX, 0));

/** Target size keeping the aspect ratio so the long side is at most `max`; never upscales. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function parseSettings(raw: string | null | undefined): WallpaperSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return { ...DEFAULT_SETTINGS };
    return { dim: clampDim(o.dim ?? DEFAULT_SETTINGS.dim), blur: clampBlur(o.blur ?? 0), hasImage: o.hasImage === true };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function serialiseSettings(s: WallpaperSettings): string {
  return JSON.stringify({ dim: clampDim(s.dim), blur: clampBlur(s.blur), hasImage: s.hasImage === true });
}

/** Returns a Persian error message, or null when the file is acceptable. */
export function validateFile(file: { type?: string; size?: number } | null | undefined): string | null {
  if (!file) return 'فایلی انتخاب نشد.';
  if (!file.type || !file.type.startsWith('image/')) return 'فقط فایل تصویر قابل انتخاب است.';
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) return 'حجم تصویر بیشتر از ۱۵ مگابایت است.';
  return null;
}

// ---- state + subscription ----
let state: WallpaperState = { ...DEFAULT_SETTINGS, url: null };
const listeners = new Set<() => void>();
export function getWallpaperState(): WallpaperState { return state; }
export function subscribeWallpaper(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

function set(next: WallpaperState) {
  if (state.url && state.url !== next.url) { try { URL.revokeObjectURL(state.url); } catch { /* ignore */ } }
  state = next;
  applyCss(state);
  listeners.forEach((l) => { try { l(); } catch { /* ignore */ } });
}

/** CSS variables for a state; shared by the live app and the settings preview. */
export function cssVars(s: WallpaperState): Record<string, string> {
  const custom = !!(s.hasImage && s.url);
  return {
    '--chat-wallpaper-image': custom ? `url("${s.url}")` : 'none',
    '--chat-wallpaper-dim': String(clampDim(s.dim) / 100),
    '--chat-wallpaper-blur': `${clampBlur(s.blur)}px`,
  };
}

function applyCss(s: WallpaperState) {
  try {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(cssVars(s))) root.style.setProperty(k, v);
    if (s.hasImage && s.url) root.setAttribute('data-chat-wallpaper', 'custom');
    else root.removeAttribute('data-chat-wallpaper');
  } catch { /* no DOM */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, serialiseSettings(state)); } catch { /* ignore */ }
}

// ---- IndexedDB ----
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch { /* ignore */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}
async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T | undefined>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); resolve(undefined); };
      } catch { db.close(); resolve(undefined); }
    });
  } catch { return undefined; }
}

// ---- image downscale ----
async function downscale(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  try {
    const { width, height } = fitSize(bmp.width, bmp.height);
    if (!width) throw new Error('empty');
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bmp, 0, 0, width, height);
    const toBlob = (type: string) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.8));
    const webp = await toBlob('image/webp');
    if (webp && webp.type === 'image/webp') return webp;
    const jpeg = await toBlob('image/jpeg');
    if (jpeg) return jpeg;
    throw new Error('encode failed');
  } finally { try { bmp.close(); } catch { /* ignore */ } }
}

// ---- public API ----
/** Call once at app start. Safe to call again: previous object URL is revoked. */
export async function loadWallpaper(): Promise<WallpaperState> {
  let s = DEFAULT_SETTINGS;
  try { s = parseSettings(localStorage.getItem(SETTINGS_KEY)); } catch { /* ignore */ }
  let url: string | null = null;
  if (s.hasImage) {
    const blob = await idb<Blob>('readonly', (st) => st.get(BLOB_KEY));
    if (blob instanceof Blob) { try { url = URL.createObjectURL(blob); } catch { url = null; } }
  }
  set({ ...s, hasImage: !!url, url });
  return state;
}

/** Validates, downscales and stores the image. Rejects with an Error whose message is Persian. */
export async function setWallpaper(file: File): Promise<WallpaperState> {
  const bad = validateFile(file);
  if (bad) throw new Error(bad);
  let blob: Blob;
  try { blob = await downscale(file); } catch { throw new Error('این تصویر خوانده نشد؛ تصویر دیگری امتحان کنید.'); }
  const ok = await idb('readwrite', (st) => st.put(blob, BLOB_KEY));
  if (ok === undefined) throw new Error('ذخیره‌ی تصویر روی این دستگاه ممکن نشد.');
  set({ ...state, hasImage: true, url: URL.createObjectURL(blob) });
  saveSettings();
  return state;
}

export function updateWallpaperSettings(patch: Partial<Pick<WallpaperSettings, 'dim' | 'blur'>>): WallpaperState {
  set({ ...state, dim: patch.dim === undefined ? state.dim : clampDim(patch.dim), blur: patch.blur === undefined ? state.blur : clampBlur(patch.blur) });
  saveSettings();
  return state;
}

/** Back to the default pattern; removes the stored image. */
export async function clearWallpaper(): Promise<WallpaperState> {
  await idb('readwrite', (st) => st.delete(BLOB_KEY));
  set({ ...DEFAULT_SETTINGS, url: null });
  saveSettings();
  return state;
}
