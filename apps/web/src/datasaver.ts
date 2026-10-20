// Data saver: user mode + a tiny own "is this link poor?" detector (RTT / throughput over recent transfers).
import { useSyncExternalStore } from 'react';

export type DataSaverMode = 'auto' | 'on' | 'off';
export type Sample = { bytes: number; ms: number; at: number };
export type LinkHint = { saveData?: boolean; effectiveType?: string };

const KEY = 'tel.datasaver';
const MAX_SAMPLES = 8;
const MAX_AGE_MS = 5 * 60_000;
const MIN_SAMPLES = 3;
const SMALL_BYTES = 4096; // tiny transfers measure latency, not bandwidth
const BIG_BYTES = 16 * 1024;
export const POOR_RTT_MS = 1500;
export const POOR_BYTES_PER_S = 40 * 1024;

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Pure rule. Measured data wins; the browser hint is used only while we have too few samples. */
export const isPoorLink = (samples: Sample[], hint: LinkHint = {}, now = Date.now()): boolean => {
  const recent = samples.filter((s) => now - s.at <= MAX_AGE_MS && s.ms > 0).slice(-MAX_SAMPLES);
  const rtt = recent.filter((s) => s.bytes <= SMALL_BYTES).map((s) => s.ms);
  const speed = recent.filter((s) => s.bytes >= BIG_BYTES).map((s) => (s.bytes * 1000) / s.ms);
  const measured = rtt.length >= MIN_SAMPLES || speed.length >= MIN_SAMPLES;
  if (measured) return (rtt.length >= MIN_SAMPLES && avg(rtt) > POOR_RTT_MS) || (speed.length >= MIN_SAMPLES && avg(speed) < POOR_BYTES_PER_S);
  return !!hint.saveData || hint.effectiveType === 'slow-2g' || hint.effectiveType === '2g';
};

let samples: Sample[] = [];
let mode = 'auto' as DataSaverMode;
let poor = false;
const listeners = new Set<() => void>();
let snapshot = { mode, saving: false };

const connection = (): LinkHint => (typeof navigator !== 'undefined' ? (navigator as unknown as { connection?: LinkHint }).connection ?? {} : {});

const recompute = () => {
  poor = isPoorLink(samples, connection());
  const saving = mode === 'on' || (mode === 'auto' && poor);
  if (snapshot.mode !== mode || snapshot.saving !== saving) { snapshot = { mode, saving }; listeners.forEach((l) => l()); }
};

const readMode = (): DataSaverMode => {
  try { const v = localStorage.getItem(KEY); return v === 'on' || v === 'off' ? v : 'auto'; } catch { return 'auto'; }
};
mode = readMode();
recompute();
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY) { mode = readMode(); recompute(); } });

export const getDataSaver = (): DataSaverMode => mode;
export const setDataSaver = (next: DataSaverMode) => {
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* private mode: keep in memory */ }
  recompute();
};

/** Feed one finished transfer (ciphertext bytes, wall ms). Small ones act as RTT samples. */
export const reportTransfer = (bytes: number, ms: number) => {
  if (!(bytes > 0) || !(ms > 0)) return;
  samples = [...samples, { bytes, ms, at: Date.now() }].slice(-MAX_SAMPLES * 2);
  recompute();
};

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export const useDataSaver = (): { mode: DataSaverMode; saving: boolean } => useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

/** Test hook. */
export const __resetDataSaver = () => { samples = []; mode = 'auto'; recompute(); };
