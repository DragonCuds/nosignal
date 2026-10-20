const isLocalDevelopment =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname === '[::1]';

if ('serviceWorker' in navigator && !isLocalDevelopment) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // The app remains fully usable when service workers are unavailable.
    });
  });
}
