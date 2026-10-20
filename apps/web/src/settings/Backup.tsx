import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { backupFileName, decryptBackup, encryptBackup, fromRecoveryKey, passphraseProblem, toRecoveryKey, type BackupPayload } from '../backup/crypto.js';
import { markBackedUp } from '../backup/reminder.js';
import { fetchServerBackup, uploadBackup, type ServerBackupState } from '../backup/serverBackup.js';
import '../backup/backup.css';

type Props = {
  userId: string;
  /** e2ee hook: current identity as a payload, or null if it is not exportable. */
  getBackup: () => Promise<BackupPayload | null>;
  /** e2ee hook: store imported identity and re-register. */
  onImport: (payload: BackupPayload) => Promise<void>;
};

const errorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'رمز عبور حساب درست نیست.';
    if (e.status === 429) return 'تلاش‌های زیادی انجام شد. چند دقیقه بعد دوباره امتحان کنید.';
    return e.message;
  }
  const m = e instanceof Error ? e.message : '';
  if (m === 'bad-passphrase') return 'رمز اشتباه است یا فایل خراب شده.';
  if (m === 'bad-file') return 'این کلید یا فایل پشتیبان معتبر نیست.';
  return m || 'خطای ناشناخته';
};

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/** Recovery key (text) + passphrase-protected file; used when switching to Power mode and later from Power mode. */
function RecoveryExport({ userId, payload }: { userId: string; payload: BackupPayload }) {
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState('');
  const key = toRecoveryKey(payload);
  const copy = async () => {
    try { await navigator.clipboard.writeText(key); setMsg('کلید کپی شد.'); } catch { setMsg('کپی نشد؛ متن را دستی انتخاب و کپی کنید.'); }
  };
  const saveFile = async () => {
    const problem = passphraseProblem(pass);
    if (problem) { setMsg(problem); return; }
    download(backupFileName(userId), await encryptBackup(payload, pass));
    setPass(''); setMsg('فایل پشتیبان ذخیره شد. آن را همراه رمزش جای امنی نگه دارید.');
  };
  return (
    <div className="group__box">
      <h4>کلید بازیابی</h4>
      <textarea className="recovery-text" dir="ltr" rows={4} readOnly value={key} onFocus={(e) => e.currentTarget.select()} aria-label="کلید بازیابی" />
      <div className="group__actions"><button className="button button--soft" type="button" onClick={() => void copy()}>کپی کلید</button></div>
      <h4>یا فایل پشتیبان (اختیاری)</h4>
      <label className="field"><span>رمز فایل (حداقل ۱۰ نویسه)</span>
        <input type="password" autoComplete="new-password" dir="ltr" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <div className="group__actions"><button className="button button--soft" type="button" onClick={() => void saveFile()}>دریافت فایل</button></div>
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}

export function Backup({ userId, getBackup, onImport }: Props) {
  const [server, setServer] = useState<ServerBackupState | 'loading'>('loading');
  const [payload, setPayload] = useState<BackupPayload | null | 'loading'>('loading');
  const [step, setStep] = useState<'idle' | 'to-power' | 'to-auto'>('idle');
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState('');
  const [recoveryText, setRecoveryText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [filePass, setFilePass] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    try { setServer(await fetchServerBackup()); } catch { setServer(null); }
    try { setPayload(await getBackup()); } catch { setPayload(null); }
  }, [getBackup]);
  useEffect(() => { void refresh(); }, [refresh]);

  const power = server !== 'loading' && server?.mode === 'manual';
  const hasCopy = server !== 'loading' && Boolean(server?.backup);

  const task = async (work: () => Promise<void>) => {
    setBusy(true); setMsg('');
    try { await work(); } catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
  };

  const enablePower = () => task(async () => {
    if (!saved) throw new Error('اول تیک «کلید را ذخیره کردم» را بزنید.');
    await api.deleteCryptoBackup();
    markBackedUp(userId);
    setStep('idle'); setSaved(false);
    await refresh();
    setMsg('حالت امنیت بیشتر روشن شد. نسخهٔ سرور پاک شد؛ کلید بازیابی را جای امنی نگه دارید.');
  });

  const enableAuto = (event: FormEvent) => {
    event.preventDefault();
    void task(async () => {
      const current = payload === 'loading' ? null : payload;
      if (!current) throw new Error('کلید این دستگاه قابل پشتیبان‌گیری نیست.');
      await api.checkPassword(password); // wrong password -> 403, nothing is stored
      await uploadBackup(current, password);
      setPassword(''); setStep('idle');
      await refresh();
      setMsg('حالت خودکار روشن شد و نسخهٔ قفل‌شده روی سرور ذخیره شد.');
    });
  };

  const importKey = (event: FormEvent) => {
    event.preventDefault();
    void task(async () => {
      let restored: BackupPayload;
      if (recoveryText.trim()) restored = fromRecoveryKey(recoveryText, userId);
      else {
        if (!file) throw new Error('کلید بازیابی را بنویسید یا یک فایل پشتیبان انتخاب کنید.');
        restored = await decryptBackup(await file.text(), filePass);
        if (restored.userId !== userId) throw new Error('این پشتیبان مال حساب دیگری است.');
      }
      await onImport(restored);
      markBackedUp(userId); setFilePass(''); setRecoveryText('');
      await refresh();
      setMsg('کلید بازیابی شد.');
    });
  };

  if (server === 'loading') return <section dir="rtl" aria-label="پشتیبان کلید"><h3>پشتیبان کلید</h3><p className="group__lead">در حال بارگذاری…</p></section>;
  const exportable = payload !== 'loading' && payload !== null;

  return (
    <section dir="rtl" aria-label="پشتیبان کلید">
      <h3>پشتیبان کلید</h3>
      {!power && (
        <>
          <p className="group__lead"><strong>حالت خودکار (پیش‌فرض).</strong> کلید رمزنگاری شما در مرورگر با رمز عبور حسابتان قفل می‌شود و فقط نسخهٔ قفل‌شده روی سرور می‌ماند. در مرورگر یا گوشی جدید با همان رمز وارد شوید تا پیام‌های قبلی خودکار باز شوند.</p>
          <p className="group__lead">نکتهٔ صادقانه: در این حالت رمز عبور شما هنگام ورود به سرور می‌رسد (برای تأیید ورود لازم است)، پس مدیر سرور در اصل می‌تواند نسخهٔ قفل‌شده را باز کند. اگر این برایتان قابل‌قبول نیست، حالت امنیت بیشتر را روشن کنید.</p>
          <div className="group__notice" role="status">
            {!exportable ? 'کلید این دستگاه با نسخهٔ قدیمی ساخته شده و قابل پشتیبان‌گیری نیست.'
              : hasCopy ? 'نسخهٔ پشتیبان روی سرور هست.' : 'هنوز نسخه‌ای روی سرور نیست؛ در ورود بعدی با رمز عبور ساخته می‌شود.'}
          </div>
          {step !== 'to-power' && <div className="group__actions"><button className="button button--soft" type="button" disabled={!exportable} onClick={() => { setStep('to-power'); setMsg(''); }}>روشن کردن حالت امنیت بیشتر</button></div>}
          {step === 'to-power' && exportable && (
            <div className="group__box">
              <p><strong>حالت امنیت بیشتر:</strong> نسخهٔ سرور پاک می‌شود و فقط خودتان با «کلید بازیابی» می‌توانید پیام‌های قبلی را در دستگاه جدید باز کنید. اگر آن را گم کنید، هیچ‌کس نمی‌تواند کمکتان کند و پیام‌های قبلی برای همیشه ناخواناست. اول کلید را ذخیره کنید:</p>
              <RecoveryExport userId={userId} payload={payload} />
              <label className="backup-check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /><span>کلید بازیابی را جای امنی ذخیره کردم.</span></label>
              <div className="group__actions">
                <button className="button button--primary" type="button" disabled={busy || !saved} onClick={() => void enablePower()}>پاک کردن نسخهٔ سرور و روشن کردن</button>
                <button className="text-button" type="button" onClick={() => { setStep('idle'); setSaved(false); }}>انصراف</button>
              </div>
            </div>
          )}
        </>
      )}
      {power && (
        <>
          <p className="group__lead"><strong>حالت امنیت بیشتر روشن است.</strong> هیچ نسخه‌ای از کلید روی سرور نیست و رمز عبور شما به‌تنهایی کلید را باز نمی‌کند. در دستگاه جدید باید کلید بازیابی یا فایل پشتیبان را وارد کنید؛ اگر هر دو را گم کنید، پیام‌های قبلی برای همیشه ناخواناست.</p>
          {exportable ? <RecoveryExport userId={userId} payload={payload} /> : <div className="group__notice group__notice--error">کلید این دستگاه با نسخهٔ قدیمی ساخته شده و قابل نمایش نیست.</div>}
          {step !== 'to-auto'
            ? <div className="group__actions"><button className="button button--soft" type="button" onClick={() => { setStep('to-auto'); setMsg(''); }}>بازگشت به حالت خودکار</button></div>
            : (
              <form className="group__box" onSubmit={enableAuto}>
                <p>برای ساخت نسخهٔ قفل‌شده، رمز عبور حسابتان را بنویسید.</p>
                <label className="field"><span>رمز عبور حساب</span>
                  <input type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <div className="group__actions">
                  <button className="button button--primary" type="submit" disabled={busy || !password || !exportable}>روشن کردن حالت خودکار</button>
                  <button className="text-button" type="button" onClick={() => { setStep('idle'); setPassword(''); }}>انصراف</button>
                </div>
              </form>
            )}
        </>
      )}
      <details className="group__box">
        <summary>بازیابی کلید از کلید بازیابی یا فایل</summary>
        <form onSubmit={importKey}>
          <label className="field"><span>کلید بازیابی (متن)</span>
            <textarea className="recovery-text" dir="ltr" rows={3} value={recoveryText} onChange={(e) => setRecoveryText(e.target.value)} placeholder="TELKEY1-…" />
          </label>
          <p className="group__lead">یا فایل پشتیبان:</p>
          <input type="file" accept=".telkey,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <label className="field"><span>رمز فایل</span>
            <input type="password" autoComplete="off" dir="ltr" value={filePass} onChange={(e) => setFilePass(e.target.value)} />
          </label>
          <button className="button button--soft" type="submit" disabled={busy}>بازیابی کلید</button>
        </form>
      </details>
      {msg && <div className="group__notice" role="status">{msg}</div>}
    </section>
  );
}
