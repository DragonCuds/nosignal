// Offline alarm: the app must never ask anything outside its own origin.
//   node scripts/offline-check.mjs                    serve apps/web/dist locally (login page, no backend)
//   node scripts/offline-check.mjs --url http://127.0.0.1:4101 [--login user:password]
//                                                     check a running server; with --login also walks the chat screens
//   node scripts/offline-check.mjs --self-test        injects a Google font link and expects the alarm to fire
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true); };
const dist = resolve(import.meta.dirname, '../apps/web/dist');
const chromium = process.env.CHROMIUM ?? '/snap/bin/chromium';
const selfTest = flag('--self-test') === true;
const shotsDir = process.env.SHOTS_DIR ?? '/root/shots';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

// Tiny static server for dist so the check works without any backend.
const serveDist = (inject) => new Promise((done) => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}'); return; }
    let file = join(dist, normalize(path));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(dist, 'index.html'); }
    let body = await readFile(file);
    if (inject && file.endsWith('index.html')) body = Buffer.from(body.toString().replace('</head>', `${inject}</head>`));
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  });
  server.listen(0, '127.0.0.1', () => done(server));
});

const run = async () => {
  let server;
  let base = typeof flag('--url') === 'string' ? flag('--url') : undefined;
  if (!base) {
    server = await serveDist(selfTest ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' : '');
    base = `http://tel.test:${server.address().port}`; // fake name -> 127.0.0.1 (the app only registers its service worker on a non-localhost name)
  }
  const origin = new URL(base).origin;
  const outside = new Set();
  const seen = new Set();
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox', '--disable-gpu', '--host-resolver-rules=MAP tel.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${origin}`] });
  // Real cutoff: the browser cannot resolve any name except localhost. Requests are still recorded so the alarm names the offender.
  const record = (url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:') || url.startsWith('chrome')) return;
    seen.add(url);
    if (new URL(url).origin !== origin) outside.add(url);
  };
  browser.on('targetcreated', async (target) => {
    if (target.type() !== 'service_worker') return;
    try {
      const session = await target.createCDPSession();
      session.on('Network.requestWillBeSent', (event) => record(event.request.url));
      await session.send('Network.enable');
    } catch { /* worker already gone */ }
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 800 });
    page.on('request', (request) => record(request.url()));
    const step = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (error) { console.log(`FAIL ${name}: ${error.message}`); outside.add(`step failed: ${name}`); } };
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));

    await step('login page', async () => {
      await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[name="username"]', { timeout: 8000 });
    });
    await step('fonts are local', async () => {
      const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family); });
      if (!fonts.some((f) => /vazirmatn/i.test(f))) throw new Error(`no local Vazirmatn loaded (loaded: ${fonts.join(',') || 'none'})`);
    });
    await step('service worker installs', async () => {
      if (['localhost', '127.0.0.1'].includes(new URL(base).hostname)) { console.log('     (skipped: the app does not register its service worker on localhost)'); return; }
      await Promise.race([
        page.evaluate(() => navigator.serviceWorker.ready.then(() => true)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('service worker never became ready')), 10000))
      ]);
      await pause(800);
    });
    await step('app shell works with the server unreachable', async () => {
      await page.setOfflineMode(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('input[name="username"], .offline, body', { timeout: 8000 });
      const text = await page.evaluate(() => document.body.innerText.length);
      if (!text) throw new Error('empty page offline');
      await page.setOfflineMode(false);
    });

    const login = flag('--login');
    if (typeof login === 'string') {
      const [user, ...rest] = login.split(':');
      await step('log in', async () => {
        await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
        await page.type('input[name="username"]', user);
        await page.type('input[name="password"]', rest.join(':'));
        await page.click('button[type="submit"]');
        await page.waitForFunction(() => !document.querySelector('input[name="password"]'), { timeout: 15000 });
      });
      await step('open first chat', async () => {
        const row = await page.$('.chat-row, [class*="chat-row"], [class*="ChatRow"]');
        if (row) { await row.click(); await pause(1200); }
      });
      for (const [name, selector] of [['sticker panel', '[aria-label*="استیکر"], [aria-label*="sticker" i]'], ['settings', '[aria-label*="تنظیمات"], [aria-label*="settings" i]']]) {
        await step(name, async () => { const el = await page.$(selector); if (el) { await el.click(); await pause(1000); } });
      }
    }
    await pause(500);
    await mkdirShots();
    await page.screenshot({ path: join(shotsDir, 'offline-check.png') }).catch(() => {});
  } finally {
    await browser.close();
    server?.close();
  }
  console.log(`\nrequests seen: ${seen.size}`);
  if (outside.size) {
    console.log('ALARM — outside of our own origin:');
    for (const item of outside) console.log(`  ${item}`);
  }
  const alarmed = outside.size > 0;
  if (selfTest) { console.log(alarmed ? 'self-test OK: the alarm fired as expected' : 'self-test FAILED: alarm did not fire'); process.exit(alarmed ? 0 : 1); }
  console.log(alarmed ? 'RESULT: FAIL' : 'RESULT: PASS — nothing left our origin');
  process.exit(alarmed ? 1 : 0);
};

async function mkdirShots() { const { mkdir } = await import('node:fs/promises'); await mkdir(shotsDir, { recursive: true }); }

run().catch((error) => { console.error(error); process.exit(2); });
