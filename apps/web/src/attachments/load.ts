import { useCallback, useEffect, useState } from 'react';
import { db, safe } from '../db.js';
import { reportTransfer } from '../datasaver.js';
import { chunkCount, cipherSize, decryptChunk, importAttachmentKey, unb64u } from './crypto.js';
import { localBlobs, setProgress } from './progress.js';
import { getCachedMedia, putCachedMedia } from '../mediaCache.js';
import { CIPHER_CHUNK, downloadChunks, type ChunkStore } from './transfer.js';
import type { AttachmentDescriptor } from './types.js';

const CACHE_BYTES = 50 * 1024 * 1024;
const cache = new Map<string, Promise<Blob>>(); // insertion order = LRU order
const sizes = new Map<string, number>();

const trim = () => {
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  for (const id of [...cache.keys()]) {
    if (total <= CACHE_BYTES || cache.size <= 1) break;
    total -= sizes.get(id) ?? 0;
    cache.delete(id);
    sizes.delete(id);
  }
};

/** Finished ciphertext chunks live in IndexedDB so a retry or reload resumes where the link died. */
const chunkStore: ChunkStore = {
  get: (id, n) => safe<Uint8Array | undefined>(async () => { const row = await db.chunks.get([id, n]); return row ? new Uint8Array(row.data) : undefined; }, undefined),
  put: (id, n, data) => safe<void>(async () => { await db.chunks.put({ id, n, data: data.slice().buffer as ArrayBuffer, updatedAt: Date.now() }); }, undefined),
  clear: (id) => safe<void>(async () => { await db.chunks.where('id').equals(id).delete(); }, undefined),
};
let swept = false;
/** Once per session: drop half-finished downloads nobody came back to (7 days). */
const sweepOldChunks = () => {
  if (swept) return;
  swept = true;
  void safe<void>(async () => { await db.chunks.where('updatedAt').below(Date.now() - 7 * 86_400_000).delete(); }, undefined);
};

/** Download chunk by chunk (resumable), decrypt, return a Blob. One download per attachment id. */
export const loadAttachment = (chatId: string, att: AttachmentDescriptor): Promise<Blob> => {
  const local = localBlobs.get(att.id);
  if (local) return Promise.resolve(local);
  const hit = cache.get(att.id);
  if (hit) { cache.delete(att.id); cache.set(att.id, hit); return hit; }
  const pending = (async () => {
    try {
      sweepOldChunks();
      setProgress(att.id, 0);
      const c = { key: await importAttachmentKey(att.key, ['decrypt']), noncePrefix: unb64u(att.noncePrefix), chatId, id: att.id, size: att.size };
      const last = chunkCount(att.size) - 1;
      const cached = await getCachedMedia(att.id);
      if (cached && cached.byteLength === cipherSize(att.size)) {
        try {
          const bytes = new Uint8Array(cached);
          const out: Uint8Array[] = [];
          for (let n = 0; n <= last; n++) out.push(await decryptChunk(c, n, bytes.subarray(n * CIPHER_CHUNK, Math.min((n + 1) * CIPHER_CHUNK, bytes.length)), n === last));
          const hitBlob = new Blob(out as BlobPart[], { type: att.mime });
          sizes.set(att.id, hitBlob.size);
          trim();
          return hitBlob;
        } catch { /* corrupt cache entry: fall through to the network */ }
      }
      const raw: Uint8Array[] = [];
      const parts = await downloadChunks({
        id: att.id, total: cipherSize(att.size), store: chunkStore,
        process: (n, cipher) => { raw[n] = cipher; return decryptChunk(c, n, cipher, n === last); },
        onProgress: (done) => setProgress(att.id, done),
        onSample: reportTransfer,
      });
      void chunkStore.clear(att.id);
      if (raw.length === last + 1 && raw.every(Boolean)) void putCachedMedia(att.id, raw);
      const blob = new Blob(parts as BlobPart[], { type: att.mime });
      sizes.set(att.id, blob.size);
      trim();
      return blob;
    } finally { setProgress(att.id, undefined); }
  })();
  cache.set(att.id, pending);
  pending.catch(() => { cache.delete(att.id); sizes.delete(att.id); });
  return pending;
};

export type LoadState = { blob?: Blob; loading: boolean; failed: boolean; load: () => void };

/** auto = start on mount (photos, voice-on-play handled by caller); otherwise call load(). */
export const useAttachmentBlob = (chatId: string, att: AttachmentDescriptor, auto: boolean): LoadState => {
  const [blob, setBlob] = useState<Blob | undefined>(() => localBlobs.get(att.id));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [wanted, setWanted] = useState(auto);
  const load = useCallback(() => setWanted(true), []);
  useEffect(() => {
    if (!wanted || blob) return;
    let live = true;
    setLoading(true);
    setFailed(false);
    loadAttachment(chatId, att).then((result) => { if (live) setBlob(result); }).catch(() => { if (live) { setFailed(true); setWanted(false); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [wanted, blob, chatId, att.id]);
  // Optimistic message settled: the local blob appears after mount.
  useEffect(() => { const local = localBlobs.get(att.id); if (local && !blob) setBlob(local); });
  return { blob, loading, failed, load };
};

/** Object URL tied to the component lifetime. */
export const useBlobUrl = (blob: Blob | undefined, type?: string): string | undefined => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) { setUrl(undefined); return; }
    const next = URL.createObjectURL(type && blob.type !== type ? new Blob([blob], { type }) : blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob, type]);
  return url;
};

/** Save a decrypted blob to disk. Forced octet-stream so the browser never renders it. */
export const saveBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
};
