// Regression: every copy of a TGS sticker renders (not only the newest), also for the receiver and after a reload.
import { readFileSync } from 'node:fs';
import { coolDown, launch, makeRun, fresh, goto, signup, startChatWith, openChatRow, sleep, tag } from './lib.mjs';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3105';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const run = makeRun('tgs');
const t = tag(); const NA = `ta${t}`; const NB = `tb${t}`;
const browser = await launch();
// painted pixels of every <tg-sticker> in the open chat (canvas inside its shadow root)
const sample = (page) => page.evaluate(() => [...document.querySelectorAll('tg-sticker.msg__sticker')].map((el) => {
  const c = el.shadowRoot?.querySelector('canvas');
  if (!c || !c.width) return { canvas: !!c, painted: 0 };
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return { canvas: true, painted: n };
}));
// A playing sticker may sit on a blank frame at the instant of sampling, so look for ~1.5 s; a blank (broken) canvas never paints.
const paint = async (page) => {
  let best = [];
  for (let i = 0; i < 8; i++) {
    const now = await sample(page);
    best = now.map((x, k) => ({ ...x, painted: Math.max(x.painted, best[k]?.painted ?? 0) }));
    if (best.length && best.every((x) => x.painted > 0)) break;
    await sleep(200);
  }
  return best;
};
try {
  const A = await fresh(browser, 'A', 1000, 900); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B', 1000, 900); await goto(B, BASE); await signup(B, NB);
  await startChatWith(A, NB);
  const pack = readFileSync(FX + 'tgs-pack.zip').toString('base64');
  const st = await A.evaluate(async (b64) => {
    const fd = new FormData(); fd.append('file', new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'p.zip', { type: 'application/zip' }));
    return (await fetch('/api/media/packs/import', { method: 'POST', body: fd, credentials: 'include' })).status;
  }, pack);
  run.check('pack import', st === 201, String(st));
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForSelector('.sidebar'); await openChatRow(A, NB);
  await A.waitForSelector('textarea');
  for (let i = 0; i < 4; i++) {
    await A.click('button[aria-label^="شکلک، استیکر"]'); await sleep(500);
    await A.click('button[role=tab][aria-label="استیکر"]'); await sleep(1200);
    await A.click('.sticker-grid button:nth-child(3)'); await sleep(1500);
  }
  await sleep(2000);
  const own = await paint(A);
  run.check('sender sees 4 stickers, all painted', own.length === 4 && own.every((x) => x.painted > 0), JSON.stringify(own));
  await coolDown();
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar'); await openChatRow(B, NA); await sleep(3000);
  const incoming = await paint(B);
  run.check('receiver (after load) sees 4 stickers, all painted', incoming.length === 4 && incoming.every((x) => x.painted > 0), JSON.stringify(incoming));
  await B.screenshot({ path: run.shots + '/B-4stickers.png' });
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForSelector('.sidebar', { timeout: 60000 }); await openChatRow(A, NB); await sleep(3000);
  const afterReload = await paint(A);
  run.check('sender after reload: all 4 painted', afterReload.length === 4 && afterReload.every((x) => x.painted > 0), JSON.stringify(afterReload));
  await A.screenshot({ path: run.shots + '/A-reload.png' });
  // scrolled into view later: scroll the list to the top, then back, and re-check
  await A.evaluate(() => { const v = document.querySelector('.messages, .chat__viewport, [class*=viewport]'); if (v) v.scrollTop = 0; });
  await sleep(500);
  await A.evaluate(() => { const v = document.querySelector('.messages, .chat__viewport, [class*=viewport]'); if (v) v.scrollTop = v.scrollHeight; });
  await sleep(1000);
  const again = await paint(A);
  run.check('after scroll away and back: still painted', again.length === 4 && again.every((x) => x.painted > 0), JSON.stringify(again));
  // leak check: leaving the chat destroys the lottie instances
  await A.evaluate(() => document.querySelector('.chat-row')?.click());
} catch (e) { console.log('ERROR', e); run.fail(); }
finally { await browser.close(); }
run.done();
