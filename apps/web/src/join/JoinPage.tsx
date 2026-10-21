import { setBackupAccount, setupBackupAfterSignup } from '../backup/serverBackup.js';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type User } from '../api.js';
import { ChatIcon, LockIcon, MoonIcon, SunIcon } from '../icons.js';
import { acceptInvite, checkInvite } from './inviteApi.js';

type Props = {
  token: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  /** Called with the new user once the invite is accepted and the session cookie is set. */
  onJoined: (user: User) => void;
};

/** Returns the invite token for `/join/:token` paths, otherwise null. */
export const inviteTokenFromPath = (pathname: string): string | null => {
  const match = /^\/join\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return match ? match[1] : null;
};

const errorText = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'این دعوت‌نامه معتبر نیست یا منقضی شده است.';
    if (error.status === 409) return 'این نام کاربری قبلاً گرفته شده است.';
    if (error.status === 429) return 'تلاش‌های زیادی انجام شد. چند دقیقه بعد دوباره امتحان کنید.';
  }
  return 'ساخت حساب انجام نشد. دوباره تلاش کنید.';
};

export function JoinPage({ token, theme, onToggleTheme, onJoined }: Props) {
  const [state, setState] = useState<'checking' | 'valid' | 'invalid'>('checking');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    checkInvite(token)
      .then((result) => { if (!cancelled) setState(result.valid ? 'valid' : 'invalid'); })
      .catch(() => { if (!cancelled) setState('invalid'); });
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim().toLowerCase();
    if (!displayName.trim()) { setError('نام خود را وارد کنید.'); return; }
    if (!/^[a-z0-9_]{3,32}$/.test(name)) { setError('نام کاربری باید ۳ تا ۳۲ حرف انگلیسی کوچک، عدد یا _ باشد.'); return; }
    if (password.length < 8) { setError('رمز عبور باید حداقل ۸ نویسه باشد.'); return; }
    setSubmitting(true);
    setError('');
    try {
      await acceptInvite(token, { username: name, displayName: displayName.trim(), password });
      const me = await api.me();
      setBackupAccount(me.id);
      await setupBackupAfterSignup(me.id, password); // key + password-wrapped backup are stored before the app opens (never throws)
      onJoined(me);
    } catch (caught) {
      setError(errorText(caught));
      setSubmitting(false);
    }
  };

  return (
    <main className="login">
      <button className="icon-button login__theme" type="button" onClick={onToggleTheme} aria-label={theme === 'dark' ? 'فعال کردن تم روشن' : 'فعال کردن تم تیره'}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
      <section className="login__card">
        <div className="logo logo--big"><ChatIcon /></div>
        {state === 'checking' && <p className="login__lead" aria-live="polite">در حال بررسی دعوت‌نامه…</p>}
        {state === 'invalid' && (
          <>
            <h1>دعوت‌نامه معتبر نیست</h1>
            <p className="login__lead">این لینک منقضی شده یا قبلاً استفاده شده. از فرستنده بخواهید لینک تازه‌ای بسازد.</p>
          </>
        )}
        {state === 'valid' && (
          <>
            <h1>به NoSignal خوش آمدید</h1>
            <p className="login__lead">یک نام و رمز عبور انتخاب کنید تا حسابتان ساخته شود.</p>
            <form onSubmit={submit} noValidate>
              <label className="field">
                <span>نام شما</span>
                <input name="name" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={100} autoFocus />
              </label>
              <label className="field">
                <span>نام کاربری (انگلیسی)</span>
                <input name="username" autoComplete="username" dir="ltr" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} aria-invalid={Boolean(error)} />
              </label>
              <label className="field">
                <span>رمز عبور (حداقل ۸ نویسه)</span>
                <input name="password" type="password" autoComplete="new-password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(error)} />
              </label>
              <div className={`login__error${error ? ' login__error--visible' : ''}`} role="alert">{error || ' '}</div>
              <button className="button button--primary" type="submit" disabled={submitting}>{submitting ? <span className="spinner" /> : 'ساخت حساب'}</button>
            </form>
            <p className="login__secure"><LockIcon /> پیام‌ها سرتاسر رمزنگاری می‌شوند</p>
          </>
        )}
      </section>
    </main>
  );
}
