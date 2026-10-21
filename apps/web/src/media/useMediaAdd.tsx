import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { mediaApi, TG_TEXT, type TgJob } from './mediaApi.js';

export type MediaAdd = ReturnType<typeof useMediaAdd>;

/**
 * One implementation of "add sticker pack (zip)", "add GIF" and "import from Telegram", shared by the
 * settings library and the composer picker. `onChanged` runs after anything was added.
 */
export function useMediaAdd(onChanged: (kind: 'pack' | 'gif') => void | Promise<void>) {
  const [progress, setProgress] = useState<{ kind: 'pack' | 'gif'; pct: number } | null>(null);
  const [error, setError] = useState('');
  const [tgEnabled, setTgEnabled] = useState<boolean | null>(null);
  const [tgJob, setTgJob] = useState<TgJob | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const alive = useRef(true);
  const packInput = useRef<HTMLInputElement>(null);
  const gifInput = useRef<HTMLInputElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { void mediaApi.telegramEnabled().then((v) => alive.current && setTgEnabled(v)); }, []);

  const pick = useCallback(async (kind: 'pack' | 'gif', file: File | undefined) => {
    if (!file) return;
    setError(''); setProgress({ kind, pct: 0 });
    try {
      const onP = (pct: number) => setProgress({ kind, pct });
      if (kind === 'pack') await mediaApi.importPack(file, onP); else await mediaApi.uploadGif(file, onP);
      await onChanged(kind);
    } catch (e) { setError(e instanceof Error ? e.message : 'آپلود نشد.'); } finally { if (alive.current) setProgress(null); }
  }, [onChanged]);

  const importTelegram = useCallback(async (link: string): Promise<boolean> => {
    setError(''); setTgJob(null); setTgBusy(true);
    try {
      let job = await mediaApi.telegramStart(link.trim());
      setTgJob(job);
      while (job.state === 'running' && alive.current) {
        await new Promise((r) => setTimeout(r, 1000));
        job = await mediaApi.telegramJob(job.id);
        if (alive.current) setTgJob(job);
      }
      if (job.state === 'error') { setError(TG_TEXT[job.code ?? 'internal'] ?? TG_TEXT.internal); return false; }
      await onChanged('pack');
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : TG_TEXT.internal); return false; } finally { if (alive.current) setTgBusy(false); }
  }, [onChanged]);

  const busy = !!progress || tgBusy;
  const inputs = <>
    <input ref={packInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => { void pick('pack', e.target.files?.[0]); e.target.value = ''; }} />
    <input ref={gifInput} type="file" accept=".gif,.mp4,image/gif,video/mp4" hidden onChange={(e) => { void pick('gif', e.target.files?.[0]); e.target.value = ''; }} />
  </>;
  return { progress, error, setError, tgEnabled, tgJob, tgBusy, busy, inputs, importTelegram, openPack: () => packInput.current?.click(), openGif: () => gifInput.current?.click() };
}

const fa = (n: number) => n.toLocaleString('fa-IR');

/** Paste-a-link form + live progress + result summary for the Telegram import. */
export function TelegramImport({ add, onDone, showError = true }: { add: MediaAdd; onDone?: () => void; showError?: boolean }) {
  const [link, setLink] = useState('');
  const { tgEnabled, tgJob, tgBusy } = add;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!link.trim() || tgBusy) return;
    if (await add.importTelegram(link)) { setLink(''); onDone?.(); }
  };
  if (tgEnabled === false) return <p className="media-lib__empty" role="status">{TG_TEXT.telegram_not_configured}</p>;
  const pct = tgJob && tgJob.total ? Math.round((tgJob.processed / tgJob.total) * 100) : 0;
  return (
    <form className="tg-import" onSubmit={(e) => void submit(e)}>
      <input className="tg-import__input" dir="ltr" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={link} disabled={tgBusy || tgEnabled === null}
        onChange={(e) => setLink(e.target.value)} placeholder="t.me/addstickers/…" aria-label="پیوند بسته‌ی استیکر تلگرام" />
      <button type="submit" className="media-lib__btn tg-import__go" disabled={tgBusy || !link.trim() || tgEnabled === null}>{tgBusy ? 'در حال وارد کردن…' : 'افزودن'}</button>
      {tgBusy && <div className="media-lib__progress tg-import__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>}
      {tgJob?.state === 'done' && <p className="tg-import__ok" role="status">
        «{tgJob.title}»: {fa(tgJob.imported)} استیکر اضافه شد{tgJob.skipped ? `، ${fa(tgJob.skipped)} تکراری` : ''}{tgJob.failed ? `، ${fa(tgJob.failed)} ناموفق` : ''}.
      </p>}
      {showError && add.error && <p className="media-lib__error tg-import__err" role="alert">{add.error}</p>}
    </form>
  );
}
