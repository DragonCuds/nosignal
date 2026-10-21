import { useState } from 'react';
import type { KeyChange } from '../e2ee.js';
import { LockIcon } from '../icons.js';
import { groupFingerprint } from './ChatHeader.js';

export type NamedKeyChange = KeyChange & { name: string };

/** Signal-style "safety number changed" notice: the contact's key differs from the pinned one; nothing is re-pinned until the user accepts. */
export function KeyChangeBanner({ changes, onAccept, onDismiss }: { changes: NamedKeyChange[]; onAccept: (change: NamedKeyChange) => Promise<void>; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const change = changes[0];
  if (!change) return null;
  const accept = async () => {
    setBusy(true); setFailed(false);
    try { await onAccept(change); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <section className="keychange" role="alert" aria-label="تغییر کلید رمزنگاری">
      <div className="keychange__title"><LockIcon /> کلید رمزنگاری {change.name} تغییر کرد</div>
      <div className="keychange__body">
      <p>این معمولاً وقتی پیش می‌آید که {change.name} برنامه را دوباره نصب کرده یا «شروع تازه» را زده باشد. به‌ندرت ممکن است کسی در میانه‌ی گفتگو باشد. تا وقتی کلید جدید را تأیید نکنید، پیام جدید فرستاده نمی‌شود و پیام‌هایی که با کلید جدید می‌آیند باز نمی‌شوند.</p>
      <p>پیش از تأیید، اثر انگشت جدید را از راه دیگری (تماس تلفنی یا حضوری) با {change.name} مقایسه کنید.</p>
      <div className="keychange__fp"><span>اثر انگشت قبلی</span><code dir="ltr">{groupFingerprint(change.oldFingerprint)}</code></div>
      <div className="keychange__fp keychange__fp--new"><span>اثر انگشت جدید</span><code dir="ltr">{groupFingerprint(change.newFingerprint)}</code></div>
      {failed && <p className="keychange__error">کلید دوباره عوض شده یا تأیید انجام نشد؛ صفحه را تازه کنید و دوباره بررسی کنید.</p>}
      </div>
      <div className="keychange__actions">
        <button className="button button--primary" type="button" disabled={busy} onClick={() => void accept()}>تأیید کلید جدید</button>
        <button className="button" type="button" disabled={busy} onClick={onDismiss}>ادامه ندادن</button>
      </div>
    </section>
  );
}
