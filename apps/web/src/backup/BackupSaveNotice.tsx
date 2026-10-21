import { useEffect, useState, useSyncExternalStore } from 'react';
import { fetchServerBackup, isBackupPending, subscribeBackupPending } from './serverBackup.js';

/** Visible warning while the server holds no copy of this account's key (Auto mode): the first upload failed or never ran. */
export function BackupSaveNotice({ ready }: { ready: boolean }) {
  const pending = useSyncExternalStore(subscribeBackupPending, isBackupPending);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void fetchServerBackup().then((state) => { if (live) setMissing(state?.mode !== 'manual' && !state?.backup); }).catch(() => undefined);
    return () => { live = false; };
  }, [ready, pending]);
  if (!pending && !missing) return null;
  return (
    <div className="backup-warning backup-warning--save" role="alert" dir="rtl">
      <strong>نسخهٔ پشتیبان کلید شما هنوز روی سرور ذخیره نشده است.</strong>
      <p>{pending ? 'ذخیره دوباره تلاش می‌شود؛ این صفحه را باز نگه دارید.' : 'اگر این مرورگر پاک شود، پیام‌های قبلی خوانده نمی‌شوند. یک بار خارج شوید و دوباره با رمز عبور وارد شوید تا ذخیره شود.'}</p>
    </div>
  );
}
