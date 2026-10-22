import { api } from './api.js';
import { isValidPackId } from './outboxRow.js';

// "Pack P was shared into chat C" is told to the server only AFTER the server accepted the sticker message (outbox success),
// so a send that fails (read, encrypt, upload, network, rejected) never opens the pack to the chat. The packId comes from the
// persisted outbox row's own `grantPackId` field (the row carries no plaintext payload), so a retry after a reload or an error-queue resend behaves the same. Cached per session; a failed grant
// is forgotten so the next sticker from that pack tries again. A grant failure never touches the already-sent message.
const granted = new Set<string>();

type SentRow = { kind: string; chatId: string; grantPackId?: unknown };
type Grant = (chatId: string, packId: string) => Promise<unknown>;

export const grantPackAfterSend = (row: SentRow, grant: Grant = (chatId, packId) => api.grantStickerPack(chatId, packId)): void => {
  if (row.kind !== 'sticker') return;
  const packId = row.grantPackId;
  if (!isValidPackId(packId)) return; // a row stored by an older version (or a damaged one) has none: no grant, never a guess
  const key = `${row.chatId}:${packId}`;
  if (granted.has(key)) return;
  granted.add(key);
  try { void Promise.resolve(grant(row.chatId, packId)).catch(() => granted.delete(key)); } catch { granted.delete(key); }
};

export const resetPackGrants = (): void => granted.clear();
