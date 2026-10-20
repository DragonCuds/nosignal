import { useEffect, useState } from 'react';
import { api, type Chat, type User } from './api.js';
import { CheckIcon, CloseIcon, CopyIcon, ComposeIcon, LogoutIcon, MenuIcon, MoonIcon, SearchIcon, SettingsIcon, SunIcon } from './icons.js';
import { Avatar, faNumber, listTimeLabel } from './ui.js';
import { fieldDir } from './chat/helpers.js';
import { withEmoji } from './emoji.js';
import { ChatListState } from './Dialogs.js';
import { MegaphoneIcon } from './channels/ChannelIcon.js';
import { GroupAvatar, UsersIcon } from './groups/GroupIcon.js';
import './styles/signup.css';
import './channels/channels.css';
import './groups/groups.css';

export const SAVED_TITLE = 'پیام‌های ذخیره‌شده';

const BookmarkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4.2L5.5 20V5a1 1 0 0 1 1-1Z" /></svg>
);

type Theme = 'light' | 'dark';
type Presence = Record<string, { online: boolean; lastSeen: string | null }>;

export const messagePreview = (chat: Chat, currentUserId: string): { prefix?: string; text: string } => {
  const message = chat.lastMessage;
  if (!message) return { text: 'گفتگو هنوز شروع نشده' };
  const prefix = message.senderId === currentUserId ? 'شما: ' : undefined;
  if (message.deletedAt) return { prefix, text: 'پیام حذف شده' };
  if (message.kind === 'sticker') return { prefix, text: 'استیکر' };
  if (message.kind === 'gif') return { prefix, text: 'گیف' };
  if (message.kind === 'photo') return { prefix, text: 'تصویر' };
  if (message.kind === 'video') return { prefix, text: 'ویدیو' };
  if (message.kind === 'voice') return { prefix, text: 'پیام صوتی' };
  if (message.kind === 'file') return { prefix, text: 'فایل' };
  return { prefix, text: message.text ?? 'پیام' };
};

function ChatRow({ chat, currentUserId, selected, online, onSelect }: { chat: Chat; currentUserId: string; selected: boolean; online: boolean; onSelect: () => void }) {
  const preview = messagePreview(chat, currentUserId);
  if (!chat.lastMessage && chat.type === 'saved') preview.text = 'پیام، فایل و یادداشت‌های خودتان';
  const activity = chat.lastMessage?.createdAt ?? chat.createdAt;
  const mine = chat.lastMessage?.senderId === currentUserId;
  const channel = chat.type === 'channel';
  if (channel && !chat.lastMessage) preview.text = 'هنوز پستی منتشر نشده';
  const group = chat.type === 'group';
  if (group && !chat.lastMessage) preview.text = 'هنوز پیامی نیست';
  const saved = !channel && !group && (chat.type === 'saved' || !chat.peer);
  return (
    <button className={`chat-row${saved ? ' chat-row--saved' : ''}${channel ? ' chat-row--channel' : ''}${group ? ' chat-row--group' : ''}${selected ? ' chat-row--selected' : ''}`} type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
      {group ? <GroupAvatar id={chat.groupId ?? chat.id} title={chat.title ?? ''} size={52} /> : channel ? <span className="avatar-saved" aria-hidden="true"><MegaphoneIcon /></span> : saved || !chat.peer ? <span className="avatar-saved" aria-hidden="true"><BookmarkIcon /></span> : <Avatar user={chat.peer} size={52} online={online} />}
      <span className="chat-row__body">
        <span className="chat-row__top">
          <strong dir="auto">{group ? chat.title ?? 'گروه' : channel ? chat.title ?? 'کانال' : saved || !chat.peer ? SAVED_TITLE : chat.peer.displayName}</strong>
          <span className="chat-row__time">{mine && <CheckIcon />}<time dateTime={activity}>{listTimeLabel(activity)}</time></span>
        </span>
        <span className="chat-row__bottom">
          <span className="chat-row__preview" dir="auto">{preview.prefix && <span className="chat-row__you">{preview.prefix}</span>}{withEmoji(preview.text)}</span>
          {chat.unreadCount > 0 && <span className="badge">{faNumber(chat.unreadCount)}</span>}
        </span>
      </span>
    </button>
  );
}

type Props = {
  user: User; theme: Theme; chats: Chat[]; status: 'loading' | 'ready' | 'error'; presence: Presence; selectedId?: string;
  onSelect: (id: string) => void; onOpenSaved: () => Promise<void>; onOpenChatWith: (userId: string) => Promise<void>; onRetry: () => void; onNewChat: () => void; onNewChannel: () => void; onNewGroup: () => void; onSettings: () => void; onToggleTheme: () => void; onLogout: () => void;
};

export function Sidebar({ user, theme, chats, status, presence, selectedId, onSelect, onOpenSaved, onOpenChatWith, onRetry, onNewChat, onNewChannel, onNewGroup, onSettings, onToggleTheme, onLogout }: Props) {
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [menuOpen]);

  const [idQuery, setIdQuery] = useState('');
  const [idResults, setIdResults] = useState<User[]>([]);
  const [idState, setIdState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [openingId, setOpeningId] = useState<string>();
  const [copied, setCopied] = useState(false);

  const idTerm = idQuery.trim().replace(/^@+/, '');
  useEffect(() => {
    if (idTerm.length < 3) { setIdResults([]); setIdState('idle'); return; }
    setIdState('loading');
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.searchUsers(idTerm, controller.signal)
        .then((found) => { setIdResults(found); setIdState('done'); })
        .catch(() => { if (!controller.signal.aborted) { setIdResults([]); setIdState('error'); } });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [idTerm]);

  const openWith = async (target: User) => {
    setOpeningId(target.id);
    try { await onOpenChatWith(target.id); setIdQuery(''); } catch { setIdState('error'); } finally { setOpeningId(undefined); }
  };

  const copyId = async () => {
    const text = `@${user.username}`;
    try { await navigator.clipboard.writeText(text); } catch {
      const area = document.createElement('textarea');
      area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const needle = query.trim().toLocaleLowerCase('fa-IR');
  const savedChat = chats.find((chat) => chat.type === 'saved');
  const directChats = chats.filter((chat) => chat.type !== 'saved' && (chat.peer || chat.type === 'channel' || chat.type === 'group'));
  const shown = needle ? directChats.filter((chat) => `${chat.title ?? ''} ${chat.peer?.displayName} ${chat.peer?.username} ${messagePreview(chat, user.id).text}`.toLocaleLowerCase('fa-IR').includes(needle)) : directChats;
  const savedShown = !needle || SAVED_TITLE.includes(needle);
  const savedRow: Chat = savedChat ?? { id: 'saved-virtual', type: 'saved', createdAt: new Date(0).toISOString(), peer: null, unreadCount: 0, lastMessage: null };
  const go = (action: () => void) => () => { setMenuOpen(false); action(); };

  return (
    <aside className="sidebar" aria-label="فهرست گفتگوها">
      <header className="sidebar__head">
        <label className="search-pill">
          <SearchIcon />
          <input type="search" dir={fieldDir(query)} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجو" aria-label="جست‌وجوی گفتگوها" />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="پاک کردن جست‌وجو"><CloseIcon /></button>}
        </label>
        <button className="icon-button" type="button" onClick={() => setMenuOpen(true)} aria-label="منو" aria-expanded={menuOpen}><MenuIcon /></button>
      </header>
      <div className="sidebar__idsearch">
        <label className="search-pill">
          <SearchIcon />
          <input type="search" dir="ltr" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={idQuery} onChange={(event) => setIdQuery(event.target.value)} placeholder="جستجوی آیدی" aria-label="جستجوی آیدی" />
          {idQuery && <button type="button" onClick={() => setIdQuery('')} aria-label="پاک کردن"><CloseIcon /></button>}
        </label>
        {idTerm.length >= 3 && (
          <div className="idsearch__results" aria-live="polite">
            {idState === 'loading' && <span className="idsearch__note">در حال جستجو…</span>}
            {idState === 'error' && <span className="idsearch__note">جستجو انجام نشد. دوباره تلاش کنید.</span>}
            {idState === 'done' && idResults.length === 0 && <span className="idsearch__note">کاربری با این آیدی پیدا نشد.</span>}
            {idState === 'done' && idResults.map((found) => (
              <button className="idsearch__result" type="button" key={found.id} disabled={Boolean(openingId)} onClick={() => void openWith(found)}>
                <Avatar user={found} size={40} />
                <span><strong dir="auto">{found.displayName}</strong><small>{`\u2066@${found.username}\u2069`}</small></span>
                {openingId === found.id && <span className="spinner spinner--accent" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="sidebar__list" aria-live="polite">
        {savedShown && <ChatRow chat={savedRow} currentUserId={user.id} selected={Boolean(savedChat) && savedChat?.id === selectedId} online={false} onSelect={() => { if (savedChat) onSelect(savedChat.id); else void onOpenSaved(); }} />}
        {status === 'loading' && <ChatListState kind="loading" />}
        {status === 'error' && <ChatListState kind="error" onRetry={onRetry} />}
        {status === 'ready' && shown.map((chat) => <ChatRow key={chat.id} chat={chat} currentUserId={user.id} selected={chat.id === selectedId} online={Boolean(chat.peer && presence[chat.peer.id]?.online)} onSelect={() => onSelect(chat.id)} />)}
        {status === 'ready' && shown.length === 0 && !(savedShown && needle) && <ChatListState kind={query ? 'search' : 'empty'} />}
      </div>
      <button className="fab" type="button" onClick={onNewChat} aria-label="گفتگوی جدید" title="گفتگوی جدید"><ComposeIcon /></button>

      <div className={`drawer${menuOpen ? ' drawer--open' : ''}`} aria-hidden={!menuOpen}>
        <button className="drawer__scrim" type="button" tabIndex={-1} onClick={() => setMenuOpen(false)} aria-label="بستن منو" />
        <nav className="drawer__panel" aria-label="منوی اصلی">
          <div className="drawer__profile">
            <Avatar user={user} size={64} />
            <strong className="drawer__name" dir="auto">{user.displayName}</strong>
            <div className="drawer__id">
              <span className="drawer__handle" dir="ltr">{`@${user.username}`}</span>
              <button className="drawer__copy" type="button" onClick={() => void copyId()} tabIndex={menuOpen ? 0 : -1} aria-label="کپی آیدی من"><CopyIcon />{copied ? 'کپی شد' : 'کپی'}</button>
            </div>
          </div>
          <button type="button" onClick={go(onNewChat)} tabIndex={menuOpen ? 0 : -1}><ComposeIcon />گفتگوی جدید</button>
          <button type="button" onClick={go(onNewGroup)} tabIndex={menuOpen ? 0 : -1}><UsersIcon />گروه جدید</button>
          <button type="button" onClick={go(onNewChannel)} tabIndex={menuOpen ? 0 : -1}><MegaphoneIcon />کانال جدید</button>
          <button type="button" onClick={go(onSettings)} tabIndex={menuOpen ? 0 : -1}><SettingsIcon />تنظیمات</button>
          <button type="button" onClick={onToggleTheme} tabIndex={menuOpen ? 0 : -1} role="switch" aria-checked={theme === 'dark'}>
            {theme === 'dark' ? <MoonIcon /> : <SunIcon />}حالت شب<span className={`switch${theme === 'dark' ? ' switch--on' : ''}`} />
          </button>
          <button className="drawer__danger" type="button" onClick={go(onLogout)} tabIndex={menuOpen ? 0 : -1}><LogoutIcon />خروج از حساب</button>
        </nav>
      </div>
    </aside>
  );
}
