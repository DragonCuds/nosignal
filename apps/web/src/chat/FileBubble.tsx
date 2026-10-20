import { useEffect, useState } from 'react';
import { saveBlob, useAttachmentBlob, useBlobUrl } from '../attachments/load.js';
import { useProgress } from '../attachments/progress.js';
import { formatBytes, formatDuration, inlineMime, type AttachmentDescriptor } from '../attachments/types.js';
import { DownloadIcon, FileIcon, PlayIcon, ProgressRing } from '../attachments/ui.js';
import { mediaSize } from './PhotoBubble.js';

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

export function VideoBubble({ chatId, attachment }: { chatId: string; attachment: AttachmentDescriptor }) {
  const { blob, loading, failed, load } = useAttachmentBlob(chatId, attachment, false);
  const progress = useProgress(attachment.id);
  const type = inlineMime(attachment.mime, 'video');
  const url = useBlobUrl(blob, type);
  const { width, height } = mediaSize(attachment);
  const busy = loading || progress !== undefined;

  if (!type) return <FileBubble chatId={chatId} attachment={{ ...attachment, name: attachment.name || 'video' }} />;
  if (url) return <video className="att-video" src={url} controls playsInline preload="metadata" style={{ width, aspectRatio: `${width} / ${height}` }} />;
  return (
    <button className="att-videocard" type="button" onClick={load} disabled={busy} style={{ width, aspectRatio: `${width} / ${height}` }} aria-label="پخش ویدیو">
      <ProgressRing className="att-videocard__ring" value={busy ? progress : null} size={52}>{busy ? null : <PlayIcon />}</ProgressRing>
      <span className="att-videocard__info">{failed ? 'دریافت نشد؛ دوباره بزنید' : `${formatBytes(attachment.size)}${attachment.durationMs ? ` · ${formatDuration(attachment.durationMs)}` : ''}`}</span>
    </button>
  );
}
