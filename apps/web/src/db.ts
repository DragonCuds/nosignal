// Local IndexedDB (Dexie) shared by the weak-net features.
import { Dexie, type Table } from 'dexie';

export type OutboxRow = {
  clientMsgId: string;
  chatId: string;
  kind: 'text' | 'sticker' | 'gif' | 'photo' | 'video' | 'voice' | 'file';
  /** Already-encrypted body exactly as POST /api/chats/:id/messages expects it. */
  encrypted: unknown;
  encryptedMediaId?: string;
  attachmentId?: string;
  replyToId: string | null;
  /** What the bubble shows while pending (decrypted text / payload). */
  text: string | null;
  payload: unknown | null;
  createdAt: number;
  state: 'pending' | 'sending' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  error?: string;
};
export type ChatRow = { id: string; data: unknown; updatedAt: number };
export type MessageRow = { chatId: string; id: string; n: number; data: unknown };
export type ChunkRow = { id: string; n: number; data: ArrayBuffer; updatedAt: number };
export type MetaRow = { key: string; value: unknown };

class TelDb extends Dexie {
  outbox!: Table<OutboxRow, string>;
  chats!: Table<ChatRow, string>;
  messages!: Table<MessageRow, [string, string]>;
  /** Finished ciphertext chunks of an attachment download (resume). id = attachment id. */
  chunks!: Table<ChunkRow, [string, number]>;
  meta!: Table<MetaRow, string>;
  constructor() {
    super('tel-messenger');
    this.version(1).stores({
      outbox: 'clientMsgId, chatId, state, createdAt',
      chats: 'id',
      messages: '[chatId+id], chatId, [chatId+n]',
      chunks: '[id+n], id, updatedAt',
      meta: 'key',
    });
  }
}

export const db = new TelDb();
/** Never throw if IndexedDB is unavailable (private mode): callers get the fallback. */
export const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => { try { return await run(); } catch { return fallback; } };
