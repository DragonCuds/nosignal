import { useCallback, useEffect, useState } from 'react';
import { MAX_GIFS, MAX_PACKS, mediaApi, type Gif, type Pack } from './mediaApi.js';
import { TelegramImport, useMediaAdd } from './useMediaAdd.js';

/** Settings section «استیکرها و گیف‌های من»: manage own sticker packs, uploaded and saved GIFs. */
export function MediaLibrary() {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [gifs, setGifs] = useState<Gif[] | null>(null);
  const [saved, setSaved] = useState<Gif[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // item id being deleted
  const [confirm, setConfirm] = useState<{ kind: 'pack' | 'unpack' | 'gif' | 'unsave'; id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, g, s] = await Promise.all([mediaApi.packs(), mediaApi.gifs(), mediaApi.savedGifs()]);
      setPacks(p); setGifs(g); setSaved(s); setError('');
      // pack sticker counts: one small request per pack (max 20)
      const counts = await Promise.all(p.map((x) => mediaApi.packDetail(x.id).then((d) => d.stickers.length).catch(() => undefined)));
      setPacks(p.map((x, i) => ({ ...x, count: counts[i] })));
    } catch (e) { setError(e instanceof Error ? e.message : 'بارگذاری نشد.'); setPacks((v) => v ?? []); setGifs((v) => v ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const savedIds = new Set(saved.map((g) => g.id));
  const uploaded = (gifs ?? []).filter((g) => !savedIds.has(g.id));

  const doDelete = async () => {
    if (!confirm) return;
    const { kind, id } = confirm;
    setConfirm(null); setBusy(id); setError('');
    try {
      if (kind === 'pack') await mediaApi.deletePack(id);
      else if (kind === 'unpack') await mediaApi.removePack(id);
      else if (kind === 'gif') await mediaApi.deleteGif(id);
      else await mediaApi.unsaveGif(id);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'حذف نشد.'); } finally { setBusy(null); }
  };

  const add = useMediaAdd(load);
  const { progress } = add;
  const [showTg, setShowTg] = useState(false);

  const loading = packs === null || gifs === null;
  const fa = (n: number) => n.toLocaleString('fa-IR');

  return (
    <section className="media-lib" dir="rtl" aria-label="استیکرها و گیف‌های من">
      <h2>استیکرها و گیف‌های من</h2>
      <p className="media-lib__usage" role="status">
        بسته‌ها {fa(packs?.length ?? 0)} از {fa(MAX_PACKS)} · گیف‌ها {fa(gifs?.length ?? 0)} از {fa(MAX_GIFS)}
      </p>
      {(error || add.error) && <p className="media-lib__error" role="alert">{error || add.error}</p>}

      <div className="media-lib__head">
        <h3>بسته‌های استیکر</h3>
        <button type="button" className="media-lib__btn" disabled={add.busy} onClick={add.openPack}>وارد کردن بسته (zip)</button>
        <button type="button" className="media-lib__btn" disabled={add.busy} aria-expanded={showTg} onClick={() => setShowTg((v) => !v)}>افزودن بسته از تلگرام</button>
        {add.inputs}
      </div>
      {showTg && <TelegramImport add={add} showError={false} />}
      {progress?.kind === 'pack' && <Progress pct={progress.pct} />}
      {loading ? <p className="media-lib__empty">در حال بارگذاری…</p>
        : packs.length === 0 ? <p className="media-lib__empty">هنوز بسته‌ی استیکری ندارید. یک فایل zip استیکر وارد کنید.</p>
        : (
          <ul className="media-lib__list">
            {packs.map((p) => (
              <li key={p.id} className="media-lib__row">
                <Thumb src={p.thumbUrl} />
                <span className="media-lib__name"><strong>{p.title}</strong>{p.count !== undefined && <small>{fa(p.count)} استیکر</small>}</span>
                <button type="button" className="media-lib__del" disabled={busy === p.id} onClick={() => setConfirm({ kind: p.owned === false ? 'unpack' : 'pack', id: p.id, name: p.title })}>{p.owned === false ? 'برداشتن' : 'حذف'}</button>
              </li>
            ))}
          </ul>
        )}

      <div className="media-lib__head">
        <h3>گیف‌های آپلودشده</h3>
        <button type="button" className="media-lib__btn" disabled={add.busy} onClick={add.openGif}>آپلود گیف</button>
      </div>
      {progress?.kind === 'gif' && <Progress pct={progress.pct} />}
      {loading ? null : uploaded.length === 0 ? <p className="media-lib__empty">هنوز گیفی آپلود نکرده‌اید.</p>
        : <GifGrid items={uploaded} busy={busy} label="حذف" onAct={(g) => setConfirm({ kind: 'gif', id: g.id, name: 'این گیف' })} />}

      <div className="media-lib__head"><h3>گیف‌های ذخیره‌شده</h3></div>
      {loading ? null : saved.length === 0 ? <p className="media-lib__empty">گیف ذخیره‌شده‌ای ندارید. در گفتگو روی یک گیف بزنید و ذخیره کنید.</p>
        : <GifGrid items={saved} busy={busy} label="برداشتن" onAct={(g) => setConfirm({ kind: 'unsave', id: g.id, name: 'این گیف' })} />}

      {confirm && (
        <div className="media-lib__scrim" role="dialog" aria-modal="true" onClick={() => setConfirm(null)}>
          <div className="media-lib__dialog" onClick={(e) => e.stopPropagation()}>
            <p>{confirm.kind === 'unsave' ? `${confirm.name} از ذخیره‌شده‌ها برداشته شود؟` : confirm.kind === 'unpack' ? `«${confirm.name}» از استیکرهای شما برداشته شود؟ صاحب بسته آن را نگه می‌دارد.` : `${confirm.name} حذف شود؟ این کار برگشت ندارد.`}</p>
            <div className="media-lib__actions">
              <button type="button" className="media-lib__btn" onClick={() => setConfirm(null)}>انصراف</button>
              <button type="button" className="media-lib__btn media-lib__btn--danger" onClick={() => void doDelete()}>{confirm.kind === 'unsave' || confirm.kind === 'unpack' ? 'برداشتن' : 'حذف'}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Progress({ pct }: { pct: number }) {
  return <div className="media-lib__progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>;
}

function Thumb({ src }: { src: string | null }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? <img className="media-lib__thumb" src={src} alt="" loading="lazy" onError={() => setBad(true)} /> : <span className="media-lib__thumb media-lib__thumb--empty" aria-hidden="true" />;
}

function GifGrid({ items, busy, label, onAct }: { items: Gif[]; busy: string | null; label: string; onAct: (g: Gif) => void }) {
  return (
    <ul className="media-lib__grid">
      {items.map((g) => (
        <li key={g.id} className="media-lib__cell">
          {g.posterUrl ? <img src={g.posterUrl} alt="" loading="lazy" /> : <span className="media-lib__thumb--empty" />}
          <button type="button" disabled={busy === g.id} onClick={() => onAct(g)} aria-label={label}>{label}</button>
        </li>
      ))}
    </ul>
  );
}
