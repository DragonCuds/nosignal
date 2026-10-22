import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type SharedStickerPack } from '../api.js';
import { CloseIcon } from '../icons.js';
import { faNumber } from '../ui.js';

export type PackTarget = { chatId: string; packId: string };

const failure = (error: unknown, adding: boolean): string => {
  if (error instanceof ApiError && error.status === 404) return 'این بسته در دسترس نیست.';
  if (error instanceof ApiError && error.status === 413) return 'حداکثر ۲۰ بستهٔ استیکر می‌توانید داشته باشید. اول یکی را حذف کنید.';
  return adding ? 'بسته اضافه نشد. دوباره تلاش کنید.' : 'بسته حذف نشد. دوباره تلاش کنید.';
};

/** Opens when a sticker bubble is tapped: the pack's stickers and one button to add it to (or drop it from) my stickers. */
export function StickerPackSheet({ target, onClose }: { target: PackTarget | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pack, setPack] = useState<SharedStickerPack>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!target) return;
    let live = true;
    setPack(undefined); setState('loading'); setNote(''); setBusy(false);
    void api.sharedStickerPack(target.chatId, target.packId)
      .then((result) => { if (live) { setPack(result); setState('ready'); } })
      .catch((error: unknown) => { if (live) { setState('error'); setNote(failure(error, true)); } });
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { live = false; };
  }, [target?.chatId, target?.packId]);

  useEffect(() => {
    const dialog = ref.current;
    if (!target && dialog?.open) dialog.close();
  }, [target]);

  const toggle = async () => {
    if (!target || !pack || busy) return;
    setBusy(true); setNote('');
    const adding = !pack.inLibrary;
    try {
      if (adding) await api.addSharedStickerPack(target.chatId, target.packId);
      else await api.removeStickerPackFromLibrary(target.packId);
      setPack({ ...pack, inLibrary: adding });
      setNote(adding ? 'به استیکرهای شما اضافه شد.' : 'از استیکرهای شما حذف شد.');
      window.dispatchEvent(new Event('sticker-packs-changed'));
    } catch (error) {
      setNote(failure(error, adding));
    } finally { setBusy(false); }
  };

  return (
    <dialog ref={ref} className="sheet sheet--pack" aria-label="بستهٔ استیکر" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.target === event.currentTarget && onClose()}>
      {target && <>
        <div className="sheet__head">
          <button className="icon-button" type="button" onClick={onClose} aria-label="بستن"><CloseIcon /></button>
          <h2 dir="auto">{pack?.title ?? 'بستهٔ استیکر'}</h2>
          {pack && <span className="pack-sheet__count">{faNumber(pack.stickers.length)} استیکر</span>}
        </div>
        <div className="sheet__scroll sheet__scroll--pad">
          {state === 'loading' && <div className="pack-sheet__state"><span className="spinner spinner--accent" /></div>}
          {state === 'error' && <div className="pack-sheet__state" role="alert">{note}</div>}
          {pack && <div className="pack-sheet__grid">
            {pack.stickers.map((sticker) => <div key={sticker.id} className="pack-sheet__cell"><tg-sticker src={sticker.fileUrl} format={sticker.format} size={76} autoplay loop alt={sticker.emoji || 'استیکر'} /></div>)}
          </div>}
        </div>
        {pack && <div className="pack-sheet__foot">
          <p className="pack-sheet__note" role="status" aria-live="polite">{note}</p>
          {pack.owned
            ? <p className="pack-sheet__owned">این بسته مال شماست.</p>
            : <button className={`button ${pack.inLibrary ? 'button--soft' : 'button--primary'}`} type="button" disabled={busy} onClick={() => void toggle()}>
              {busy && <span className="spinner" />}{pack.inLibrary ? 'حذف از استیکرهای من' : 'افزودن به استیکرها'}
            </button>}
        </div>}
      </>}
    </dialog>
  );
}
