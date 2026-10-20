import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { Chat } from '../api.js';
import { BackIcon, CloseIcon, CopyIcon, DownIcon, LockIcon, SearchIcon, UpIcon } from '../icons.js';
import { Avatar } from '../ui.js';
import { MegaphoneIcon } from '../channels/ChannelIcon.js';
import { GroupAvatar } from '../groups/GroupIcon.js';
import { fieldDir, lastSeenLabel, type PeerPresence } from './helpers.js';

export type SearchState = { query: string; total: number; index: number };

type Props = {
  peer: Chat['peer'];
  /** Saved Messages: no peer, no presence/typing. */
  saved?: boolean;
  /** Channel: title + member count; clicking the title opens the info sheet. */
  channel?: { title: string; memberCount: number; onInfo: () => void; /** A group (not a channel): shows the group avatar and group labels. */ groupId?: string };
  presence?: PeerPresence;
  typing: boolean;
  fingerprint?: string;
  search: SearchState | null;
  onSearchOpen: () => void;
  onSearchClose: () => void;
  onSearchQuery: (query: string) => void;
  onSearchStep: (direction: 1 | -1) => void;
  onCopyFingerprint: (value: string) => void;
  onBack: () => void;
};

const groupFingerprint = (value: string) => value.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? value;

export function ChatHeader({ peer, saved, channel, presence, typing, fingerprint, search, onSearchOpen, onSearchClose, onSearchQuery, onSearchStep, onCopyFingerprint, onBack }: Props) {
  const [infoOpen, setInfoOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (search) searchInput.current?.focus(); }, [Boolean(search)]);
  useEffect(() => {
    if (!infoOpen) return;
    const away = (event: PointerEvent) => { if (!infoRef.current?.contains(event.target as Node)) setInfoOpen(false); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setInfoOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [infoOpen]);

  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') onSearchClose();
    else if (event.key === 'Enter') { event.preventDefault(); onSearchStep(event.shiftKey ? 1 : -1); }
  };

  if (search) {
    return (
      <header className="chat-header chat-header--search">
        <button className="icon-button chat-header__back" type="button" onClick={onBack} aria-label="بازگشت"><BackIcon /></button>
        <label className="chat-header__search">
          <SearchIcon />
          <input ref={searchInput} dir={fieldDir(search.query)} value={search.query} onChange={(event) => onSearchQuery(event.target.value)} onKeyDown={searchKey} placeholder="جست‌وجو در پیام‌های این گفتگو" aria-label="جست‌وجو در گفتگو" />
          {search.query.trim() && <span className="chat-header__count">{search.total ? `${(search.index + 1).toLocaleString('fa-IR')} از ${search.total.toLocaleString('fa-IR')}` : 'نتیجه‌ای نیست'}</span>}
        </label>
        <button className="icon-button" type="button" disabled={!search.total} onClick={() => onSearchStep(-1)} aria-label="نتیجهٔ قبلی"><UpIcon /></button>
        <button className="icon-button" type="button" disabled={!search.total} onClick={() => onSearchStep(1)} aria-label="نتیجهٔ بعدی"><DownIcon /></button>
        <button className="icon-button" type="button" onClick={onSearchClose} aria-label="بستن جست‌وجو"><CloseIcon /></button>
      </header>
    );
  }

  return (
    <header className="chat-header">
      <button className="icon-button chat-header__back" type="button" onClick={onBack} aria-label="بازگشت"><BackIcon /></button>
      {channel?.groupId ? <GroupAvatar id={channel.groupId} title={channel.title} size={40} /> : channel ? <span className="avatar-saved avatar-saved--head" aria-hidden="true"><MegaphoneIcon /></span> : saved || !peer
        ? <span className="avatar-saved avatar-saved--head" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4.2L5.5 20V5a1 1 0 0 1 1-1Z" /></svg></span>
        : <Avatar user={peer} size={40} online={presence?.online} />}
      {channel ? <button className="chat-header__identity chat-header__identity--button" type="button" onClick={channel.onInfo} aria-label={channel.groupId ? 'اطلاعات گروه' : 'اطلاعات کانال'}><strong dir="auto">{channel.title}</strong><span className="chat-header__status">{channel.memberCount.toLocaleString('fa-IR')} عضو</span></button> : <div className="chat-header__identity">
        <strong dir="auto">{saved || !peer ? 'پیام‌های ذخیره‌شده' : peer.displayName}</strong>
        {saved || !peer ? null : typing
          ? <span className="chat-header__status chat-header__status--typing">در حال نوشتن<span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></span>
          : <span className={`chat-header__status${presence?.online ? ' chat-header__status--online' : ''}`}>{presence?.online ? 'آنلاین' : lastSeenLabel(presence?.lastSeen, peer?.username ?? '')}</span>}
      </div>}
      <button className="icon-button" type="button" onClick={onSearchOpen} aria-label="جست‌وجو در گفتگو" title="جست‌وجو"><SearchIcon /></button>
      {saved || !peer ? null : <div className="chat-header__info" ref={infoRef}>
        <button className={`icon-button${fingerprint ? ' icon-button--secure' : ''}`} type="button" onClick={() => setInfoOpen((value) => !value)} aria-expanded={infoOpen} aria-label="اطلاعات رمزنگاری" title="رمزنگاری سرتاسری"><LockIcon /></button>
        {infoOpen && (
          <div className="popover" role="dialog" aria-label="رمزنگاری سرتاسری">
            <div className="popover__title"><LockIcon /> رمزنگاری سرتاسری</div>
            <p>پیام‌های این گفتگو فقط روی دستگاه شما و {peer?.displayName} باز می‌شوند. برای اطمینان، اثر انگشت زیر را خارج از NoSignal با او مقایسه کنید.</p>
            {fingerprint
              ? <><code dir="ltr">{groupFingerprint(fingerprint)}</code><button className="popover__copy" type="button" onClick={() => { onCopyFingerprint(fingerprint); setInfoOpen(false); }}><CopyIcon />کپی اثر انگشت</button></>
              : <p className="popover__muted">هنوز کلید مخاطب ثبت نشده؛ بعد از اولین ورود او ساخته می‌شود.</p>}
          </div>
        )}
      </div>}
    </header>
  );
}
