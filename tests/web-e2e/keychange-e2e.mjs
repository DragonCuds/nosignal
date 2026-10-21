// Peer key change: B starts fresh (new identity); A must see the key-change notice, can accept explicitly, and the chat works again.
import { launch, makeRun, fresh, goto, signup, login, startChatWith, openChatRow, clickText, text, waitFor, send, sleep, tag, apiJson, PASS } from './lib.mjs';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3105';
const run = makeRun('keychange');
const t = tag(); const NA = `ka${t}`; const NB = `kb${t}`;
const browser = await launch();
try {
  const A = await fresh(browser, 'A', 360, 740); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B', 1000, 800); await goto(B, BASE); await signup(B, NB);
  await startChatWith(A, NB);
  await send(A, 'سلام از A');
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar'); await openChatRow(B, NA);
  run.check('B reads A', await waitFor(B, 'سلام از A'));
  await send(B, 'جواب از B');
  run.check('A reads B', await waitFor(A, 'جواب از B'));

  // B's identity is reset on the server, then B starts fresh in a new browser
  const reset = await apiJson(B, '/api/crypto/identity/reset', 'POST', { password: PASS });
  run.check('server accepted identity reset', reset.status === 204 || reset.status === 200, String(reset.status));
  const B2 = await fresh(browser, 'B2', 1000, 800); await goto(B2, BASE); await login(B2, NB);
  // the server forgot B's identity (what «شروع تازه» does): this browser has no key, so a new one is generated at login
  await B2.waitForSelector('.sidebar', { timeout: 30000 }); await sleep(2500);
  await openChatRow(B2, NA);
  await send(B2, 'پیام جدید از B');

  // A: reload so the old tab state is gone, open the chat
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForSelector('.sidebar'); await sleep(1500);
  await openChatRow(A, NB);
  const banner = await waitFor(A, 'تغییر کرد', 15000);
  run.check('A sees the key-change banner naming B', banner && (await text(A)).includes('کلید رمزنگاری') && (await text(A)).includes('تأیید کلید جدید') && (await text(A)).includes('ادامه ندادن'));
  const fps = await A.evaluate(() => [...document.querySelectorAll('.keychange code')].map((c) => c.textContent.replace(/\s/g, '')));
  run.check('old and new fingerprints are shown and differ', fps.length === 2 && fps[0].length === 64 && fps[1].length === 64 && fps[0] !== fps[1]);
  await A.screenshot({ path: run.shots + '/A-banner-360.png' });
  const blockedText = !(await text(A)).includes('پیام جدید از B');
  run.check('message under the new key is not shown before acceptance', blockedText);
  run.check('composer is blocked (no textarea)', (await A.$('textarea')) === null);
  // "ادامه ندادن" hides the banner but keeps everything blocked
  await clickText(A, '.keychange button', 'ادامه ندادن'); await sleep(500);
  run.check('dismiss hides banner, composer stays blocked', (await A.$('.keychange')) === null && (await A.$('textarea')) === null);
  // still not re-pinned after a reload
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForSelector('.sidebar'); await sleep(1500); await openChatRow(A, NB);
  run.check('banner returns after reload (nothing was re-pinned)', await waitFor(A, 'تأیید کلید جدید', 15000));
  await clickText(A, '.keychange button', 'تأیید کلید جدید');
  run.check('after accepting, the new message decrypts', await waitFor(A, 'پیام جدید از B', 15000));
  run.check('banner is gone', (await A.$('.keychange')) === null);
  await send(A, 'بعد از تایید');
  run.check('B2 reads A after acceptance', await waitFor(B2, 'بعد از تایید', 15000));
  await A.screenshot({ path: run.shots + '/A-accepted-360.png' });
} catch (e) { console.log('ERROR', e); run.fail(); }
finally { await browser.close(); }
run.done();
