import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, notifyUnauthorized, onUnauthorized, type Chat, type RealtimeEvent, type User } from './api.js';
import { onOutboxSent, setStaleKeyRecovery, startOutbox } from './outbox.js';
import { clearMediaCache } from './mediaCache.js';
import { baselineSeq, cacheChats, cacheEventMessage, catchUp, clearCache, type CatchUp as CatchUpResult, noteLiveSeq, plainOf, prepareCache, readCachedChats, type SyncSignal } from './sync.js';
import { ChatIcon } from './icons.js';
import { Conversation } from './Conversation.js';
import { NewChatDialog, SettingsDialog } from './Dialogs.js';
import { LoadingScreen, LoginPage } from './Login.js';
import { Sidebar } from './Sidebar.js';
import { useRealtime } from './realtime.js';
import { decryptMessage, KeyChangedError, reencryptForStaleKey, registerChannelChats, registerGroupChats, getBackup, hasLocalIdentity, importIdentity, initializeEncryption, resetIdentity } from './e2ee.js';
import { JoinPage, inviteTokenFromPath } from './join/JoinPage.js';
import { RecoveryScreen } from './backup/RecoveryScreen.js';
import { clearBackupAccount, fetchServerBackup, setBackupAccount, uploadBackup } from './backup/serverBackup.js';
import { BackupWarning } from './backup/BackupWarning.js';
import { BackupSaveNotice } from './backup/BackupSaveNotice.js';
import { CreateGroupDialog } from './groups/CreateGroupDialog.js';
import { CreateChannelDialog } from './channels/CreateChannelDialog.js';
import { ChannelJoin } from './channels/ChannelJoin.js';
import { channelTokenFromPath } from './channels/channelsApi.js';

type Theme = 'light' | 'dark';
type AuthState = { status: 'checking' } | { status: 'guest' } | { status: 'ready'; user: User };

const savedTheme = (): Theme => {
  try {
    const stored = localStorage.getItem('tel-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* storage can be blocked */ }
  return 'dark';
};

const activity = (chat: Chat) => new Date(chat.lastMessage?.createdAt ?? chat.createdAt).getTime();

function EmptyConversation() {
  return (
    <section className="conversation conversation--empty">
      <span className="hint-pill"><ChatIcon />یک گفتگو را انتخاب کنید</span>
    </section>
  );
}

type MessengerProps = { initialChatId?: string; user: User; theme: Theme; onToggleTheme: () => void; onLogout: () => void };

function Messenger({ initialChatId, user, theme, onToggleTheme, onLogout }: MessengerProps) {
  const [chats, setChats] = useState<Chat[]>([]);
  const chatsRef = useRef<Chat[]>([]);
  chatsRef.current = chats;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedId, setSelectedId] = useState<string | undefined>(initialChatId);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [realtimeEvent, setRealtimeEvent] = useState<RealtimeEvent>();
  const [sync, setSync] = useState<SyncSignal>({ token: 0, reset: false, events: [] });
  const [gate, setGate] = useState<'checking' | 'import' | 'ready'>('checking');
  const [canBackup, setCanBackup] = useState(false);
  const [powerMode, setPowerMode] = useState(false);
  const [presence, setPresence] = useState<Record<string, { online: boolean; lastSeen: string | null }>>({});
  const [cryptoOk, setCryptoOk] = useState(false);
  const [bannerOn, setBannerOn] = useState(false);
  const cryptoReady = useRef(false);
  const registered = useRef(false);
  const chatsFresh = useRef(false);
  const chatCount = useRef(0);
  chatCount.current = chats.length;

  const decryptChats = useCallback((raw: Chat[]) => {
    registerChannelChats(raw);
    registerGroupChats(raw);
    return Promise.all(raw.map(async (chat) => ({ ...chat, lastMessage: chat.lastMessage ? await decryptMessage(chat.lastMessage) : null })));
  }, []);

  // The cache holds the server form (ciphertext) only; decryption happens here, in memory.
  const fetchChats = useCallback(async () => {
    const raw = await api.chats();
    void cacheChats(raw);
    chatsFresh.current = true;
    return decryptChats(raw);
  }, [decryptChats]);

  const loadChats = useCallback(async (showLoading = true) => {
    if (showLoading && chatCount.current === 0) setStatus('loading');
    try {
      setChats(await fetchChats());
      setStatus('ready');
    } catch {
      if (showLoading && chatCount.current === 0) setStatus('error'); // with a cached list on screen a failed refresh stays silent
    }
  }, [fetchChats]);

  const startEncryption = useCallback((hasKey = false) => (async () => {
    try {
      await initializeEncryption(user.id);
      registered.current = true;
    } catch (caught) {
      if (!hasKey) {
        // Account already has an identity but this browser has no key: offer the recovery choices instead of an error.
        if (caught instanceof ApiError && caught.status === 409) { setGate('import'); return; }
        setGate('ready'); setStatus('error'); return;
      }
      // The key is on this device; only registering it failed (offline). Work from the cache, register at the next reconnect.
    }
    try {
      setCanBackup((await getBackup()) !== null);
      void fetchServerBackup().then((state) => setPowerMode(state?.mode === 'manual')).catch(() => undefined);
      cryptoReady.current = true;
      setCryptoOk(true);
      setGate('ready');
      void readCachedChats().then(decryptChats).then((list) => { if (!chatsFresh.current && list.length) setChats(list); }).catch(() => undefined);
      await Promise.all([baselineSeq(), loadChats()]); // request order matters: the cursor is read no later than the list
    } catch { setGate('ready'); setStatus('error'); }
  })(), [user.id, loadChats, decryptChats]);

  useEffect(() => {
    let live = true;
    let stopOutbox: (() => void) | undefined;
    // A queued text whose chat key version went stale (a contact started fresh): seal it again with the new version while the
    // plaintext is still in memory. After a reload the plaintext is gone, so it fails with a clear message instead.
    const stopRecovery = setStaleKeyRecovery(async (row) => {
      const plain = plainOf(row.clientMsgId);
      if (!plain || typeof plain.text !== 'string') throw new Error('کلید گفت‌وگو عوض شده و متن این پیام دیگر در حافظه نیست؛ دوباره بفرستید.');
      try { return await reencryptForStaleKey(row.chatId, user.id, { kind: 'text', text: plain.text, payload: null }); } catch (caught) {
        if (caught instanceof KeyChangedError) throw new Error('کلید رمزنگاری مخاطب عوض شده است. پس از تأیید آن، پیام را دوباره بفرستید.');
        throw new Error('پیام با کلید جدید رمزگذاری نشد؛ دوباره بفرستید.');
      }
    });
    void (async () => {
      await prepareCache(user.id);
      if (!live) return;
      stopOutbox = startOutbox(); // pending/failed messages of an earlier session go out again
      let hasKey = false;
      try { hasKey = await hasLocalIdentity(user.id); } catch { /* fall through to normal init */ }
      if (hasKey) {
        // Open instantly from the local cache (list only; previews are decrypted once the key is loaded).
        const cached = await readCachedChats();
        if (live && cached.length && !chatsFresh.current) { setChats(cached); setStatus('ready'); setGate('ready'); }
      } else {
        // New device (no local key; a password login already restored it from the server copy when there was one) of an account that already has chats: offer the recovery choices.
        // Channels need no personal key and an empty saved chat holds nothing to lose.
        try { if ((await api.chats()).some((chat) => chat.type !== 'channel' && chat.type !== 'group' && (chat.type !== 'saved' || chat.lastMessage))) { setGate('import'); return; } } catch { /* fall through to normal init */ }
      }
      await startEncryption(hasKey);
    })();
    return () => { live = false; stopOutbox?.(); stopRecovery(); };
  }, [user.id]);

  /** Chat-list part of a message/chat event (shared by live events and events replayed by polling). */
  const applyToList = (event: RealtimeEvent) => {
    if (!cryptoReady.current) return; // the list is rebuilt as soon as the key is ready
    if (event.type === 'presence') {
      setPresence((current) => ({ ...current, [event.userId]: { online: event.online, lastSeen: event.lastSeen } }));
    } else if ((event.type as string) === 'chat.new') {
      void loadChats(false); // added to a new direct chat / group: show it without a reload
    } else if (event.type === 'message.new') {
      if (!chatsRef.current.some((chat) => chat.id === event.chatId)) { void loadChats(false); return; } // first message of a chat we do not list yet
      void decryptMessage(event.message).then((message) => setChats((current) => current
        .map((chat) => chat.id === event.chatId ? {
          ...chat,
          lastMessage: message,
          unreadCount: message.senderId !== user.id && chat.id !== selectedId ? chat.unreadCount + 1 : chat.unreadCount,
        } : chat)
        .sort((a, b) => activity(b) - activity(a))));
    } else if (event.type === 'message.edited') {
      void decryptMessage(event.message).then((message) => setChats((current) => current.map((chat) => chat.id === event.chatId && chat.lastMessage?.id === message.id ? { ...chat, lastMessage: message } : chat)));
    } else if (event.type === 'message.deleted') {
      void loadChats(false);
    }
  };

  /** What a reconnect does with a catch-up result: refresh lists and hand the open conversation the missed events. */
  const applyCatchUp = (pending: Promise<CatchUpResult>) => {
    if (!cryptoReady.current) return;
    if (!registered.current) void initializeEncryption(user.id).then(() => { registered.current = true; }).catch(() => undefined);
    void loadChats(false);
    void pending.then((result) => {
      for (const event of result.events) void cacheEventMessage(event.message);
      setSync((current) => ({ token: current.token + 1, reset: result.reset, events: result.events }));
    }).catch(() => setSync((current) => ({ token: current.token + 1, reset: true, events: [] })));
  };

  const realtime = useRealtime((event) => {
    setRealtimeEvent(event);
    if ('message' in event) { noteLiveSeq(event.seq); void cacheEventMessage(event.message); }
    applyToList(event);
  }, () => {
    // Called synchronously on reconnect: catchUp() marks "syncing" first so live events cannot skip the gap.
    applyCatchUp(catchUp());
  }, () => notifyUnauthorized(), async (full) => {
    // Polling transport (WS and SSE both blocked): one /api/sync per tick. Throws on network error / 401 so the client can back off.
    const result = await catchUp();
    if (full || result.reset) { applyCatchUp(Promise.resolve(result)); return; }
    if (!result.events.length) return;
    for (const event of result.events) void cacheEventMessage(event.message);
    setSync((current) => ({ token: current.token + 1, reset: false, events: result.events }));
    for (const event of result.events) applyToList({ type: event.type, chatId: event.chatId, message: event.message, seq: event.seq });
  });

  // A sent message moves the chat list preview; the open conversation does this itself.
  useEffect(() => onOutboxSent((row) => { realtime.nudge(); if (row.chatId !== selectedId) void loadChats(false); }), [selectedId, loadChats]);

  useEffect(() => {
    if (realtime.state !== 'offline') { setBannerOn(false); return; }
    const timer = window.setTimeout(() => setBannerOn(true), 3000);
    return () => window.clearTimeout(timer);
  }, [realtime.state]);

  const selected = chats.find((chat) => chat.id === selectedId);

  const handleCreated = async (chatId: string) => {
    setChats(await fetchChats());
    setStatus('ready');
    setSelectedId(chatId);
  };

  const openSaved = async () => { await handleCreated((await api.createSavedChat()).id); };
  const openChatWith = async (userId: string) => { await handleCreated((await api.createChat(userId)).id); };

  const handleChatChanged = useCallback((chatId: string, read = false) => {
    if (read) setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, unreadCount: 0 } : chat));
    void loadChats(false);
  }, [loadChats]);

  if (gate === 'checking') return <LoadingScreen />;
  if (gate === 'import') {
    return (
      <RecoveryScreen
        userId={user.id}
        onLogout={onLogout}
        onRestored={async (payload) => { await importIdentity(payload); await startEncryption(); }}
        onFresh={async (password, secondFactor) => {
          await resetIdentity(user.id, password, secondFactor);
          try {
            const payload = await getBackup();
            if (payload && (await fetchServerBackup())?.mode !== 'manual') await uploadBackup(payload, password);
          } catch { /* the next password login uploads it */ }
          await startEncryption();
        }}
      />
    );
  }

  return (
    <main className={`messenger${selected ? ' messenger--chat-open' : ''}`}>
      {bannerOn && <div className="net-banner" role="status">اتصال برقرار نیست… در حال تلاش دوباره</div>}
      <Sidebar
        user={user} theme={theme} chats={chats} status={status} presence={presence} selectedId={selectedId}
        onSelect={setSelectedId} onOpenSaved={openSaved} onOpenChatWith={openChatWith} onRetry={() => void loadChats()} onNewChat={() => setNewChatOpen(true)} onNewChannel={() => setNewChannelOpen(true)} onNewGroup={() => setNewGroupOpen(true)}
        onSettings={() => setSettingsOpen(true)} onToggleTheme={onToggleTheme} onLogout={onLogout}
      />
      <BackupSaveNotice ready={cryptoOk} />
      {canBackup && powerMode && <div className="backup-warning"><BackupWarning userId={user.id} onBackup={() => setSettingsOpen(true)} /></div>}
      <section className="chat-pane" aria-label="گفتگو">
        {selected && !cryptoOk
          ? <section className="conversation conversation--empty"><span className="hint-pill">در حال آماده‌سازی…</span></section>
          : selected
          ? <Conversation key={selected.id} chat={selected} currentUser={user} realtimeEvent={realtimeEvent} sync={sync} peerPresence={selected.peer ? presence[selected.peer.id] : undefined} sendRealtime={realtime.send} onBack={() => setSelectedId(undefined)} onChatChanged={handleChatChanged} />
          : <EmptyConversation />}
      </section>
      <NewChatDialog open={newChatOpen} onClose={() => setNewChatOpen(false)} onCreated={handleCreated} />
      <CreateGroupDialog open={newGroupOpen} onClose={() => setNewGroupOpen(false)} onCreated={handleCreated} />
      <CreateChannelDialog open={newChannelOpen} onClose={() => setNewChannelOpen(false)} onCreated={handleCreated} />
      <SettingsDialog open={settingsOpen} userId={user.id} getBackup={getBackup} onImport={importIdentity} onClose={() => { setSettingsOpen(false); void fetchServerBackup().then((state) => setPowerMode(state?.mode === 'manual')).catch(() => undefined); }} />
    </main>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [channelToken, setChannelToken] = useState(() => channelTokenFromPath(window.location.pathname));
  const [openChatId, setOpenChatId] = useState<string>();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17212b' : '#ffffff');
    try { localStorage.setItem('tel-theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => onUnauthorized(() => { clearBackupAccount(); void clearMediaCache(); setAuth({ status: 'guest' }); }), []);
  useEffect(() => { void api.me().then((user) => { setBackupAccount(user.id); setAuth({ status: 'ready', user }); }).catch(() => setAuth({ status: 'guest' })); }, []);

  const joinToken = inviteTokenFromPath(window.location.pathname);

  const toggleTheme = () => setTheme((value) => value === 'dark' ? 'light' : 'dark');
  const logout = async () => { clearBackupAccount(); try { await api.logout(); } finally { void clearCache(); setAuth({ status: 'guest' }); } };

  if (auth.status !== 'ready' && joinToken) return <JoinPage token={joinToken} theme={theme} onToggleTheme={toggleTheme} onJoined={(user) => { window.history.replaceState(null, '', '/'); setAuth({ status: 'ready', user }); }} />;
  if (auth.status === 'checking') return <LoadingScreen />;
  if (auth.status === 'guest') return <LoginPage theme={theme} onToggleTheme={toggleTheme} onAuthenticated={(user) => setAuth({ status: 'ready', user })} />;
  if (channelToken) return <ChannelJoin token={channelToken} onDone={(chatId) => { window.history.replaceState(null, '', '/'); setOpenChatId(chatId); setChannelToken(null); }} />;
  return <Messenger initialChatId={openChatId} user={auth.user} theme={theme} onToggleTheme={toggleTheme} onLogout={() => void logout()} />;
}
