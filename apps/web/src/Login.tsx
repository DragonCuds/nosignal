import { FormEvent, useEffect, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, ApiError, type User } from './api.js';
import { ChatIcon, LockIcon, MoonIcon, SunIcon } from './icons.js';
import { checkUsername, isSignupOpen, registerAccount, signupErrorText, USERNAME_RE, validateSignup, type SignupCheck } from './registerApi.js';
import { setBackupAccount, setupBackupAfterSignup, syncBackupAfterLogin } from './backup/serverBackup.js';
import './styles/signup.css';

type Theme = 'light' | 'dark';

export function LoadingScreen() {
  return (
    <main className="splash" aria-live="polite">
      <div className="logo logo--pulse"><ChatIcon /></div>
      <p>در حال آماده‌سازی NoSignal…</p>
    </main>
  );
}

type Props = { theme: Theme; onToggleTheme: () => void; onAuthenticated: (user: User) => void };

const hintText: Record<SignupCheck, string> = {
  idle: 'فقط حرف انگلیسی کوچک، عدد و _ (۳ تا ۳۲ نویسه)',
  invalid: 'آیدی باید ۳ تا ۳۲ حرف انگلیسی کوچک، عدد یا _ باشد.',
  checking: 'در حال بررسی…',
  available: 'این آیدی آزاد است.',
  taken: 'این آیدی قبلاً گرفته شده است.',
  error: 'بررسی آیدی انجام نشد؛ بعداً دوباره امتحان کنید.',
};

function SignupForm({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [check, setCheck] = useState<SignupCheck>('idle');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const idRef = useRef<HTMLInputElement>(null);

  useEffect(() => idRef.current?.focus(), []);

  useEffect(() => {
    if (!username) { setCheck('idle'); return; }
    if (!USERNAME_RE.test(username)) { setCheck('invalid'); return; }
    setCheck('checking');
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      checkUsername(username, controller.signal)
        .then(setCheck)
        .catch((caught) => { if (!controller.signal.aborted) setCheck(caught instanceof ApiError && caught.status === 429 ? 'idle' : 'error'); });
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [username]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const problem = validateSignup(username, password, repeat);
    if (problem) { setError(problem); return; }
    if (check === 'taken') { setError(hintText.taken); return; }
    setSubmitting(true);
    setError('');
    try {
      await registerAccount(username, password, displayName);
      // Same as the invite flow: the session cookie is set; E2EE identity creation and the backup reminder run when the messenger opens.
      const me = await api.me();
      setBackupAccount(me.id);
      await setupBackupAfterSignup(me.id, password); // Auto mode: key made now, wrapped with the password, stored on the server
      onAuthenticated(me);
    } catch (caught) {
      setError(signupErrorText(caught));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <label className="field">
        <span>آیدی (نام کاربری)</span>
        <input ref={idRef} name="username" autoComplete="username" dir="ltr" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={32}
          value={username} onChange={(event) => setUsername(event.target.value.trim().toLowerCase())} aria-invalid={check === 'taken' || check === 'invalid'} />
        <small className={`signup__hint signup__hint--${check}`} aria-live="polite">{hintText[check]}</small>
      </label>
      <label className="field">
        <span>نام نمایشی (اختیاری)</span>
        <input name="name" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={100} placeholder={username || 'پیش‌فرض: همان آیدی'} />
      </label>
      <label className="field">
        <span>رمز عبور (حداقل ۸ نویسه)</span>
        <input name="password" type="password" autoComplete="new-password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={1024} />
      </label>
      <label className="field">
        <span>تکرار رمز عبور</span>
        <input name="password-repeat" type="password" autoComplete="new-password" dir="ltr" value={repeat} onChange={(event) => setRepeat(event.target.value)} maxLength={1024} aria-invalid={Boolean(repeat) && repeat !== password} />
      </label>
      <p className="signup__warning" role="note">رمز عبور قابل بازیابی نیست. راهی برای «فراموشی رمز» وجود ندارد و هیچ‌کس، حتی مدیر سرور، نمی‌تواند آن را برایتان تغییر دهد. رمز را جایی امن نگه دارید.</p>
      <div className={`login__error${error ? ' login__error--visible' : ''}`} role="alert">{error || ' '}</div>
      <button className="button button--primary" type="submit" disabled={submitting}>{submitting ? <span className="spinner" /> : 'ساخت حساب'}</button>
    </form>
  );
}

export function LoginPage({ theme, onToggleTheme, onAuthenticated }: Props) {
  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [signupOpen, setSignupOpen] = useState(false);
  useEffect(() => { let live = true; void isSignupOpen().then((open) => { if (live) setSignupOpen(open); }); return () => { live = false; }; }, []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [secondFactorRequired, setSecondFactorRequired] = useState(false);
  const [secondFactor, setSecondFactor] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (tab === 'login') usernameRef.current?.focus(); }, [tab]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) { setError('نام کاربری و رمز عبور را وارد کنید.'); return; }
    setSubmitting(true);
    setError('');
    try {
      await api.login(username.trim(), password, secondFactor || undefined);
      const me = await api.me();
      setBackupAccount(me.id);
      await syncBackupAfterLogin(me.id, password); // restores the key on a new device / uploads the backup; never blocks login
      onAuthenticated(me);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 428) {
        setSecondFactorRequired(true);
        setError('کد برنامهٔ احراز هویت یا یکی از کدهای بازیابی را وارد کنید.');
      } else setError(caught instanceof ApiError && caught.status === 401
        ? 'نام کاربری یا رمز عبور درست نیست.'
        : caught instanceof Error ? caught.message : 'ورود انجام نشد. دوباره تلاش کنید.');
    } finally { setSubmitting(false); }
  };

  const loginWithPasskey = async () => {
    setSubmitting(true);
    setError('');
    try {
      const optionsJSON = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON });
      await api.verifyPasskeyLogin(response);
      const me = await api.me();
      setBackupAccount(me.id);
      onAuthenticated(me);
    } catch (caught) {
      setError(caught instanceof Error && caught.name !== 'NotAllowedError' ? caught.message : 'ورود با کلید عبور لغو شد یا موفق نبود.');
    } finally { setSubmitting(false); }
  };

  return (
    <main className="login">
      <button className="icon-button login__theme" type="button" onClick={onToggleTheme} aria-label={theme === 'dark' ? 'فعال کردن تم روشن' : 'فعال کردن تم تیره'}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
      <section className="login__card">
        <div className="logo logo--big"><ChatIcon /></div>
        <h1>{tab === 'login' ? 'ورود به NoSignal' : 'ساخت حساب در NoSignal'}</h1>
        <p className="login__lead">{tab === 'login' ? 'پیام‌رسان شخصی شما' : 'فقط با یک آیدی و رمز عبور'}</p>
        {signupOpen && (
          <div className="login__tabs" role="tablist" aria-label="ورود یا ثبت‌نام">
            <button type="button" role="tab" aria-selected={tab === 'login'} className={tab === 'login' ? 'login__tab--active' : ''} onClick={() => setTab('login')}>ورود</button>
            <button type="button" role="tab" aria-selected={tab === 'signup'} className={tab === 'signup' ? 'login__tab--active' : ''} onClick={() => setTab('signup')}>ثبت‌نام</button>
          </div>
        )}
        {tab === 'signup' && signupOpen && <SignupForm onAuthenticated={onAuthenticated} />}
        {(tab === 'login' || !signupOpen) && <form onSubmit={submit} noValidate>
          <label className="field">
            <span>نام کاربری</span>
            <input ref={usernameRef} name="username" autoComplete="username" dir="ltr" value={username} onChange={(event) => setUsername(event.target.value)} aria-invalid={Boolean(error)} />
          </label>
          <label className="field">
            <span>رمز عبور</span>
            <input name="password" type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(error)} />
          </label>
          {secondFactorRequired && (
            <label className="field">
              <span>کد دومرحله‌ای یا بازیابی</span>
              <input name="one-time-code" autoComplete="one-time-code" inputMode="numeric" dir="ltr" value={secondFactor} onChange={(event) => setSecondFactor(event.target.value)} maxLength={24} autoFocus />
            </label>
          )}
          <div className={`login__error${error ? ' login__error--visible' : ''}`} role="alert">{error || ' '}</div>
          <button className="button button--primary" type="submit" disabled={submitting}>{submitting ? <span className="spinner" /> : 'ورود'}</button>
          {typeof window !== 'undefined' && 'PublicKeyCredential' in window && !/^\d{1,3}(\.\d{1,3}){3}$|:/u.test(window.location.hostname) && (
            <button className="button button--soft" type="button" disabled={submitting} onClick={() => void loginWithPasskey()}>ورود با کلید عبور</button>
          )}
        </form>}
        <p className="login__secure"><LockIcon /> پیام‌ها سرتاسر رمزنگاری می‌شوند</p>
      </section>
    </main>
  );
}
