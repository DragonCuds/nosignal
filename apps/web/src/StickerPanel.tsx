import { CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { api, type Gif, type Sticker, type StickerPack, type StickerPackDetail } from './api.js';
import { GifIcon, PlusIcon, RecentIcon, SearchIcon, SmileIcon, StickerIcon } from './icons.js';
import { TelegramImport, useMediaAdd, type MediaAdd } from './media/useMediaAdd.js';
import { GifVideo } from './GifVideo.js';
import { fieldDir } from './chat/helpers.js';
import { EmojiPicker } from './EmojiPicker.js';

type Tab = 'emoji' | 'stickers' | 'gifs';
type HeldSticker = { sticker: Sticker; x: number; y: number; timer: number };


function StickerMedia({ sticker, size, label }: { sticker: Sticker; size: number; label?: string }) {
  return <tg-sticker src={sticker.fileUrl} format={sticker.format} size={size} autoplay loop alt={label ?? (sticker.emoji || 'استیکر')} />;
}

function AddButtons({ add, kind, onTelegram, big }: { add: MediaAdd; kind: 'stickers' | 'gifs'; onTelegram?: () => void; big?: boolean }) {
  return <div className={`panel-add${big ? ' panel-add--big' : ''}`}>
    <button type="button" disabled={add.busy} onClick={kind === 'stickers' ? add.openPack : add.openGif}><PlusIcon />{kind === 'stickers' ? 'افزودن استیکر' : 'افزودن گیف'}</button>
    {kind === 'stickers' && <button type="button" disabled={add.busy} onClick={onTelegram}><PlusIcon />افزودن بسته از تلگرام</button>}
  </div>;
}

export function StickerPanel({ open, onClose, onEmoji, onSticker, onGif }: { open: boolean; onClose: () => void; onEmoji: (emoji: string) => void; onSticker: (sticker: Sticker) => Promise<void>; onGif: (gif: Gif) => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('emoji');
  const [packs, setPacks] = useState<StickerPack[]>([]);
  const [details, setDetails] = useState<Record<string, StickerPackDetail>>({});
  const [recent, setRecent] = useState<Sticker[]>([]);
  const [selectedPack, setSelectedPack] = useState('recent');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Sticker | null>(null);
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [savedGifs, setSavedGifs] = useState<Gif[]>([]);
  const [gifSearch, setGifSearch] = useState('');
  const [gifView, setGifView] = useState<'all' | 'saved'>('saved');
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState('');
  const [gifReload, setGifReload] = useState(0);
  const [showTg, setShowTg] = useState(false);
  const add = useMediaAdd((kind) => { window.dispatchEvent(new Event('sticker-packs-changed')); if (kind === 'gif') { setGifView('all'); setGifSearch(''); setGifReload((value) => value + 1); } });
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const held = useRef<HeldSticker | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  const load = () => {
    setLoading(true); setError('');
    void Promise.all([api.stickerPacks(), api.recentStickers()]).then(([packList, recentList]) => {
      setPacks(packList); setRecent(recentList);
      setSelectedPack((current) => {
        if (current === 'recent' && recentList.length === 0 && packList.length) return packList[0].id;
        return current === 'recent' || packList.some((pack) => pack.id === current) ? current : packList[0]?.id ?? 'recent';
      });
    }).catch(() => setError('استیکرها دریافت نشدند.')).finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    load();
    const changed = () => { setDetails({}); load(); };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('sticker-packs-changed', changed);
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('sticker-packs-changed', changed); document.removeEventListener('keydown', key); };
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'stickers' || selectedPack === 'recent' || details[selectedPack]) return;
    setLoading(true); setError('');
    void api.stickerPack(selectedPack).then((pack) => setDetails((current) => ({ ...current, [pack.id]: pack }))).catch(() => setError('این بسته دریافت نشد.')).finally(() => setLoading(false));
  }, [open, tab, selectedPack, details]);

  useEffect(() => {
    if (!open || tab !== 'gifs') return;
    const timer = window.setTimeout(() => {
      setGifLoading(true); setGifError('');
      void Promise.all([api.gifs(gifSearch), api.savedGifs()]).then(([items, saved]) => {
        setGifs(items); setSavedGifs(saved);
      }).catch(() => setGifError('گیف‌ها دریافت نشدند.')).finally(() => setGifLoading(false));
    }, gifSearch ? 250 : 0);
    return () => clearTimeout(timer);
  }, [open, tab, gifSearch, gifReload]);

  useEffect(() => () => { if (held.current) clearTimeout(held.current.timer); }, []);

  const current = selectedPack === 'recent' ? recent : details[selectedPack]?.stickers ?? [];
  const beginPreview = (event: ReactPointerEvent, sticker: Sticker) => {
    if (held.current) clearTimeout(held.current.timer);
    const item = { sticker, x: event.clientX, y: event.clientY, timer: 0 };
    item.timer = window.setTimeout(() => { setPreview(sticker); held.current = undefined; }, 500);
    held.current = item;
  };
  const movePreview = (event: ReactPointerEvent) => {
    const item = held.current;
    if (item && Math.hypot(event.clientX - item.x, event.clientY - item.y) >= 10) { clearTimeout(item.timer); held.current = undefined; }
  };
  const endPreview = () => { if (held.current) { clearTimeout(held.current.timer); held.current = undefined; } setPreview(null); };
  const send = async (sticker: Sticker) => {
    if (preview) return;
    await onSticker(sticker);
    setRecent((items) => [sticker, ...items.filter((item) => item.id !== sticker.id)].slice(0, 50));
    onClose();
  };
  const sendGif = async (gif: Gif) => { await onGif(gif); onClose(); };
  const shownGifs = gifView === 'saved'
    ? savedGifs.filter((gif) => !gifSearch.trim() || gif.tags.includes(gifSearch.trim().toLocaleLowerCase()))
    : gifs;

  if (!mounted) return null;
  return <>
    <button className={`sticker-panel-scrim${closing ? ' sticker-panel-scrim--closing' : ''}`} type="button" onClick={onClose} aria-label="بستن پنل" />
    <div className={`sticker-panel${closing ? ' sticker-panel--closing' : ''}`} ref={panel} role="dialog" aria-modal="true" aria-label="شکلک و استیکر">
      <div className="sticker-panel__content">
        {tab === 'emoji' && <EmojiPicker onPick={onEmoji} />}
        {tab === 'stickers' && <div className="sticker-content">
          {add.inputs}
          <nav className="pack-strip" aria-label="بسته‌های استیکر"><button className={selectedPack === 'recent' ? 'pack-button--active' : ''} type="button" onClick={() => setSelectedPack('recent')} aria-label="استیکرهای اخیر" aria-pressed={selectedPack === 'recent'}><RecentIcon /></button>{packs.map((pack) => <button className={selectedPack === pack.id ? 'pack-button--active' : ''} type="button" key={pack.id} title={pack.title} onClick={() => setSelectedPack(pack.id)} aria-label={pack.title} aria-pressed={selectedPack === pack.id}>{pack.thumbUrl ? <tg-sticker src={pack.thumbUrl} format={pack.thumbUrl.match(/\.(tgs|webm|webp)(?:$|[?#])/i)?.[1]?.toLowerCase() as Sticker['format'] | undefined} size={30} alt="" /> : <StickerIcon />}</button>)}</nav>
          {current.length > 0 && !loading && <AddButtons add={add} kind="stickers" onTelegram={() => setShowTg((v) => !v)} />}
          {add.progress?.kind === 'pack' && <div className="media-lib__progress panel-add__bar" role="progressbar" aria-valuenow={add.progress.pct}><span style={{ width: `${add.progress.pct}%` }} /></div>}
          {showTg && <div className="panel-tg"><TelegramImport add={add} /></div>}
          {add.error && !showTg && <p className="media-lib__error panel-add__err" role="alert">{add.error}</p>}
          <div className="sticker-grid" onPointerMove={movePreview} onPointerUp={endPreview} onPointerCancel={endPreview} onPointerLeave={endPreview}>{current.map((sticker) => <button type="button" key={sticker.id} onPointerDown={(event) => beginPreview(event, sticker)} onClick={() => void send(sticker)} aria-label={sticker.emoji ? `ارسال استیکر ${sticker.emoji}` : 'ارسال استیکر'}><StickerMedia sticker={sticker} size={68} /></button>)}</div>
          {loading && <div className="panel-state"><span className="spinner spinner--accent" /></div>}{!loading && error && <div className="panel-state"><span>{error}</span><button className="text-button" type="button" onClick={load}>تلاش دوباره</button></div>}{!loading && !error && current.length === 0 && <div className="panel-state"><StickerIcon /><span>{selectedPack === 'recent' && packs.length === 0 ? 'هنوز استیکری ندارید. یک بسته‌ی zip یا بسته‌ی تلگرام اضافه کنید.' : selectedPack === 'recent' ? 'هنوز استیکری نفرستاده‌اید.' : 'این بسته خالی است.'}</span><AddButtons add={add} kind="stickers" big onTelegram={() => setShowTg(true)} /></div>}
        </div>}
        {tab === 'gifs' && <div className="gif-content">
          {add.inputs}
          <div className="gif-tools"><label className="gif-search"><SearchIcon/><input value={gifSearch} onChange={(event) => setGifSearch(event.target.value)} placeholder="جستجو با برچسب" aria-label="جستجوی گیف با برچسب" dir={fieldDir(gifSearch)}/></label><div className="gif-filter" role="group" aria-label="نمایش گیف‌ها"><button className="gif-filter__add" type="button" disabled={add.busy} onClick={add.openGif} aria-label="افزودن گیف"><PlusIcon />افزودن گیف</button><button className={gifView === 'saved' ? 'gif-filter--active' : ''} type="button" onClick={() => setGifView('saved')} aria-pressed={gifView === 'saved'}>ذخیره‌شده</button><button className={gifView === 'all' ? 'gif-filter--active' : ''} type="button" onClick={() => setGifView('all')} aria-pressed={gifView === 'all'}>همه</button></div></div>
          {add.progress?.kind === 'gif' && <div className="media-lib__progress panel-add__bar" role="progressbar" aria-valuenow={add.progress.pct}><span style={{ width: `${add.progress.pct}%` }} /></div>}
          {add.error && <p className="media-lib__error panel-add__err" role="alert">{add.error}</p>}
          <div className="gif-grid">{shownGifs.map((gif) => <button type="button" key={gif.id} onClick={() => void sendGif(gif)} aria-label={`ارسال گیف${gif.tags[0] ? ` ${gif.tags[0]}` : ''}`} style={{ aspectRatio: `${gif.w} / ${gif.h}` }}><GifVideo mp4Url={gif.mp4Url} posterUrl={gif.posterUrl} /><span>GIF</span></button>)}</div>
          {gifLoading && <div className="panel-state panel-state--overlay"><span className="spinner spinner--accent"/></div>}{!gifLoading && gifError && <div className="panel-state"><span>{gifError}</span><button className="text-button" type="button" onClick={() => setGifReload((value) => value + 1)}>تلاش دوباره</button></div>}{!gifLoading && !gifError && shownGifs.length === 0 && <div className="panel-state"><GifIcon/><strong>{gifView === 'saved' ? 'هنوز گیفی ذخیره نکرده‌اید.' : 'گیفی پیدا نشد.'}</strong>{!gifSearch.trim() && <span>یک فایل گیف یا ویدیوی کوتاه (mp4) اضافه کنید.</span>}<AddButtons add={add} kind="gifs" big /></div>}
        </div>}
      </div>
      <nav className="media-tabs" aria-label="نوع رسانه" role="tablist" style={{ '--i': tab === 'emoji' ? 0 : tab === 'stickers' ? 1 : 2 } as CSSProperties}><button className={tab === 'emoji' ? 'media-tab--active' : ''} type="button" onClick={() => setTab('emoji')} aria-label="شکلک" role="tab" aria-selected={tab === 'emoji'}><SmileIcon /></button><button className={tab === 'stickers' ? 'media-tab--active' : ''} type="button" onClick={() => setTab('stickers')} aria-label="استیکر" role="tab" aria-selected={tab === 'stickers'}><StickerIcon /></button><button className={tab === 'gifs' ? 'media-tab--active' : ''} type="button" onClick={() => setTab('gifs')} aria-label="گیف" role="tab" aria-selected={tab === 'gifs'}><GifIcon /></button></nav>
    </div>
    {preview && <div className="sticker-preview" role="status" onPointerUp={endPreview} onPointerCancel={endPreview}><StickerMedia sticker={preview} size={200} label="پیش‌نمایش استیکر" /><span>{preview.emoji || 'پیش‌نمایش استیکر'}</span></div>}
  </>;
}
