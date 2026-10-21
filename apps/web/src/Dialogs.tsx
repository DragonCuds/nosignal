import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api, ApiError, type DeviceSession, type SecurityStatus, type User } from './api.js';
import { ChatIcon, ChevronIcon, CloseIcon, SearchIcon, ShieldIcon, UploadIcon } from './icons.js';
import { Avatar } from './ui.js';
import { fieldDir } from './chat/helpers.js';
import { Invites } from './settings/Invites.js';
import { Backup } from './settings/Backup.js';
import { DataSaverSettings } from './settings/DataSaver.js';
import { WallpaperSettings } from './wallpaper/WallpaperSettings.js';
import { MediaLibrary } from './media/MediaLibrary.js';
import type { BackupPayload } from './backup/crypto.js';
import { changePasswordAndBackup } from './backup/serverBackup.js';

const isIpHost = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/u.test(host) || host.includes(':') || host.startsWith('[');

const useDialog = (open: boolean) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return ref;
};

function Empty({ icon, title, copy, onRetry }: { icon?: 'chat'; title: string; copy: string; onRetry?: () => void }) {
  return (
    <div className="state">
      <span className="state__icon">{icon === 'chat' ? <ChatIcon /> : <SearchIcon />}</span>
      <strong>{title}</strong>
      <p>{copy}</p>
      {onRetry && <button className="text-button" type="button" onClick={onRetry}>تلاش دوباره</button>}
    </div>
  );
}

export function ListSkeleton() {
  return <div className="row-skeleton" aria-label="در حال دریافت">{[0, 1, 2, 3, 4].map((item) => <div key={item}><span /><div><i /><i /></div></div>)}</div>;
}

export function ChatListState({ kind, onRetry }: { kind: 'loading' | 'empty' | 'error' | 'search'; onRetry?: () => void }) {
  if (kind === 'loading') return <ListSkeleton />;
  if (kind === 'search') return <Empty title="نتیجه‌ای پیدا نشد" copy="نام مخاطب یا بخشی از پیام را جست‌وجو کنید." />;
  if (kind === 'error') return <Empty icon="chat" title="گفتگوها دریافت نشد" copy="اتصال اینترنت را بررسی و دوباره تلاش کنید." onRetry={onRetry} />;
  return <Empty icon="chat" title="هنوز گفتگویی ندارید" copy="با دکمهٔ پیام جدید، اولین گفتگو را شروع کنید." />;
}

type NewChatProps = { open: boolean; onClose: () => void; onCreated: (chatId: string) => Promise<void> };

export function NewChatDialog({ open, onClose, onCreated }: NewChatProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [creatingId, setCreatingId] = useState<string>();
  const dialogRef = useDialog(open);

  const fetchUsers = useCallback(() => {
    setStatus('loading');
    void api.users().then((result) => { setUsers(result); setStatus('ready'); }).catch(() => setStatus('error'));
  }, []);

  useEffect(() => { if (open) { setQuery(''); fetchUsers(); } }, [open, fetchUsers]);

  const needle = query.trim().toLocaleLowerCase('fa-IR');
  const filtered = users.filter((user) => `${user.displayName} ${user.username}`.toLocaleLowerCase('fa-IR').includes(needle));

  const create = async (user: User) => {
    setCreatingId(user.id);
    try {
      const result = await api.createChat(user.id);
      await onCreated(result.id);
      onClose();
    } finally { setCreatingId(undefined); }
  };

  return (
    <dialog ref={dialogRef} className="sheet sheet--narrow" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet__head">
        <button className="icon-button" type="button" onClick={onClose} aria-label="بستن"><CloseIcon /></button>
        <h2>پیام جدید</h2>
      </div>
      <label className="search-pill search-pill--sheet">
        <SearchIcon />
        <input autoFocus type="search" dir={fieldDir(query)} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی مخاطب" />
      </label>
      <div className="sheet__scroll">
        {status === 'loading' && <ListSkeleton />}
        {status === 'error' && <ChatListState kind="error" onRetry={fetchUsers} />}
        {status === 'ready' && filtered.map((user) => (
          <button className="contact" type="button" key={user.id} disabled={Boolean(creatingId)} onClick={() => void create(user)}>
            <Avatar user={user} size={40} />
            <span><strong>{user.displayName}</strong><small>{`\u2066@${user.username}\u2069`}</small></span>
            {creatingId === user.id ? <span className="spinner spinner--accent" /> : <ChevronIcon />}
          </button>
        ))}
        {status === 'ready' && filtered.length === 0 && <ChatListState kind={query ? 'search' : 'empty'} />}
      </div>
    </dialog>
  );
}

function SecuritySettings({ open, userId }: { open: boolean; userId: string }) {
  const [security, setSecurity] = useState<SecurityStatus>();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [pendingSecret, setPendingSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordFactor, setPasswordFactor] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const refresh = useCallback(() => Promise.all([api.securityStatus(), api.sessions()])
    .then(([nextSecurity, nextSessions]) => { setSecurity(nextSecurity); setSessions(nextSessions); })
    .catch(() => setNotice('دریافت وضعیت امنیتی انجام نشد.')), []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const credentials = (withSecondFactor = true): { password: string; secondFactor?: string } | null => {
    const password = window.prompt('رمز عبور فعلی را وارد کنید');
    if (!password) return null;
    const secondFactor = withSecondFactor && security?.totpEnabled ? window.prompt('کد دومرحله‌ای یا کد بازیابی را وارد کنید') || undefined : undefined;
    return { password, secondFactor };
  };
  const setupTotp = async () => {
    const value = credentials(); if (!value) return;
    try { const enrollment = await api.setupTotp(value.password, value.secondFactor); setPendingSecret(enrollment.secret); setNotice('کلید را در برنامهٔ Authenticator وارد کنید، سپس کد شش‌رقمی را تأیید کنید.'); }
    catch { setNotice('شروع راه‌اندازی دومرحله‌ای انجام نشد.'); }
  };
  const enableTotp = async () => {
    try { const enabled = await api.enableTotp(totpCode); setPendingSecret(''); setTotpCode(''); setRecoveryCodes(enabled.recoveryCodes); setNotice('ورود دومرحله‌ای فعال شد. کدهای بازیابی را همین حالا در جای امن ذخیره کنید.'); await refresh(); }
    catch { setNotice('کد دومرحله‌ای نامعتبر است یا زمان راه‌اندازی تمام شده است.'); }
  };
  const addPasskey = async () => {
    const value = credentials(); if (!value) return;
    try { const optionsJSON = await api.passkeyRegistrationOptions(value.password, value.secondFactor); const response = await startRegistration({ optionsJSON }); await api.verifyPasskeyRegistration(response, 'Passkey'); setNotice('کلید عبور اضافه شد.'); await refresh(); }
    catch { setNotice('افزودن کلید عبور لغو شد یا ناموفق بود.'); }
  };
  const removePasskey = (id: string) => {
    const value = credentials();
    if (value) void api.deletePasskey(id, value.password, value.secondFactor).then(refresh).catch(() => setNotice('حذف کلید عبور انجام نشد.'));
  };
  const revoke = async (id: string) => { try { await api.revokeSession(id); setNotice('نشست حذف شد.'); await refresh(); } catch { setNotice('حذف نشست انجام نشد.'); } };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setNotice('تکرار رمز جدید یکسان نیست.'); return; }
    if (newPassword.length < 12) { setNotice('رمز جدید باید حداقل ۱۲ نویسه باشد.'); return; }
    setChangingPassword(true); setNotice('');
    try {
      await changePasswordAndBackup(userId, currentPassword, newPassword, passwordFactor || undefined);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordFactor('');
      setNotice('رمز عبور و پشتیبان کلید به‌روزرسانی شدند. نشست‌های دیگر خارج شدند.');
      await refresh();
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 409
        ? 'نسخهٔ پشتیبان در دستگاه دیگری تغییر کرده است. صفحه را تازه کنید و دوباره تلاش کنید.'
        : error instanceof ApiError && error.status === 403
          ? 'رمز فعلی یا کد دومرحله‌ای درست نیست.'
          : error instanceof Error ? error.message : 'تغییر رمز انجام نشد. وضعیت پشتیبان کلید را بررسی کنید.');
    } finally { setChangingPassword(false); }
  };

  if (!open) return null;
  const ipHost = isIpHost(window.location.hostname);
  return (
    <section className="group" aria-labelledby="security-heading">
      <h3 id="security-heading"><ShieldIcon />امنیت حساب</h3>
      <p className="group__lead">رمزنگاری گفتگو روی دستگاه شما انجام می‌شود. برای خود حساب هم کلید عبور یا ورود دومرحله‌ای را فعال کنید.</p>
      <div className="group__actions">
        {!security?.totpEnabled && <button type="button" className="button button--soft" onClick={() => void setupTotp()}>فعال‌سازی ورود دومرحله‌ای</button>}
        {security?.totpEnabled && <span className="chip chip--ok">ورود دومرحله‌ای فعال است · {security.recoveryCodesRemaining.toLocaleString('fa-IR')} کد بازیابی مانده</span>}
        {!ipHost && <button type="button" className="button button--soft" onClick={() => void addPasskey()}>افزودن کلید عبور</button>}
      </div>
      {ipHost && <p className="group__lead">کلید عبور فقط روی نشانی دامنه‌دار کار می‌کند، نه با آدرس IP.</p>}
      {pendingSecret && (
        <div className="group__box">
          <strong dir="ltr" className="group__secret">{pendingSecret}</strong>
          <p>این کلید فقط یک‌بار نمایش داده می‌شود؛ آن را به Authenticator اضافه کنید.</p>
          <label className="field"><span>کد شش‌رقمی</span><input inputMode="numeric" autoComplete="one-time-code" dir="ltr" value={totpCode} onChange={(event) => setTotpCode(event.target.value)} maxLength={6} /></label>
          <button type="button" className="button button--primary" disabled={totpCode.length !== 6} onClick={() => void enableTotp()}>تأیید و فعال‌سازی</button>
        </div>
      )}
      {recoveryCodes.length > 0 && <div className="group__box"><strong>کدهای بازیابی (فقط اکنون)</strong><p dir="ltr" className="group__secret">{recoveryCodes.join(' · ')}</p></div>}
      {security?.passkeys.length ? (
        <ul className="list">{security.passkeys.map((passkey) => <li key={passkey.id}><span>{passkey.name}</span><button type="button" className="text-button" onClick={() => removePasskey(passkey.id)}>حذف</button></li>)}</ul>
      ) : null}
      <form className="group__box" onSubmit={(event) => void changePassword(event)}>
        <h4>تغییر رمز عبور</h4>
        <p>در حالت خودکار، کلید همین حساب پیش از تغییر رمز با رمز جدید پشتیبان‌گیری می‌شود.</p>
        <label className="field"><span>رمز فعلی</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
        <label className="field"><span>رمز جدید (حداقل ۱۲ نویسه)</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} required /></label>
        <label className="field"><span>تکرار رمز جدید</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
        {security?.totpEnabled && <label className="field"><span>کد دومرحله‌ای یا بازیابی</span><input autoComplete="one-time-code" value={passwordFactor} onChange={(event) => setPasswordFactor(event.target.value)} required /></label>}
        <button className="button button--primary" type="submit" disabled={changingPassword}>تغییر رمز</button>
      </form>
      <h4>دستگاه‌های واردشده</h4>
      <ul className="list">
        {sessions.map((session) => (
          <li key={session.id}>
            <span>{session.current ? 'این دستگاه' : session.userAgent || 'دستگاه ناشناس'}<small>{new Date(session.lastSeenAt).toLocaleString('fa-IR')}</small></span>
            {!session.current && <button type="button" className="text-button" onClick={() => void revoke(session.id)}>خروج</button>}
          </li>
        ))}
      </ul>
      {notice && <p className="group__notice" role="status">{notice}</p>}
    </section>
  );
}

type SettingsProps = {
  open: boolean; userId: string; onClose: () => void;
  getBackup: () => Promise<BackupPayload | null>; onImport: (payload: BackupPayload) => Promise<void>;
};

export function SettingsDialog({ open, userId, getBackup, onImport, onClose }: SettingsProps) {
  const dialogRef = useDialog(open);
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => { if (open) { setFile(undefined); setTitle(''); setStatus('idle'); setMessage(''); } }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || status === 'uploading') return;
    setStatus('uploading');
    setMessage('');
    try {
      const result = await api.importStickerPack(file, title);
      setStatus('done');
      setMessage(`بستهٔ «${result.title}» با ${result.count.toLocaleString('fa-IR')} استیکر اضافه شد.`);
      window.dispatchEvent(new Event('sticker-packs-changed'));
    } catch (caught) {
      setStatus('error');
      setMessage(caught instanceof Error ? caught.message : 'بسته وارد نشد.');
    }
  };

  return (
    <dialog ref={dialogRef} className="sheet" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet__head">
        <button className="icon-button" type="button" onClick={onClose} aria-label="بستن"><CloseIcon /></button>
        <h2>تنظیمات</h2>
      </div>
      <div className="sheet__scroll sheet__scroll--pad">
        <SecuritySettings open={open} userId={userId} />
        <div className="group"><DataSaverSettings /></div>
        <div className="group"><WallpaperSettings /></div>
        <div className="group"><MediaLibrary /></div>
        {open && <div className="group"><Backup userId={userId} getBackup={getBackup} onImport={onImport} /></div>}
        {open && <div className="group"><Invites /></div>}
        <form className="group" onSubmit={submit}>
          <h3><UploadIcon />وارد کردن بستهٔ استیکر</h3>
          <p className="group__lead">یک فایل ZIP شامل استیکرهای TGS، WebM یا WebP انتخاب کنید.</p>
          <label className="field"><span>نام بسته (اختیاری)</span><input dir={fieldDir(title)} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} placeholder="مثلاً حال خوب" /></label>
          <label className="file-picker">
            <input type="file" accept=".zip,application/zip" onChange={(event) => { setFile(event.target.files?.[0]); setStatus('idle'); setMessage(''); }} />
            <UploadIcon /><span>{file?.name ?? 'انتخاب فایل ZIP'}</span>
          </label>
          {message && <div className={`group__notice group__notice--${status}`} role="status">{message}</div>}
          <button className="button button--primary" type="submit" disabled={!file || status === 'uploading'}>
            {status === 'uploading' ? <><span className="spinner" /> در حال بارگذاری…</> : status === 'done' ? 'بسته اضافه شد' : 'افزودن بسته'}
          </button>
        </form>
      </div>
    </dialog>
  );
}
