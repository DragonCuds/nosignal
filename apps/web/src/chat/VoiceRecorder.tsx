import { PointerEvent, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../attachments/types.js';
import { CloseIcon, MicIcon, SendIcon } from '../icons.js';

const MAX_MS = 10 * 60_000;
const MIN_MS = 600;
const TAP_MS = 350;
const CANCEL_PX = 80;
const SAMPLE_MS = 60;
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

export type VoiceResult = { blob: Blob; durationMs: number; waveform: Uint8Array };
type Props = { disabled?: boolean; onVoice: (voice: VoiceResult) => void; onError: (copy: string) => void; onActive?: (active: boolean) => void };
type Live = { recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; chunks: Blob[]; peaks: number[]; started: number; timer: number; type: string; mode: 'hold' | 'lock'; x0: number; discard: boolean };

const waveformOf = (peaks: number[]): Uint8Array => {
  const out = new Uint8Array(64);
  if (!peaks.length) return out;
  const max = Math.max(...peaks, 0.001);
  for (let i = 0; i < 64; i++) {
    const from = Math.floor((i * peaks.length) / 64);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / 64));
    let peak = 0;
    for (let j = from; j < Math.min(to, peaks.length); j++) peak = Math.max(peak, peaks[j]);
    out[i] = Math.round(Math.min(1, peak / max) * 255);
  }
  return out;
};

/** Mic button + recording bar. Hold = release to send (drag sideways to cancel); tap = locked bar with cancel/send. */
export function VoiceRecorder({ disabled, onVoice, onError, onActive }: Props) {
  const live = useRef<Live | null>(null);
  const pressed = useRef(false);
  const [state, setState] = useState<'idle' | 'hold' | 'lock'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [willCancel, setWillCancel] = useState(false);

  useEffect(() => { onActive?.(state !== 'idle'); }, [state]);
  useEffect(() => () => { const l = live.current; if (l) { l.discard = true; l.recorder.state !== 'inactive' && l.recorder.stop(); window.clearInterval(l.timer); l.stream.getTracks().forEach((t) => t.stop()); void l.ctx.close(); } }, []);

  const start = async (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || live.current) return;
    const button = event.currentTarget;
    const pointerId = event.pointerId;
    const x0 = event.clientX;
    pressed.current = true;
    try { button.setPointerCapture(pointerId); } catch { /* ignore */ }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return onError('ضبط صدا در این مرورگر پشتیبانی نمی‌شود.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch { return onError('دسترسی به میکروفون داده نشد.'); }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 20_000 });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);
    const l: Live = { recorder, stream, ctx, chunks: [], peaks: [], started: performance.now(), timer: 0, type: type || recorder.mimeType || 'audio/webm', mode: 'hold', x0, discard: false };
    live.current = l;
    recorder.ondataavailable = (e) => { if (e.data.size) l.chunks.push(e.data); };
    recorder.onstop = () => {
      window.clearInterval(l.timer);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      const durationMs = Math.round(performance.now() - l.started);
      live.current = null;
      setState('idle'); setWillCancel(false); setLevels([]); setElapsed(0);
      if (l.discard) return;
      if (durationMs < MIN_MS) return onError('پیام صوتی خیلی کوتاه بود.');
      onVoice({ blob: new Blob(l.chunks, { type: l.type }), durationMs, waveform: waveformOf(l.peaks) });
    };
    recorder.start(1000);
    l.timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) { const d = (v - 128) / 128; sum += d * d; }
      const level = Math.min(1, Math.sqrt(sum / buffer.length) * 3.2);
      l.peaks.push(level);
      setLevels((cur) => [...cur.slice(-39), level]);
      const ms = performance.now() - l.started;
      setElapsed(ms);
      if (ms >= MAX_MS && recorder.state !== 'inactive') recorder.stop();
    }, SAMPLE_MS);
    // Finger already lifted while the permission prompt / startup was pending: behave like a tap (locked).
    if (!pressed.current) l.mode = 'lock';
    setState(l.mode);
  };

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const l = live.current;
    if (!l || l.mode !== 'hold') return;
    setWillCancel(Math.abs(event.clientX - l.x0) > CANCEL_PX);
  };
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    pressed.current = false;
    const l = live.current;
    if (!l || l.mode !== 'hold') return;
    const held = performance.now() - l.started;
    if (Math.abs(event.clientX - l.x0) > CANCEL_PX) { l.discard = true; l.recorder.stop(); return; }
    if (held < TAP_MS) { l.mode = 'lock'; setState('lock'); setWillCancel(false); return; }
    l.recorder.stop();
  };
  const stop = (discard: boolean) => {
    const l = live.current;
    if (!l) return;
    l.discard = discard;
    if (l.recorder.state !== 'inactive') l.recorder.stop();
  };

  const bars = [...Array(Math.max(0, 40 - levels.length)).fill(0), ...levels];
  return (
    <>
      {state !== 'idle' && (
        <div className={`voice-bar${willCancel ? ' voice-bar--cancel' : ''}`} role="status">
          {state === 'lock' && <button className="icon-button" type="button" onClick={() => stop(true)} aria-label="لغو ضبط"><CloseIcon /></button>}
          <span className="voice-bar__dot" />
          <span className="voice-bar__time" dir="ltr">{formatDuration(elapsed)}</span>
          <span className="voice-bar__wave" aria-hidden="true">{bars.map((v, i) => <i key={i} style={{ height: `${Math.max(8, Math.round(v * 100))}%` }} />)}</span>
          {state === 'hold' && <span className="voice-bar__hint">{willCancel ? 'رها کنید تا لغو شود' : 'برای لغو بکشید'}</span>}
          {state === 'lock' && <button className="voice-bar__send" type="button" onClick={() => stop(false)} aria-label="ارسال پیام صوتی"><SendIcon /></button>}
        </div>
      )}
      <button
        className={`icon-button voice-mic${state === 'hold' ? ' voice-mic--live' : ''}${state === 'lock' ? ' voice-mic--hidden' : ''}`}
        type="button" disabled={disabled} aria-label="ضبط پیام صوتی" title="نگه دارید و صحبت کنید"
        onPointerDown={(event) => void start(event)} onPointerMove={move} onPointerUp={release} onPointerCancel={() => { pressed.current = false; stop(true); }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <MicIcon />
      </button>
    </>
  );
}
