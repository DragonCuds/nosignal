import { b64u } from './crypto.js';
import type { AttachmentDescriptor, AttachmentInput } from './types.js';

export type Prepared = { blob: Blob; extra: Partial<AttachmentDescriptor> };

const MAX_EDGE = 1280;
const MAX_EDGE_HD = 1600; // opt-in only
const QUALITY = 0.75;
const THUMB_W = 24;
const THUMB_MAX_BYTES = 1400; // base64url stays under the 2 KB contract limit

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

const makeCanvas = (w: number, h: number, bg?: string): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  return [canvas, ctx];
};

const decode = async (file: Blob): Promise<ImageBitmap> => {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return createImageBitmap(file); }
};

/** Max 1280 px (1600 if hd), WebP q0.75 (JPEG fallback). Re-encoding drops EXIF/GPS. Plus a tiny blurred preview. */
export const preparePhoto = async (file: Blob, hd = false): Promise<Prepared> => {
  const bitmap = await decode(file);
  const scale = Math.min(1, (hd ? MAX_EDGE_HD : MAX_EDGE) / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  let [canvas, ctx] = makeCanvas(w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  let blob = await toBlob(canvas, 'image/webp', QUALITY);
  if (!blob || blob.type !== 'image/webp') {
    [canvas, ctx] = makeCanvas(w, h, '#fff');
    ctx.drawImage(bitmap, 0, 0, w, h);
    blob = await toBlob(canvas, 'image/jpeg', QUALITY);
  }
  if (!blob) throw new Error('encode failed');

  let thumb: string | undefined;
  const th = Math.max(1, Math.round((h / w) * THUMB_W));
  const [tc, tctx] = makeCanvas(THUMB_W, th, '#fff');
  tctx.drawImage(bitmap, 0, 0, THUMB_W, th);
  for (const [type, q] of [['image/webp', 0.5], ['image/webp', 0.25], ['image/jpeg', 0.3]] as const) {
    const t = await toBlob(tc, type, q);
    if (t && t.type === type && t.size <= THUMB_MAX_BYTES) { thumb = b64u(new Uint8Array(await t.arrayBuffer())); break; }
  }
  bitmap.close();
  return { blob, extra: { mime: blob.type, w, h, thumb } };
};

export const thumbMime = (thumbB64u: string): string => (thumbB64u.startsWith('UklG') ? 'image/webp' : 'image/jpeg'); // "RIFF" => webp

/** Duration and size of a video, best effort (never blocks sending). */
export const prepareVideo = (file: Blob): Promise<Prepared> =>
  new Promise((resolve) => {
    const mime = file.type || 'video/mp4';
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (extra: Partial<AttachmentDescriptor>) => { URL.revokeObjectURL(url); resolve({ blob: file, extra: { mime, ...extra } }); };
    const timer = window.setTimeout(() => done({}), 4000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => { window.clearTimeout(timer); done({ w: video.videoWidth || undefined, h: video.videoHeight || undefined, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined }); };
    video.onerror = () => { window.clearTimeout(timer); done({}); };
    video.src = url;
  });

const sanitizeName = (raw: string): string => {
  const clean = raw.replace(/[\\/:*?"<>|\u0000-\u001f‪-‮⁦-⁩]/g, '_').trim().replace(/^\.+/, '') || 'file';
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
  return clean.slice(0, 120 - ext.length) + ext;
};

export const prepare = async (input: AttachmentInput): Promise<Prepared> => {
  const { blob, kind } = input;
  if (kind === 'photo') return preparePhoto(blob);
  if (kind === 'video') return prepareVideo(blob);
  if (kind === 'voice') {
    return { blob, extra: { mime: (blob.type || 'audio/webm').split(';')[0], durationMs: input.durationMs, waveform: input.waveform ? b64u(input.waveform) : undefined } };
  }
  return { blob, extra: { mime: blob.type || 'application/octet-stream', name: sanitizeName(input.name ?? 'file') } };
};
