// Blocks pinch zoom and double-tap zoom on touch browsers (iOS Safari ignores user-scalable=no).
// Normal scrolling, text selection and single touches are never blocked.
export function installZoomLock(): void {
  const opts = { passive: false } as const;
  const stop = (e: Event) => { if (e.cancelable) e.preventDefault(); };

  // iOS Safari pinch gestures.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, stop, opts);
  }

  // Multi-touch move (pinch) on other browsers.
  document.addEventListener('touchmove', (e) => {
    const scale = (e as TouchEvent & { scale?: number }).scale;
    if (e.touches.length > 1 || (scale !== undefined && scale !== 1)) stop(e);
  }, opts);

  // Double-tap guard: a second touchend within 300 ms is a zoom attempt.
  // Taps on form fields and links are left alone so focus and clicks still work.
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    const target = e.target as Element | null;
    const interactive = target?.closest?.('input, textarea, select, [contenteditable="true"]');
    if (now - lastEnd <= 300 && !interactive) stop(e);
    lastEnd = now;
  }, opts);

  // Trackpad pinch / ctrl+wheel zoom in desktop browsers.
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) stop(e); }, opts);
}
