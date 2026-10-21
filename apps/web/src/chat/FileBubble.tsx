import { useEffect, useState } from 'react';
import { saveBlob, useAttachmentBlob } from '../attachments/load.js';
import { useProgress } from '../attachments/progress.js';
import { formatBytes, type AttachmentDescriptor } from '../attachments/types.js';
import { DownloadIcon, FileIcon, ProgressRing } from '../attachments/ui.js';

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toUpperCase() : '';
};

export function FileBubble({ chatId, attachment }: { chatId: string; attachment: AttachmentDescriptor }) {
  const { blob, loading, failed, load } = useAttachmentBlob(chatId, attachment, false);
  const progress = useProgress(attachment.id);
  const name = attachment.name || 'file';
  const busy = loading || progress !== undefined;
  const [saveWhenReady, setSaveWhenReady] = useState(false);

  useEffect(() => {
    if (blob && saveWhenReady) { setSaveWhenReady(false); saveBlob(blob, name); }
  }, [blob, saveWhenReady, name]);

  const click = () => {
    if (busy) return;
    if (blob) saveBlob(blob, name);
    else { setSaveWhenReady(true); load(); }
  };
  const ext = extOf(name);
  return (
    <button className="att-file" type="button" onClick={click} aria-label={`دریافت ${name}`}>
      <ProgressRing className="att-file__icon" value={busy ? progress : null}>
        {busy ? null : blob ? <FileIcon /> : <DownloadIcon />}
      </ProgressRing>
      <span className="att-file__copy">
        <strong dir="auto">{name}</strong>
        <span>{failed ? 'دریافت نشد؛ دوباره بزنید' : `${formatBytes(attachment.size)}${ext ? ` · ${ext}` : ''}`}</span>
      </span>
    </button>
  );
}
