/**
 * iOS keyboard / viewport handling. Layout rules live in styles/viewport.css.
 *
 * iOS Safari (and the installed PWA) keep the LAYOUT viewport at full height when the keyboard opens and shrink / pan the VISUAL
 * viewport instead. Roots are `position:fixed; inset:0` by default (correct when the keyboard is closed, no JS involved). While an
 * editable element is focused AND the visual viewport is clearly smaller than the layout viewport, we set `data-kb` on <html> plus
 * --vvt / --vvb / --vvh so the roots shrink to exactly the visible area. We never force the window scroll while typing, never set
 * body:fixed, and we always return to the plain CSS state the moment the keyboard is gone.
 * Android Chrome resizes the layout viewport itself (interactive-widget=resizes-content), so data-kb is never set there.
 */
const KB_MIN = 80; // px the visual viewport must be shorter than the layout viewport to count as "keyboard open"

const isEditable = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset|file|range|color|image)$/i.test((el as HTMLInputElement).type)));

export const installViewportFix = (): void => {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const debug = new URLSearchParams(location.search).has('vvdebug');
  let overlay: HTMLElement | null = null;
  let timer = 0;
  let raf = 0;
  let kbOn = false;

  const clear = () => {
    root.removeAttribute('data-kb');
    for (const name of ['--vvt', '--vvb', '--vvh']) root.style.removeProperty(name);
    kbOn = false;
  };

  const render = () => {
    if (!overlay) return;
    const r = (document.querySelector('.messenger, .login, .splash') as HTMLElement | null)?.getBoundingClientRect();
    overlay.textContent =
      `innerH ${window.innerHeight}  innerW ${window.innerWidth}  scrollY ${Math.round(window.scrollY)}\n` +
      `vv h ${vv ? vv.height.toFixed(1) : '-'}  top ${vv ? vv.offsetTop.toFixed(1) : '-'}  scale ${vv ? vv.scale.toFixed(2) : '-'}\n` +
      `kb ${kbOn ? 'ON' : 'off'}  focus ${document.activeElement?.tagName ?? '-'}  standalone ${matchMedia('(display-mode: standalone)').matches}\n` +
      `root top ${r ? r.top.toFixed(1) : '-'}  h ${r ? r.height.toFixed(1) : '-'}  bottom ${r ? r.bottom.toFixed(1) : '-'}`;
  };

  const update = () => {
    raf = 0;
    if (!vv) { render(); return; }
    const hidden = window.innerHeight - vv.height; // part of the layout viewport covered by the keyboard (iOS)
    const open = isEditable(document.activeElement) && hidden > KB_MIN && vv.scale <= 1.01;
    if (open) {
      const top = Math.max(0, vv.offsetTop);
      const bottom = Math.max(0, window.innerHeight - top - vv.height);
      root.setAttribute('data-kb', '');
      root.style.setProperty('--vvt', `${top}px`);
      root.style.setProperty('--vvb', `${bottom}px`);
      root.style.setProperty('--vvh', `${vv.height}px`);
      kbOn = true;
    } else if (kbOn || root.hasAttribute('data-kb')) {
      clear();
      if (!isEditable(document.activeElement) && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
    }
    render();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

  // Keyboard open/close animations and focus changes do not reliably fire visualViewport events on every iOS version: while a field
  // is focused (and for a moment after blur) re-check on a short interval as a safety net.
  const watch = (ms: number) => {
    clearInterval(timer);
    const until = Date.now() + ms;
    timer = window.setInterval(() => {
      update();
      if (Date.now() > until && !isEditable(document.activeElement)) clearInterval(timer);
    }, 150);
  };

  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', () => { schedule(); watch(1200); });
  window.addEventListener('pageshow', () => { schedule(); watch(800); });
  document.addEventListener('visibilitychange', schedule);

  document.addEventListener('focusin', (event) => {
    const el = event.target;
    if (!isEditable(el as Element)) return;
    schedule();
    watch(800);
    // After the keyboard animation, make sure the field is visible inside ITS scroll container (the window itself never scrolls).
    const reveal = () => { update(); (el as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
    setTimeout(reveal, 350);
    setTimeout(reveal, 700);
  });
  document.addEventListener('focusout', () => {
    // Tapping from one field to another fires focusout then focusin: wait a beat before deciding the keyboard is gone.
    setTimeout(() => { update(); watch(900); }, 60);
  });

  if (debug) {
    overlay = document.createElement('div');
    overlay.className = 'vvdebug';
    document.body.appendChild(overlay);
    setInterval(render, 250);
  }
  update();
};
