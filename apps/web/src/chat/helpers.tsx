import type { ReactNode } from 'react';
import type { GifMessagePayload, Message, StickerMessagePayload } from '../api.js';
import { emojiOnlyCount, withEmoji } from '../emoji.js';
import { clockLabel, dayKey } from '../ui.js';

export type UiMessage = Message & {
  optimistic?: boolean; failed?: boolean; clientKey?: string;
  /** Why a failed bubble failed (Persian copy) and how many sends already went wrong (shows «در حال ارسال»). */
  error?: string; attempts?: number;
};

export const isTemp = (id: string): boolean => id.startsWith('temp-');
export type Mode = { kind: 'reply' | 'edit'; message: UiMessage } | null;
export type MenuAction = 'reply' | 'edit' | 'delete' | 'copy' | 'save-gif';
export type PeerPresence = { online: boolean; lastSeen: string | null };

export const GROUP_GAP_MS = 300_000;

export const dateLabel = (value: string): string => {
  const date = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return 'امروز';
  if (dayKey(date) === dayKey(yesterday)) return 'دیروز';
  return new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'long', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' }).format(date);
};

export const lastSeenLabel = (value: string | null | undefined, username: string): string => {
  if (!value) return `\u2066@${username}\u2069`;
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(value) === dayKey(now)) return `آخرین بازدید امروز ${clockLabel(value)}`;
  if (dayKey(value) === dayKey(yesterday)) return `آخرین بازدید دیروز ${clockLabel(value)}`;
  return `آخرین بازدید ${new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(new Date(value))}`;
};

export const excerpt = (message: Pick<UiMessage, 'deletedAt' | 'kind' | 'text'>): string => {
  if (message.deletedAt) return 'پیام حذف شده';
  if (message.kind === 'sticker') return 'استیکر';
  if (message.kind === 'gif') return 'گیف';
  if (message.kind === 'photo') return message.text ? `تصویر · ${message.text}` : 'تصویر';
  if (message.kind === 'video') return message.text ? `ویدیو · ${message.text}` : 'ویدیو';
  if (message.kind === 'voice') return 'پیام صوتی';
  if (message.kind === 'file') return message.text ? `فایل · ${message.text}` : 'فایل';
  return message.text ?? 'پیام';
};

export const sameGroup = (a: UiMessage | undefined, b: UiMessage | undefined): boolean =>
  Boolean(a && b && !a.deletedAt === !b.deletedAt && a.senderId === b.senderId && Math.abs(+new Date(b.createdAt) - +new Date(a.createdAt)) <= GROUP_GAP_MS && dayKey(a.createdAt) === dayKey(b.createdAt));

export const readAtLeast = (readId: string | undefined, id: string): boolean => {
  if (!readId || id.startsWith('temp-')) return false;
  try { return BigInt(readId) >= BigInt(id); } catch { return false; }
};

export const stickerPayload = (value: unknown): StickerMessagePayload | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<StickerMessagePayload>;
  return item.stickerId && item.packId && (item.format === 'tgs' || item.format === 'webm' || item.format === 'webp') && typeof item.w === 'number' && typeof item.h === 'number' && typeof item.emoji === 'string' ? item as StickerMessagePayload : undefined;
};

export const gifPayload = (value: unknown): GifMessagePayload | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<GifMessagePayload>;
  return item.gifId && typeof item.mp4Url === 'string' && typeof item.w === 'number' && typeof item.h === 'number' && typeof item.durationMs === 'number' ? item as GifMessagePayload : undefined;
};

export const emojiOnly = (text: string | null): boolean => emojiOnlyCount(text) > 0;

/** First strong character decides the paragraph direction, like dir="auto" but usable on the bubble itself. */
export const textDir = (text: string | null): 'rtl' | 'ltr' => {
  const match = text?.match(/[\p{L}]/u);
  return match && /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(match[0]) ? 'rtl' : text && match ? 'ltr' : 'rtl';
};

/** Inputs: empty or neutral text follows the app (rtl); the first strong letter flips it. */
export const fieldDir = (value: string): 'rtl' | 'ltr' => textDir(value.trim() ? value : null);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const highlight = (text: string, needle: string, active: boolean, key: string): ReactNode => {
  if (!needle) return text;
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'));
  if (parts.length === 1) return text;
  return parts.map((part, index) => index % 2 ? <mark key={`${key}-${index}`} className={active ? 'is-active' : undefined}>{part}</mark> : part);
};

const LINK = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?'"»)\]}،؛؟])/giu;

/** Plain text → React nodes with safe links and optional search highlight. */
export const renderText = (text: string, needle = '', active = false): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(...withEmoji(text.slice(last, index), (part, key) => highlight(part, needle, active, key), `t${index}`));
    const href = /^www\./i.test(match[1]) ? `https://${match[1]}` : match[1];
    nodes.push(<a key={`l${index}`} href={href} target="_blank" rel="noopener noreferrer nofollow" dir="ltr">{highlight(match[1], needle, active, `h${index}`)}</a>);
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(...withEmoji(text.slice(last), (part, key) => highlight(part, needle, active, key), 'tail'));
  return nodes;
};
