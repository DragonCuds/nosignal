import { Avatar } from '../ui.js';

export const UsersIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.4-3 2.6-4.8 5.5-4.8s5.1 1.8 5.5 4.8" /><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.3 14.5c1.8.5 3 2 3.2 4.5" /></svg>
);

/** Round initials avatar for a group (same look as user avatars, colour from the group id). */
export function GroupAvatar({ id, title, size = 52 }: { id: string; title: string; size?: 40 | 52 | 64 | number }) {
  return <Avatar user={{ id, displayName: title || 'گروه', avatarPath: null } as never} size={size as never} />;
}
