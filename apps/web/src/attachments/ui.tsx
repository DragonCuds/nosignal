import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const S = ({ children, ...p }: P) => <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>{children}</svg>;

export const FileIcon = (p: P) => <S {...p}><path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8Z"/><path d="M14 3v5h5"/></S>;
export const PlayIcon = (p: P) => <S {...p} fill="currentColor" stroke="none"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.5-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5Z"/></S>;
export const PauseIcon = (p: P) => <S {...p} fill="currentColor" stroke="none"><rect x="6.5" y="5" width="4" height="14" rx="1.4"/><rect x="13.5" y="5" width="4" height="14" rx="1.4"/></S>;
export const DownloadIcon = (p: P) => <S {...p}><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></S>;

/** Circle with a progress arc; value undefined = indeterminate spin, null = idle (no arc). Children (icon) sit in the middle. */
export function ProgressRing({ value, size = 44, children, className = '' }: { value?: number | null; size?: number; children?: React.ReactNode; className?: string }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const shown = value == null ? 0.25 : Math.max(0.06, Math.min(1, value));
  return (
    <span className={`ring ${className}`} style={{ height: size, width: size }}>
      {value !== null && <svg viewBox="0 0 44 44" className={value === undefined ? 'ring__spin' : undefined} aria-hidden="true">
        <circle cx="22" cy="22" r={r} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray={`${c * shown} ${c}`} transform="rotate(-90 22 22)" />
      </svg>}
      {children}
    </span>
  );
}
