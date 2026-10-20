// Weak-net client sync: seq cursor + catch-up after a reconnect, and the local cache of chats / last messages.
// Only SERVER forms are stored here (ciphertext for message content, E2EE): decryption happens after loading, in memory.
import { api, type Chat, type Message, type SyncEvent } from './api.js';
import { db, safe } from './db.js';

export const CACHE_PER_CHAT = 50;

// ---- seq cursor -------------------------------------------------------------------------------------------------

const SEQ_KEY = 'lastSeq';
let seqValue: number | undefined;
let seqLoaded = false;
let syncing = false;
let liveMax = 0;

export const getLastSeq = async (): Promise<number | undefined> => {
  if (!seqLoaded) {
    const row = await safe(() => db.meta.get(SEQ_KEY), undefined);
    if (!seqLoaded) { seqLoaded = true; if (typeof row?.value === 'number') seqValue = row.value; }
  }
  return seqValue;
};

const storeSeq = (value: number) => {
  seqValue = value;
  seqLoaded = true;
  void safe(() => db.meta.put({ key: SEQ_KEY, value }).then(() => undefined), undefined);
};

/** A realtime message.* event carried `seq`. While a catch-up runs it is only remembered (the response sets the cursor). */
export const noteLiveSeq = (seq: number | undefined): void => {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
  if (syncing) { liveMax = Math.max(liveMax, seq); return; }
  if (seq > (seqValue ?? 0)) storeSeq(seq);
};

export type CatchUp = { events: SyncEvent[]; reset: boolean };

/**
 * Ask the server what happened since the stored cursor. reset=true: the caller must refetch (no usable cursor,
 * log too old, or the server went backwards). Call it synchronously from onReconnect so live events that arrive
 * meanwhile cannot move the cursor past events we have not seen yet.
 */
export const catchUp = async (): Promise<CatchUp> => {
  syncing = true;
  liveMax = 0;
  try {
    const since = await getLastSeq();
    const res = await api.sync(since);
    const backwards = since !== undefined && res.latest < since;
    storeSeq(backwards ? res.latest : Math.max(res.latest, liveMax, since ?? 0));
    const reset = res.reset || since === undefined || backwards;
    if (reset) await clearMessageCache();
    return { events: reset ? [] : res.events, reset };
  } finally {
    syncing = false;
  }
};

/** App start: move the cursor to "now" right before the chat list is refetched (the list is the fresh state). */
export const baselineSeq = async (): Promise<void> => {
  syncing = true;
  liveMax = 0;
  try {
    const res = await api.sync(await getLastSeq());
    storeSeq(Math.max(res.latest, liveMax));
    if (res.reset) await clearMessageCache();
  } catch { /* offline: keep the stored cursor, the next reconnect catches up */ } finally { syncing = false; }
};

// ---- cache ------------------------------------------------------------------------------------------------------

const META_USER = 'cacheUser';
const activityOf = (chat: Chat) => new Date(chat.lastMessage?.createdAt ?? chat.createdAt).getTime();
const orderOf = (id: string): number => { const n = Number(id); return Number.isSafeInteger(n) ? n : 0; };

/** The local DB is shared by whoever logs in on this browser: wipe it when the account changes. */
export const prepareCache = async (userId: string): Promise<void> => {
  const row = await safe(() => db.meta.get(META_USER), undefined);
  if (row?.value === userId) return;
  await safe(async () => {
    await Promise.all([db.chats.clear(), db.messages.clear(), db.outbox.clear(), db.chunks.clear(), db.meta.clear()]);
    await db.meta.put({ key: META_USER, value: userId });
  }, undefined);
  seqValue = undefined;
  seqLoaded = false;
};

/** Explicit logout: forget cached conversations (the unsent outbox stays; prepareCache drops it on an account change). */
export const clearCache = async (): Promise<void> => {
  await safe(() => Promise.all([db.chats.clear(), db.messages.clear()]).then(() => undefined), undefined);
};

export const clearMessageCache = (): Promise<void> => safe(() => db.messages.clear(), undefined);

export const cacheChats = (chats: Chat[]): Promise<void> => safe(() => db.transaction('rw', db.chats, async () => {
  await db.chats.clear();
  await db.chats.bulkPut(chats.map((chat) => ({ id: chat.id, data: chat, updatedAt: activityOf(chat) })));
}), undefined);

export const readCachedChats = async (): Promise<Chat[]> => {
  const rows = await safe(() => db.chats.toArray(), []);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).map((row) => row.data as Chat);
};

/** The fetched page IS the latest page: replace the chat's cache with its last ~50 messages. */
export const cacheMessages = (chatId: string, messages: Message[]): Promise<void> => safe(() => db.transaction('rw', db.messages, async () => {
  await db.messages.where('chatId').equals(chatId).delete();
  await db.messages.bulkPut(messages.slice(-CACHE_PER_CHAT).map((message) => ({ chatId, id: message.id, n: orderOf(message.id), data: message })));
}), undefined);

export const readCachedMessages = async (chatId: string): Promise<Message[]> => {
  const rows = await safe(() => db.messages.where('chatId').equals(chatId).toArray(), []);
  return rows.sort((a, b) => a.n - b.n).slice(-CACHE_PER_CHAT).map((row) => row.data as Message);
};

/** A live/sync message event for a chat whose cache exists: keep the cache current (edited/deleted replace the row). */
export const cacheEventMessage = (message: Message): Promise<void> => safe(async () => {
  if (await db.messages.where('chatId').equals(message.chatId).count() === 0) return;
  await db.messages.put({ chatId: message.chatId, id: message.id, n: orderOf(message.id), data: message });
  const extra = (await db.messages.where('chatId').equals(message.chatId).count()) - CACHE_PER_CHAT;
  if (extra > 0) {
    const oldest = await db.messages.where('chatId').equals(message.chatId).sortBy('n');
    await db.messages.bulkDelete(oldest.slice(0, extra).map((row) => [row.chatId, row.id] as [string, string]));
  }
}, undefined);

// ---- plaintext of messages we are sending (memory only, never persisted) --------------------------------------------

const plain = new Map<string, { text: string | null; payload: unknown | null }>();
export const rememberPlain = (clientMsgId: string, value: { text: string | null; payload: unknown | null }) => { plain.set(clientMsgId, value); };
export const plainOf = (clientMsgId: string | null | undefined) => (clientMsgId ? plain.get(clientMsgId) : undefined);
export const forgetPlain = (clientMsgId: string) => { plain.delete(clientMsgId); };

/** What App hands the open conversation after every reconnect: events to apply, or reset = refetch and merge. */
export type SyncSignal = { token: number; reset: boolean; events: SyncEvent[] };
