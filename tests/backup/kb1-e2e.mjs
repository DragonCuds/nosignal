// kb-1 end-to-end: real server (https://127.0.0.1:3068, NODE_ENV=production TLS_MODE=auto OPEN_REGISTRATION=1), headless chromium.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'https://127.0.0.1:3068';
const SHOTS = '/root/tel-dev/shots/kb1';
mkdirSync(SHOTS, { recursive: true });
const tag = Math.random().toString(36).slice(2, 7);
const NAME = { A: `ka${tag}`, B: `kb${tag}` };
const PASS = 'pass-word-1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'] });
const text = (page) => page.evaluate(() => document.body.innerText);
const waitFor = async (page, needle, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await text(page)).includes(needle)) return true; await sleep(300); } return false; };
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const clickText = async (page, selector, label) => {
  const ok = await page.evaluate((sel, lab) => { const el = [...document.querySelectorAll(sel)].find((n) => n.textContent?.includes(lab) && n.offsetParent !== null); if (el) { el.click(); return true; } return false; }, selector, label);
  if (!ok) throw new Error(`no ${selector} with "${label}"`);
};
const fresh = async (who) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message));
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  return page;
};
const login = async (page, who, password = PASS) => {
  await page.waitForSelector('input[name=username]');
  await page.type('input[name=username]', NAME[who]);
  await page.type('input[name=password]', password);
  await page.keyboard.press('Enter');
};
const signup = async (page, who) => {
  await page.waitForSelector('.login__tabs');
  await clickText(page, '.login__tabs button', 'ثبت‌نام');
  await page.waitForSelector('input[name=username]');
  await page.type('input[name=username]', NAME[who]);
  await page.type('input[name=password]', PASS);
  await page.type('input[name=password-repeat]', PASS);
  await clickText(page, 'button[type=submit]', 'ساخت حساب');
  await page.waitForSelector('.sidebar', { timeout: 30000 });
};
const apiGet = (page, path) => page.evaluate(async (p) => { const r = await fetch(p, { credentials: 'include' }); return { status: r.status, body: await r.json().catch(() => null) }; }, path);
const openChatRow = async (page, label) => { await page.waitForFunction((l) => [...document.querySelectorAll('.chat-row')].some((n) => n.textContent?.includes(l)), { timeout: 20000 }, label); await clickText(page, '.chat-row', label); };
const send = async (page, msg) => { await page.waitForSelector('textarea', { timeout: 10000 }); await page.type('textarea', msg); await page.keyboard.press('Enter'); await sleep(1500); };

try {
  // 1. A and B sign up through the UI (A's key is made at signup and its backup uploaded in Auto mode)
  const A = await fresh('A'); await signup(A, 'A'); await sleep(2500);
  const B = await fresh('B'); await signup(B, 'B'); await sleep(2500);
  const copy = await apiGet(A, '/api/crypto/backup');
  check('A has an auto backup on the server right after signup', copy.status === 200 && copy.body.mode === 'auto' && Boolean(copy.body.backup?.wrapped), JSON.stringify({ status: copy.status, mode: copy.body?.mode, iter: copy.body?.backup?.iterations }));
  check('server blob does not contain a plaintext key', !JSON.stringify(copy.body).includes('"d"') && !JSON.stringify(copy.body).includes('kty'));

  // 2. A opens a chat with B through ID search and they exchange messages
  await A.type('input[aria-label="جستجوی آیدی"]', NAME.B); await sleep(1500);
  await clickText(A, '.idsearch__result', NAME.B); await sleep(2500);
  await send(A, 'سلام از A');
  await sleep(1500);
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar');
  await openChatRow(B, NAME.A); await sleep(2000);
  check('B reads A message', await waitFor(B, 'سلام از A'));
  await send(B, 'جواب از B');
  check('A sees B reply', await waitFor(A, 'جواب از B'));
  await shot(A, '01-A-chat');

  // 3. Fresh browser for A: wrong password refused, then right password -> old messages readable with no extra step
  const A2 = await fresh('A2');
  await login(A2, 'A', 'wrong-password-1');
  check('wrong password cannot log in', await waitFor(A2, 'نام کاربری یا رمز عبور درست نیست.'));
  await A2.evaluate(() => { document.querySelector('input[name=password]').value = ''; });
  await A2.click('input[name=password]', { clickCount: 3 }); await A2.keyboard.press('Backspace');
  await A2.type('input[name=password]', PASS); await A2.keyboard.press('Enter');
  await A2.waitForSelector('.sidebar', { timeout: 30000 });
  check('no recovery gate after password login on a new browser', !(await text(A2)).includes('کلید رمزنگاری این دستگاه پیدا نشد'));
  await openChatRow(A2, NAME.B); await sleep(2500);
  const t2 = await text(A2);
  check('A (new browser) reads old messages automatically', t2.includes('سلام از A') && t2.includes('جواب از B') && !t2.includes('قابل رمزگشایی نیست'));
  await shot(A2, '02-A2-restored');

  // 4. Settings -> Power mode
  await A2.click('button[aria-label="منو"]'); await sleep(500);
  await clickText(A2, '.drawer__panel button', 'تنظیمات'); await sleep(1200);
  await clickText(A2, 'dialog[open] button', 'روشن کردن حالت امنیت بیشتر'); await sleep(800);
  const recoveryKey = await A2.evaluate(() => document.querySelector('dialog[open] textarea[aria-label="کلید بازیابی"]')?.value ?? '');
  check('recovery key text is shown', recoveryKey.startsWith('TELKEY1-'), `${recoveryKey.length} chars`);
  await A2.evaluate(() => document.querySelector('dialog[open] .backup-check input').click());
  await shot(A2, '03-power-confirm');
  await clickText(A2, 'dialog[open] button', 'پاک کردن نسخهٔ سرور'); await sleep(1500);
  const after = await apiGet(A2, '/api/crypto/backup');
  check('server copy is gone and mode is manual', after.status === 200 && after.body.mode === 'manual' && after.body.backup === null, JSON.stringify(after.body));

  // 5. Fresh browser: password login -> friendly screen -> recovery key restores
  const A3 = await fresh('A3');
  await login(A3, 'A');
  check('3-choice screen shown (no dead end)', await waitFor(A3, 'کلید رمزنگاری این دستگاه پیدا نشد'));
  const screen = await text(A3);
  check('screen offers recovery key/file and fresh start', screen.includes('کلید بازیابی') && screen.includes('شروع تازه') && screen.includes('خروج'));
  await shot(A3, '04-A3-choices');
  await A3.type('textarea.recovery-text', recoveryKey);
  await clickText(A3, 'button[type=submit]', 'بازیابی کلید');
  await A3.waitForSelector('.sidebar', { timeout: 30000 });
  await openChatRow(A3, NAME.B); await sleep(2500);
  const t3 = await text(A3);
  check('recovery key restores old messages', t3.includes('سلام از A') && t3.includes('جواب از B') && !t3.includes('قابل رمزگشایی نیست'));
  const stillManual = await apiGet(A3, '/api/crypto/backup');
  check('Power mode stays on after login (no silent re-upload)', stillManual.body?.mode === 'manual' && stillManual.body?.backup === null);

  // 6. Fresh browser: «شروع تازه»
  const A4 = await fresh('A4');
  await login(A4, 'A');
  check('choices screen again on another new browser', await waitFor(A4, 'کلید رمزنگاری این دستگاه پیدا نشد'));
  const forms = await A4.$$('form.group');
  const freshForm = forms[forms.length - 1];
  await (await freshForm.$('input[type=password]')).type(PASS);
  await (await freshForm.$('input[type=checkbox]')).click();
  await (await freshForm.$('button[type=submit]')).click();
  await A4.waitForSelector('.sidebar', { timeout: 30000 });
  await sleep(2500);
  check('fresh start lands in the app', !(await text(A4)).includes('کلید رمزنگاری این دستگاه پیدا نشد'));
  await A4.click('button[aria-label="منو"]'); await sleep(500);
  const menu = await text(A4);
  check('app is usable after fresh start (menu opens)', menu.includes('تنظیمات'));
  await A4.keyboard.press('Escape');
  const idNow = await apiGet(A4, '/api/me');
  check('session still valid', idNow.status === 200);
  await shot(A4, '05-A4-fresh');
  // new identity can chat in a NEW conversation (saved messages)
  await A4.reload({ waitUntil: 'networkidle2' }); await A4.waitForSelector('.sidebar');
  await openChatRow(A4, 'پیام‌های ذخیره‌شده'); await sleep(2500);
  await send(A4, 'یادداشت تازه');
  check('saved messages work with the new identity', await waitFor(A4, 'یادداشت تازه', 8000));
  const afterFresh = await apiGet(A4, '/api/crypto/backup');
  check('mode stays manual after fresh start', afterFresh.body?.mode === 'manual');

  // 7. Auto mode: sign up C-like second user's fresh start does auto upload (B: fresh browser login keeps working)
  const B2 = await fresh('B2'); await login(B2, 'B'); await B2.waitForSelector('.sidebar', { timeout: 30000 });
  check('B (Auto) logs in on a new browser without any gate', !(await text(B2)).includes('کلید رمزنگاری این دستگاه پیدا نشد'));
} catch (error) {
  console.log('ERROR', error.message); failures++;
}
await browser.close();
console.log(failures ? `FAILED: ${failures}` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
