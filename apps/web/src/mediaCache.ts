// Persistent media cache: stores CIPHERTEXT exactly as the server sent it, so a reload decrypts locally instead of downloading again.
// Never holds plaintext. Wiped on logout, session revoke and account change (see sync.ts / App.tsx). Every failure falls back to the network.
import { db, safe } from './db.js';

export const MEDIA_CACHE_MAX_BYTES = 300 * 1024 * 1024;
export const MEDIA_ITEM_MAX_BYTES = 100 * 1024 * 1024;

let persistAsked = false;
const askPersist = () => {
  if (persistAsked) return;
  persistAsked = true;
  try { void navigator.storage?.persist?.().catch(() => undefined); } catch { /* best effort */ }
};

export const getCachedMedia = (id: string): Promise<ArrayBuffer | undefined> => safe<ArrayBuffer | undefined>(async () => {
  const row = await db.mediaData.get(id);
  if (!row) return undefined;
  void db.mediaMeta.update(id, { lastUsed: Date.now() }).catch(() => undefined);
  return row.data;
}, undefined);

export const putCachedMedia = (id: string, parts: Uint8Array[]): Promise<void> => safe<void>(async () => {
  let size = 0;
  for (const part of parts) size += part.byteLength;
  if (size < 1 || size > MEDIA_ITEM_MAX_BYTES) return;
  const data = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { data.set(part, at); at += part.byteLength; }
  askPersist();
  await db.transaction('rw', db.mediaMeta, db.mediaData, async () => {
    await db.mediaData.put({ id, data: data.buffer as ArrayBuffer });
    await db.mediaMeta.put({ id, size, lastUsed: Date.now() });
    let total = 0;
    const rows = await db.mediaMeta.orderBy('lastUsed').toArray();
    for (const row of rows) total += row.size;
    for (const row of rows) { // oldest first
      if (total <= MEDIA_CACHE_MAX_BYTES) break;
      if (row.id === id) continue;
      total -= row.size;
      await db.mediaMeta.delete(row.id);
      await db.mediaData.delete(row.id);
    }
  });
}, undefined);

export const clearMediaCache = (): Promise<void> => safe<void>(async () => {
  await Promise.all([db.mediaMeta.clear(), db.mediaData.clear()]);
}, undefined);
