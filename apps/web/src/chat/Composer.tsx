import { KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Gif, Sticker } from '../api.js';
import { AttachIcon, CheckIcon, CloseIcon, EditIcon, GifIcon, ImageIcon, ReplyIcon, SendIcon, SmileIcon } from '../icons.js';
import type { AttachmentInput } from '../attachments/types.js';
import { FileIcon } from '../attachments/ui.js';
import { VoiceRecorder } from './VoiceRecorder.js';
import { withEmoji } from '../emoji.js';
import { StickerPanel } from '../StickerPanel.js';
import { excerpt, fieldDir, type Mode } from './helpers.js';

type Props = {
  mode: Mode;
  cancel: () => void;
  submit: (text: string) => Promise<boolean>;
  sendSticker: (sticker: Sticker) => Promise<void>;
  sendGif: (gif: Gif) => Promise<void>;
  uploadGif: (file: File) => Promise<void>;
  /** photo / video / voice / file (see attachments/send.ts); without it the paperclip only sends GIFs. */
  sendAttachment?: (input: AttachmentInput) => Promise<void>;
  typing: (active: boolean) => void;
};

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 132;

export function Composer({ mode, cancel, submit, sendSticker, sendGif, uploadGif, sendAttachment, typing }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const anyInput = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuShown, setMenuShown] = useState(false);
  useEffect(() => {
    if (menuOpen) { setMenuShown(true); return; }
    const timer = window.setTimeout(() => setMenuShown(false), 150);
    return () => window.clearTimeout(timer);
  }, [menuOpen]);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState('');
  const noteTimer = useRef<number | undefined>(undefined);
  const notify = (copy: string) => {
    setNote(copy);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(''), 3200);
  };
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  const canSend = Boolean(text.trim());
  const editing = mode?.kind === 'edit';

  const resize = () => {
    const element = input.current;
    if (!element) return;
    element.style.height = `${MIN_HEIGHT}px`;
    element.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, element.scrollHeight))}px`;
  };
  useLayoutEffect(resize, [text]);

  useEffect(() => {
    if (mode?.kind === 'edit') setText(mode.message.text ?? '');
    requestAnimationFrame(() => input.current?.focus());
  }, [mode?.kind, mode?.message.id]);

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const accepted = await submit(value);
    setBusy(false);
    if (accepted) { setText(''); typing(false); }
    requestAnimationFrame(() => { resize(); input.current?.focus(); });
  };

  const cancelMode = () => {
    if (editing) setText('');
    cancel();
    input.current?.focus();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && mode) { event.preventDefault(); cancelMode(); }
    else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  const addEmoji = (emoji: string) => {
    setText((value) => `${value}${emoji}`);
    requestAnimationFrame(() => input.current?.focus());
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    try { await uploadGif(file); } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => { if (!(event.target as Element | null)?.closest?.('.attach-menu, .attach-menu-anchor')) setMenuOpen(false); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menuOpen]);

  const choose = async (files: FileList | null, source: 'media' | 'file', input: HTMLInputElement | null) => {
    const list = files ? [...files] : [];
    if (input) input.value = '';
    if (!list.length || !sendAttachment) return;
    // The text in the box rides along as the caption of a single attachment.
    const caption = list.length === 1 ? text.trim() || undefined : undefined;
    if (caption) { setText(''); typing(false); }
    for (const file of list) {
      const photo = source === 'media' && /^image\/(jpeg|png|webp|avif|heic|heif|bmp)$/i.test(file.type);
      const video = source === 'media' && file.type.startsWith('video/');
      await sendAttachment({ kind: photo ? 'photo' : video ? 'video' : 'file', blob: file, name: file.name, caption });
    }
  };

  return (
    <div className="composer-wrap">
      <StickerPanel open={panelOpen} onClose={() => setPanelOpen(false)} onEmoji={addEmoji} onSticker={sendSticker} onGif={sendGif} />
      {note && <div className="composer__note" role="status">{note}</div>}
      {(menuOpen || menuShown) && sendAttachment && (
        <div className={`attach-menu${menuOpen ? '' : ' attach-menu--closing'}`} role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); photoInput.current?.click(); }}><ImageIcon />عکس یا ویدیو</button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); anyInput.current?.click(); }}><FileIcon />فایل</button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); fileInput.current?.click(); }}><GifIcon />گیف از دستگاه</button>
        </div>
      )}
      <div className="composer">
        <div className={`composer__pill${mode ? ' composer__pill--mode' : ''}`}>
          {mode && (
            <div className="composer__mode">
              {editing ? <EditIcon /> : <ReplyIcon />}
              <span className="composer__mode-copy">
                <strong>{editing ? 'ویرایش پیام' : `پاسخ به ${mode.message.sender.displayName}`}</strong>
                <span dir="auto">{withEmoji(excerpt(mode.message))}</span>
              </span>
              <button className="icon-button icon-button--small" type="button" onClick={cancelMode} aria-label="لغو"><CloseIcon /></button>
            </div>
          )}
          <div className="composer__row">
            <button className={`icon-button${panelOpen ? ' icon-button--on' : ''}`} type="button" onClick={() => setPanelOpen((value) => !value)} aria-expanded={panelOpen} aria-label="شکلک، استیکر و گیف"><SmileIcon /></button>
            <textarea
              ref={input} dir={fieldDir(text)} rows={1} value={text} maxLength={4096}
              placeholder={editing ? 'متن جدید پیام' : 'پیام بنویسید…'} aria-label="متن پیام"
              onKeyDown={keyDown}
              onChange={(event) => { setText(event.target.value); if (!editing) typing(Boolean(event.target.value.trim())); }}
            />
            <input ref={fileInput} className="composer__file" type="file" accept="image/gif,video/mp4,.gif,.mp4" onChange={(event) => void chooseFile(event.target.files?.[0])} />
            <input ref={photoInput} className="composer__file" type="file" multiple accept="image/*,video/*" onChange={(event) => void choose(event.target.files, 'media', event.target)} />
            <input ref={anyInput} className="composer__file" type="file" multiple onChange={(event) => void choose(event.target.files, 'file', event.target)} />
            <span className="attach-menu-anchor">
              <button className={`icon-button${menuOpen ? ' icon-button--on' : ''}`} type="button" disabled={uploading || editing || recording} onClick={() => (sendAttachment ? setMenuOpen((value) => !value) : fileInput.current?.click())} aria-expanded={sendAttachment ? menuOpen : undefined} aria-label={uploading ? 'در حال بارگذاری گیف' : sendAttachment ? 'پیوست' : 'ارسال گیف از دستگاه'} title={sendAttachment ? 'پیوست' : 'ارسال گیف'}>
                {uploading ? <span className="spinner spinner--accent" /> : <AttachIcon />}
              </button>
            </span>
            {sendAttachment && !canSend && !editing && <VoiceRecorder disabled={uploading} onVoice={(voice) => void sendAttachment({ kind: 'voice', blob: voice.blob, durationMs: voice.durationMs, waveform: voice.waveform })} onError={notify} onActive={setRecording} />}
          </div>
        </div>
        <button className={`composer__send${canSend ? ' composer__send--visible' : ''}`} type="button" disabled={busy || !canSend} tabIndex={canSend ? 0 : -1} onClick={() => void send()} aria-label={editing ? 'ذخیرهٔ ویرایش' : 'ارسال پیام'}>
          {editing ? <CheckIcon /> : <SendIcon />}
        </button>
      </div>
    </div>
  );
}
