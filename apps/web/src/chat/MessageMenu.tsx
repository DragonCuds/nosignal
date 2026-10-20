import { CSSProperties, useEffect, useRef } from 'react';
import { CopyIcon, EditIcon, ReplyIcon, StarIcon, TrashIcon } from '../icons.js';
import type { MenuAction, UiMessage } from './helpers.js';

export type MenuState = { message: UiMessage; x: number; y: number; closing: boolean };

const ROW = 40;
const WIDTH = 208;

export const placeMenu = (message: UiMessage, own: boolean, x: number, y: number): { x: number; y: number } => {
  const rows = 1 + Number(message.kind === 'gif') + Number(own && message.kind === 'text') + Number(own) + Number(Boolean(message.text));
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - rows * ROW - 20)),
  };
};

type Props = { menu: MenuState; me: string; close: () => void; action: (name: MenuAction) => void };

export function MessageMenu({ menu, me, close, action }: Props) {
  const own = menu.message.senderId === me;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [close]);

  return (
    <div className="menu-layer" onPointerDown={(event) => event.target === event.currentTarget && close()} onContextMenu={(event) => { event.preventDefault(); close(); }}>
      <div className={`menu${menu.closing ? ' menu--closing' : ''}`} style={{ left: menu.x, top: menu.y, '--origin': `${menu.x > window.innerWidth / 2 ? 'right' : 'left'} ${menu.y > window.innerHeight / 2 ? 'bottom' : 'top'}` } as CSSProperties} role="menu" aria-label="گزینه‌های پیام">
        <button ref={first} type="button" role="menuitem" onClick={() => action('reply')}><ReplyIcon />پاسخ</button>
        {menu.message.text && <button type="button" role="menuitem" onClick={() => action('copy')}><CopyIcon />کپی متن</button>}
        {menu.message.kind === 'gif' && <button type="button" role="menuitem" onClick={() => action('save-gif')}><StarIcon />ذخیرهٔ گیف</button>}
        {own && menu.message.kind === 'text' && <button type="button" role="menuitem" onClick={() => action('edit')}><EditIcon />ویرایش</button>}
        {own && <button className="menu__danger" type="button" role="menuitem" onClick={() => action('delete')}><TrashIcon />حذف</button>}
      </div>
    </div>
  );
}
