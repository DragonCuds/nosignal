import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User } from '../api.js';
import { CloseIcon } from '../icons.js';
import { ensureGroupKeyed, registerGroupChat } from '../e2ee.js';
import { PeoplePicker } from './PeoplePicker.js';
import { groupsApi } from './groupsApi.js';
import './groups.css';

type Props = { open: boolean; onClose: () => void; onCreated: (chatId: string) => Promise<void> };

export function CreateGroupDialog({ open, onClose, onCreated }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) { setTitle(''); setMembers([]); setError(''); dialog.showModal(); }
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) { setError('نام گروه را وارد کنید.'); return; }
    if (members.length === 0) { setError('دست‌کم یک عضو اضافه کنید.'); return; }
    setBusy(true); setError('');
    try {
      const created = await groupsApi.create(name, members.map((member) => member.id));
      registerGroupChat(created.chatId, created.id);
      await ensureGroupKeyed(created.chatId, created.id); // makes the first key and wraps it for every member
      await onCreated(created.chatId);
      onClose();
    } catch { setError('ساخت گروه انجام نشد. دوباره تلاش کنید.'); } finally { setBusy(false); }
  };

  return (
    <dialog ref={ref} className="sheet sheet--narrow" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet__head">
        <button className="icon-button" type="button" onClick={onClose} aria-label="بستن"><CloseIcon /></button>
        <h2>گروه جدید</h2>
      </div>
      <form className="channel-form group-form" onSubmit={submit} noValidate>
        <label className="field">
          <span>نام گروه</span>
          <input autoFocus value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} dir="auto" aria-label="نام گروه" />
        </label>
        <div className="group-chips" aria-label="اعضای انتخاب‌شده">
          {members.map((member) => (
            <button className="group-chip" type="button" key={member.id} onClick={() => setMembers((current) => current.filter((item) => item.id !== member.id))} aria-label={`حذف ${member.displayName}`}>
              <span dir="auto">{member.displayName}</span><CloseIcon />
            </button>
          ))}
        </div>
        <PeoplePicker exclude={members.map((member) => member.id)} onPick={(user) => setMembers((current) => [...current, user])} disabled={busy || members.length >= 99} placeholder="افزودن عضو با آیدی" />
        <div className={`login__error${error ? ' login__error--visible' : ''}`} role="alert">{error || ' '}</div>
        <button className="button button--primary" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : 'ساخت گروه'}</button>
      </form>
    </dialog>
  );
}
