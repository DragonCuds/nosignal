// Incoming media (GIF / sticker / photo) from the other side, real server (see start script in tasks), two browser contexts.
import { coolDown, launch, makeRun, fresh, goto, signup, startChatWith, openChatRow, sleep, tag } from './lib.mjs';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3105';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const run = makeRun('media');
const t = tag(); const NA = `ma${t}`; const NB = `mb${t}`;
const browser = await launch();
let photoDir;
try {
  photoDir = mkdtempSync(join(homedir(), 'nosignal-media-'));
  const photoPath = join(photoDir, 'photo.png');
  copyFileSync(FX + 'photo.png', photoPath);
  const A = await fresh(browser, 'A'); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B'); await goto(B, BASE); await signup(B, NB);
  await startChatWith(A, NB);
  await A.waitForSelector('textarea');
  // seed: tgs pack + a gif for both users (each uploads their own copy, like real users)
  for (const [who, page] of [['A', A], ['B', B]]) {
    const r = await page.evaluate(async (zipB64) => {
      const bin = Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0));
      const fd = new FormData(); fd.append('file', new File([bin], 'pack.zip', { type: 'application/zip' }));
      const a = await fetch('/api/media/packs/import', { method: 'POST', body: fd, credentials: 'include' });
      return a.status;
    }, (await import('node:fs')).readFileSync(FX + 'tgs-pack.zip').toString('base64'));
    const g = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const fd = new FormData(); fd.append('file', new File([bin], 't.gif', { type: 'image/gif' }));
      const a = await fetch('/api/media/gifs/upload', { method: 'POST', body: fd, credentials: 'include' });
      const j = await a.json().catch(() => ({})); if (a.status === 201) await fetch(`/api/media/gifs/${j.id}/save`, { method: 'PUT', credentials: 'include' });
      return a.status;
    }, (await import('node:fs')).readFileSync(FX + 't.gif').toString('base64'));
    console.log(who, 'pack import', r, 'gif upload', g);
  }
  await A.reload({ waitUntil: 'networkidle2' }); await B.reload({ waitUntil: 'networkidle2' });
  await A.waitForSelector('.sidebar'); await B.waitForSelector('.sidebar');
  await openChatRow(A, NB);
  await openChatRow(B, NA);
  await A.waitForSelector('textarea');
  await B.waitForSelector('textarea');
  // B opens chat BEFORE A sends (live path)
  const openPanel = async (page, tabLabel) => { await page.click('button[aria-label^="شکلک، استیکر"]'); await sleep(500); await page.click(`button[role=tab][aria-label="${tabLabel}"]`); await sleep(1500); };
  console.log('tabs', await A.evaluate(() => [...document.querySelectorAll('.media-tabs button')].map((b) => b.getAttribute('aria-label'))));
  // GIF from A
  await openPanel(A, 'گیف'); await sleep(1500);
  await A.screenshot({ path: run.shots + '/A-gifpanel.png' });
  await A.click('.gif-grid button'); await sleep(4000);
  // sticker from A
  await openPanel(A, 'استیکر'); await sleep(1500);
  await A.click('.sticker-grid button'); await sleep(3000);
  // photo from A
  const inputs = await A.$$('input.composer__file');
  await inputs[1].uploadFile(photoPath); await sleep(2000);
  await A.screenshot({ path: run.shots + '/A-after.png' });
  await sleep(6000);
  await B.screenshot({ path: run.shots + '/B-live.png' });
  const state = (page) => page.evaluate(() => ({
    gifs: [...document.querySelectorAll('video[data-gif-video].msg__gif, img.msg__gif')].map((v) => ({ tag: v.tagName, src: (v.currentSrc || v.src || '').slice(0, 40), ready: v.readyState, w: v.videoWidth, paused: v.paused, err: v.error && v.error.code, box: [v.getBoundingClientRect().width, v.getBoundingClientRect().height] })),
    stickers: document.querySelectorAll('tg-sticker.msg__sticker').length,
    photos: [...document.querySelectorAll('.msg img')].map((i) => ({ w: i.naturalWidth, src: i.currentSrc.slice(0, 30) })),
    text: document.body.innerText.includes('قابل رمزگشایی') ? 'UNDECRYPTABLE' : 'ok'
  }));
  const ok = (st) => st.gifs.length === 1 && st.gifs[0].w > 0 && st.gifs[0].ready >= 2 && !st.gifs[0].err
    && st.photos.some((p) => p.w === 320) && st.stickers === 1 && st.text === 'ok';
  const pollOk = async (page) => { let st; for (let i = 0; i < 15; i++) { st = await state(page); if (ok(st)) return [true, st]; await sleep(1000); } return [false, st]; };
  const [liveOk, live] = await pollOk(B);
  run.check('B: incoming GIF decodes, photo shows, sticker present (live)', liveOk, JSON.stringify(live));
  const [ownOk, own] = await pollOk(A);
  run.check('A: own GIF/photo/sticker fine', ok(own) || ownOk, JSON.stringify(own));
  await coolDown();
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar', { timeout: 60000 }); await openChatRow(B, NA);
  const [reOk, re] = await pollOk(B);
  run.check('B: same after reload', reOk, JSON.stringify(re));
  const csp = await B.evaluate(async () => (await fetch('/')).headers.get('content-security-policy') ?? '');
  run.check('CSP allows blob: for img/media/connect (decrypted media is shown from blob URLs)', /img-src[^;]*blob:/.test(csp) && /media-src[^;]*blob:/.test(csp) && /connect-src[^;]*blob:/.test(csp), csp.slice(0, 200));
} catch (e) { console.log('ERROR', e); run.fail(); }
finally {
  try { await browser.close(); }
  finally { if (photoDir) rmSync(photoDir, { recursive: true, force: true }); }
}
run.done();
