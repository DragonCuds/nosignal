const CACHE_PREFIX = 'tel-pwa-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-v4`;
const STATIC_CACHE = `${CACHE_PREFIX}static-v3`;
const EMOJI_CACHE = `${CACHE_PREFIX}emoji-v1`;
const EMOJI_MAX_ENTRIES = 400;
const STATIC_MAX_ENTRIES = 150;
const NAVIGATE_TIMEOUT_MS = 5000;
const SHELL_URLS = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/tel-icon.svg',
  '/icons/tel-icon-192.png',
  '/icons/tel-icon-512.png',
  '/icons/tel-maskable.svg',
  '/icons/tel-maskable-512.png',
  '/icons/tel-apple-touch-icon.png',
  '/fonts/vazirmatn-arabic-400-normal.woff2',
  '/fonts/vazirmatn-arabic-500-normal.woff2',
  '/fonts/vazirmatn-arabic-600-normal.woff2',
  '/fonts/vazirmatn-latin-400-normal.woff2',
  '/fonts/vazirmatn-latin-500-normal.woff2',
  '/fonts/vazirmatn-latin-600-normal.woff2'
];

const isPrivateOrDynamicPath = (pathname) => {
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  return (
    pathname.startsWith('/api/') ||
    pathname === '/api' ||
    pathname.startsWith('/ws') ||
    pathname.startsWith('/media/') ||
    pathname === '/media' ||
    segments.includes('auth') ||
    segments.includes('login') ||
    segments.includes('logout') ||
    segments.includes('session')
  );
};

// Cache keys are kept in insertion order, so the first ones are the oldest.
const trimCache = async (cache, max) => {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((key) => cache.delete(key)));
};

const cacheFirst = async (request, cacheName, max) => {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic' && !(response.headers.get('content-type') || '').includes('text/html')) {
    await cache.put(request, response.clone());
    await trimCache(cache, max);
  }
  return response;
};

// Network first, but a stalled link falls back to the cached shell after a few seconds.
const networkFirstShell = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATE_TIMEOUT_MS);
  try {
    return await fetch(request, { signal: controller.signal });
  } catch {
    return (await caches.match('/')) || (await caches.match('/offline.html')) || Response.error();
  } finally {
    clearTimeout(timer);
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_URLS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && ![SHELL_CACHE, STATIC_CACHE, EMOJI_CACHE].includes(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isPrivateOrDynamicPath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }

  if (url.pathname.startsWith('/emoji/') && url.pathname.endsWith('.png')) {
    event.respondWith(cacheFirst(request, EMOJI_CACHE, EMOJI_MAX_ENTRIES));
    return;
  }

  // Hashed build output never changes under the same name.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE, STATIC_MAX_ENTRIES));
    return;
  }

  const cacheableShellAsset = ['script', 'style', 'font'].includes(request.destination);
  if (!cacheableShellAsset) return;

  event.respondWith(cacheFirst(request, STATIC_CACHE, STATIC_MAX_ENTRIES));
});
