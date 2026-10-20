import { AnimationEvent, CSSProperties, memo, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { api, type GifMessagePayload, type Sticker, type StickerMessagePayload } from '../api.js';
import { CheckIcon, ClockIcon, DoubleCheckIcon, MoreIcon, ReplyIcon, RetryIcon } from '../icons.js';
import { GifVideo } from '../GifVideo.js';
import { attachmentPayload } from '../attachments/types.js';
import { FileBubble, VideoBubble } from './FileBubble.js';
import { PhotoBubble } from './PhotoBubble.js';
import { VoiceBubble } from './VoiceBubble.js';
import { emojiOnlyCount, withEmoji } from '../emoji.js';
import { clockLabel } from '../ui.js';
import { excerpt, gifPayload, readAtLeast, renderText, sameGroup, stickerPayload, textDir, type UiMessage } from './helpers.js';

const stickerCache = new Map<string, Sticker>();
const stickerPackRequests = new Map<string, Promise<void>>();

export const rememberSticker = (sticker: Sticker) => { stickerCache.set(sticker.id, sticker); };

const STICKER_SIZE = 256;
const GIF_BOX = 340;
const GIF_MIN = 120;
const SWIPE_TRIGGER = 56;
const SWIPE_MAX = 76;
const LONG_PRESS_MS = 500;

function StickerMessage({ payload }: { payload: StickerMessagePayload }) {
  const direct = payload.fileUrl
    ? { id: payload.stickerId, packId: payload.packId, fileUrl: payload.fileUrl, format: payload.format, emoji: payload.emoji, w: payload.w, h: payload.h, sort: 0 } satisfies Sticker
    : stickerCache.get(payload.stickerId);
  const [sticker, setSticker] = useState<Sticker | undefined>(direct);

  useEffect(() => {
    if (sticker || !payload.packId) return;
    let pending = stickerPackRequests.get(payload.packId);
    if (!pending) {
      pending = api.stickerPack(payload.packId).then((pack) => { pack.stickers.forEach((item) => stickerCache.set(item.id, item)); }).catch(() => undefined);
      stickerPackRequests.set(payload.packId, pending);
    }
    void pending.then(() => setSticker(stickerCache.get(payload.stickerId)));
  }, [payload.packId, payload.stickerId, sticker]);

  if (!sticker) return <span className="sticker-unavailable">استیکر در دسترس نیست</span>;
  const wide = Math.min(1, sticker.w / sticker.h);
  const tall = Math.min(1, sticker.h / sticker.w);
  return (
    <tg-sticker
      className="msg__sticker"
      src={sticker.fileUrl}
      format={sticker.format}
      size={STICKER_SIZE}
      autoplay
      loop
      alt={sticker.emoji || 'استیکر'}
      style={{ '--sticker-w': `${STICKER_SIZE * wide}px`, aspectRatio: `${wide} / ${tall}` } as CSSProperties}
    />
  );
}

function GifMessage({ payload }: { payload: GifMessagePayload }) {
  const ratio = payload.w / payload.h;
  const width = Math.round(Math.max(GIF_MIN, Math.min(ratio >= 1 ? GIF_BOX : GIF_BOX * ratio, GIF_BOX)));
  const mimeType = (payload as unknown as { encryptedMedia?: { mimeType?: string } }).encryptedMedia?.mimeType;
  const style = { width, aspectRatio: `${payload.w} / ${payload.h}` };
  if (mimeType === 'image/gif') return <img className="msg__gif" src={payload.mp4Url} alt="گیف" style={style} />;
  return <GifVideo className="msg__gif" mp4Url={payload.mp4Url} label="گیف" style={style} />;
}

function Status({ message, readId }: { message: UiMessage; readId?: string }) {
  if (message.failed) return <RetryIcon className="msg__status msg__status--failed" />;
  if (message.optimistic) return <ClockIcon className="msg__status" />;
  const read = readAtLeast(readId, message.id);
  return read ? <DoubleCheckIcon className="msg__status msg__status--read" /> : <CheckIcon className="msg__status" />;
}

export type BubbleProps = {
  message: UiMessage;
  previous?: UiMessage;
  next?: UiMessage;
  reply?: UiMessage;
  me: string;
  readId?: string;
  deleting: boolean;
  enter: boolean;
  needle: string;
  active: boolean;
  onRetry: (message: UiMessage) => void;
  onDiscard?: (message: UiMessage) => void;
  onMenu: (message: UiMessage, x: number, y: number) => void;
  onReply: (message: UiMessage) => void;
  onJump: (id: string) => void;
};

function BubbleView({ message, previous, next, reply, me, readId, deleting, enter, needle, active, onRetry, onDiscard, onMenu, onReply, onJump }: BubbleProps) {
  const outgoing = message.senderId === me;
  const joinedAbove = sameGroup(previous, message);
  const joinedBelow = sameGroup(message, next);
  const sticker = !message.deletedAt && message.kind === 'sticker' ? stickerPayload(message.payload) : undefined;
  const gif = !message.deletedAt && message.kind === 'gif' ? gifPayload(message.payload) : undefined;
  const att = !message.deletedAt && (message.kind === 'photo' || message.kind === 'video' || message.kind === 'voice' || message.kind === 'file') ? attachmentPayload(message.payload) : undefined;
  const caption = att ? att.caption ?? message.text ?? undefined : undefined;
  const visual = Boolean(att && (message.kind === 'photo' || message.kind === 'video'));
  const mediaOnly = visual && !caption;
  const emojiCount = !message.deletedAt && message.kind === 'text' ? emojiOnlyCount(message.text) : 0;
  const bigEmoji = emojiCount > 0;
  const bare = Boolean(sticker || bigEmoji);
  const interactive = !message.deletedAt && !message.optimistic && !message.failed;

  const [entering, setEntering] = useState(enter);
  const [bump, setBump] = useState(false);
  const lastEdit = useRef(message.editedAt);
  useEffect(() => {
    if (message.editedAt && message.editedAt !== lastEdit.current) {
      lastEdit.current = message.editedAt;
      setBump(true);
      const timer = window.setTimeout(() => setBump(false), 420);
      return () => window.clearTimeout(timer);
    }
    lastEdit.current = message.editedAt;
  }, [message.editedAt]);

  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; timer: number; swiping: boolean; armed: boolean } | undefined>(undefined);
  useEffect(() => () => { if (gesture.current) window.clearTimeout(gesture.current.timer); }, []);

  const settle = () => {
    const element = track.current;
    if (!element) return;
    element.style.transition = 'transform 200ms ease-out';
    element.style.transform = '';
    element.parentElement?.style.setProperty('--swipe', '0');
  };
  const down = (event: ReactPointerEvent) => {
    if (!interactive || event.pointerType === 'mouse') return;
    const x = event.clientX;
    const y = event.clientY;
    const timer = window.setTimeout(() => {
      if (gesture.current && !gesture.current.swiping) { onMenu(message, x, y); gesture.current = undefined; }
    }, LONG_PRESS_MS);
    gesture.current = { x, y, timer, swiping: false, armed: false };
    if (track.current) track.current.style.transition = 'none';
  };
  const move = (event: ReactPointerEvent) => {
    const state = gesture.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.swiping && Math.hypot(dx, dy) > 10) {
      window.clearTimeout(state.timer);
      if (Math.abs(dy) > Math.abs(dx) || dx > 0) { gesture.current = undefined; return; }
      state.swiping = true;
    }
    if (!state.swiping) return;
    const pull = Math.min(SWIPE_MAX, -dx);
    if (track.current) track.current.style.transform = `translateX(${-pull}px)`;
    track.current?.parentElement?.style.setProperty('--swipe', String(Math.min(1, pull / SWIPE_TRIGGER)));
    if (pull >= SWIPE_TRIGGER && !state.armed) { state.armed = true; if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(10); }
    if (pull < SWIPE_TRIGGER) state.armed = false;
  };
  const up = () => {
    const state = gesture.current;
    if (!state) return;
    window.clearTimeout(state.timer);
    gesture.current = undefined;
    if (state.swiping) { settle(); if (state.armed) onReply(message); }
  };

  const direction = textDir(message.text);
  const className = [
    'msg', outgoing ? 'msg--out' : 'msg--in',
    joinedAbove && 'msg--joined-above', joinedBelow && 'msg--joined-below',
    !joinedBelow && !bare && !gif && !mediaOnly && 'msg--tail',
    mediaOnly && 'msg--media', visual && caption && 'msg--media-caption',
    sticker && 'msg--sticker', gif && 'msg--gif', bigEmoji && `msg--emoji msg--emoji-${emojiCount}`, enter && 'msg--live', bump && 'msg--bump',
    message.optimistic && 'msg--sending', message.failed && 'msg--failed',
  ].filter(Boolean).join(' ');

  const meta = (
    <span className="msg__meta" dir="ltr">
      {message.editedAt && !message.deletedAt && <span className="msg__edited">ویرایش‌شده</span>}
      {message.optimistic && !message.failed && Boolean(message.attempts) && <span className="msg__edited">در حال ارسال</span>}
      <time dateTime={message.createdAt}>{clockLabel(message.createdAt)}</time>
      {outgoing && <Status message={message} readId={readId} />}
    </span>
  );

  const rowClass = ['msg-row', outgoing ? 'msg-row--out' : 'msg-row--in', joinedAbove && 'msg-row--joined', entering && 'msg-row--enter', deleting && 'msg-row--leave'].filter(Boolean).join(' ');
  const rowAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => { if (event.target === event.currentTarget && event.animationName === 'row-grow') setEntering(false); };

  return (
    <div className={rowClass} onAnimationEnd={rowAnimationEnd}>
    <div
      className={className}
      data-message-id={message.id}
      onContextMenu={(event) => { if (interactive) { event.preventDefault(); onMenu(message, event.clientX, event.clientY); } }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    >
      <span className="msg__swipe-hint" aria-hidden="true"><ReplyIcon /></span>
      <div className="msg__track" ref={track}>
        {interactive && outgoing && (
          <span className="msg__tools">
            <button type="button" onClick={() => onReply(message)} aria-label="پاسخ" title="پاسخ"><ReplyIcon /></button>
            <button type="button" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); onMenu(message, box.left, box.bottom); }} aria-label="گزینه‌ها" title="گزینه‌ها"><MoreIcon /></button>
          </span>
        )}
        <div className="bubble" dir={direction}>
          {message.replyToId && (
            <button className="bubble__quote" type="button" disabled={!reply} onClick={() => onJump(message.replyToId!)}>
              <strong dir="auto">{reply ? reply.senderId === me ? 'شما' : reply.sender.displayName : 'پیام قبلی'}</strong>
              <span dir="auto">{reply ? withEmoji(excerpt(reply)) : 'این پیام در بخش بارگذاری‌شده نیست'}</span>
            </button>
          )}
          {att ? (
            <>
              {message.kind === 'photo' && <div className="att-media"><PhotoBubble chatId={message.chatId} attachment={att.attachment} /></div>}
              {message.kind === 'video' && <div className="att-media"><VideoBubble chatId={message.chatId} attachment={att.attachment} /></div>}
              {message.kind === 'voice' && <VoiceBubble chatId={message.chatId} attachment={att.attachment} />}
              {message.kind === 'file' && <FileBubble chatId={message.chatId} attachment={att.attachment} />}
              {caption && <span className="bubble__text att-caption">{renderText(caption, needle, active)}</span>}
            </>
          ) : sticker ? <StickerMessage payload={sticker} /> : gif ? <GifMessage payload={gif} /> : (
            <span className={`bubble__text${message.deletedAt ? ' bubble__text--deleted' : ''}`}>
              {message.deletedAt ? 'این پیام حذف شده است' : renderText(message.text ?? excerpt(message), needle, active)}
            </span>
          )}
          {meta}
          {message.failed && (
            <span className="bubble__failed">
              {message.error && <span className="bubble__error">{message.error}</span>}
              <span className="bubble__failed-actions">
                <button className="bubble__retry" type="button" onClick={() => onRetry(message)}><RetryIcon />تلاش دوباره</button>
                {onDiscard && <button className="bubble__retry" type="button" onClick={() => onDiscard(message)}>حذف</button>}
              </span>
            </span>
          )}
        </div>
        {interactive && !outgoing && (
          <span className="msg__tools">
            <button type="button" onClick={() => onReply(message)} aria-label="پاسخ" title="پاسخ"><ReplyIcon /></button>
            <button type="button" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); onMenu(message, box.left, box.bottom); }} aria-label="گزینه‌ها" title="گزینه‌ها"><MoreIcon /></button>
          </span>
        )}
      </div>
    </div>
    </div>
  );
}

export const Bubble = memo(BubbleView);
