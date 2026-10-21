// Chat video player: A sends two mp4s and a GIF to B; B checks bubble size, play button, playing, controls,
// one-at-a-time, fullscreen, and that the GIF still autoplays muted without the new controls.
// Real server: BASE=https://127.0.0.1:3071 node tests/web-e2e/video-e2e.mjs
import { readFileSync } from 'node:fs';
import { launch, makeRun, fresh, goto, signup, startChatWith, openChatRow, sleep, tag } from './lib.mjs';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3105';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const run = makeRun('video');
const t = tag(); const NA = `va${t}`; const NB = `vb${t}`;
const browser = await launch();
try {
  const A = await fresh(browser, 'A'); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B'); await goto(B, BASE); await signup(B, NB);
  await startChatWith(A, NB);
  await A.waitForSelector('textarea');
  // A saves a GIF to the library (like media-e2e)
  await A.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const fd = new FormData(); fd.append('file', new File([bin], 't.gif', { type: 'image/gif' }));
    const a = await fetch('/api/media/gifs/upload', { method: 'POST', body: fd, credentials: 'include' });
    const j = await a.json().catch(() => ({})); if (a.status === 201) await fetch(`/api/media/gifs/${j.id}/save`, { method: 'PUT', credentials: 'include' });
  }, readFileSync(FX + 't.gif').toString('base64'));
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForSelector('.sidebar'); await openChatRow(A, NB); await A.waitForSelector('textarea');
  await openChatRow(B, NA); await B.waitForSelector('textarea');

  for (const f of ['clip.mp4', 'clip2.mp4']) {
    const inputs = await A.$$('input.composer__file');
    await inputs[1].uploadFile(FX + f); await sleep(2500);
    const sendBtn = await A.$('.attach-send, button[aria-label="ارسال"]'); if (sendBtn) { await sendBtn.click(); await sleep(1000); }
  }
  await A.click('button[aria-label^="شکلک، استیکر"]'); await sleep(500);
  await A.click('button[role=tab][aria-label="گیف"]'); await sleep(2000);
  await A.click('.gif-grid button'); await sleep(3000);
  await sleep(5000);

  await B.waitForSelector('.vp', { timeout: 30000 });
  await B.waitForFunction(() => document.querySelectorAll('.vp').length >= 2, { timeout: 30000 });
  const info = () => B.evaluate(() => [...document.querySelectorAll('.vp')].map((el) => {
    const r = el.getBoundingClientRect(); const c = el.querySelector('.vp__center'); const cr = c?.getBoundingClientRect(); const v = el.querySelector('video');
    return { w: Math.round(r.width), h: Math.round(r.height), play: cr ? { w: Math.round(cr.width), h: Math.round(cr.height), op: getComputedStyle(c).opacity, vis: getComputedStyle(c).visibility } : null, t: v?.currentTime, paused: v?.paused, muted: v?.muted, dur: v?.duration, badge: el.querySelector('.vp__badge')?.textContent };
  }));
  const before = await info();
  console.log(JSON.stringify(before));
  run.check('landscape bubble is wide (>=300px)', before[0].w >= 300, `w=${before[0].w} h=${before[0].h}`);
  run.check('portrait bubble capped (<=420px tall, >=200 wide)', before[1].h <= 421 && before[1].w >= 200, `w=${before[1].w} h=${before[1].h}`);
  run.check('aspect ratio kept (16:9)', Math.abs(before[0].w / before[0].h - 16 / 9) < 0.05);
  run.check('big play button visible before playing', before.every((b) => b.play && b.play.w >= 60 && b.play.h >= 60 && b.play.op === '1' && b.play.vis === 'visible'));
  run.check('duration badge shown', before.every((b) => /:/.test(b.badge ?? '')), before.map((b) => b.badge).join(' '));
  await B.screenshot({ path: run.shots + '/B-desktop-idle.png' });

  const first = (await B.$$('.vp'))[0]; const second = (await B.$$('.vp'))[1];
  await first.scrollIntoView(); await sleep(300);
  await (await first.$('.vp__center')).click();
  await B.waitForFunction(() => { const v = document.querySelectorAll('.vp video')[0]; return v && !v.paused && v.currentTime > 0.5; }, { timeout: 30000 });
  run.check('click on play button plays (currentTime advances)', true);
  await first.hover(); await sleep(500);
  await B.screenshot({ path: run.shots + '/B-desktop-playing.png' });
  run.check('control bar visible while hovering', await B.evaluate(() => getComputedStyle(document.querySelector('.vp__bar')).opacity === '1'));
  await sleep(3800);
  run.check('control bar auto-hides while playing', await B.evaluate(() => getComputedStyle(document.querySelector('.vp__bar')).opacity === '0'));
  // tap video: pause, then tap again: play
  const box = await first.boundingBox();
  await B.mouse.click(box.x + box.width / 2, box.y + box.height / 3); await sleep(500);
  run.check('tap on the picture pauses', await B.evaluate(() => document.querySelectorAll('.vp video')[0].paused));
  await B.mouse.click(box.x + box.width / 2, box.y + box.height / 3); await sleep(800);
  run.check('tap again plays', await B.evaluate(() => !document.querySelectorAll('.vp video')[0].paused));
  await first.hover(); await sleep(300);
  await first.$eval('button[aria-label="توقف"]', (b) => b.click()); await sleep(300);
  run.check('bar pause button pauses', await B.evaluate(() => document.querySelectorAll('.vp video')[0].paused));
  // seek
  await B.evaluate(() => { const i = document.querySelector('.vp__seek'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '8'); i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(500);
  const ct = await B.evaluate(() => document.querySelectorAll('.vp video')[0].currentTime);
  run.check('seek bar moves the video', ct > 7.5 && ct < 8.5, `t=${ct}`);
  // mute
  await first.$eval('button[aria-label="بی‌صدا"]', (b) => b.click()); await sleep(200);
  run.check('mute button mutes', await B.evaluate(() => document.querySelectorAll('.vp video')[0].muted));
  await first.$eval('button[aria-label="روشن کردن صدا"]', (b) => b.click());
  // keyboard
  await first.focus(); await B.keyboard.press('Space'); await sleep(600);
  run.check('keyboard Space plays', await B.evaluate(() => !document.querySelectorAll('.vp video')[0].paused));
  // second video pauses the first
  await second.scrollIntoView(); await sleep(300);
  await (await second.$('.vp__center')).click();
  await B.waitForFunction(() => { const v = document.querySelectorAll('.vp video')[1]; return v && !v.paused && v.currentTime > 0.4; }, { timeout: 30000 });
  run.check('second video playing', true);
  run.check('first video was paused by the second', await B.evaluate(() => document.querySelectorAll('.vp video')[0].paused));
  // scrolled away pauses
  await B.setViewport({ width: 1100, height: 900 }); await sleep(500);
  // fullscreen
  await second.scrollIntoView(); await sleep(300);
  await second.hover(); await sleep(300);
  await second.$eval('button[aria-label="تمام‌صفحه"]', (b) => b.click()); await sleep(800);
  const fs = await B.evaluate(() => ({ el: document.fullscreenElement?.className ?? null, w: innerWidth }));
  run.check('fullscreen button enters fullscreen', !!fs.el && /vp/.test(fs.el), JSON.stringify(fs));
  await B.screenshot({ path: run.shots + '/B-fullscreen.png' });
  await B.keyboard.press('Escape'); await sleep(500);
  await B.evaluate(() => document.exitFullscreen?.().catch(() => {})); await sleep(500);
  run.check('exits fullscreen; layout intact', await B.evaluate(() => !document.fullscreenElement && document.querySelector('.vp').getBoundingClientRect().width > 150));
  // tab hidden pauses (simulate)
  await B.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  run.check('hidden tab pauses video', await B.evaluate(() => [...document.querySelectorAll('.vp video')].every((v) => v.paused)));
  await B.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  // GIF
  const gif = await B.evaluate(() => { const g = document.querySelector('video[data-gif-video]'); return g ? { paused: g.paused, muted: g.muted, loop: g.loop, inVp: !!g.closest('.vp'), controls: g.controls, t: g.currentTime } : null; });
  run.check('GIF autoplays muted & loops, no player controls', !!gif && !gif.paused && gif.muted && gif.loop && !gif.inVp && !gif.controls, JSON.stringify(gif));
  // error + retry: corrupt a video element source
  await B.evaluate(() => { const v = document.querySelectorAll('.vp video')[0]; v.dispatchEvent(new Event('error')); });
  await sleep(400);
  const errTxt = await B.evaluate(() => document.querySelectorAll('.vp')[0].querySelector('.vp__error')?.textContent ?? '');
  run.check('error state shows Persian message + retry', errTxt.includes('پخش نشد') && errTxt.includes('تلاش دوباره'), errTxt);
  await (await first.$('.vp__retry')).click(); await sleep(1500);
  run.check('retry recovers (error gone, plays)', await B.evaluate(() => !document.querySelectorAll('.vp')[0].querySelector('.vp__error') && !document.querySelectorAll('.vp video')[0].paused));
  await B.evaluate(() => document.querySelectorAll('.vp video')[0].pause());
  // phone width
  await B.setViewport({ width: 360, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await sleep(800);
  if (!(await B.$('.vp'))) await openChatRow(B, NA);
  await B.waitForSelector('.vp');
  await B.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = el.scrollHeight; });
  await sleep(500);
  const mob = await B.evaluate(() => ({ ws: [...document.querySelectorAll('.vp')].map((e) => Math.round(e.getBoundingClientRect().width)), over: document.documentElement.scrollWidth > innerWidth }));
  run.check('360px: bubble fits (<=78vw) and no horizontal overflow', mob.ws.every((w) => w <= 282) && !mob.over && mob.ws[0] >= 240, JSON.stringify(mob));
  await B.screenshot({ path: run.shots + '/B-360-idle.png' });
  const m2 = (await B.$$('.vp'))[0]; await m2.scrollIntoView();
  await m2.tap?.(); await sleep(300);
  await (await m2.$('.vp__center'))?.tap(); await sleep(1500);
  await B.screenshot({ path: run.shots + '/B-360-playing.png' });
  const tapBtn = await B.evaluate(() => [...document.querySelectorAll('.vp__btn')].map((b) => Math.round(Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))));
  run.check('tap targets >= 44px', tapBtn.length > 0 && tapBtn.every((s) => s >= 44), tapBtn.join(','));
} catch (e) { console.log('ERR', e); run.fail(); }
await browser.close();
run.done();
