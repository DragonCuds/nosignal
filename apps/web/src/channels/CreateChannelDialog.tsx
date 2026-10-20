import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CloseIcon } from '../icons.js';
import { channelsApi } from './channelsApi.js';
import './channels.css';

type Props = { open: boolean; onClose: () => void; onCreated: (chatId: string) => Promise<void> };

export function CreateChannelDialog({ open, onClose, onCreated }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) { setTitle(''); setError(''); dialog.showModal(); }
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) { setError('نام کانال را وارد کنید.'); return; }
    setBusy(true); setError('');
    try {
      const { chatId } = await channelsApi.create(name);
      await onCreated(chatId);
      onClose();
    } catch { setError('ساخت کانال انجام نشد. دوباره تلاش کنید.'); } finally { setBusy(false); }
  };

  return (
    <dialog ref={ref} className="sheet sheet--narrow" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet__head">
        <button className="icon-button" type="button" onClick={onClose} aria-label="بستن"><CloseIcon /></button>
        <h2>کانال جدید</h2>
      </div>
      <form className="channel-form" onSubmit={submit} noValidate>
        <p className="channel-form__lead">کانال خصوصی است؛ فقط با لینک دعوت می‌توان عضو شد. تنها شما و مدیرها می‌توانید پست بگذارید.</p>
        <label className="field">
          <span>نام کانال</span>
          <input autoFocus value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} dir="auto" />
        </label>
        <div className={`login__error${error ? ' login__error--visible' : ''}`} role="alert">{error || ' '}</div>
        <button className="button button--primary" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : 'ساخت کانال'}</button>
      </form>
    </dialog>
  );
}
