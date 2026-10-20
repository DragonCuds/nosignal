import { useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  BLUR_MAX, DIM_MAX, clearWallpaper, cssVars, getWallpaperState, setWallpaper, subscribeWallpaper, updateWallpaperSettings,
} from './wallpaper.js';

/** Settings section: pick a chat background from the gallery, tune dim/blur, reset. Mounted by the settings page. */
export function WallpaperSettings() {
  const s = useSyncExternalStore(subscribeWallpaper, getWallpaperState, getWallpaperState);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError('');
    try { await setWallpaper(file); } catch (e) { setError(e instanceof Error ? e.message : 'خطای نامشخص'); }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  return (
    <section dir="rtl" aria-label="پس‌زمینه‌ی گفتگو" className="wallpaper-settings">
      <h2>پس‌زمینه‌ی گفتگو</h2>
      <div className="wallpaper-preview" data-custom={s.hasImage && s.url ? '1' : '0'} style={cssVars(s) as CSSProperties} aria-hidden="true">
        <span className="wallpaper-preview__bubble wallpaper-preview__bubble--in">سلام!</span>
        <span className="wallpaper-preview__bubble wallpaper-preview__bubble--out">پس‌زمینه‌ی تازه چطوره؟</span>
      </div>
      <div className="wallpaper-actions">
        <button type="button" className="wallpaper-btn wallpaper-btn--main" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'در حال آماده‌سازی…' : 'انتخاب تصویر از گالری'}
        </button>
        <button type="button" className="wallpaper-btn" disabled={busy || !s.hasImage} onClick={() => { setError(''); void clearWallpaper(); }}>
          بازگشت به پیش‌فرض
        </button>
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      {error && <p role="alert" className="wallpaper-error">{error}</p>}
      <label className="wallpaper-slider">
        <span>تیرگی <b>{s.dim}٪</b></span>
        <input type="range" min={0} max={DIM_MAX} step={1} value={s.dim} disabled={!s.hasImage} onChange={(e) => updateWallpaperSettings({ dim: Number(e.target.value) })} />
      </label>
      <label className="wallpaper-slider">
        <span>محوشدگی <b>{s.blur}px</b></span>
        <input type="range" min={0} max={BLUR_MAX} step={1} value={s.blur} disabled={!s.hasImage} onChange={(e) => updateWallpaperSettings({ blur: Number(e.target.value) })} />
      </label>
      <p className="wallpaper-note">تصویر فقط روی همین دستگاه ذخیره می‌شود و جایی ارسال نمی‌شود.</p>
    </section>
  );
}
