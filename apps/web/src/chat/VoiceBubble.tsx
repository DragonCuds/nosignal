import { PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { unb64u } from '../attachments/crypto.js';
import { useAttachmentBlob, useBlobUrl } from '../attachments/load.js';
import { useProgress } from '../attachments/progress.js';
import { formatDuration, inlineMime, type AttachmentDescriptor } from '../attachments/types.js';
import { PauseIcon, PlayIcon, ProgressRing } from '../attachments/ui.js';

const BARS = 36;
let playing: HTMLAudioElement | undefined; // only one voice message plays at a time

const bars = (waveform?: string): number[] => {
  let src: Uint8Array | undefined;
  try { src = waveform ? unb64u(waveform) : undefined; } catch { src = undefined; }
  if (!src || !src.length) return Array.from({ length: BARS }, () => 0.3);
  return Array.from({ length: BARS }, (_, i) => {
    const from = Math.floor((i * src!.length) / BARS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * src!.length) / BARS));
    let peak = 0;
    for (let j = from; j < to; j++) peak = Math.max(peak, src![j]);
    return Math.max(0.12, peak / 255);
  });
};

export function VoiceBubble({ chatId, attachment }: { chatId: string; attachment: AttachmentDescriptor }) {
  const { blob, loading, failed, load } = useAttachmentBlob(chatId, attachment, false);
  const progress = useProgress(attachment.id);
  const url = useBlobUrl(blob, inlineMime(attachment.mime, 'audio'));
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [wantPlay, setWantPlay] = useState(false);
  const [pos, setPos] = useState(0); // ms
  const total = attachment.durationMs ?? 0;
  const peaks = useMemo(() => bars(attachment.waveform), [attachment.waveform]);
  const busy = loading || progress !== undefined;
  const fraction = total > 0 ? Math.min(1, pos / total) : 0;

  useEffect(() => {
    if (!url || !wantPlay) return;
    setWantPlay(false);
    void toggle(true);
  }, [url, wantPlay]);
  useEffect(() => () => { if (playing === audio.current) playing = undefined; }, []);

  const toggle = async (force?: boolean) => {
    const element = audio.current;
    if (!element) return;
    if (force === undefined && !element.paused) { element.pause(); return; }
    if (playing && playing !== element) playing.pause();
    playing = element;
    try { await element.play(); } catch { setOn(false); }
  };
  const press = () => {
    if (busy) return;
    if (url) void toggle();
    else { setWantPlay(true); load(); }
  };
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const element = audio.current;
    if (!element || !url || total <= 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    element.currentTime = ((rtl ? 1 - ratio : ratio) * total) / 1000;
    setPos(((rtl ? 1 - ratio : ratio) * total));
  };

  return (
    <div className="att-voice">
      <button className="att-voice__btn" type="button" onClick={press} aria-label={on ? 'توقف' : 'پخش پیام صوتی'}>
        <ProgressRing className="att-voice__ring" value={busy ? progress : null} size={42}>{busy ? null : on ? <PauseIcon /> : <PlayIcon />}</ProgressRing>
      </button>
      <div className="att-voice__main">
        <div className="att-voice__wave" onPointerDown={seek} role="slider" aria-label="موقعیت پخش" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          {peaks.map((peak, i) => <i key={i} className={i / BARS < fraction ? 'is-done' : undefined} style={{ height: `${Math.round(peak * 100)}%` }} />)}
        </div>
        <span className="att-voice__time" dir="ltr">{failed ? 'دریافت نشد' : formatDuration(on || pos > 0 ? pos : total)}</span>
      </div>
      {url && (
        <audio
          ref={audio} src={url} preload="auto"
          onPlay={() => setOn(true)} onPause={() => setOn(false)}
          onEnded={() => { setOn(false); setPos(0); }}
          onTimeUpdate={(event) => setPos(event.currentTarget.currentTime * 1000)}
        />
      )}
    </div>
  );
}
