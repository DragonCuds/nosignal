import { useEffect, useState } from 'react';
import { api, type User } from '../api.js';
import { Avatar } from '../ui.js';
import { SearchIcon } from '../icons.js';

type Props = { exclude: string[]; onPick: (user: User) => void; disabled?: boolean; placeholder?: string };

/** Find people by ID (username) — the only way to look anyone up; the server never lists everybody. */
export function PeoplePicker({ exclude, onPick, disabled, placeholder = 'جستجوی آیدی' }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const term = query.trim().replace(/^@+/, '');

  useEffect(() => {
    if (term.length < 3) { setResults([]); setState('idle'); return; }
    setState('loading');
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.searchUsers(term, controller.signal)
        .then((found) => { setResults(found); setState('done'); })
        .catch((error: unknown) => { if ((error as { name?: string })?.name !== 'AbortError') setState('error'); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [term]);

  const shown = results.filter((user) => !exclude.includes(user.id));
  return (
    <div className="people-picker">
      <label className="search-pill">
        <SearchIcon />
        <input type="search" dir="ltr" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={query} disabled={disabled} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
      </label>
      {term.length >= 3 && (
        <div className="idsearch__results" aria-live="polite">
          {state === 'loading' && <span className="idsearch__note">در حال جستجو…</span>}
          {state === 'error' && <span className="idsearch__note">جستجو انجام نشد. دوباره تلاش کنید.</span>}
          {state === 'done' && shown.length === 0 && <span className="idsearch__note">کاربری با این آیدی پیدا نشد.</span>}
          {state === 'done' && shown.map((user) => (
            <button className="idsearch__result" type="button" key={user.id} disabled={disabled} onClick={() => { onPick(user); setQuery(''); }}>
              <Avatar user={user} size={40} />
              <span><strong dir="auto">{user.displayName}</strong><small>{`⁦@${user.username}⁩`}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
