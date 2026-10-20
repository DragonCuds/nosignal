import type { ReactNode } from 'react';
import { emojiFiles } from './emoji-files.js';

/** Noto Emoji images (self-hosted in /public/emoji). Characters without an image stay as plain text. */
const bySequence = new Map(emojiFiles.map((file) => [file.replaceAll('-fe0f', ''), file]));
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣/u;

export const emojiSrc = (char: string): string | undefined => {
  const key = [...char].map((part) => part.codePointAt(0)!.toString(16).padStart(4, '0')).filter((hex) => hex !== 'fe0f').join('-');
  const file = bySequence.get(key);
  return file ? `/emoji/${file}.png` : undefined;
};

export const hasEmoji = (text: string): boolean => EMOJI.test(text);

export function Emoji({ char, className = '', lazy = false }: { char: string; className?: string; lazy?: boolean }) {
  const src = emojiSrc(char);
  if (!src) return <>{char}</>;
  return <img className={`emoji ${className}`.trim()} src={src} alt={char} draggable={false} loading={lazy ? 'lazy' : undefined} decoding="async" />;
}

/** Text → nodes where every emoji becomes an emoji image. `plain` can post-process the text between emoji (search highlight). */
export const withEmoji = (text: string, plain: (value: string, key: string) => ReactNode = (value) => value, prefix = 'e'): ReactNode[] => {
  if (!EMOJI.test(text)) return [plain(text, `${prefix}-p`)];
  const nodes: ReactNode[] = [];
  let run = '';
  let index = 0;
  const flush = () => { if (run) { nodes.push(plain(run, `${prefix}-t${index++}`)); run = ''; } };
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI.test(segment) && emojiSrc(segment)) { flush(); nodes.push(<Emoji key={`${prefix}-e${index++}`} char={segment} />); }
    else run += segment;
  }
  flush();
  return nodes;
};

/** How many graphemes when the text is only 1–3 emoji (and nothing else), else 0. */
export const emojiOnlyCount = (text: string | null): number => {
  if (!text) return 0;
  const value = text.trim();
  if (!value || /\s/u.test(value)) return 0;
  const parts = [...segmenter.segment(value)].map((part) => part.segment);
  return parts.length >= 1 && parts.length <= 3 && parts.every((item) => EMOJI.test(item)) ? parts.length : 0;
};
