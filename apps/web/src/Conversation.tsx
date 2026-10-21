import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Chat, type Gif, type GifMessagePayload, type Message, type OutboundEncryptedPayload, type RealtimeEvent, type Sticker, type StickerMessagePayload, type User } from './api.js';
import { DownIcon } from './icons.js';
import { acceptKeyChange, checkKeyChanges, decryptMessage as decryptPlain, encryptContent } from './e2ee.js';
import { discard as discardOutbox, enqueue, listOutbox, newClientMsgId, onOutboxChange, onOutboxSent, retryNow, type OutboxRow } from './outbox.js';
import { cacheEventMessage, cacheMessages, forgetPlain, plainOf, readCachedMessages, rememberPlain, type SyncSignal } from './sync.js';
import { decryptMessageMedia as decryptMessage, decryptMessagesMedia as decryptMessages, encryptMediaMessage } from './encrypted-media.js';
import { dayKey, faNumber } from './ui.js';
import { ChatHeader, type SearchState } from './chat/ChatHeader.js';
import { KeyChangeBanner, type NamedKeyChange } from './chat/KeyChangeBanner.js';
import { groupsApi } from './groups/groupsApi.js';
import { Composer } from './chat/Composer.js';
import { ChannelInfo } from './channels/ChannelInfo.js';
import { GroupInfo } from './groups/GroupInfo.js';
import { ensureGroupKeyed, registerGroupChat } from './e2ee.js';
import { sendAttachment } from './attachments/send.js';
import { attachmentPayload, type AttachmentInput } from './attachments/types.js';
import { localBlobs } from './attachments/progress.js';
import type { SenderDeps } from './attachments/send.js';
import { Bubble, rememberSticker } from './chat/MessageBubble.js';
import { MessageMenu, placeMenu, type MenuState } from './chat/MessageMenu.js';
import { dateLabel, gifPayload, isTemp, sameGroup, type MenuAction, type Mode, type PeerPresence, type UiMessage } from './chat/helpers.js';

const PAGE_SIZE = 50;
const NEAR_BOTTOM_PX = 96;
const MENU_CLOSE_MS = 160;
const LEAVE_MS = 300;

const useLatest = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
};

const temporaryId = () => `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const byServerId = (a: UiMessage, b: UiMessage) => isTemp(a.id) ? 1 : isTemp(b.id) ? -1 : Number(BigInt(a.id) - BigInt(b.id));
const byCreated = (a: UiMessage, b: UiMessage) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
/** Server errors may be English; the bubble always shows Persian. */
const faError = (message: string | undefined, fallback: string) => message && !/[A-Za-z]{4}/.test(message) ? message : fallback;
const tempKey = (clientMsgId: string) => `temp-${clientMsgId}`;

/** Insert/replace a server message. Matches by id, then by clientMsgId (the echo of something we sent); keeps the React key stable. */
const upsert = (current: UiMessage[], incoming: UiMessage, me: string, key?: string): UiMessage[] => {
  const index = current.findIndex((item) => item.id === incoming.id || (incoming.clientMsgId && item.clientMsgId === incoming.clientMsgId && !isTemp(item.id)));
  const existing = index >= 0 ? current[index] : undefined;
  const own = incoming.senderId === me && incoming.clientMsgId ? tempKey(incoming.clientMsgId) : undefined;
  const merged: UiMessage = { ...incoming, clientKey: existing?.clientKey ?? key ?? own };
  const next = existing ? current.map((item, i) => i === index ? merged : item) : [...current, merged];
  next.sort(byServerId);
  return next;
};

/**
 * After a reconnect/reset: the freshly fetched latest page replaces the same ids, everything else stays
 * (older pages, pending drafts). If the page does not touch what we have (a gap of > 1 page), the old server rows are dropped instead.
 */
const mergeLatest = (current: UiMessage[], fetched: UiMessage[], pageSize: number): { list: UiMessage[]; replaced: boolean } => {
  const server = current.filter((item) => !isTemp(item.id));
  const drafts = current.filter((item) => isTemp(item.id));
  if (!fetched.length) return { list: current, replaced: false };
  const newestHeld = server.length ? BigInt(server[server.length - 1].id) : undefined;
  const gap = newestHeld !== undefined && fetched.length === pageSize && BigInt(fetched[0].id) > newestHeld;
  const byId = new Map(server.map((item) => [item.id, item]));
  const base = gap ? [] : server.filter((item) => !fetched.some((f) => f.id === item.id));
  const list = [...base, ...fetched.map((item): UiMessage => ({ ...item, clientKey: byId.get(item.id)?.clientKey }))].sort(byServerId);
  return { list: [...list, ...drafts], replaced: gap || !server.length };
};

type Props = {
  chat: Chat;
  currentUser: User;
  realtimeEvent?: RealtimeEvent;
  sync: SyncSignal;
  peerPresence?: PeerPresence;
  sendRealtime: (event: { type: 'typing'; chatId: string; isTyping?: boolean }) => boolean;
  onBack: () => void;
  onChatChanged: (chatId: string, read?: boolean) => void;
};

function ConversationSkeleton() {
  return (
    <div className="conversation-skeleton" aria-label="در حال دریافت پیام‌ها" aria-busy="true">
      <span className="conversation-skeleton__chip" />
      <span className="conversation-skeleton__bubble conversation-skeleton__bubble--in conversation-skeleton__bubble--short" />
      <span className="conversation-skeleton__bubble conversation-skeleton__bubble--out" />
      <span className="conversation-skeleton__bubble conversation-skeleton__bubble--in" />
      <span className="conversation-skeleton__bubble conversation-skeleton__bubble--out conversation-skeleton__bubble--short" />
    </div>
  );
}

export function Conversation({ chat, currentUser, realtimeEvent, sync, peerPresence, sendRealtime, onBack, onChatChanged }: Props) {
  const [infoOpen, setInfoOpen] = useState(false);
  const isChannel = chat.type === 'channel';
  const isGroup = chat.type === 'group';
  const canPost = !isChannel || chat.role === 'owner' || chat.role === 'admin';
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const [showScroll, setShowScroll] = useState(false);
  const [peerReadId, setPeerReadId] = useState<string>();
  const [peerTyping, setPeerTyping] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [fingerprint, setFingerprint] = useState<string>();
  const [keyChanges, setKeyChanges] = useState<NamedKeyChange[]>([]);
  const [keyDismissed, setKeyDismissed] = useState(false);
  const [unreadFromId, setUnreadFromId] = useState<string>();
  const [search, setSearch] = useState<{ query: string; index: number } | null>(null);
  const [outboxRows, setOutboxRows] = useState<OutboxRow[]>(() => listOutbox(chat.id));
  const [restored, setRestored] = useState<Record<string, Pick<UiMessage, 'kind' | 'text' | 'payload'>>>({});

  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const readSent = useRef<string | undefined>(undefined);
  const lastTyping = useRef(0);
  const typingTimer = useRef<number | undefined>(undefined);
  const peerTypingTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const errorTimer = useRef<number | undefined>(undefined);
  const initialUnread = useRef(chat.unreadCount);
  const pendingInitialScroll = useRef(false);
  const freshKeys = useRef(new Set<string>());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadRun = useRef(0);
  const olderLoaded = useRef(false);
  /** Failed bubbles that never reached the outbox (upload / encryption stage): how to run them again. */
  const retryActions = useRef(new Map<string, () => void>());

  // What is on screen: loaded server messages, then everything not confirmed yet (drafts + outbox rows) by send time.
  const all = useMemo(() => {
    const server = messages.filter((item) => !isTemp(item.id));
    const held = new Set(server.map((item) => item.clientMsgId).filter(Boolean));
    const queued = outboxRows.filter((row) => !held.has(row.clientMsgId)).flatMap((row): UiMessage[] => {
      const known = plainOf(row.clientMsgId) as Pick<UiMessage, 'text' | 'payload'> | undefined;
      const value = known ? { kind: row.kind as UiMessage['kind'], ...known } : restored[row.clientMsgId];
      if (!value) return [];
      const failed = row.state === 'failed';
      return [{
        id: tempKey(row.clientMsgId), clientMsgId: row.clientMsgId, clientKey: tempKey(row.clientMsgId), chatId: row.chatId, senderId: currentUser.id,
        kind: value.kind, text: value.text, payload: value.payload, replyToId: row.replyToId, createdAt: new Date(row.createdAt).toISOString(),
        editedAt: null, deletedAt: null, encrypted: null, sender: currentUser,
        optimistic: !failed, failed, attempts: row.attempts, error: failed ? faError(row.error, 'ارسال پیام انجام نشد.') : undefined,
      }];
    });
    const rest = [...messages.filter((item) => isTemp(item.id) && !queued.some((q) => q.id === item.id)), ...queued].sort(byCreated);
    return [...server, ...rest];
  }, [messages, outboxRows, restored, currentUser]);
  const byId = useMemo(() => new Map(all.map((message) => [message.id, message])), [all]);

  const showError = useCallback((copy: string) => {
    setError(copy);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(''), 3200);
  }, []);

  const scrollBottom = useCallback((smooth = false) => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinned.current = true;
    setShowScroll(false);
    setUnreadBelow(0);
  }, []);

  /** Keep the view glued to the bottom while a new row grows in, so older messages slide up smoothly. */
  const follow = useCallback((ms = 380) => {
    const element = viewport.current;
    if (!element) return;
    pinned.current = true;
    const end = performance.now() + ms;
    const step = () => { element.scrollTop = element.scrollHeight; if (performance.now() < end) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    setShowScroll(false);
    setUnreadBelow(0);
  }, []);

  const animateOut = useCallback((message: UiMessage) => {
    setDeleting((current) => new Set(current).add(message.id));
    window.setTimeout(() => {
      setMessages((current) => current.map((item) => item.id === message.id ? message : item));
      setDeleting((current) => { const result = new Set(current); result.delete(message.id); return result; });
    }, LEAVE_MS);
  }, []);

  const markRead = useCallback((items: UiMessage[]) => {
    if (document.visibilityState !== 'visible') return;
    const newest = [...items].reverse().find((item) => item.senderId !== currentUser.id && !item.deletedAt && !item.optimistic);
    if (!newest || newest.id === readSent.current) return;
    readSent.current = newest.id;
    void api.markRead(chat.id, newest.id).then(() => onChatChanged(chat.id, true)).catch(() => { readSent.current = undefined; });
  }, [chat.id, currentUser.id, onChatChanged]);

  const load = useCallback(async () => {
    const run = ++loadRun.current;
    setStatus('loading');
    readSent.current = undefined;
    setUnreadBelow(0);
    setUnreadFromId(undefined);
    freshKeys.current.clear();
    olderLoaded.current = false;
    setMode(null);
    setSearch(null);
    let cacheShown = false;
    let netDone = false;
    // Cached last page (ciphertext in IndexedDB, decrypted here in memory): shown first, the network refreshes it.
    const showCached = async (): Promise<boolean> => {
      const cached = await readCachedMessages(chat.id);
      if (!cached.length || netDone || cacheShown || run !== loadRun.current) return false;
      const result = await decryptMessages(cached);
      if (netDone || cacheShown || run !== loadRun.current) return false;
      cacheShown = true;
      pendingInitialScroll.current = true;
      setMessages(result);
      setHasMore(true);
      setStatus('ready');
      return true;
    };
    // With unread messages we need the fresh page first (the divider position depends on it).
    if (initialUnread.current === 0) void showCached().catch(() => undefined);
    try {
      const raw = await api.messages(chat.id);
      void cacheMessages(chat.id, raw);
      const result = await decryptMessages(raw);
      if (run !== loadRun.current) return;
      netDone = true;
      if (cacheShown) {
        const merged = mergeLatest(messagesRef.current, result, PAGE_SIZE);
        setMessages(merged.list);
        if (merged.replaced) setHasMore(result.length === PAGE_SIZE);
        if (pinned.current) requestAnimationFrame(() => scrollBottom());
      } else {
        const incoming = result.filter((item) => item.senderId !== currentUser.id && !item.deletedAt);
        const unread = initialUnread.current;
        setUnreadFromId(unread > 0 && incoming.length > unread ? incoming[incoming.length - unread].id : undefined);
        pendingInitialScroll.current = true;
        setMessages(result);
        setHasMore(result.length === PAGE_SIZE);
        setStatus('ready');
      }
      initialUnread.current = 0;
      markRead(result);
    } catch {
      if (run !== loadRun.current || cacheShown) return; // cache is already on screen: stay silent
      try { if (!(await showCached())) setStatus('error'); } catch { setStatus('error'); }
    }
  }, [chat.id, currentUser.id, markRead, scrollBottom]);

  useEffect(() => { void load(); }, [load]);
  // Groups: an owner/admin client that opens the group finishes a pending key rotation (and makes the first key).
  const groupId = chat.type === 'group' ? chat.groupId : undefined;
  if (groupId) registerGroupChat(chat.id, groupId);
  useEffect(() => {
    if (!groupId) return;
    let live = true;
    const tick = () => { void ensureGroupKeyed(chat.id, groupId).catch(() => undefined); };
    tick();
    const timer = window.setInterval(tick, 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [chat.id, groupId]);

  useLayoutEffect(() => {
    if (status !== 'ready' || !pendingInitialScroll.current) return;
    pendingInitialScroll.current = false;
    const divider = viewport.current?.querySelector<HTMLElement>('.unread-divider');
    if (divider && viewport.current) {
      viewport.current.scrollTop = divider.offsetTop - 64;
      pinned.current = false;
      setShowScroll(true);
    } else scrollBottom();
  }, [status, messages, scrollBottom]);

  useEffect(() => {
    setFingerprint(undefined);
    void api.chatCrypto(chat.id)
      .then((state) => setFingerprint(state.members.find((member) => member.userId === chat.peer?.id)?.fingerprint ?? undefined))
      .catch(() => undefined);
  }, [chat.id, chat.peer?.id]);

  // A contact whose key differs from the pinned one: show the notice, block sending, never re-pin on our own.
  const refreshKeyChanges = useLatest(async () => {
    try {
      const found = await checkKeyChanges(chat.id);
      if (!found.length) { setKeyChanges([]); return; }
      let names = new Map<string, string>();
      if (isGroup && chat.groupId) names = new Map((await groupsApi.get(chat.groupId)).members.map((member) => [member.id, member.displayName]));
      setKeyChanges(found.map((item) => ({ ...item, name: names.get(item.memberId) ?? chat.peer?.displayName ?? 'مخاطب' })));
    } catch { /* offline or not ready: try again later */ }
  });
  useEffect(() => { setKeyChanges([]); setKeyDismissed(false); void refreshKeyChanges(); }, [chat.id]);
  const undecryptable = messages.filter((item) => item.text?.startsWith('🔒 ')).length;
  useEffect(() => { if (undecryptable) void refreshKeyChanges(); }, [undecryptable]);
  const acceptKey = async (change: NamedKeyChange) => {
    await acceptKeyChange(chat.id, change);
    setKeyChanges([]);
    setKeyDismissed(false);
    await load();
    void refreshKeyChanges();
  };

  /** Apply one server message event to the open list (live or replayed by /api/sync; both are idempotent). */
  const applyEvent = useLatest(async (type: 'message.new' | 'message.edited' | 'message.deleted', raw: Message) => {
    const mine = raw.senderId === currentUser.id;
    if (type === 'message.new' && messagesRef.current.some((item) => item.id === raw.id)) return; // already shown (live echo + sync replay)
    const known = type === 'message.new' && mine ? plainOf(raw.clientMsgId) : undefined; // our own echo: no need to decrypt again
    const message: UiMessage = known ? { ...raw, text: known.text, payload: known.payload } : await decryptMessage(raw);
    if (type === 'message.deleted') { animateOut(message); return; }
    setMessages((current) => {
      const draft = mine && !message.clientMsgId ? current.find((item) => item.optimistic && isTemp(item.id) && item.kind === message.kind && item.replyToId === message.replyToId) : undefined;
      const base = draft ? current.filter((item) => item.id !== draft.id) : current;
      const existing = base.find((item) => item.id === message.id || (message.clientMsgId && item.clientMsgId === message.clientMsgId && !isTemp(item.id)));
      const updated = upsert(base, message, currentUser.id, draft?.id);
      if (type === 'message.new' && !existing) {
        const fresh = updated.find((item) => item.id === message.id)!;
        if (!draft) freshKeys.current.add(fresh.clientKey ?? fresh.id);
        if (pinned.current || mine) requestAnimationFrame(() => follow());
        else setUnreadBelow((count) => count + 1);
        if (!mine && pinned.current) markRead(updated);
      }
      return updated;
    });
  });

  // After a reconnect App hands over what the server log says happened (or reset = refetch and merge).
  const seenSync = useRef(sync.token);
  useEffect(() => {
    if (sync.token === seenSync.current) return; // a signal from before this chat was opened is not for us
    seenSync.current = sync.token;
    if (status === 'error') { void load(); return; }
    if (status !== 'ready') return;
    if (sync.reset) {
      void api.messages(chat.id).then(async (raw) => {
        void cacheMessages(chat.id, raw);
        const result = await decryptMessages(raw);
        const merged = mergeLatest(messagesRef.current, result, PAGE_SIZE);
        setMessages(merged.list);
        if (merged.replaced) { olderLoaded.current = false; setHasMore(result.length === PAGE_SIZE); }
        if (pinned.current) requestAnimationFrame(() => scrollBottom());
        markRead(result);
      }).catch(() => undefined);
      return;
    }
    const mine = sync.events.filter((event) => event.chatId === chat.id);
    if (!mine.length) return;
    void (async () => { for (const event of mine) { try { await applyEvent(event.type, event.message); } catch { /* one bad event must not stop the rest */ } } })();
  }, [sync.token]);

  useEffect(() => {
    const event = realtimeEvent;
    if (!event) return;
    if (event.type === 'typing' && event.chatId === chat.id && event.userId === chat.peer?.id) {
      if (peerTypingTimer.current) clearTimeout(peerTypingTimer.current);
      setPeerTyping(event.isTyping);
      if (event.isTyping) peerTypingTimer.current = window.setTimeout(() => setPeerTyping(false), 4000);
      return;
    }
    if (event.type === 'read' && event.chatId === chat.id && event.userId === chat.peer?.id) { setPeerReadId(event.messageId); return; }
    if (!('message' in event) || event.chatId !== chat.id) return;
    void applyEvent(event.type, event.message).catch(() => undefined);
  }, [realtimeEvent]);

  // Outbox: pending/failed rows of this chat are bubbles (also after a reload); a sent row turns into the saved message.
  useEffect(() => {
    const refresh = () => setOutboxRows(listOutbox(chat.id));
    refresh();
    return onOutboxChange((chatId) => { if (chatId === chat.id) refresh(); });
  }, [chat.id]);

  const outboxSent = useLatest((row: OutboxRow, message: Message) => {
    if (row.chatId !== chat.id) return;
    void cacheEventMessage(message);
    const known = plainOf(row.clientMsgId);
    const finish = (saved: UiMessage) => {
      setMessages((current) => upsert(current, saved, currentUser.id, tempKey(row.clientMsgId)));
      forgetPlain(row.clientMsgId);
      onChatChanged(chat.id);
      if (pinned.current) requestAnimationFrame(() => follow(160));
    };
    if (known) finish({ ...message, text: known.text, payload: known.payload });
    else void decryptMessage(message).then(finish).catch(() => undefined);
  });
  useEffect(() => onOutboxSent(outboxSent), [outboxSent]);

  // Rows restored after a reload have no plaintext in memory (E2EE: never stored): decrypt the ciphertext we kept.
  useEffect(() => {
    for (const row of outboxRows) {
      if (plainOf(row.clientMsgId) || restored[row.clientMsgId]) continue;
      const enc = row.encrypted as Message['encrypted'];
      const fake = { id: tempKey(row.clientMsgId), chatId: row.chatId, senderId: currentUser.id, kind: row.kind, text: null, payload: null, replyToId: row.replyToId, createdAt: '', editedAt: null, deletedAt: null, encrypted: enc } as Message;
      void decryptPlain(fake).then((done) => {
        const label = row.kind === 'sticker' ? 'استیکر' : row.kind === 'gif' ? 'گیف' : undefined;
        const value = label ? { kind: 'text' as const, text: label, payload: null } : { kind: done.kind, text: done.text, payload: done.payload };
        setRestored((current) => ({ ...current, [row.clientMsgId]: value }));
      }).catch(() => undefined);
    }
  }, [outboxRows]);

  useEffect(() => {
    const visible = () => document.visibilityState === 'visible' && markRead(messages);
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [messages, markRead]);

  useEffect(() => () => {
    [typingTimer.current, peerTypingTimer.current, closeTimer.current, errorTimer.current].forEach((timer) => timer && clearTimeout(timer));
  }, []);

  const loadOlder = async () => {
    const first = messages.find((item) => !isTemp(item.id));
    const element = viewport.current;
    if (!first || !element || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const oldHeight = element.scrollHeight;
    const oldTop = element.scrollTop;
    try {
      const result = await decryptMessages(await api.messages(chat.id, first.id));
      olderLoaded.current = true;
      setMessages((current) => [...result.filter((item) => !current.some((held) => held.id === item.id)), ...current]);
      setHasMore(result.length === PAGE_SIZE);
      requestAnimationFrame(() => { element.scrollTop = element.scrollHeight - oldHeight + oldTop; });
    } finally { setLoadingMore(false); }
  };

  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    setShowScroll(!pinned.current);
    if (pinned.current) { setUnreadBelow(0); markRead(messages); }
    if (element.scrollTop < 80) void loadOlder();
  };

  const draft = (partial: Pick<UiMessage, 'kind' | 'text' | 'payload' | 'replyToId'>): UiMessage => ({
    id: temporaryId(), chatId: chat.id, senderId: currentUser.id, encrypted: null, createdAt: new Date().toISOString(),
    editedAt: null, deletedAt: null, sender: currentUser, optimistic: true, ...partial,
  });
  const append = (message: UiMessage) => {
    freshKeys.current.add(message.id);
    setMessages((current) => [...current, message]);
    setMode(null);
    requestAnimationFrame(() => follow());
  };
  const settle = (temporary: UiMessage, saved: UiMessage) => {
    setMessages((current) => [...current.filter((item) => item.id !== saved.id && item.id !== temporary.id), { ...saved, clientKey: temporary.id }]);
    onChatChanged(chat.id);
    if (pinned.current) requestAnimationFrame(() => follow(160));
  };
  const dropDraft = (id: string) => { retryActions.current.delete(id); setMessages((current) => current.filter((item) => item.id !== id)); };
  const markFailed = (id: string, error: string | undefined, again: () => void) => {
    retryActions.current.set(id, again);
    setMessages((current) => current.map((item) => item.id === id ? { ...item, optimistic: false, failed: true, error: error ?? item.error } : item));
  };
  const replyId = mode?.kind === 'reply' ? mode.message.id : null;

  /** Attachments keep the chunked sendAttachment flow; a final failure leaves a failed bubble (retry/delete) instead of vanishing. */
  const attachWith = (input: AttachmentInput, replyTo: string | null): Promise<void> => {
    let failedId: string | undefined;
    const deps: SenderDeps = {
      chatId: chat.id, userId: currentUser.id, replyToId: replyTo, draft, append, settle,
      discard: (temporary) => {
        failedId = temporary.id;
        const info = attachmentPayload(temporary.payload);
        if (info) localBlobs.set(info.attachment.id, input.blob); // so the failed bubble still shows the file
        markFailed(temporary.id, 'ارسال فایل انجام نشد.', () => { dropDraft(temporary.id); void attachWith(input, replyTo); });
      },
      showError: (copy) => {
        if (!failedId) { showError(copy); return; }
        const id = failedId;
        setMessages((current) => current.map((item) => item.id === id ? { ...item, error: copy } : item));
      },
    };
    return sendAttachment(deps, input);
  };
  const attach = (input: AttachmentInput) => attachWith(input, replyId);

  /** Encrypt, then hand the ready-to-send body to the persisted outbox (survives reload/offline, dedupes on retry). */
  const queue = (clientMsgId: string, kind: 'text' | 'sticker' | 'gif', encrypted: OutboundEncryptedPayload, plain: { text: string | null; payload: unknown | null }, replyTo: string | null, encryptedMediaId?: string) => {
    rememberPlain(clientMsgId, plain);
    freshKeys.current.add(tempKey(clientMsgId));
    setMode(null);
    enqueue({ clientMsgId, chatId: chat.id, kind, encrypted, encryptedMediaId, replyToId: replyTo, text: null, payload: null });
    requestAnimationFrame(() => follow());
  };

  const sendText = async (text: string, replyToId: string | null) => {
    try {
      const encrypted = await encryptContent(chat.id, currentUser.id, { kind: 'text', text, payload: null });
      queue(newClientMsgId(), 'text', encrypted, { text, payload: null }, replyToId);
      return true;
    } catch {
      showError('پیام رمزگذاری نشد؛ طرف مقابل باید یک‌بار وارد شود. متن شما نگه داشته شد.');
      return false;
    }
  };

  /** Sticker/GIF: the bubble shows while the encrypted media uploads; once that is done the outbox row takes the bubble over. */
  const sendMedia = async (kind: 'sticker' | 'gif', payload: StickerMessagePayload | GifMessagePayload, source: string | Blob, replyTo: string | null, after?: () => void): Promise<void> => {
    const clientMsgId = newClientMsgId();
    const temporary: UiMessage = { ...draft({ kind, text: null, payload, replyToId: replyTo }), id: tempKey(clientMsgId) };
    append(temporary);
    try {
      const secured = await encryptMediaMessage(chat.id, currentUser.id, kind, payload as unknown as Record<string, unknown>, source);
      queue(clientMsgId, kind, secured.encrypted, { text: null, payload }, replyTo, secured.encryptedMediaId);
      setMessages((current) => current.filter((item) => item.id !== temporary.id));
      after?.();
    } catch {
      markFailed(temporary.id, kind === 'sticker' ? 'استیکر رمزگذاری یا ارسال نشد.' : 'گیف رمزگذاری یا ارسال نشد.', () => { dropDraft(temporary.id); void sendMedia(kind, payload, source, replyTo, after); });
    }
  };

  const sendSticker = async (sticker: Sticker) => {
    const payload: StickerMessagePayload = { packId: sticker.packId, stickerId: sticker.id, fileUrl: sticker.fileUrl, format: sticker.format, emoji: sticker.emoji, w: sticker.w, h: sticker.h };
    rememberSticker(sticker);
    await sendMedia('sticker', payload, sticker.fileUrl, replyId, () => { void api.rememberSticker(sticker.id).catch(() => undefined); });
  };

  const sendGif = async (gif: Gif, source: string | Blob = gif.mp4Url) => {
    const payload: GifMessagePayload = { gifId: gif.id, mp4Url: gif.mp4Url, w: gif.w, h: gif.h, durationMs: gif.durationMs };
    await sendMedia('gif', payload, source, replyId);
  };

  const uploadGif = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) return showError('حجم فایل نباید از ۲۵ مگابایت بیشتر باشد.');
    if (!/\.(gif|mp4)$/i.test(file.name) || !['image/gif', 'video/mp4'].includes(file.type)) return showError('فقط فایل GIF یا MP4 پذیرفته می‌شود.');
    const gif: Gif = { id: `local-${crypto.randomUUID()}`, mp4Url: URL.createObjectURL(file), posterUrl: '', w: 320, h: 240, durationMs: 1, tags: [] };
    await sendGif(gif, file);
  };

  const submit = async (text: string) => {
    if (mode?.kind !== 'edit') return sendText(text, replyId);
    try {
      const encrypted = await encryptContent(chat.id, currentUser.id, { kind: 'text', text, payload: null });
      const saved = { ...await api.editMessage(chat.id, mode.message.id, encrypted), text };
      setMessages((current) => current.map((item) => item.id === saved.id ? saved : item));
      setMode(null);
      onChatChanged(chat.id);
      return true;
    } catch { showError('ویرایش رمزگذاری‌شده انجام نشد.'); return false; }
  };

  const retry = useLatest((message: UiMessage) => {
    const again = retryActions.current.get(message.id);
    if (again) { retryActions.current.delete(message.id); again(); return; }
    if (message.clientMsgId) retryNow(message.clientMsgId);
  });

  const discardFailed = useLatest((message: UiMessage) => {
    if (retryActions.current.has(message.id)) {
      const info = attachmentPayload(message.payload);
      if (info) localBlobs.delete(info.attachment.id);
      dropDraft(message.id);
    } else if (message.clientMsgId) { discardOutbox(message.clientMsgId); forgetPlain(message.clientMsgId); }
  });

  const typing = useCallback((active: boolean) => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (!active) { sendRealtime({ type: 'typing', chatId: chat.id, isTyping: false }); lastTyping.current = 0; return; }
    const now = Date.now();
    if (now - lastTyping.current >= 3000) { sendRealtime({ type: 'typing', chatId: chat.id, isTyping: true }); lastTyping.current = now; }
    typingTimer.current = window.setTimeout(() => { sendRealtime({ type: 'typing', chatId: chat.id, isTyping: false }); lastTyping.current = 0; }, 3000);
  }, [chat.id, sendRealtime]);

  const openMenu = useLatest((message: UiMessage, x: number, y: number) => {
    const spot = placeMenu(message, message.senderId === currentUser.id, x, y);
    setMenu({ message, ...spot, closing: false });
  });
  const closeMenu = useCallback(() => {
    setMenu((current) => current && { ...current, closing: true });
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenu(null), MENU_CLOSE_MS);
  }, []);
  const startReply = useLatest((message: UiMessage) => setMode({ kind: 'reply', message }));

  const jump = useCallback((id: string) => {
    const element = viewport.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!element) return showError('پیام اصلی در پیام‌های بارگذاری‌شده نیست.');
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.remove('msg--highlight');
    requestAnimationFrame(() => element.classList.add('msg--highlight'));
    window.setTimeout(() => element.classList.remove('msg--highlight'), 1600);
  }, [showError]);

  const runAction = (name: MenuAction) => {
    const selected = menu?.message;
    if (!selected) return;
    closeMenu();
    if (name === 'reply') setMode({ kind: 'reply', message: selected });
    if (name === 'edit') setMode({ kind: 'edit', message: selected });
    if (name === 'copy' && selected.text) void navigator.clipboard.writeText(selected.text).then(() => showError('متن کپی شد.')).catch(() => showError('کپی متن انجام نشد.'));
    if (name === 'save-gif') {
      const payload = gifPayload(selected.payload);
      if (payload && !payload.gifId.startsWith('local-')) {
        void api.saveGif(payload.gifId).then(() => { window.dispatchEvent(new Event('saved-gifs-changed')); showError('گیف ذخیره شد.'); }).catch(() => showError('ذخیرهٔ گیف انجام نشد.'));
      }
    }
    if (name === 'delete') {
      setDeleting((current) => new Set(current).add(selected.id));
      const pause = new Promise((resolve) => window.setTimeout(resolve, LEAVE_MS));
      void Promise.allSettled([api.deleteMessage(chat.id, selected.id), pause]).then(([result]) => {
        if (result.status === 'fulfilled') { const saved = result.value; setMessages((current) => current.map((item) => item.id === saved.id ? saved : item)); onChatChanged(chat.id); }
        else showError('حذف پیام انجام نشد.');
        setDeleting((current) => { const next = new Set(current); next.delete(selected.id); return next; });
      });
    }
  };

  // In-chat search runs over the messages that are already loaded and decrypted.
  const needle = search?.query.trim().toLocaleLowerCase('fa-IR') ?? '';
  const matches = useMemo(
    () => needle ? all.filter((item) => !item.deletedAt && item.text?.toLocaleLowerCase('fa-IR').includes(needle)) : [],
    [all, needle],
  );
  const activeMatch = search && matches.length ? matches[Math.min(search.index, matches.length - 1)] : undefined;
  const searchState: SearchState | null = search && { query: search.query, total: matches.length, index: Math.min(search.index, Math.max(0, matches.length - 1)) };

  useEffect(() => { if (activeMatch) jump(activeMatch.id); }, [activeMatch?.id]);

  // Deleted messages disappear; one that is still animating out stays until it has gone.
  const visible = useMemo(() => all.filter((message) => !message.deletedAt || deleting.has(message.id)), [all, deleting]);
  const days = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: Array<{ message: UiMessage; index: number }> }> = [];
    visible.forEach((message, index) => {
      const key = dayKey(message.createdAt);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.items.push({ message, index });
      else groups.push({ key, label: dateLabel(message.createdAt), items: [{ message, index }] });
    });
    return groups;
  }, [visible]);

  return (
    <section className="conversation" aria-label={isGroup ? `گروه ${chat.title ?? ''}` : isChannel ? `کانال ${chat.title ?? ''}` : chat.peer ? `گفتگو با ${chat.peer.displayName}` : 'پیام‌های ذخیره‌شده'}>
      <ChatHeader
        peer={chat.peer} saved={!isChannel && !isGroup && (chat.type === 'saved' || !chat.peer)} channel={isGroup ? { title: chat.title ?? 'گروه', memberCount: chat.memberCount ?? 0, onInfo: () => setInfoOpen(true), groupId: chat.groupId } : isChannel ? { title: chat.title ?? 'کانال', memberCount: chat.memberCount ?? 0, onInfo: () => setInfoOpen(true) } : undefined} presence={peerPresence} typing={peerTyping} fingerprint={fingerprint} search={searchState}
        onSearchOpen={() => setSearch({ query: '', index: 0 })}
        onSearchClose={() => setSearch(null)}
        onSearchQuery={(query) => setSearch({ query, index: Number.MAX_SAFE_INTEGER })}
        onSearchStep={(direction) => setSearch((current) => current && matches.length ? { ...current, index: (Math.min(current.index, matches.length - 1) + direction + matches.length) % matches.length } : current)}
        onCopyFingerprint={(value) => void navigator.clipboard.writeText(value).then(() => showError('اثر انگشت کپی شد؛ آن را خارج از NoSignal با مخاطب مقایسه کنید.')).catch(() => showError(value))}
        onBack={onBack}
      />
      {keyChanges.length > 0 && !keyDismissed && <KeyChangeBanner changes={keyChanges} onAccept={acceptKey} onDismiss={() => setKeyDismissed(true)} />}
      <div className="conversation__body">
        <div className="viewport" ref={viewport} onScroll={onScroll}>
          <div className="column" aria-live="polite">
            {loadingMore && <div className="history-loader"><span className="spinner" />پیام‌های قدیمی‌تر</div>}
            {status === 'loading' && <ConversationSkeleton />}
            {status === 'error' && <div className="conversation-state"><span>پیام‌ها دریافت نشد.</span><button className="text-button" onClick={() => void load()}>تلاش دوباره</button></div>}
            {status === 'ready' && !visible.length && <div className="conversation-state conversation-state--empty"><strong>{isChannel ? 'هنوز پستی نیست' : isGroup ? 'هنوز پیامی نیست' : 'گفتگو را شروع کنید'}</strong><span>{isGroup ? 'اولین پیام گروه را بفرستید.' : isChannel ? (canPost ? 'اولین پست کانال را منتشر کنید.' : 'پست‌های کانال اینجا نمایش داده می‌شوند.') : chat.peer ? `اولین پیام را برای ${chat.peer.displayName} بفرستید.` : 'هر چیزی را برای خودتان اینجا نگه دارید.'}</span></div>}
            {status === 'ready' && days.map((day) => (
              <section className="day" key={day.key}>
                <div className="day__chip"><span>{day.label}</span></div>
                {day.items.map(({ message, index }) => (
                  <Fragment key={message.clientKey ?? message.id}>
                    {message.id === unreadFromId && <div className="unread-divider"><span>پیام‌های خوانده‌نشده</span></div>}
                    {isGroup && message.senderId !== currentUser.id && !message.deletedAt && !isTemp(message.id) && (message.id === unreadFromId || !sameGroup(visible[index - 1], message)) && <div className="group-sender" dir="auto">{message.sender?.displayName ?? ''}</div>}
                    <Bubble
                      message={message} previous={visible[index - 1]} next={visible[index + 1]}
                      reply={message.replyToId ? byId.get(message.replyToId) : undefined}
                      me={currentUser.id} readId={peerReadId} deleting={deleting.has(message.id)} enter={freshKeys.current.has(message.clientKey ?? message.id)}
                      needle={needle} active={activeMatch?.id === message.id}
                      onRetry={retry} onDiscard={discardFailed} onMenu={openMenu} onReply={startReply} onJump={jump}
                    />
                  </Fragment>
                ))}
              </section>
            ))}
          </div>
        </div>
        {error && <div className="toast" role="status">{error}</div>}
        <button className={`scroll-bottom${showScroll || unreadBelow ? ' scroll-bottom--visible' : ''}`} type="button" onClick={() => scrollBottom(true)} aria-label="رفتن به آخر گفتگو" tabIndex={showScroll || unreadBelow ? 0 : -1}>
          <DownIcon />{unreadBelow > 0 && <span>{faNumber(unreadBelow)}</span>}
        </button>
      </div>
      {keyChanges.length > 0
        ? <div className="channel-readonly" role="note">تا تأیید کلید جدید، ارسال پیام ممکن نیست.{keyDismissed && <> <button className="text-button" type="button" onClick={() => setKeyDismissed(false)}>بررسی کلید</button></>}</div>
        : canPost
        ? <Composer mode={mode} cancel={() => setMode(null)} submit={submit} sendAttachment={attach} sendSticker={sendSticker} sendGif={sendGif} uploadGif={uploadGif} typing={typing} />
        : <div className="channel-readonly" role="note">فقط مدیران کانال می‌توانند پست بگذارند.</div>}
      {isGroup && chat.groupId && <GroupInfo open={infoOpen} groupId={chat.groupId} chatId={chat.id} onClose={() => setInfoOpen(false)} onChanged={() => onChatChanged(chat.id)} onGone={() => { onBack(); onChatChanged(chat.id); }} />}
      {isChannel && <ChannelInfo open={infoOpen} channelId={chat.channelId ?? chat.id} onClose={() => setInfoOpen(false)} onChanged={() => onChatChanged(chat.id)} onGone={() => { onBack(); onChatChanged(chat.id); }} />}
      {menu && <MessageMenu menu={menu} me={currentUser.id} close={closeMenu} action={runAction} />}
    </section>
  );
}
