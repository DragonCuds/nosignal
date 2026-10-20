import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_TGS_BYTES = 64 * 1024;
const MAX_TGS_INFLATED_BYTES = 1024 * 1024;

export type Dimensions = { w: number; h: number; durationMs?: number; codec?: string };

const validateDimensions = (w: number, h: number): void => {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 8_192 || h > 8_192 || w * h > 16_777_216) {
    throw new Error('Media dimensions are invalid or too large');
  }
};

export const validateTgs = (file: Buffer): Dimensions => {
  if (file.length > MAX_TGS_BYTES) {
    throw new Error('A .tgs file must be 64 KB or smaller');
  }
  let inflated: Buffer;
  try {
    inflated = gunzipSync(file, { maxOutputLength: MAX_TGS_INFLATED_BYTES });
  } catch {
    throw new Error('A .tgs file must be gzip-compressed Lottie JSON');
  }
  if (inflated.length > MAX_TGS_INFLATED_BYTES) throw new Error('A .tgs Lottie JSON is too large');
  let lottie: unknown;
  try { lottie = JSON.parse(inflated.toString('utf8')); } catch { throw new Error('Invalid Lottie JSON'); }
  if (!lottie || typeof lottie !== 'object') throw new Error('Invalid Lottie JSON');
  const source = lottie as Record<string, unknown>;
  if (source.v === undefined || !Array.isArray(source.layers) || source.w !== 512 || source.h !== 512) {
    throw new Error('A .tgs must be a 512x512 Lottie animation');
  }
  const assets = Array.isArray(source.assets) ? source.assets : [];
  if (assets.some((asset) => asset && typeof asset === 'object' && ('p' in asset || 'u' in asset))) {
    throw new Error('A .tgs sticker cannot contain external or embedded image assets');
  }
  const pending: unknown[] = [source];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
    }
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'x' && typeof child === 'string' && child.length > 0) throw new Error('A .tgs sticker cannot contain expressions');
        pending.push(child);
      }
    }
  }
  return { w: 512, h: 512 };
};

export const probeMedia = async (file: string): Promise<Dimensions> => {
  const { stdout } = await execFileAsync('/usr/bin/ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,duration:format=duration', '-of', 'json', file
  ], { maxBuffer: 64 * 1024, timeout: 10_000, killSignal: 'SIGKILL' });
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) throw new Error('The upload has no readable video stream');
  validateDimensions(stream.width, stream.height);
  const duration = Number(stream.duration ?? parsed.format?.duration);
  return { w: stream.width, h: stream.height, codec: stream.codec_name, durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : undefined };
};

export const validateWebpSticker = async (file: string, size: number): Promise<Dimensions> => {
  if (size > 512 * 1024) throw new Error('A WebP sticker must be 512 KB or smaller');
  const info = await probeMedia(file);
  if (info.codec !== 'webp' || info.w > 512 || info.h > 512 || (info.w !== 512 && info.h !== 512)) {
    throw new Error('A WebP sticker must have one 512px edge and be no larger than 512x512');
  }
  return info;
};

export const validateWebmSticker = async (file: string, size: number): Promise<Dimensions> => {
  if (size > 256 * 1024) throw new Error('A WebM sticker must be 256 KB or smaller');
  const info = await probeMedia(file);
  if (info.codec !== 'vp9' || info.w > 512 || info.h > 512 || (info.w !== 512 && info.h !== 512) || !info.durationMs || info.durationMs > 3000) {
    throw new Error('A WebM sticker must be VP9, have one 512px edge, and be 3 seconds or shorter');
  }
  return info;
};
