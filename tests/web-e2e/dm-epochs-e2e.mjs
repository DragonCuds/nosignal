// NS-07 end to end (real server + headless chromium, see lib.mjs): after B starts fresh in a new browser,
//  - the start-fresh screen says how many chats are touched and that contacts keep their history;
//  - A (who accepts B's new key) still reads old messages AND new ones; B2 reads only the new ones;
//  - a tab of A that stayed open (stale key version) is refused by the server, shows the key-change notice, and delivers after accepting;
//  - encrypted media (GIF) from before and after the reset opens for A.
// Needs a server like keychange-e2e.mjs (BASE=https://127.0.0.1:<port>, NODE_ENV=production TLS_MODE=auto OPEN_REGISTRATION=1).
import { readFileSync } from 'node:fs';
import { launch, makeRun, fresh, goto, signup, login, startChatWith, openChatRow, clickText, text, waitFor, send, sleep, tag, apiJson, coolDown, PASS } from './lib.mjs';

const BASE = process.env.BASE ?? 'https://127.0.0.1:3105';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const run = makeRun('dm-epochs');
const t = tag(); const NA = `ea${t}`; const NB = `eb${t}`;
const browser = await launch();
const LOCK = 'قابل رمزگشایی نیست';
const gifState = (page) => page.evaluate(() => [...document.querySelectorAll('video[data-gif-video].msg__gif, img.msg__gif')].map((v) => ({ w: v.videoWidth ?? v.naturalWidth, err: v.error && v.error.code })));
const gifsOk = async (page, n) => { let st = []; for (let i = 0; i < 20; i++) { st = await gifState(page); if (st.length === n && st.every((g) => g.w > 0 && !g.err)) return [true, st]; await sleep(1000); } return [false, st]; };
const sendGif = async (page) => {
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('بعداً یادآوری'))?.click(); }); await sleep(400); // the "no backup yet" notice covers the toolbar
  await page.click('button[aria-label^="شکلک، استیکر"]'); await sleep(800);
  if (!(await page.$('button[role=tab][aria-label="گیف"]'))) { await page.click('button[aria-label^="شکلک، استیکر"]'); await sleep(800); }
  if (!(await page.$('button[role=tab][aria-label="گیف"]'))) {
    console.log('tabs', await page.evaluate(() => [...document.querySelectorAll('[role=tab],button[aria-label]')].map((b) => b.getAttribute('aria-label'))));
    await page.screenshot({ path: run.shots + '/gif-panel-debug.png' });
  }
  await page.click('button[role=tab][aria-label="گیف"]'); await sleep(2000);
  await page.click('.gif-grid button'); await sleep(3500);
};
try {
  const A = await fresh(browser, 'A', 1000, 800); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B', 1000, 800); await goto(B, BASE); await signup(B, NB);
  // a GIF in B's saved list (used before and after the reset: it is the same account)
  const seed = await B.evaluate(async (b64) => {
    const fd = new FormData(); fd.append('file', new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 't.gif', { type: 'image/gif' }));
    const r = await fetch('/api/media/gifs/upload', { method: 'POST', body: fd, credentials: 'include' });
    const j = await r.json().catch(() => ({})); if (r.status === 201) await fetch(`/api/media/gifs/${j.id}/save`, { method: 'PUT', credentials: 'include' });
    return r.status;
  }, readFileSync(FX + 't.gif').toString('base64'));
  run.check('seed GIF for B', seed === 201 || seed === 200, String(seed));
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar');

  await startChatWith(B, NA);
  await send(B, 'سلام از B');                                   // B creates key version 1
  await sendGif(B);                                             // media sealed under version 1
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForSelector('.sidebar'); await openChatRow(A, NB);
  run.check('A reads B (version 1)', await waitFor(A, 'سلام از B'));
  await send(A, 'جواب از A');
  run.check('B reads A', await waitFor(B, 'جواب از A'));
  const [g1] = await gifsOk(A, 1);
  run.check('A shows B\'s GIF from before the reset', g1);
  // A keeps THIS tab open from here on (it will hold the old key version)

  // B loses the key: delete the server backup (needs a grant), then log in on a fresh browser => recovery screen
  const rev = (await apiJson(B, '/api/crypto/backup')).body.revision;
  const grant = await apiJson(B, '/api/crypto/action-grant', 'POST', { action: 'backup.delete', expectedRevision: rev, password: PASS });
  const del = await apiJson(B, '/api/crypto/backup', 'DELETE', { expectedRevision: rev, actionToken: grant.body?.token });
  run.check('backup removed so the new browser cannot restore', del.status === 204, String(del.status));
  const B2 = await fresh(browser, 'B2', 1000, 800); await goto(B2, BASE); await login(B2, NB);
  run.check('recovery screen appears', await waitFor(B2, 'کلید رمزنگاری این دستگاه پیدا نشد', 30000));
  await waitFor(B2, 'تحت‌تأثیر', 10000); // the affected-chat count is fetched after the screen shows
  const body = await text(B2);
  run.check('screen says how many chats are touched', /۱ گفتگوی شما تحت‌تأثیر قرار می‌گیرد/.test(body), body.slice(body.indexOf('شروع تازه'), body.indexOf('شروع تازه') + 300));
  run.check('screen says contacts keep their history and you start fresh', body.includes('مخاطب‌های شما تاریخچهٔ گفتگو را نگه می‌دارند و شما از نو شروع می‌کنید'));
  run.check('old "may disrupt the other side" wording is gone', !body.includes('مختل'));
  await B2.screenshot({ path: run.shots + '/B2-recovery.png' });
  await B2.evaluate((pw) => {
    const form = [...document.querySelectorAll('form')].find((f) => f.querySelector('h3')?.textContent.includes('شروع تازه'));
    form.querySelector('input[type=checkbox]').click();
    return pw;
  }, PASS);
  const freshForm = await B2.evaluateHandle(() => [...document.querySelectorAll('form')].find((f) => f.querySelector('h3')?.textContent.includes('شروع تازه')));
  await (await freshForm.$('input[type=password]')).type(PASS);
  await (await freshForm.$('button[type=submit]')).click();
  await B2.waitForSelector('.sidebar', { timeout: 40000 }); await sleep(2500);
  await openChatRow(B2, NA);                                    // B2 opens the chat: the new key version is created here (A's pin of B is still the old one)
  await sleep(3000);
  const b2text = await text(B2);
  run.check('B2 cannot read what was sent before the reset', b2text.includes(LOCK) || !b2text.includes('سلام از B'));

  // A's OLD tab (never reloaded) now sends: the server refuses the stale key version; A must see the key-change notice
  await A.waitForSelector('textarea', { timeout: 10000 });
  await A.type('textarea', 'از تب قدیمی'); await A.keyboard.press('Enter');
  const banner = await waitFor(A, 'تأیید کلید جدید', 30000);
  run.check('stale tab: the refused message leads to the key-change notice', banner);
  await A.screenshot({ path: run.shots + '/A-stale-banner.png' });
  run.check('stale tab: message is not lost, it waits as failed', await waitFor(A, 'از تب قدیمی', 5000));
  await clickText(A, '.keychange button', 'تأیید کلید جدید');
  run.check('stale tab: after accepting, the message is delivered under the new key (B2 reads it)', await waitFor(B2, 'از تب قدیمی', 30000));
  // item 11: A reads old and new
  const all = ['سلام از B', 'جواب از A', 'از تب قدیمی'];
  let ok = false; for (let i = 0; i < 20 && !ok; i++) { const tx = await text(A); ok = all.every((s) => tx.includes(s)); if (!ok) await sleep(1000); }
  run.check('A reads the old history (version 1) and the new message', ok, (await text(A)).slice(0, 400));
  run.check('A shows no undecryptable message', !(await text(A)).includes(LOCK));
  // B2 answers under the new key, with a GIF too
  await send(B2, 'پیام جدید از B2');
  await sendGif(B2);
  run.check('A reads the new message from B2', await waitFor(A, 'پیام جدید از B2', 30000));
  const [g2, g2state] = await gifsOk(A, 2);
  run.check('A shows both GIFs (before and after the reset)', g2, JSON.stringify(g2state));
  // a second tab of A (fresh page load, same profile) sees the same without any notice
  const A2 = await A.browserContext().newPage(); await A2.setViewport({ width: 1000, height: 800 }); await goto(A2, BASE);
  await A2.waitForSelector('.sidebar', { timeout: 40000 }); await openChatRow(A2, NB);
  let ok2 = false; for (let i = 0; i < 25 && !ok2; i++) { const tx = await text(A2); ok2 = [...all, 'پیام جدید از B2'].every((s) => tx.includes(s)); if (!ok2) await sleep(1000); }
  run.check('A, new tab: whole history readable, no key-change notice', ok2 && (await A2.$('.keychange')) === null);
  const [g3] = await gifsOk(A2, 2);
  run.check('A, new tab: both GIFs decode', g3);
  // B2 never sees the old messages
  await coolDown();
  const b2final = await text(B2);
  run.check('B2 still cannot read the version-1 messages, but has the new ones', !b2final.includes('سلام از B') && b2final.includes('پیام جدید از B2') && b2final.includes('جواب از A') === false);
  await B2.screenshot({ path: run.shots + '/B2-final.png' });
  await A.screenshot({ path: run.shots + '/A-final.png' });
} catch (e) { console.log('ERROR', e); run.fail(); }
finally { await browser.close(); }
run.done();
