import { useEffect, useState } from 'react';
import { ChatIcon } from '../icons.js';
import { MegaphoneIcon } from './ChannelIcon.js';
import { channelsApi } from './channelsApi.js';
import './channels.css';

type Props = { token: string; onDone: (chatId?: string) => void };

/** Full-screen join page for `/c/<token>`; shown after login/signup, the token stays in the URL until then. */
export function ChannelJoin({ token, onDone }: Props) {
  const [info, setInfo] = useState<{ title: string; memberCount: number } | 'invalid' | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    channelsApi.preview(token)
      .then((result) => { if (live) setInfo(result); })
      .catch(() => { if (live) setInfo('invalid'); });
    return () => { live = false; };
  }, [token]);

  const join = async () => {
    setBusy(true); setError('');
    try { onDone((await channelsApi.join(token)).chatId); }
    catch { setError('عضویت انجام نشد. دوباره تلاش کنید.'); setBusy(false); }
  };

  return (
    <main className="login">
      <section className="login__card channel-join">
        {info === 'loading' && <><div className="logo logo--big"><ChatIcon /></div><p className="login__lead" aria-live="polite">در حال بررسی لینک…</p></>}
        {info === 'invalid' && (
          <>
            <div className="logo logo--big"><MegaphoneIcon /></div>
            <h1>لینک معتبر نیست</h1>
            <p className="login__lead">این لینک دعوت منقضی یا لغو شده. از مدیر کانال بخواهید لینک تازه‌ای بسازد.</p>
            <button className="button button--soft" type="button" onClick={() => onDone()}>رفتن به گفتگوها</button>
          </>
        )}
        {typeof info === 'object' && (
          <>
            <div className="logo logo--big"><MegaphoneIcon /></div>
            <h1 dir="auto">{info.title}</h1>
            <p className="login__lead">{info.memberCount.toLocaleString('fa-IR')} عضو · کانال خصوصی</p>
            <div className={`login__error${error ? ' login__error--visible' : ''}`} role="alert">{error || ' '}</div>
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void join()}>{busy ? <span className="spinner" /> : 'عضویت در کانال'}</button>
            <button className="text-button" type="button" onClick={() => onDone()}>فعلاً نه</button>
          </>
        )}
      </section>
    </main>
  );
}
