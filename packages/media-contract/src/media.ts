import type { StickerFormat } from './index.js';

export type StickerPack = {
  id: string;
  slug: string;
  title: string;
  thumbUrl: string | null;
};

export type MediaSticker = {
  id: string;
  packId: string;
  fileUrl: string;
  format: StickerFormat;
  emoji: string;
  w: number;
  h: number;
  sort: number;
};

export type MediaGif = {
  id: string;
  mp4Url: string;
  posterUrl: string;
  w: number;
  h: number;
  durationMs: number;
  tags: string[];
};
