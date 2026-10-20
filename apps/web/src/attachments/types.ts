// Mirrors packages/media-contract/src/attachments.ts (web has no dependency on that package).
export type AttachmentKind = 'photo' | 'video' | 'voice' | 'file';

export type AttachmentDescriptor = {
  version: 2;
  id: string;
  key: string;
  noncePrefix: string;
  chunkSize: number;
  size: number;
  mime: string;
  name?: string;
  w?: number;
  h?: number;
  durationMs?: number;
  waveform?: string;
  thumb?: string;
};

export type AttachmentPayload = { attachment: AttachmentDescriptor; caption?: string };

/** What the composer hands to the sender; preparation (resize, metadata) happens in the sender. */
export type AttachmentInput = {
  kind: AttachmentKind;
  blob: Blob;
  name?: string;
  caption?: string;
  durationMs?: number;
  waveform?: Uint8Array;
};

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const B64U = /^[A-Za-z0-9_-]+$/;

/** Validates a decrypted message payload; anything off => undefined (bubble falls back to text). */
export const attachmentPayload = (value: unknown): AttachmentPayload | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const a = (value as { attachment?: Partial<AttachmentDescriptor> }).attachment;
  if (!a || a.version !== 2 || typeof a.id !== 'string' || !/^[0-9a-f]{32}$/.test(a.id)) return undefined;
  if (typeof a.key !== 'string' || a.key.length !== 43 || !B64U.test(a.key)) return undefined;
  if (typeof a.noncePrefix !== 'string' || a.noncePrefix.length !== 11 || !B64U.test(a.noncePrefix)) return undefined;
  if (a.chunkSize !== 262_144 || !Number.isSafeInteger(a.size) || a.size! < 0 || a.size! > MAX_ATTACHMENT_BYTES * 1.01) return undefined;
  if (typeof a.mime !== 'string' || a.mime.length > 128) return undefined;
  const caption = (value as { caption?: unknown }).caption;
  return { attachment: a as AttachmentDescriptor, caption: typeof caption === 'string' ? caption : undefined };
};

const INLINE = /^(image\/(png|jpe?g|webp|gif|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;
/** Mime from the (encrypted) metadata, re-checked: only safe media types may be shown inline. */
export const inlineMime = (mime: string, family: 'image' | 'audio' | 'video'): string | undefined => {
  const base = mime.split(';')[0].trim().toLowerCase();
  return INLINE.test(base) && base.startsWith(`${family}/`) ? base : undefined;
};

export const formatBytes = (n: number): string => {
  const f = (v: number) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(v);
  if (n < 1024) return `${f(n)} بایت`;
  if (n < 1024 * 1024) return `${f(n / 1024)} کیلوبایت`;
  return `${f(n / 1024 / 1024)} مگابایت`;
};

export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  const two = (v: number) => new Intl.NumberFormat('fa-IR', { minimumIntegerDigits: 2, useGrouping: false }).format(v);
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};

export const ATTACHMENT_LIMIT_COPY = 'حجم فایل نباید از ۱۰۰ مگابایت بیشتر باشد.';
