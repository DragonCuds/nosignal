import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api.js';
import { createInvite, deleteInvite, listInvites, type InviteStatus, type InviteSummary } from '../join/inviteApi.js';

const statusText: Record<InviteStatus, string> = { active: 'فعال', used: 'استفاده‌شده', expired: 'منقضی' };

const dateText = (iso: string): string => new Date(iso).toLocaleDateString('fa-IR', { month: 'long', day: 'numeric' });

const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back for plain-IP installs.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { return document.execCommand('copy'); } finally { area.remove(); }
  }
};

/** Settings section «دعوت دوستان». Renders nothing for non-admins (server answers 403). */
export function Invites() {
  const [rows, setRows] = useState<InviteSummary[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [maxUses, setMaxUses] = useState(1);
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await listInvites());
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 401)) setForbidden(true);
      else setMsg('بارگیری فهرست دعوت‌ها انجام نشد.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (forbidden) return null;

  const create = async () => {
    setBusy(true); setMsg('');
    try {
      const invite = await createInvite(maxUses);
      const url = `${window.location.origin}${invite.path}`;
      setFresh({ id: invite.id, url });
      setMsg(await copyText(url) ? 'لینک ساخته و کپی شد.' : 'لینک ساخته شد. آن را انتخاب و کپی کنید.');
      await load();
    } catch { setMsg('ساخت لینک انجام نشد.'); } finally { setBusy(false); }
  };

  const copyFresh = async () => {
    if (fresh) setMsg(await copyText(fresh.url) ? 'لینک کپی شد.' : 'کپی نشد؛ لینک را دستی انتخاب کنید.');
  };

  const remove = async (id: string) => {
    setMsg('');
    try {
      await deleteInvite(id);
      if (fresh?.id === id) setFresh(null);
      await load();
    } catch { setMsg('حذف دعوت انجام نشد.'); }
  };

  return (
    <section dir="rtl" aria-label="دعوت دوستان">
      <h2>دعوت دوستان</h2>
      <p>یک لینک یک‌بارمصرف بسازید و برای دوستتان بفرستید. لینک ۷ روز اعتبار دارد.</p>
      <label className="field">
        <span>تعداد افرادی که می‌توانند با این لینک عضو شوند</span>
        <input type="number" min={1} max={100} dir="ltr" value={maxUses}
          onChange={(event) => setMaxUses(Math.min(100, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
      </label>
      <button className="button button--primary" type="button" disabled={busy} onClick={() => void create()}>
        {busy ? <span className="spinner" /> : 'ساخت لینک دعوت'}
      </button>
      {fresh && (
        <div>
          <label className="field">
            <span>لینک تازه (فقط همین یک بار نمایش داده می‌شود)</span>
            <input readOnly dir="ltr" value={fresh.url} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <button className="button button--soft" type="button" onClick={() => void copyFresh()}>کپی لینک</button>
        </div>
      )}
      {msg && <p role="status">{msg}</p>}
      {rows && rows.length === 0 && <p>هنوز دعوتی نساخته‌اید.</p>}
      {rows && rows.length > 0 && (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              {statusText[row.status]} · {row.uses} از {row.maxUses} نفر · تا {dateText(row.expiresAt)}{' '}
              <button className="button button--soft" type="button" onClick={() => void remove(row.id)}>حذف</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
