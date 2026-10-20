import { setDataSaver, useDataSaver, type DataSaverMode } from '../datasaver.js';

const CHOICES: { mode: DataSaverMode; title: string; hint: string }[] = [
  { mode: 'auto', title: 'خودکار', hint: 'اگر اینترنت ضعیف باشد، عکس‌ها خودشان دانلود نمی‌شوند.' },
  { mode: 'on', title: 'روشن', hint: 'عکس‌ها فقط وقتی بزنید دانلود می‌شوند.' },
  { mode: 'off', title: 'خاموش', hint: 'عکس‌ها همیشه خودکار دانلود می‌شوند.' },
];

/** Settings section: three data-saver choices. Mounted by the settings page. */
export function DataSaverSettings() {
  const { mode, saving } = useDataSaver();
  return (
    <section dir="rtl" aria-label="صرفه‌جویی در اینترنت">
      <h2>صرفه‌جویی در اینترنت</h2>
      <div role="radiogroup" aria-label="صرفه‌جویی در اینترنت" style={{ display: 'grid', gap: 6 }}>
        {CHOICES.map((c) => (
          <button
            key={c.mode} type="button" role="radio" aria-checked={mode === c.mode} onClick={() => setDataSaver(c.mode)}
            style={{ background: mode === c.mode ? 'var(--accent-soft)' : 'transparent', border: 0, borderRadius: 12, color: 'var(--text)', cursor: 'pointer', display: 'grid', font: 'inherit', gap: 2, padding: '10px 12px', textAlign: 'start' }}
          >
            <strong style={{ color: mode === c.mode ? 'var(--accent)' : undefined }}>{c.title}</strong>
            <span style={{ fontSize: 13, opacity: 0.7 }}>{c.hint}</span>
          </button>
        ))}
      </div>
      {mode === 'auto' && saving && <p role="status" style={{ fontSize: 13, opacity: 0.7 }}>اینترنت شما الان ضعیف است؛ صرفه‌جویی فعال شد.</p>}
    </section>
  );
}
