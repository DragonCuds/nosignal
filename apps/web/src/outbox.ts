// Persisted send queue (weak-net C6). Rows live in memory (source for the UI) and are mirrored to Dexie `db.outbox`
// so a reload or a dead link never loses a message. Same clientMsgId on every retry = the server dedupes (C1).
import { api, ApiError, type Message, type OutboundEncryptedPayload, type StickerMessagePayload, type GifMessagePayload } from './api.js';
import { db, safe, type OutboxRow } from './db.js';

export type { OutboxRow } from './db.js';
export type EnqueueInput = Omit<OutboxRow, 'state' | 'attempts' | 'nextAttemptAt' | 'createdAt'> & { createdAt?: number };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

/** 1 s, 2 s, 4 s … capped at 30 s, with ±20% jitter (never above the cap). `attempts` = failures so far (>= 1). */
export const backoffMs = (attempts: number, rand: () => number = Math.random): number => {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.min(BACKOFF_CAP_MS, Math.round(base * (0.8 + 0.4 * rand())));
};

/** Network trouble or a transient server answer is retried; any other 4xx will never succeed, so it stops as `failed`. */
export const isRetryable = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) return true;
  const s = error.status;
  return s === 0 || s === 408 || s === 429 || s >= 500;
};

/**
 * Which rows may go out now. Per chat the oldest non-failed row is the only candidate, so order is kept:
 * a row in flight or waiting for its backoff holds back the newer ones. Failed rows don't block the chat.
 * `wakeAt` = when the earliest waiting row becomes ready (null if nothing waits).
 */
export const planFlush = (rows: readonly OutboxRow[], now: number): { ready: OutboxRow[]; wakeAt: number | null } => {
  const byChat = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    if (row.state === 'failed') continue;
    const list = byChat.get(row.chatId);
    if (list) list.push(row); else byChat.set(row.chatId, [row]);
  }
  const ready: OutboxRow[] = [];
  let wakeAt: number | null = null;
  for (const list of byChat.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || (a.clientMsgId < b.clientMsgId ? -1 : 1));
    const head = list[0]!;
    if (head.state === 'sending') continue;
    if (head.nextAttemptAt <= now) ready.push(head);
    else wakeAt = wakeAt === null ? head.nextAttemptAt : Math.min(wakeAt, head.nextAttemptAt);
  }
  return { ready, wakeAt };
};

/** Test hook: pure helpers, no browser needed. */
export const outboxLogic = { backoffMs, isRetryable, planFlush };

const mem = new Map<string, OutboxRow>();
const inflight = new Set<string>(); // chat ids with a send in progress
const changeListeners = new Set<(chatId: string) => void>();
const sentListeners = new Set<(row: OutboxRow, message: Message) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let started: (() => void) | undefined;

const emit = (chatId: string) => { for (const cb of changeListeners) { try { cb(chatId); } catch { /* listener bug must not stop the queue */ } } };
const persist = (row: OutboxRow) => safe(() => db.outbox.put(row).then(() => undefined), undefined);
const unpersist = (id: string) => safe(() => db.outbox.delete(id), undefined);
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

export const newClientMsgId = (): string => crypto.randomUUID();

const update = (id: string, patch: Partial<OutboxRow>): OutboxRow | undefined => {
  const row = mem.get(id);
  if (!row) return undefined; // discarded meanwhile
  const next = { ...row, ...patch };
  if ('error' in patch && patch.error === undefined) delete next.error;
  mem.set(id, next);
  void persist(next);
  emit(next.chatId);
  return next;
};

const sendRow = (row: OutboxRow): Promise<Message> => {
  const enc = row.encrypted as OutboundEncryptedPayload;
  const bad = () => Promise.reject(new ApiError('پیام ناقص است.', 400));
  switch (row.kind) {
    case 'text': return api.sendMessage(row.chatId, enc, row.replyToId, row.clientMsgId);
    case 'sticker':
      return row.encryptedMediaId ? api.sendSticker(row.chatId, row.payload as StickerMessagePayload, enc, row.encryptedMediaId, row.replyToId, row.clientMsgId) : bad();
    case 'gif':
      return row.encryptedMediaId ? api.sendGif(row.chatId, row.payload as GifMessagePayload, enc, row.encryptedMediaId, row.replyToId, row.clientMsgId) : bad();
    default:
      return row.attachmentId ? api.sendAttachment(row.chatId, row.kind, row.attachmentId, enc, row.replyToId, row.clientMsgId) : bad();
  }
};

const run = async (row: OutboxRow) => {
  inflight.add(row.chatId);
  update(row.clientMsgId, { state: 'sending' });
  try {
    const message = await sendRow(row);
    const sent = mem.get(row.clientMsgId) ?? row;
    mem.delete(row.clientMsgId);
    await unpersist(row.clientMsgId);
    emit(row.chatId);
    for (const cb of sentListeners) { try { cb(sent, message); } catch { /* ignore */ } }
  } catch (error) {
    const attempts = row.attempts + 1;
    const text = error instanceof Error ? error.message : 'ارسال ناموفق بود.';
    if (isRetryable(error)) update(row.clientMsgId, { state: 'pending', attempts, nextAttemptAt: Date.now() + backoffMs(attempts), error: text });
    else update(row.clientMsgId, { state: 'failed', attempts, error: text });
  } finally {
    inflight.delete(row.chatId);
    flush();
  }
};

const flush = () => {
  clearTimeout(timer);
  timer = undefined;
  if (!isOnline()) return; // the `online` event restarts the loop; no attempts are burnt while offline
  const { ready, wakeAt } = planFlush([...mem.values()], Date.now());
  for (const row of ready) if (!inflight.has(row.chatId)) void run(row);
  if (wakeAt !== null) timer = setTimeout(flush, Math.max(50, wakeAt - Date.now()));
};

/** Queue a message (already encrypted). Returns the stored row; the flush loop sends it right away. */
export const enqueue = (input: EnqueueInput): OutboxRow => {
  const now = Date.now();
  const row: OutboxRow = { ...input, createdAt: input.createdAt ?? now, state: 'pending', attempts: 0, nextAttemptAt: 0 };
  mem.set(row.clientMsgId, row);
  void persist(row);
  emit(row.chatId);
  flush();
  return row;
};

/** Retry failed rows (all, or one) and any waiting backoff, immediately. */
export const retryNow = (clientMsgId?: string): void => {
  for (const row of [...mem.values()]) {
    if (clientMsgId && row.clientMsgId !== clientMsgId) continue;
    if (row.state === 'sending') continue;
    update(row.clientMsgId, { state: 'pending', attempts: row.state === 'failed' ? 0 : row.attempts, nextAttemptAt: 0, error: undefined });
  }
  flush();
};

/** Drop a row without sending it (e.g. the user deletes a failed bubble). */
export const discard = (clientMsgId: string): void => {
  const row = mem.get(clientMsgId);
  if (!row) return;
  mem.delete(clientMsgId);
  void unpersist(clientMsgId);
  emit(row.chatId);
};

/** Rows of one chat, oldest first. Synchronous (memory); filled from IndexedDB once startOutbox() has run. */
export const listOutbox = (chatId: string): OutboxRow[] =>
  [...mem.values()].filter((row) => row.chatId === chatId).sort((a, b) => a.createdAt - b.createdAt || (a.clientMsgId < b.clientMsgId ? -1 : 1));

export const onOutboxChange = (cb: (chatId: string) => void): (() => void) => {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
};

/** Fires after a row was accepted by the server, with the saved message (to swap the pending bubble). */
export const onOutboxSent = (cb: (row: OutboxRow, message: Message) => void): (() => void) => {
  sentListeners.add(cb);
  return () => { sentListeners.delete(cb); };
};

/** Load persisted rows (anything caught `sending` by a reload goes back to `pending`), start the flush loop. Idempotent; returns stop(). */
export const startOutbox = (): (() => void) => {
  if (started) return started;
  const wake = () => retryDue();
  const retryDue = () => {
    // Waiting rows are tried now, but a permanently failed one stays failed until retryNow().
    for (const row of [...mem.values()]) if (row.state === 'pending' && row.nextAttemptAt > 0) update(row.clientMsgId, { nextAttemptAt: 0 });
    flush();
  };
  const onVisible = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') wake(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  void (async () => {
    const stored = await safe(() => db.outbox.toArray(), [] as OutboxRow[]);
    const touched = new Set<string>();
    for (const row of stored) {
      if (mem.has(row.clientMsgId)) continue; // enqueued since boot: the live copy wins
      const fixed = row.state === 'sending' ? { ...row, state: 'pending' as const } : row;
      if (fixed !== row) void persist(fixed);
      mem.set(fixed.clientMsgId, fixed);
      touched.add(fixed.chatId);
    }
    for (const chatId of touched) emit(chatId);
    flush();
  })();
  started = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    clearTimeout(timer);
    timer = undefined;
    started = undefined;
  };
  return started;
};
