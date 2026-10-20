import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { unb64u } from '../attachments/crypto.js';
import { saveBlob, useAttachmentBlob, useBlobUrl } from '../attachments/load.js';
import { thumbMime } from '../attachments/prepare.js';
import { useProgress } from '../attachments/progress.js';
import { formatBytes, inlineMime, type AttachmentDescriptor } from '../attachments/types.js';
import { useDataSaver } from '../datasaver.js';
import { CloseIcon } from '../icons.js';
import { DownloadIcon, ProgressRing } from '../attachments/ui.js';

const BOX = 340;

export const mediaSize = (a: AttachmentDescriptor, box = BOX): { width: number; height: number } => {
  const w = a.w && a.w > 0 ? a.w : 4;
  const h = a.h && a.h > 0 ? a.h : 3;
  const scale = Math.min(box / w, box / h, 1);
  const width = Math.max(120, Math.round(w * scale));
  return { width, height: Math.max(80, Math.round(width * h / w)) };
};

const useThumbUrl = (a: AttachmentDescriptor): string | undefined => {
  const [blob, setBlob] = useState<Blob>();
  useEffect(() => {
    try { setBlob(a.thumb ? new Blob([unb64u(a.thumb) as BlobPart], { type: thumbMime(a.thumb) }) : undefined); } catch { setBlob(undefined); }
  }, [a.thumb]);
  return useBlobUrl(blob);
};

function Lightbox({ url, name, blob, close }: { url: string; name: string; blob?: Blob; close: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [close]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-label="نمایش تصویر" onClick={close}>
      <div className="lightbox__bar" onClick={(event) => event.stopPropagation()}>
        {blob && <button className="icon-button" type="button" onClick={() => saveBlob(blob, name)} aria-label="ذخیره" title="ذخیره"><DownloadIcon /></button>}
        <button className="icon-button" type="button" onClick={close} aria-label="بستن"><CloseIcon /></button>
      </div>
      <img src={url} alt="تصویر" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}

export function PhotoBubble({ chatId, attachment }: { chatId: string; attachment: AttachmentDescriptor }) {
  const { saving } = useDataSaver();
  const { blob, loading, failed, load } = useAttachmentBlob(chatId, attachment, !saving);
  const progress = useProgress(attachment.id);
  const type = inlineMime(attachment.mime, 'image');
  const url = useBlobUrl(blob, type);
  const thumb = useThumbUrl(attachment);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const { width, height } = mediaSize(attachment);
  const ext = type?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'img';

  return (
    <div className="att-photo" style={{ width, aspectRatio: `${width} / ${height}` }}>
      {thumb && <img className="att-photo__blur" src={thumb} alt="" />}
      {url && type && (
        <button className={`att-photo__open${shown ? ' att-photo__open--ready' : ''}`} type="button" onClick={() => setOpen(true)} aria-label="باز کردن تصویر">
          <img src={url} alt="تصویر" onLoad={() => setShown(true)} />
        </button>
      )}
      {(progress !== undefined || (!url && loading)) && <ProgressRing className="att-photo__ring" value={progress} />}
      {!url && !loading && !failed && progress === undefined && saving && <button className="att-photo__retry" type="button" onClick={load} aria-label="دانلود تصویر"><DownloadIcon />{formatBytes(attachment.size)}</button>}
      {!url && failed && <button className="att-photo__retry" type="button" onClick={load}><DownloadIcon />تلاش دوباره</button>}
      {open && url && <Lightbox url={url} name={`photo.${ext}`} blob={blob} close={() => setOpen(false)} />}
    </div>
  );
}
