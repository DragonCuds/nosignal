import { useSyncExternalStore } from 'react';

// Transfer progress (0..1) per attachment id, plus blobs the sender still holds locally.
const values = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export const setProgress = (id: string, value: number | undefined) => {
  if (value === undefined) values.delete(id);
  else if (Math.abs((values.get(id) ?? -1) - value) < 0.01 && value < 1) return;
  else values.set(id, value);
  notify();
};

export const useProgress = (id: string): number | undefined =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => values.get(id));

/** Plaintext blobs of attachments this session sent (shown instantly, no download). */
export const localBlobs = new Map<string, Blob>();
