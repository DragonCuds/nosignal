import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon, CopyIcon, TrashIcon } from '../icons.js';
import { channelsApi, inviteLink, type ChannelDetail } from './channelsApi.js';
import './channels.css';

type Props = { open: boolean; channelId: string; onClose: () => void; onChanged: () => void; onGone: () => void };

const roleLabel = { owner: 'مالک', admin: 'مدیر', member: 'عضو' } as const;

export function ChannelInfo({ open, channelId, onClose, onChanged, onGone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<ChannelDetail>();
  const [title, setTitle] = useState('');
  const [links, setLinks] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => channelsApi.get(channelId).then((result) => { setDetail(result); setTitle(result.title); }).catch(() => setNote('دریافت اطلاعات کانال انجام نشد.')), [channelId]);

  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) { setNote(''); void load(); dialog.showModal(); }
    if (!open && dialog?.open) dialog.close();
  }, [open, load]);

  const run = async (action: () => Promise<unknown>, fail: string, after?: () => void) => {
    setBusy(true); setNote('');
    try { await action(); after?.(); } catch { setNote(fail); } finally { setBusy(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setNote('لینک کپی شد.'); } catch { setNote(text); }
  };

  const owner = detail?.role === 'owner';
  const staff = owner || detail?.role === 'admin';

  const newInvite = () => run(async () => {
    const invite = await channelsApi.createInvite(channelId);
    const link = inviteLink(invite.token);
    setLinks((current) => ({ ...current, [invite.id]: link }));
    await load();
    await copy(link);
  }, 'ساخت لینک انجام نشد.');

  const leave = () => {
    if (!window.confirm('از این کانال خارج می‌شوید؟')) return;
    void run(() => channelsApi.leave(channelId), 'خروج انجام نشد.', () => { onClose(); onGone(); });
  };
  const remove = () => {
    if (!window.confirm('کانال برای همهٔ اعضا حذف می‌شود. ادامه می‌دهید؟')) return;
    void run(() => channelsApi.remove(channelId), 'حذف کانال انجام نشد.', () => { onClose(); onGone(); });
  };
  const saveTitle = () => {
    const name = title.trim();
    if (!name || name === detail?.title) return;
    void run(() => channelsApi.rename(channelId, name), 'تغییر نام انجام نشد.', () => { setNote('نام کانال تغییر کرد.'); void load(); onChanged(); });
  };

  return (
    <dialog ref={ref} className="sheet sheet--narrow" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet__head">
        <button className="icon-button" type="button" onClick={onClose} aria-label="بستن"><CloseIcon /></button>
        <h2>اطلاعات کانال</h2>
      </div>
      <div className="sheet__scroll channel-info">
        {!detail && !note && <span className="spinner spinner--accent" />}
        {detail && (
          <>
            {owner ? (
              <div className="channel-info__rename">
                <label className="field"><span>نام کانال</span><input value={title} maxLength={100} dir="auto" onChange={(event) => setTitle(event.target.value)} /></label>
                <button className="button button--soft" type="button" disabled={busy || !title.trim() || title.trim() === detail.title} onClick={saveTitle}>ذخیره</button>
              </div>
            ) : <strong className="channel-info__title" dir="auto">{detail.title}</strong>}
            <p className="channel-info__meta">{detail.memberCount.toLocaleString('fa-IR')} عضو · نقش شما: {roleLabel[detail.role]}</p>

            {owner && (
              <section className="channel-info__section">
                <h3>لینک دعوت</h3>
                <button className="button button--primary" type="button" disabled={busy} onClick={() => void newInvite()}><CopyIcon /> ساخت و کپی لینک تازه</button>
                {(detail.invites ?? []).map((invite) => (
                  <div className="channel-row" key={invite.id}>
                    <span dir="ltr" className="channel-row__link">{links[invite.id] ?? `لینک ${new Date(invite.createdAt).toLocaleDateString('fa-IR')}`}</span>
                    {links[invite.id] && <button className="icon-button" type="button" onClick={() => void copy(links[invite.id])} aria-label="کپی لینک"><CopyIcon /></button>}
                    <button className="icon-button" type="button" disabled={busy} aria-label="لغو لینک" onClick={() => void run(() => channelsApi.revokeInvite(channelId, invite.id), 'لغو لینک انجام نشد.', () => void load())}><TrashIcon /></button>
                  </div>
                ))}
                {(detail.invites ?? []).length === 0 && <small className="channel-info__meta">لینک فعالی وجود ندارد.</small>}
              </section>
            )}

            {staff && (
              <section className="channel-info__section">
                <h3>اعضا</h3>
                {(detail.members ?? []).map((member) => (
                  <div className="channel-row" key={member.id}>
                    <span className="channel-row__name"><strong dir="auto">{member.displayName}</strong><small>{`⁦@${member.username}⁩`} · {roleLabel[member.role]}</small></span>
                    {owner && member.role !== 'owner' && (
                      <>
                        <button className="text-button" type="button" disabled={busy} onClick={() => void run(() => member.role === 'admin' ? channelsApi.removeAdmin(channelId, member.id) : channelsApi.makeAdmin(channelId, member.id), 'تغییر نقش انجام نشد.', () => void load())}>{member.role === 'admin' ? 'حذف مدیر' : 'مدیر کن'}</button>
                        <button className="icon-button" type="button" disabled={busy} aria-label="حذف عضو" onClick={() => { if (window.confirm(`${member.displayName} از کانال حذف شود؟`)) void run(() => channelsApi.removeMember(channelId, member.id), 'حذف عضو انجام نشد.', () => { void load(); onChanged(); }); }}><TrashIcon /></button>
                      </>
                    )}
                  </div>
                ))}
              </section>
            )}

            {owner
              ? <button className="button channel-info__danger" type="button" disabled={busy} onClick={remove}>حذف کانال</button>
              : <button className="button channel-info__danger" type="button" disabled={busy} onClick={leave}>خروج از کانال</button>}
          </>
        )}
        {note && <div className="channel-info__note" role="status">{note}</div>}
      </div>
    </dialog>
  );
}
