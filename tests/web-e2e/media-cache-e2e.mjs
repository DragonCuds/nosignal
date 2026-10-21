// Persistent media cache: B opens a video + photo (network), reloads, opens again: ZERO attachment byte requests.
// Also: logout wipes the cache, and a broken IndexedDB still plays (network fallback).
// Run: BASE=https://127.0.0.1:3411 node tests/web-e2e/media-cache-e2e.mjs
import { launch, makeRun, fresh, goto, login, signup, startChatWith, openChatRow, sleep, tag, PASS } from './lib.mjs';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3411';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const run = makeRun('media-cache');
const t = tag(); const NA = `ma${t}`; const NB = `mb${t}`; const NC = `mc${t}`;
const browser = await launch();
const isBytes = (u) => /\/api\/(attachments|encrypted-media)\//.test(u);
const counter = (page) => { const c = { n: 0 }; page.on('request', (r) => { if (isBytes(r.url())) c.n++; }); return c; };
const idbRows = (page) => page.evaluate(() => new Promise((res) => {
  const o = indexedDB.open('tel-messenger'); o.onerror = () => res(-1);
  o.onsuccess = () => { const d = o.result; if (!d.objectStoreNames.contains('mediaMeta')) return res(-2); const q = d.transaction('mediaData').objectStore('mediaData').count(); q.onsuccess = () => res(q.result); q.onerror = () => res(-1); };
}));
try {
  const A = await fresh(browser, 'A'); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B'); await goto(B, BASE); await signup(B, NB);
  await startChatWith(A, NB); await A.waitForSelector('textarea');
  for (const f of ['clip.mp4', 'photo.png']) {
    const inputs = await A.$$('input.composer__file'); await inputs[1].uploadFile(FX + f); await sleep(2500);
    const s = await A.$('.attach-send, button[aria-label="ارسال"]'); if (s) { await s.click(); await sleep(1500); }
  }
  await sleep(3000);
  const cnt = counter(B);
  await openChatRow(B, NA); await B.waitForSelector('textarea');
  await B.waitForSelector('.vp', { timeout: 30000 });
  const media = () => B.evaluate(() => ({ vid: !!document.querySelector('.vp video'), imgs: [...document.querySelectorAll('.att-photo__open img')].map((i) => i.naturalWidth) }));
  await B.waitForFunction(() => [...document.querySelectorAll('.att-photo__open img')].some((i) => i.naturalWidth > 0), { timeout: 30000 });
  await B.evaluate(() => document.querySelector('.vp__center')?.click());
  await B.waitForFunction(() => { const v = document.querySelector('.vp video'); return v && !v.paused && v.currentTime > 0.5; }, { timeout: 30000 });
  run.check('first open downloads from network', cnt.n > 0, `requests=${cnt.n}`);
  await sleep(1500);
  run.check('cache rows written', (await idbRows(B)) >= 2, `rows=${await idbRows(B)}`);

  const cnt2 = counter(B);
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar');
  await openChatRow(B, NA); await B.waitForSelector('textarea');
  await B.waitForSelector('.vp', { timeout: 30000 });
  await B.waitForFunction(() => [...document.querySelectorAll('.att-photo__open img')].some((i) => i.naturalWidth > 0), { timeout: 30000 });
  await B.evaluate(() => document.querySelector('.vp__center')?.click());
  await B.waitForFunction(() => { const v = document.querySelector('.vp video'); return v && !v.paused && v.currentTime > 0.5; }, { timeout: 30000 });
  await sleep(1500);
  run.check('after reload: ZERO attachment byte requests', cnt2.n === 0, `requests=${cnt2.n}`);
  run.check('after reload: video plays and photo shows', true);

  // logout wipes the cache
  await B.click('button[aria-label="منو"]'); await sleep(500);
  await B.evaluate(() => [...document.querySelectorAll('.drawer__danger')].find((b) => b.textContent.includes('خروج از حساب'))?.click());
  await B.waitForSelector('input[name=username]', { timeout: 15000 }); await sleep(800);
  run.check('logout clears cache rows', (await idbRows(B)) === 0, `rows=${await idbRows(B)}`);

  // IndexedDB broken: playback still works from the network
  const D = await fresh(browser, 'D');
  // only the app cache DB is broken (key storage uses its own DB); open() throws like a private-mode/quota failure
  await D.evaluateOnNewDocument(() => { const open = IDBFactory.prototype.open; IDBFactory.prototype.open = function (name, ...a) { if (name === 'tel-messenger') throw new DOMException('unavailable', 'SecurityError'); return open.call(this, name, ...a); }; });
  await goto(D, BASE); await login(D, NB); await D.waitForSelector('.sidebar', { timeout: 30000 });
  const cnt3 = counter(D);
  await openChatRow(D, NA); await D.waitForSelector('textarea');
  await D.waitForSelector('.vp', { timeout: 30000 });
  await D.waitForFunction(() => [...document.querySelectorAll('.att-photo__open img')].some((i) => i.naturalWidth > 0), { timeout: 30000 });
  await D.evaluate(() => document.querySelector('.vp__center')?.click());
  await D.waitForFunction(() => { const v = document.querySelector('.vp video'); return v && !v.paused && v.currentTime > 0.5; }, { timeout: 30000 });
  run.check('IndexedDB unavailable: media still loads and plays (network)', cnt3.n > 0, `requests=${cnt3.n}`);

  // another account on a fresh login: no cached items from B (same browser profile)
  const E = await fresh(browser, 'E'); await goto(E, BASE); await signup(E, NC);
  run.check('other account on new profile sees no cache rows', (await idbRows(E)) <= 0);
} catch (e) { console.log('ERR', e); run.fail(); } finally { await browser.close(); }
run.done();
