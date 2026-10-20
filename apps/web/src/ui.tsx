import type { User } from './api.js';

export const initials = (name: string): string => {
  const pieces = name.trim().split(/\s+/).filter(Boolean);
  return pieces.slice(0, 2).map((part) => [...part][0]).join('').toLocaleUpperCase('fa-IR') || '؟';
};

export const avatarUrl = (path: string | null): string | undefined => {
  if (!path) return undefined;
  return path.startsWith('/') ? path : `/${path}`;
};

const hue = (seed: string): number => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 8;
};

type AvatarProps = { user: Pick<User, 'id' | 'displayName' | 'avatarPath'>; size?: 28 | 40 | 52 | 64 | 80; online?: boolean };

export function Avatar({ user, size = 52, online }: AvatarProps) {
  const src = avatarUrl(user.avatarPath);
  return (
    <span className={`avatar avatar--${size} avatar--c${hue(user.id)}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : <span>{initials(user.displayName)}</span>}
      {online && <i className="avatar__presence" />}
    </span>
  );
}

export const dayKey = (value: string | Date): string => {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export const clockLabel = (value: string): string =>
  new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

export const listTimeLabel = (value: string): string => {
  const date = new Date(value);
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return clockLabel(value);
  const diffDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (diffDays < 6) return new Intl.DateTimeFormat('fa-IR', { weekday: 'short' }).format(date);
  return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(date);
};

export const faNumber = (value: number): string => (value > 99 ? '+۹۹' : value.toLocaleString('fa-IR'));
