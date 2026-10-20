import { useEffect, useRef, useState } from 'react';
import { Emoji } from './emoji.js';
import type { EmojiCategory } from './emoji-data.js';

const RECENT_KEY = 'tel-recent-emoji';
const RECENT_MAX = 32;

const readRecent = (): string[] => {
  try { const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, RECENT_MAX) : []; } catch { return []; }
};
const saveRecent = (items: string[]) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(items)); } catch { /* storage can be blocked */ } };

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [categories, setCategories] = useState<EmojiCategory[]>([]);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [active, setActive] = useState('recent');
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());

  useEffect(() => { void import('./emoji-data.js').then((module) => setCategories(module.emojiCategories)); }, []);

  const tabs = [...(recent.length ? [{ id: 'recent', icon: '🕘' }] : []), ...categories.map((category) => ({ id: category.id, icon: category.icon }))];

  const pick = (emoji: string) => {
    onPick(emoji);
    const next = [emoji, ...recent.filter((item) => item !== emoji)].slice(0, RECENT_MAX);
    setRecent(next);
    saveRecent(next);
  };

  const spy = () => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top + 40;
    let current = tabs[0]?.id ?? 'recent';
    for (const [id, element] of sections.current) if (element.getBoundingClientRect().top <= top) current = id;
    setActive(current);
  };
  const jump = (id: string) => sections.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const register = (id: string) => (element: HTMLElement | null) => { if (element) sections.current.set(id, element); else sections.current.delete(id); };

  return (
    <div className="emoji-content">
      <nav className="emoji-tabs" aria-label="دسته‌بندی شکلک‌ها">
        {tabs.map((tab) => <button key={tab.id} className={active === tab.id ? 'emoji-tab--active' : ''} type="button" onClick={() => jump(tab.id)} aria-label={tab.id}><Emoji char={tab.icon} /></button>)}
      </nav>
      <div className="emoji-scroll" ref={scroller} onScroll={spy}>
        {recent.length > 0 && <section ref={register('recent')}><h3>اخیر</h3><div className="emoji-grid">{recent.map((emoji) => <button type="button" key={emoji} onClick={() => pick(emoji)} aria-label={`افزودن ${emoji}`}><Emoji char={emoji} lazy /></button>)}</div></section>}
        {categories.map((category) => (
          <section key={category.id} ref={register(category.id)}>
            <h3>{category.label}</h3>
            <div className="emoji-grid">{category.items.map((emoji) => <button type="button" key={emoji} onClick={() => pick(emoji)} aria-label={`افزودن ${emoji}`}><Emoji char={emoji} lazy /></button>)}</div>
          </section>
        ))}
        {!categories.length && <div className="panel-state"><span className="spinner spinner--accent" /></div>}
      </div>
    </div>
  );
}
