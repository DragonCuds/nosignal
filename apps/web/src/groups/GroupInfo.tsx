import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon, TrashIcon } from '../icons.js';
import { Avatar } from '../ui.js';
import { groupFingerprint } from '../chat/ChatHeader.js';
import { ensureGroupKeyed, forgetGroup, KeyChangedError } from '../e2ee.js';
import { GroupAvatar } from './GroupIcon.js';
import { PeoplePicker } from './PeoplePicker.js';
import { groupsApi, type GroupDetail } from './groupsApi.js';
import './groups.css';

type Props = { open: boolean; groupId: string; chatId: string; onClose: () => void; onChanged: () => void; onGone: () => void };

const roleLabel = { owner: 'مالک', admin: 'مدیر', member: 'عضو' } as const;
export function GroupInfo({ open, groupId, chatId, onClose, onChanged, onGone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<GroupDetail>();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => groupsApi.get(groupId).then((result) => { setDetail(result); setTitle(result.title); }).catch(() => setNote('دریافت اطلاعات گروه انجام نشد.')), [groupId]);

  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) { setNote(''); void load(); dialog.showModal(); }
    if (!open && dialog?.open) dialog.close();
  }, [open, load]);

  const run = async (action: () => Promise<unknown>, fail: string, after?: () => void) => {
    setBusy(true); setNote('');
    try { await action(); after?.(); } catch (error) { setNote(error instanceof KeyChangedError ? 'کلید رمزنگاری یکی از اعضا تغییر کرده است. اثر انگشت جدید را در گفتگو بررسی و تأیید کنید؛ چرخش کلید تا آن زمان متوقف می‌ماند.' : (error as { status?: number; message?: string })?.status ? `${fail} (${(error as Error).message})` : fail); } finally { setBusy(false); }
  };

  const owner = detail?.role === 'owner';
  const staff = owner || detail?.role === 'admin';

  const addMember = (user: { id: string; displayName: string }) => run(async () => {
    // Adding a member leaves rotation pending until every recipient's identity has been checked.
    await groupsApi.addMember(groupId, user.id);
    await load(); onChanged();
    await ensureGroupKeyed(chatId, groupId);
    await load(); onChanged();
    setNote(`${user.displayName} اضافه شد؛ فقط پیام‌های بعدی را می‌خواند.`);
  }, 'افزودن عضو انجام نشد.');

  const removeMember = (member: { id: string; displayName: string }) => {
    if (!window.confirm(`${member.displayName} از گروه حذف شود؟`)) return;
    void run(async () => {
      await groupsApi.removeMember(groupId, member.id);
      await load(); onChanged();
      await ensureGroupKeyed(chatId, groupId); // new key for the remaining members
      await load(); onChanged();
    }, 'حذف عضو انجام نشد.');
  };
  const setAdmin = (member: { id: string; role: string }) => run(() => member.role === 'admin' ? groupsApi.removeAdmin(groupId, member.id) : groupsApi.makeAdmin(groupId, member.id), 'تغییر نقش انجام نشد.', () => void load());
  const transfer = (member: { id: string; displayName: string }) => {
    if (!window.confirm(`مالکیت گروه به ${member.displayName} داده شود؟`)) return;
    void run(() => groupsApi.transfer(groupId, member.id), 'انتقال مالکیت انجام نشد.', () => void load());
  };
  const leave = () => {
    if (!window.confirm('از این گروه خارج می‌شوید؟')) return;
    void run(() => groupsApi.leave(groupId), 'خروج انجام نشد.', () => { forgetGroup(chatId); onClose(); onGone(); });
  };
  const remove = () => {
    if (!window.confirm('گروه برای همهٔ اعضا حذف می‌شود. ادامه می‌دهید؟')) return;
    void run(() => groupsApi.remove(groupId), 'حذف گروه انجام نشد.', () => { forgetGroup(chatId); onClose(); onGone(); });
  };
  const saveTitle = () => {
    const name = title.trim();
    if (!name || name === detail?.title) return;
    void run(() => groupsApi.rename(groupId, name), 'تغییر نام انجام نشد.', () => { setNote('نام گروه تغییر کرد.'); void load(); onChanged(); });
  };

  return (
    <dialog ref={ref} className="sheet sheet--narrow" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet__head">
        <button className="icon-button" type="button" onClick={onClose} aria-label="بستن"><CloseIcon /></button>
        <h2>اطلاعات گروه</h2>
      </div>
      <div className="sheet__scroll channel-info group-info">
        {!detail && !note && <span className="spinner spinner--accent" />}
        {detail && (
          <>
            <div className="group-info__top"><GroupAvatar id={detail.id} title={detail.title} size={64} /></div>
            {staff ? (
              <div className="channel-info__rename">
                <label className="field"><span>نام گروه</span><input value={title} maxLength={80} dir="auto" onChange={(event) => setTitle(event.target.value)} /></label>
                <button className="button button--soft" type="button" disabled={busy || !title.trim() || title.trim() === detail.title} onClick={saveTitle}>ذخیره</button>
              </div>
            ) : <strong className="channel-info__title" dir="auto">{detail.title}</strong>}
            <p className="channel-info__meta">{detail.memberCount.toLocaleString('fa-IR')} عضو · نقش شما: {roleLabel[detail.role]}</p>

            {staff && (
              <section className="channel-info__section">
                <h3>افزودن عضو</h3>
                <PeoplePicker exclude={detail.members.map((member) => member.id)} onPick={(user) => void addMember(user)} disabled={busy || detail.memberCount >= 100} />
              </section>
            )}

            <section className="channel-info__section">
              <h3>اعضا</h3>
              {detail.members.map((member) => (
                <div className="channel-row" key={member.id}>
                  <Avatar user={{ id: member.id, displayName: member.displayName, avatarPath: null, username: member.username } as never} size={40} />
                  <span className="channel-row__name"><strong dir="auto">{member.displayName}</strong><small>{`⁦@${member.username}⁩`} · {roleLabel[member.role]}</small>{member.fingerprint && <code dir="ltr" title="اثر انگشت کلید؛ از راهی دیگر با عضو مقایسه کنید">{groupFingerprint(member.fingerprint)}</code>}</span>
                  {owner && member.role !== 'owner' && (
                    <>
                      <button className="text-button" type="button" disabled={busy} onClick={() => void setAdmin(member)}>{member.role === 'admin' ? 'حذف مدیر' : 'مدیر کن'}</button>
                      <button className="text-button" type="button" disabled={busy} onClick={() => transfer(member)}>انتقال مالکیت</button>
                    </>
                  )}
                  {staff && member.role !== 'owner' && !(member.role === 'admin' && !owner) && (
                    <button className="icon-button" type="button" disabled={busy} aria-label={`حذف ${member.displayName}`} onClick={() => removeMember(member)}><TrashIcon /></button>
                  )}
                </div>
              ))}
            </section>

            {!owner && <button className="button channel-info__danger" type="button" disabled={busy} onClick={leave}>خروج از گروه</button>}
            {owner && <button className="button channel-info__danger" type="button" disabled={busy} onClick={remove}>حذف گروه</button>}
          </>
        )}
        {note && <div className="channel-info__note" role="status">{note}</div>}
      </div>
    </dialog>
  );
}
