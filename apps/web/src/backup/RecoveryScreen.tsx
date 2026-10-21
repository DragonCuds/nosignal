import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api.js';
import { decryptBackup, fromRecoveryKey, unwrapFromServer, type BackupPayload } from './crypto.js';
import { fetchServerBackup } from './serverBackup.js';
import './backup.css';

type Props = {
  userId: string;
  /** Store the recovered identity (e2ee importIdentity) and open the app. */
  onRestored: (payload: BackupPayload, password?: string) => Promise<void>;
  /** Make a brand-new identity (needs the login password) and open the app. */
  onFresh: (password: string) => Promise<void>;
  onLogout: () => void;
};

const errorText = (caught: unknown): string => {
  if (caught instanceof ApiError) {
    if (caught.status === 403) return 'رمز عبور حساب درست نیست.';
    if (caught.status === 429) return 'تلاش‌های زیادی انجام شد. چند دقیقه بعد دوباره امتحان کنید.';
    if (caught.status === 0) return caught.message;
  }
  const m = caught instanceof Error ? caught.message : '';
  if (m === 'bad-passphrase') return 'رمز اشتباه است یا پشتیبان خراب شده.';
  if (m === 'bad-file') return 'این کلید یا فایل بازیابی معتبر نیست.';
  return 'انجام نشد. دوباره تلاش کنید.';
};

/** Shown instead of the old blocking gate: three ways forward, never a dead end. */
export function RecoveryScreen({ userId, onRestored, onFresh, onLogout }: Props) {
  const [serverCopy, setServerCopy] = useState<'loading' | 'yes' | 'no'>('loading');
  const [accountPassword, setAccountPassword] = useState('');
  const [recoveryText, setRecoveryText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [filePass, setFilePass] = useState('');
  const [freshPassword, setFreshPassword] = useState('');
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    void fetchServerBackup().then((state) => { if (live) setServerCopy(state?.backup ? 'yes' : 'no'); }).catch(() => { if (live) setServerCopy('no'); });
    return () => { live = false; };
  }, []);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setMsg('');
    try { await task(); } catch (caught) { setMsg(errorText(caught)); setBusy(false); }
  };

  const restoreWithPassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const state = await fetchServerBackup();
      if (!state?.backup) throw new Error('bad-file');
      await onRestored(await unwrapFromServer(state.backup, accountPassword, userId), accountPassword);
    });
  };

  const restoreWithKey = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (recoveryText.trim()) { await onRestored(fromRecoveryKey(recoveryText, userId)); return; }
      if (!file) throw new Error('bad-file');
      const payload = await decryptBackup(await file.text(), filePass);
      if (payload.userId !== userId) throw new Error('bad-file');
      await onRestored(payload);
    });
  };

  const startFresh = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmFresh) { setMsg('برای ادامه، تیک تأیید را بزنید.'); return; }
    void run(async () => { await onFresh(freshPassword); });
  };

  return (
    <main className="login"><section className="login__card" dir="rtl">
      <h1>کلید رمزنگاری این دستگاه پیدا نشد</h1>
      <p className="login__lead">برای خواندن پیام‌های قبلی یکی از این راه‌ها را انتخاب کنید. هر کدام جواب داد، لازم نیست بقیه را انجام دهید.</p>

      {serverCopy === 'no' && (
        <p className="group__lead" role="note"><strong>هیچ نسخهٔ پشتیبانی از کلید این حساب روی سرور نیست.</strong> اگر کلید یا فایل بازیابی ندارید و این حساب را روی دستگاه دیگری هم باز نکرده‌اید، گزینهٔ «شروع تازه» پایین همین صفحه را بزنید تا با کلید جدید ادامه دهید.</p>
      )}

      {serverCopy === 'yes' && (
        <form className="group" onSubmit={restoreWithPassword}>
          <h3>۱. بازیابی با رمز عبور حساب</h3>
          <p className="group__lead">یک نسخهٔ رمزشدهٔ کلید شما روی سرور است. رمز عبور حسابتان را بنویسید تا باز شود.</p>
          <label className="field"><span>رمز عبور حساب</span>
            <input type="password" autoComplete="current-password" dir="ltr" value={accountPassword} onChange={(e) => setAccountPassword(e.target.value)} />
          </label>
          <button className="button button--primary" type="submit" disabled={busy || !accountPassword}>بازیابی</button>
        </form>
      )}

      <form className="group" onSubmit={restoreWithKey}>
        <h3>{serverCopy === 'yes' ? '۲' : '۱'}. بازیابی با کلید یا فایل بازیابی</h3>
        <p className="group__lead">اگر حالت «امنیت بیشتر» را روشن کرده بودید، کلید بازیابی (متن) یا فایل پشتیبان را وارد کنید.</p>
        <label className="field"><span>کلید بازیابی (متن)</span>
          <textarea className="recovery-text" dir="ltr" rows={3} value={recoveryText} onChange={(e) => setRecoveryText(e.target.value)} placeholder="TELKEY1-…" />
        </label>
        <p className="group__lead">یا فایل پشتیبان (.telkey) و رمز آن:</p>
        <label className="file-picker"><input type="file" accept=".telkey,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><span>{file?.name ?? 'انتخاب فایل'}</span></label>
        <label className="field"><span>رمز فایل</span>
          <input type="password" autoComplete="off" dir="ltr" value={filePass} onChange={(e) => setFilePass(e.target.value)} />
        </label>
        <button className="button button--soft" type="submit" disabled={busy || (!recoveryText.trim() && !file)}>بازیابی کلید</button>
      </form>

      <form className="group" onSubmit={startFresh}>
        <h3>{serverCopy === 'yes' ? '۳' : '۲'}. شروع تازه</h3>
        <p className="group__lead">یک کلید جدید ساخته می‌شود؛ پیام‌های رمزنگاری‌شدهٔ قبلی برای همیشه ناخواناست و گفتگوهای قبلی از نو شروع می‌شوند.</p>
        <label className="field"><span>رمز عبور حساب (برای تأیید)</span>
          <input type="password" autoComplete="current-password" dir="ltr" value={freshPassword} onChange={(e) => setFreshPassword(e.target.value)} />
        </label>
        <label className="backup-check">
          <input type="checkbox" checked={confirmFresh} onChange={(e) => setConfirmFresh(e.target.checked)} />
          <span>می‌دانم که پیام‌های قبلی خوانده نمی‌شوند.</span>
        </label>
        <button className="button button--soft" type="submit" disabled={busy || !freshPassword}>شروع تازه</button>
      </form>

      <div className={`login__error${msg ? ' login__error--visible' : ''}`} role="alert">{msg || ' '}</div>
      <button className="text-button" type="button" onClick={onLogout}>خروج</button>
    </section></main>
  );
}
