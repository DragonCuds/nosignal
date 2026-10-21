import { CSSProperties, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { unb64u } from '../attachments/crypto.js';
import { useAttachmentBlob, useBlobUrl } from '../attachments/load.js';
import { thumbMime } from '../attachments/prepare.js';
import { useProgress } from '../attachments/progress.js';
import { inlineMime, type AttachmentDescriptor } from '../attachments/types.js';
import { ExitFullscreenIcon, FullscreenIcon, MutedIcon, PauseIcon, PlayIcon, ProgressRing, RetryArrowIcon, VolumeIcon } from '../attachments/ui.js';
import { FileBubble } from './FileBubble.js';

type FsVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean };
type FsBox = HTMLElement & { webkitRequestFullscreen?: () => void };
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };

const fa = new Intl.NumberFormat('fa-IR', { useGrouping: false });
const fa2 = new Intl.NumberFormat('fa-IR', { useGrouping: false, minimumIntegerDigits: 2 });
/** m:ss with Persian digits; always laid out left-to-right (dir=ltr on the element) so RTL never flips it. */
export const clock = (seconds: number): string => {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${fa.format(Math.floor(s / 60))}:${fa2.format(s % 60)}`;
};

/** Only one video plays at a time: starting one pauses every other registered player. */
const players = new Set<HTMLVideoElement>();
const pauseOthers = (self: HTMLVideoElement) => { for (const v of players) if (v !== self && !v.paused) v.pause(); };

const useThumbUrl = (a: AttachmentDescriptor): string | undefined => {
  const [blob, setBlob] = useState<Blob>();
  useEffect(() => {
    try { setBlob(a.thumb ? new Blob([unb64u(a.thumb) as BlobPart], { type: thumbMime(a.thumb) }) : undefined); } catch { setBlob(undefined); }
  }, [a.thumb]);
  return useBlobUrl(blob);
};

const HIDE_MS = 2800;

export function VideoPlayer({ chatId, attachment }: { chatId: string; attachment: AttachmentDescriptor }) {
  const { blob, loading, failed, load } = useAttachmentBlob(chatId, attachment, false);
  const progress = useProgress(attachment.id);
  const type = inlineMime(attachment.mime, 'video');
  const url = useBlobUrl(blob, type);
  const thumb = useThumbUrl(attachment);
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<FsVideo>(null);
  const wantPlay = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const [ratio, setRatio] = useState(() => (attachment.w && attachment.h && attachment.w > 0 && attachment.h > 0 ? attachment.w / attachment.h : 4 / 3));
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState((attachment.durationMs ?? 0) / 1000);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [chrome, setChrome] = useState(true);
  const busy = loading || progress !== undefined;

  const poke = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), HIDE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => { if (!playing) { window.clearTimeout(hideTimer.current); setChrome(true); } else poke(); }, [playing, poke]);

  // register for the one-at-a-time rule
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    players.add(el);
    return () => { players.delete(el); };
  }, [url, attempt]);

  // pause when scrolled out of view or the tab is hidden
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const away = () => { const v = video.current; if (v && !v.paused && !isFull()) v.pause(); };
    const io = new IntersectionObserver(([entry]) => { if (entry && entry.intersectionRatio < 0.25) away(); }, { threshold: [0, 0.25, 0.5] });
    io.observe(el);
    const vis = () => { if (document.visibilityState !== 'visible') away(); };
    document.addEventListener('visibilitychange', vis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  }, []);

  const isFull = () => {
    const d = document as FsDoc;
    return (d.fullscreenElement ?? d.webkitFullscreenElement) === box.current || Boolean(video.current?.webkitDisplayingFullscreen);
  };
  useEffect(() => {
    const sync = () => setFullscreen(isFull());
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    const el = video.current;
    el?.addEventListener('webkitendfullscreen', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('webkitfullscreenchange', sync); el?.removeEventListener('webkitendfullscreen', sync); };
  }, [url, attempt]);

  const play = useCallback(() => {
    const el = video.current;
    if (!el) return;
    pauseOthers(el);
    void el.play().catch((e: unknown) => {
      // autoplay blocked after an async download (iOS): stay paused, the next tap plays
      if (e instanceof DOMException && e.name === 'NotAllowedError') return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(true);
    });
  }, []);

  // download finished after a tap: start right away
  useEffect(() => { if (url && wantPlay.current) { wantPlay.current = false; play(); } }, [url, play]);

  const toggle = () => {
    if (error) return;
    const el = video.current;
    if (!url || !el) {
      wantPlay.current = true;
      if (!busy) load();
      return;
    }
    if (el.paused || el.ended) play(); else el.pause();
    poke();
  };

  const retry = () => {
    setError(false);
    setWaiting(false);
    wantPlay.current = true;
    if (!blob) { load(); return; }
    setAttempt((n) => n + 1); // fresh <video> element on the same decrypted blob
  };

  const toggleMute = () => { const el = video.current; if (!el) return; el.muted = !el.muted; setMuted(el.muted); poke(); };

  const enterFull = () => {
    const el = box.current as FsBox | null;
    const v = video.current;
    if (!el || !v) return;
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else v.webkitEnterFullscreen?.();
  };
  const toggleFull = () => {
    if (fullscreen) {
      const d = document as FsDoc;
      if (d.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else if (d.webkitFullscreenElement) d.webkitExitFullscreen?.();
      else video.current?.webkitExitFullscreen?.();
    } else enterFull();
    poke();
  };

  const seek = (value: number) => { const el = video.current; if (!el || !Number.isFinite(value)) return; el.currentTime = value; setTime(value); poke(); };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return; // buttons and the slider keep their own keys
    const el = video.current;
    if (event.key === ' ' || event.key === 'k' || event.key === 'Enter') { event.preventDefault(); toggle(); }
    else if (event.key === 'ArrowRight' && el) { event.preventDefault(); seek(Math.min(duration, el.currentTime + 5)); }
    else if (event.key === 'ArrowLeft' && el) { event.preventDefault(); seek(Math.max(0, el.currentTime - 5)); }
    else if (event.key === 'm') toggleMute();
    else if (event.key === 'f') toggleFull();
  };

  if (!type) return <FileBubble chatId={chatId} attachment={{ ...attachment, name: attachment.name || 'video' }} />;

  const showCenter = !playing && !error;
  const spinning = busy || (waiting && playing) || (loading && !url);
  const style = { '--vp-ar': ratio } as CSSProperties;

  return (
    <div
      ref={box}
      className={`vp${fullscreen ? ' vp--full' : ''}${playing ? ' vp--playing' : ''}${chrome || !playing ? ' vp--chrome' : ''}`}
      style={style}
      tabIndex={0}
      role="group"
      aria-label="پخش‌کننده ویدیو"
      onKeyDown={onKey}
      onPointerMove={() => { if (playing) poke(); }}
    >
      {thumb && !started && <img className="vp__poster" src={thumb} alt="" />}
      {url && (
        <video
          key={attempt}
          ref={video}
          className="vp__video"
          src={`${url}#t=0.001`}
          poster={thumb}
          playsInline
          preload="metadata"
          aria-label="ویدیو"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (Number.isFinite(v.duration)) setDuration(v.duration);
            if (v.videoWidth && v.videoHeight) setRatio(v.videoWidth / v.videoHeight);
          }}
          onDurationChange={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={(e) => { pauseOthers(e.currentTarget); setPlaying(true); setStarted(true); setError(false); }}
          onPlaying={() => setWaiting(false)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); }}
          onWaiting={() => setWaiting(true)}
          onCanPlay={() => { setWaiting(false); if (wantPlay.current) { wantPlay.current = false; play(); } }}
          onError={() => { setPlaying(false); setWaiting(false); setError(true); }}
        />
      )}
      <div className="vp__surface" onClick={toggle} aria-hidden="true" />
      {!playing && !error && duration > 0 && <span className="vp__badge" dir="ltr">{clock(duration)}</span>}
      {showCenter && (
        <button className="vp__center" type="button" onClick={toggle} aria-label={busy ? 'در حال دریافت ویدیو' : 'پخش ویدیو'} disabled={busy && !url} data-state={spinning ? 'loading' : 'idle'}>
          {spinning
            ? <ProgressRing className="vp__ring" value={progress} size={64} />
            : <span className="vp__disc"><PlayIcon /></span>}
        </button>
      )}
      {playing && waiting && <span className="vp__wait" aria-label="در حال بارگذاری"><ProgressRing className="vp__ring" value={undefined} size={52} /></span>}
      {error && (
        <div className="vp__error" role="alert">
          <span>پخش نشد. دوباره تلاش کنید.</span>
          <button type="button" className="vp__retry" onClick={retry}><RetryArrowIcon />تلاش دوباره</button>
        </div>
      )}
      {failed && !url && !busy && !error && <div className="vp__error vp__error--small" role="alert"><span>دریافت نشد</span><button type="button" className="vp__retry" onClick={retry}><RetryArrowIcon />تلاش دوباره</button></div>}
      {url && !error && (
        <div className="vp__bar" onClick={(e) => e.stopPropagation()} onPointerDown={() => poke()}>
          <button type="button" className="vp__btn" onClick={toggle} aria-label={playing ? 'توقف' : 'پخش'}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
          <span className="vp__time" dir="ltr">{clock(time)}</span>
          <input
            className="vp__seek"
            type="range"
            dir="ltr"
            min={0}
            max={duration > 0 ? duration : 1}
            step={0.05}
            value={Math.min(time, duration > 0 ? duration : 1)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="جابه‌جایی در ویدیو"
            aria-valuetext={`${clock(time)} از ${clock(duration)}`}
            style={{ '--vp-pos': `${duration > 0 ? Math.min(100, (time / duration) * 100) : 0}%` } as CSSProperties}
          />
          <span className="vp__time" dir="ltr">{clock(duration)}</span>
          <button type="button" className="vp__btn" onClick={toggleMute} aria-label={muted ? 'روشن کردن صدا' : 'بی‌صدا'}>{muted ? <MutedIcon /> : <VolumeIcon />}</button>
          <button type="button" className="vp__btn" onClick={toggleFull} aria-label={fullscreen ? 'خروج از تمام‌صفحه' : 'تمام‌صفحه'}>{fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}</button>
        </div>
      )}
    </div>
  );
}
