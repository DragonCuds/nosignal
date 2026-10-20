#!/usr/bin/env node
// Weak-network benchmark: headless Chromium + CDP network emulation against a production-like server (see README.md).
// usage: node bench.mjs [fast|poor3g|edge|flaky ...]   (default: all four)  -> prints + writes results-<profile>.json
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';

const HOST = process.env.BENCH_HOST || 'tel.bench.test'; // not localhost: the app deliberately skips its service worker there
const BASE = process.env.BASE || `https://${HOST}:3070`;
const WORK = process.env.WORK || '/root/pb3-run/work';
const OUT = path.dirname(new URL(import.meta.url).pathname);
const PASS = 'bench-password-12345';
const PEER = 'pbpeer' + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
// The dev server uses its own self-signed TLS cert. Trust exactly that key (so a service worker may register) and map the name to loopback.
const spki = await new Promise((resolve, reject) => {
  const sock = tls.connect({ host: '127.0.0.1', port: 3070, servername: HOST, rejectUnauthorized: false }, () => {
    const cert = new X509Certificate(sock.getPeerCertificate().raw);
    sock.end(); resolve(createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'));
  });
  sock.on('error', reject);
});
const BROWSER_ARGS = ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`, '--window-size=420,900'];

// bytes/s; latency = round trip ms added by Chromium emulation
const PROFILES = {
  fast: null,
  poor3g: { downloadThroughput: 50_000, uploadThroughput: 18_750, latency: 400 }, // 400 / 150 kbit/s, 400 ms
  edge: { downloadThroughput: 12_500, uploadThroughput: 6_250, latency: 800 }, // 100 / 50 kbit/s, 800 ms
  flaky: { downloadThroughput: 50_000, uploadThroughput: 18_750, latency: 400, drops: true }, // poor3g + 2 x 8 s link loss
};

const launch = (dir) => puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true, userDataDir: dir, args: BROWSER_ARGS, defaultViewport: { width: 420, height: 900 } });

// One client = one browser profile + counters of bytes on the wire (page and service worker).
class Client {
  constructor(browser, cond) { this.browser = browser; this.cond = cond; this.sessions = []; this.down = 0; this.up = 0; this.reqs = 0; this.upload = 0; this.uploadPage = 0; this.uploadSw = 0; }
  async cdp(target) {
    const s = await target.createCDPSession();
    const fromSw = new Set(); const url = new Map();
    const isPage = typeof target.goto === 'function';
    s.on('Network.requestWillBeSent', (e) => { url.set(e.requestId, e.request.url); this.reqs++; if (e.request.method === 'PUT' && /\/attachments\//.test(e.request.url)) { const n = Number(e.request.headers['Content-Length'] || e.request.headers['content-length'] || 0) || (e.request.postData || '').length; if (isPage) this.uploadPage += n; else this.uploadSw += n; } });
    s.on('Network.responseReceived', (e) => { if (e.response.fromServiceWorker) fromSw.add(e.requestId); });
    s.on('Network.loadingFinished', (e) => { if (!fromSw.has(e.requestId)) this.down += e.encodedDataLength; });
    s.on('Network.requestWillBeSentExtraInfo', () => {});
    await s.send('Network.enable');
    this.sessions.push(s);
    await this.apply(s, this.cond);
    return s;
  }
  async apply(s, c) {
    const x = c || { downloadThroughput: -1, uploadThroughput: -1, latency: 0 };
    await s.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: x.downloadThroughput, uploadThroughput: x.uploadThroughput, latency: x.latency }).catch(() => {});
  }
  async setOffline(off) {
    const x = this.cond || { downloadThroughput: -1, uploadThroughput: -1, latency: 0 };
    for (const s of this.sessions) await s.send('Network.emulateNetworkConditions', { offline: off, downloadThroughput: x.downloadThroughput, uploadThroughput: x.uploadThroughput, latency: x.latency }).catch(() => {});
  }
  async drop(ms) { await this.setOffline(true); await sleep(ms); await this.setOffline(false); }
  async newPage() {
    const page = await this.browser.newPage();
    await page.evaluateOnNewDocument(HELPERS);
    await this.cdp(page);
    return page;
  }
  async watchSw() {
    const hook = async (t) => { if (t.type() === 'service_worker') await this.cdp(t).catch(() => {}); };
    this.browser.on('targetcreated', hook);
    for (const t of this.browser.targets()) await hook(t);
  }
  reset() { this.down = 0; this.reqs = 0; }
  get uploaded() { return Math.max(this.uploadPage, this.uploadSw); }
}

const waitFor = async (page, fn, arg, timeout = 300_000) => {
  const t0 = now();
  while (now() - t0 < timeout) {
    try { if (await page.evaluate(fn, arg)) return now() - t0; } catch { /* navigation */ }
    await sleep(60);
  }
  return null;
};
const timed = async (label, res, fn) => {
  const t0 = now();
  let ok = null, note;
  try { ok = await fn(); } catch (e) { note = String(e.message || e).slice(0, 120); }
  const ms = ok === null || ok === undefined || ok === false ? null : Math.round(now() - t0);
  res.steps[label] = ms;
  if (note) res.notes[label] = note;
  console.log(`  ${label}: ${ms === null ? 'FAILED/timeout' : (ms / 1000).toFixed(1) + ' s'}${note ? ' (' + note + ')' : ''}`);
  return ms;
};

// DOM probes (run inside the page)
const hasUsername = () => { const e = document.querySelector('input[name=username]'); return !!e && e.offsetParent !== null && !e.disabled; };
const hasList = () => document.querySelectorAll('.chat-row').length > 0;
const hasComposer = () => !!document.querySelector('textarea[aria-label="متن پیام"]');
const HELPERS = () => {
  window.__b = {
    state(text) {
      const m = [...document.querySelectorAll('.msg')].filter((x) => x.innerText.includes(text));
      return { count: m.length, sending: m.some((x) => x.classList.contains('msg--sending')), failed: m.some((x) => x.classList.contains('msg--failed')) };
    },
    media: () => document.querySelectorAll('.msg--media, .msg img, .msg canvas').length,
  };
};
const msgState = (text) => window.__b.state(text);
const delivered = (text) => { const s = window.__b.state(text); return s.count === 1 && !s.sending && !s.failed; };
const countText = (text) => window.__b.state(text).count;
const mediaCount = () => window.__b.media();

const ev = async (page, fn, arg) => { for (let i = 0; i < 20; i++) { try { return await page.evaluate(fn, arg); } catch { await sleep(500); } } return null; };
const settle = async (c, quiet = 2500, cap = 240_000) => { // wait until the byte counter stops moving
  const t0 = now(); let last = c.down, since = now();
  while (now() - t0 < cap) { await sleep(300); if (c.down !== last) { last = c.down; since = now(); } else if (now() - since > quiet) break; }
};

async function ensurePhoto() {
  const f = path.join(WORK, 'photo.jpg');
  if (existsSync(f)) return f;
  const b = await launch(path.join(WORK, 'photo-gen'));
  const p = await b.newPage();
  const b64 = await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 1200); g.addColorStop(0, '#2a6'); g.addColorStop(1, '#a42'); x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
    let s = 7; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 2500; i++) { x.fillStyle = `hsl(${r() * 360},${40 + r() * 50}%,${30 + r() * 50}%)`; x.fillRect(r() * 1600, r() * 1200, 10 + r() * 90, 10 + r() * 90); }
    for (let q = 0.95; q > 0.05; q -= 0.02) { const d = c.toDataURL('image/jpeg', q); if (d.length * 0.75 < 300_000) return d.split(',')[1]; }
  });
  await b.close();
  writeFileSync(f, Buffer.from(b64, 'base64'));
  return f;
}

async function registerUser(page, username) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=username]', { visible: true });
  await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.includes('ثبت')).click());
  await page.type('input[name=username]', username); await page.type('input[name=password]', PASS); await page.type('input[name=password-repeat]', PASS);
}
const submit = (page) => page.click('button[type=submit]');

async function peerSetup() {
  const dir = path.join(WORK, 'peer'); rmSync(dir, { recursive: true, force: true });
  const browser = await launch(dir);
  const c = new Client(browser, null);
  const page = await c.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=username]', { visible: true });
  const tab = await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.includes('ثبت'))?.click());
  await page.type('input[name=username]', PEER); await page.type('input[name=password]', PASS); await page.type('input[name=password-repeat]', PASS);
  await submit(page);
  if (!(await waitFor(page, hasList, null, 30_000))) throw new Error('peer signup failed');
  return { browser, page, client: c };
}
const peerOpen = async (peerPage, name) => {
  // the other person finds the new account by ID and opens the same direct chat (get-or-create on the server)
  await peerPage.evaluate(() => { const i = document.querySelector('input[aria-label="جستجوی آیدی"]'); if (i) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); } });
  await peerPage.type('input[aria-label="جستجوی آیدی"]', name);
  const ok = await waitFor(peerPage, () => { const b = document.querySelector('.idsearch__result'); if (b && !b.disabled) { b.click(); return true; } return false; }, null, 60_000);
  if (ok === null) throw new Error('peer could not find the new account');
  if ((await waitFor(peerPage, hasComposer, null, 30_000)) === null) throw new Error('peer chat did not open');
};

async function runProfile(name, peerClient) {
  const cond = PROFILES[name];
  const peer = { page: await peerClient.newPage() };
  await peer.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  if ((await waitFor(peer.page, hasList, null, 60_000)) === null) throw new Error('peer page did not open');
  const log = (...x) => console.log(`[${name}]`, ...x);
  const res = { profile: name, steps: {}, bytes: {}, notes: {}, facts: {} };
  (globalThis.__res ||= {})[name] = res;
  const user = `bench_${name}_${Date.now().toString(36)}`.slice(0, 32);
  const dir = path.join(WORK, 'prof-' + name);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const browser = await launch(dir);
  const c = new Client(browser, cond);
  await c.watchSw();
  let page = await c.newPage();
  const photo = await ensurePhoto();
  const tag = (s) => `${s}-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const send = async (label, text, dropAfter) => {
    await page.focus('textarea[aria-label="متن پیام"]'); await page.type('textarea[aria-label="متن پیام"]', text);
    const t0 = now(); await page.keyboard.press('Enter');
    if (dropAfter) void c.drop(8000);
    const ack = await waitFor(page, delivered, text, 600_000);
    res.steps[label + ' (sent, tick shown)'] = ack === null ? null : Math.round(ack);
    const seen = await waitFor(peer.page, countText, text, 120_000).then(() => null);
    return null;
  };
  const peerSees = async (text, since) => {
    const t = await waitFor(peer.page, (x) => window.__b.state(x).count > 0, text, 600_000);
    return t === null ? null : Math.round(now() - since);
  };
  const sendText = async (label, text) => {
    await page.focus('textarea[aria-label="متن پیام"]'); await page.type('textarea[aria-label="متن پیام"]', text);
    const t0 = now(); await page.keyboard.press('Enter');
    if (process.env.DEBUG_SHOTS) setTimeout(async () => { await page.screenshot({ path: '/root/pb3-run/dbg-a.png' }); await peer.page.screenshot({ path: '/root/pb3-run/dbg-b.png' }); log('A msgs', await page.evaluate(() => [...document.querySelectorAll('.msg')].map((m) => m.className + '|' + m.innerText.slice(0, 40)))); }, 15000);
    const [a, b] = await Promise.all([waitFor(page, delivered, text, 600_000), peerSees(text, t0)]);
    res.steps[label + ' (tick on my side)'] = a === null ? null : Math.round(a);
    res.steps[label + ' (arrives at the other person)'] = b;
    log(`  ${label}: tick ${a === null ? 'FAILED' : (a / 1000).toFixed(1) + ' s'}, peer ${b === null ? 'FAILED' : (b / 1000).toFixed(1) + ' s'}`);
  };
  const sendPhoto = async (label, drop) => {
    const before = await page.evaluate(() => document.querySelectorAll('.msg').length); const pBefore = await peer.page.evaluate(() => document.querySelectorAll('.msg').length);
    c.uploadPage = 0; c.uploadSw = 0;
    const input = await page.$('input.composer__file[accept="image/*,video/*"]');
    const t0 = now(); await input.uploadFile(photo);
    if (drop) void (async () => { await sleep(3000); await c.drop(8000); })();
    if (process.env.DEBUG_PHOTO) {
      page.on('requestfailed', (r) => log(`  [dbg] request failed ${r.method()} ${r.url().replace(BASE, '')} ${r.failure()?.errorText}`));
      page.on('response', (r) => { if (/attachments|messages/.test(r.url())) log(`  [dbg] ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
      for (const sec of [40, 120]) setTimeout(async () => {
        await page.screenshot({ path: `/root/pb3-run/dbg-photo-${sec}.png` });
        log('  [dbg] t+' + sec, await ev(page, () => [...document.querySelectorAll('.msg')].map((m) => m.className.replace(/msg--(tail|live|joined-\w+)/g, '').trim() + '|' + m.innerText.slice(0, 20))));
      }, sec * 1000);
    }
    const mine = waitFor(page, (n) => document.querySelectorAll('.msg').length > n && !document.querySelector('.msg--sending') && !document.querySelector('.msg--failed'), before, 900_000);
    const theirs = waitFor(peer.page, (n) => document.querySelectorAll('.msg').length > n, pBefore, 900_000);
    const [a, b] = await Promise.all([mine, theirs]);
    res.steps[label + ' (done on my side)'] = a === null ? null : Math.round(a);
    res.steps[label + ' (arrives at the other person)'] = b === null ? null : Math.round(b);
    res.facts[label + ' uploaded bytes'] = c.uploaded;
    log(`  ${label}: mine ${a === null ? 'FAILED' : (a / 1000).toFixed(1) + ' s'}, peer ${b === null ? 'FAILED' : (b / 1000).toFixed(1) + ' s'}, uploaded ${c.uploaded} B`);
  };
  const login = async (label) => {
    await page.focus('input[name=username]'); await page.type('input[name=username]', user); await page.type('input[name=password]', PASS);
    const t0 = now(); await submit(page);
    const ok = await waitFor(page, hasList, null, 600_000);
    res.steps[label] = ok === null ? null : Math.round(now() - t0);
    log(`  ${label}: ${ok === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'}`);
  };
  const loadLogin = async (label, bytesLabel) => {
    c.reset(); const t0 = now();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 600_000 }).catch(() => {});
    const ok = await waitFor(page, hasUsername, null, 600_000);
    res.steps[label] = ok === null ? null : Math.round(now() - t0);
    res.bytes[bytesLabel + ' (at login screen)'] = c.down;
    log(`  ${label}: ${ok === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'}, ${c.down} B`);
    await settle(c); res.bytes[bytesLabel + ' (after settling)'] = c.down;
  };
  const clearCaches = async () => {
    const s = c.sessions[0];
    await s.send('Network.clearBrowserCache').catch(() => {});
    await s.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'cache_storage,service_workers,appcache' }).catch(() => {});
    await s.send('Network.clearBrowserCookies').catch(() => {});
  };
  const clearCookiesOnly = async () => c.sessions[0].send('Network.clearBrowserCookies').catch(() => {});

  let t0s;
  log(`\n== ${name} ==`);
  // ---- COLD ----
  await loadLogin('COLD: load until login screen usable', 'COLD first load');
  t0s = now();
  const tabT = await waitFor(page, () => { const t = [...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.includes('ثبت')); if (t) { t.click(); return true; } return false; }, null, 600_000);
  res.steps['COLD: sign-up tab appears (after login screen)'] = tabT === null ? null : Math.round(now() - t0s); log(`  sign-up tab appeared after ${tabT === null ? 'NEVER' : (tabT / 1000).toFixed(1) + ' s more'}`);
  await page.type('input[name=username]', user); await page.type('input[name=password]', PASS); await page.type('input[name=password-repeat]', PASS);
  c.reset(); let t0 = now(); await submit(page);
  let ok = await waitFor(page, hasList, null, 600_000);
  res.steps['COLD: sign-up until chat list shown'] = ok === null ? null : Math.round(now() - t0);
  res.bytes['COLD sign-up step'] = c.down;
  log(`  signup: ${ok === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'}`);
  if (ok === null) { await browser.close(); return res; }
  // open chat with peer through ID search
  t0 = now(); c.reset();
  await page.type('input[aria-label="جستجوی آیدی"]', PEER);
  ok = await waitFor(page, () => { const b = document.querySelector('.idsearch__result'); if (b && !b.disabled) { b.click(); return true; } return false; }, null, 600_000);
  const opened = ok === null ? null : await waitFor(page, hasComposer, null, 600_000);
  res.steps['COLD: find person by ID and open chat'] = opened === null ? null : Math.round(now() - t0);
  res.bytes['COLD find+open chat'] = c.down;
  log(`  open chat: ${opened === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'}`);
  if (opened === null) { await browser.close(); return res; }
  await peerOpen(peer.page, user);
  c.reset();
  await sendText('COLD: send text', tag('hello'));
  res.bytes['COLD send text'] = c.down;
  await sendPhoto('COLD: send ~300 KB photo', cond?.drops);
  // cold login: clear caches + cookies, keep the local E2EE key
  await clearCaches();
  await loadLogin('COLD: load until login screen usable (after cache clear)', 'COLD login load');
  await login('COLD: log in until chat list shown');
  res.bytes['COLD login step'] = c.down;
  // ---- WARM ----
  await settle(c);
  c.reset(); t0 = now();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 600_000 }).catch(() => {});
  ok = await waitFor(page, hasList, null, 600_000);
  res.steps['WARM: reopen (logged in) until chat list shown'] = ok === null ? null : Math.round(now() - t0);
  res.bytes['WARM reopen (at chat list)'] = c.down;
  log(`  warm reopen: ${ok === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'}, ${c.down} B`);
  await settle(c); res.bytes['WARM reopen (after settling)'] = c.down;
  await clearCookiesOnly();
  await loadLogin('WARM: load until login screen usable', 'WARM login load');
  await login('WARM: log in until chat list shown');
  c.reset(); t0 = now();
  await page.evaluate((n) => { const r = [...document.querySelectorAll('.chat-row')].find((x) => x.innerText.includes(n)); r?.click(); }, PEER);
  const nmsg = await waitFor(page, () => document.querySelectorAll('.msg').length >= 2, null, 600_000);
  res.steps['WARM: open chat until old messages shown'] = nmsg === null ? null : Math.round(now() - t0);
  res.bytes['WARM open chat'] = c.down;
  log(`  warm open chat: ${nmsg === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'}, ${c.down} B`);
  if (nmsg === null) { await browser.close(); return res; }
  await sendText('WARM: send text', tag('hello'));
  await sendPhoto('WARM: send ~300 KB photo', cond?.drops);
  // offline then online
  const off1 = tag('offline');
  await c.setOffline(true);
  await page.focus('textarea[aria-label="متن پیام"]'); await page.type('textarea[aria-label="متن پیام"]', off1); await page.keyboard.press('Enter');
  await sleep(4000);
  const during = await page.evaluate(msgState, off1);
  res.facts['offline send: bubble while offline'] = during.count === 1 ? (during.failed ? 'shown as failed' : 'shown as pending') : `count=${during.count}`;
  t0 = now(); await c.setOffline(false);
  const back = await waitFor(page, delivered, off1, 300_000);
  res.steps['OFFLINE->ONLINE: text delivered after link returns'] = back === null ? null : Math.round(now() - t0);
  await sleep(6000);
  const mineCount = await ev(page, countText, off1); const theirCount = await ev(peer.page, countText, off1);
  res.facts['offline send: copies on my screen / other person'] = `${mineCount} / ${theirCount}`;
  log(`  offline->online: ${back === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'}; copies mine ${mineCount}, peer ${theirCount}`);
  // offline + reload
  const off2 = tag('offreload');
  await c.setOffline(true);
  await page.focus('textarea[aria-label="متن پیام"]'); await page.type('textarea[aria-label="متن پیام"]', off2); await page.keyboard.press('Enter');
  await sleep(2000);
  t0 = now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  const reopenedOffline = await waitFor(page, () => document.querySelectorAll('.chat-row').length > 0, null, 40_000);
  res.steps['OFFLINE: reload the app while offline until chat list shown'] = reopenedOffline === null ? null : Math.round(now() - t0);
  res.facts['offline reload: what the screen shows'] = reopenedOffline !== null ? 'app opened from cache' : (await page.evaluate(() => !!document.querySelector('input[name=username]')).catch(() => false)) ? 'LOGIN SCREEN (app shell loads, but chats are not shown)' : (await page.evaluate(() => document.body.innerText.slice(0, 80).replace(/\s+/g, ' ')).catch(() => '?'));
  log(`  offline reload: ${reopenedOffline === null ? 'FAILED: ' + res.facts['offline reload: what the screen shows'] : ((now() - t0) / 1000).toFixed(1) + ' s'}`);
  await c.setOffline(false);
  t0 = now();
  if (reopenedOffline === null) await page.reload({ waitUntil: 'domcontentloaded', timeout: 300_000 }).catch(() => {});
  await waitFor(page, hasList, null, 300_000);
  await ev(page, (n) => { const r = [...document.querySelectorAll('.chat-row')].find((x) => x.innerText.includes(n)); r?.click(); }, PEER);
  const got = await peerSees(off2, t0);
  await sleep(6000);
  const theirs2 = await ev(peer.page, countText, off2); const mine2 = await ev(page, countText, off2);
  res.steps['OFFLINE+RELOAD: queued text reaches the other person after link returns'] = got;
  res.facts['offline+reload: copies on my screen / other person'] = `${mine2} / ${theirs2}`;
  log(`  offline+reload text: peer ${got === null ? 'NEVER' : (got / 1000).toFixed(1) + ' s'}; copies mine ${mine2}, peer ${theirs2}`);
  // app reopen offline in a brand-new tab
  await c.setOffline(true);
  const p2 = await c.newPage();
  t0 = now();
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  const shown = await waitFor(p2, () => document.querySelectorAll('.chat-row').length > 0 || !!document.querySelector('input[name=username]'), null, 30_000);
  res.steps['OFFLINE: new tab opens the app until something usable shows'] = shown === null ? null : Math.round(now() - t0);
  res.facts['offline new tab: what the screen shows'] = await p2.evaluate(() => document.querySelectorAll('.chat-row').length ? 'chat list (from cache)' : document.querySelector('input[name=username]') ? 'login screen only' : document.body.innerText.slice(0, 80).replace(/\s+/g, ' ')).catch(() => 'nothing');
  log(`  offline new tab: ${shown === null ? 'FAILED' : ((now() - t0) / 1000).toFixed(1) + ' s'} -> ${res.facts['offline new tab: what the screen shows']}`);
  await c.setOffline(false);
  await browser.close();
  return res;
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : ['fast', 'poor3g', 'edge', 'flaky'];
mkdirSync(WORK, { recursive: true });
const peer = await peerSetup().catch(async (e) => { console.log('peer setup:', e.message); throw e; });
const run = async (name) => {
  try {
    const r = await runProfile(name, peer.client);
    writeFileSync(path.join(OUT, `results-${name}.json`), JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('profile crashed', name, String(e.stack || e).split('\n').slice(0, 3).join(' | '));
    const r = globalThis.__res?.[name]; if (r) { r.crashed = String(e.message || e); writeFileSync(path.join(OUT, `results-${name}.json`), JSON.stringify(r, null, 2)); }
  }
};
// fast runs alone (clean CPU); the throttled profiles are network-bound and run side by side to save time
if (want.includes('fast')) await run('fast');
const rest = want.filter((n) => n !== 'fast');
if (process.env.SERIAL) { for (const n of rest) await run(n); } else await Promise.all(rest.map(run));
await peer.browser.close();
