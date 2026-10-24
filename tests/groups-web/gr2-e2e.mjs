// gr-2 end-to-end: real server on https://127.0.0.1:3067, headless chromium.
import puppeteer from 'puppeteer-core';
import { makeRun } from '../web-e2e/lib.mjs';

const BASE = process.env.BASE ?? 'https://127.0.0.1:3067';
const SHOTS = makeRun('gr2').shots;
const tag = Math.random().toString(36).slice(2, 7);
const names = { A: `ga${tag}`, B: `gb${tag}`, C: `gc${tag}` };
const PASS = 'pass-word-1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'] });
const open = async (who) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message));
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  const status = await page.evaluate(async (u, p) => (await fetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p, displayName: `نام ${u.slice(0, 2)}` }) })).status, names[who], PASS);
  if (status !== 204) throw new Error(`register ${who} -> ${status}`);
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  await sleep(1500);
  return page;
};
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const text = (page) => page.evaluate(() => document.body.innerText);
const clickText = async (page, selector, label) => {
  const ok = await page.evaluate((sel, lab) => { const el = [...document.querySelectorAll(sel)].find((n) => n.textContent?.includes(lab) && n.offsetParent !== null); if (el) { el.click(); return true; } return false; }, selector, label);
  if (!ok) throw new Error(`no ${selector} with "${label}"`);
};
const send = async (page, msg) => {
  await page.waitForSelector('textarea', { timeout: 10000 });
  await page.type('textarea', msg);
  await page.keyboard.press('Enter');
  await sleep(1500);
};
const openGroupRow = async (page, title) => { await clickText(page, '.chat-row', title); await sleep(1500); };
const waitFor = async (page, needle, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await text(page)).includes(needle)) return true; await sleep(400); } return false; };

try {
  const A = await open('A'); const B = await open('B'); const C = await open('C');
  await shot(A, '01-A-home');

  // A creates the group with B
  await A.click('button[aria-label="منو"]'); await sleep(400);
  await clickText(A, '.drawer__panel button', 'گروه جدید'); await sleep(600);
  await A.type('input[aria-label="نام گروه"]', 'گروه تست');
  await A.type('.group-form input[type=search]', names.B); await sleep(1200);
  await shot(A, '02-A-create-search');
  await clickText(A, '.group-form .idsearch__result', names.B); await sleep(300);
  await shot(A, '03-A-create-chip');
  await clickText(A, '.group-form button[type=submit]', 'ساخت گروه'); await sleep(3000);
  await shot(A, '04-A-group-open');
  check('A sees the group header with 2 members', (await text(A)).includes('گروه تست') && (await text(A)).includes('۲ عضو'));
  await send(A, 'سلام از A');
  check('A sees own first post', (await text(A)).includes('سلام از A'));

  // B reads
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar'); await sleep(2000);
  await openGroupRow(B, 'گروه تست');
  const bRead = await waitFor(B, 'سلام از A');
  await shot(B, '05-B-reads');
  check('B reads A post', bRead);
  check('B sees sender name above incoming bubble', (await B.evaluate(() => document.querySelector('.group-sender')?.textContent ?? '')).includes('نام'));

  // A adds C via info sheet
  await A.click('.chat-header__identity--button'); await sleep(800);
  await A.type('.group-info input[type=search]', names.C); await sleep(1200);
  await shot(A, '06-A-info-add');
  await clickText(A, '.group-info .idsearch__result', names.C); await sleep(3000);
  await shot(A, '07-A-info-added');
  check('A info shows 3 members', (await text(A)).includes('۳ عضو'));
  await A.keyboard.press('Escape'); await sleep(500);
  await A.evaluate(() => document.querySelector('.sheet[open] .icon-button')?.click());
  await sleep(500);
  await send(A, 'پیام بعد از C');

  // C reads only new
  await C.reload({ waitUntil: 'networkidle2' }); await C.waitForSelector('.sidebar'); await sleep(2000);
  await openGroupRow(C, 'گروه تست');
  const cNew = await waitFor(C, 'پیام بعد از C');
  const cT = await text(C);
  await shot(C, '08-C-reads-new');
  check('C reads the new message', cNew);
  check('C cannot read the older message', !cT.includes('سلام از A'));
  await send(C, 'سلام از C');
  check('A reads C post', await waitFor(A, 'سلام از C'));
  check('B reads C post', await waitFor(B, 'سلام از C'));

  // A removes B
  await A.click('.chat-header__identity--button'); await sleep(800);
  A.once('dialog', (d) => d.accept());
  await A.evaluate((u) => { const rows = [...document.querySelectorAll('.group-info .channel-row')]; const row = rows.find((r) => r.textContent.includes(u)); row?.querySelector('button.icon-button')?.click(); }, names.B);
  await sleep(3500);
  await shot(A, '09-A-removed-B');
  check('A info now shows 2 members', (await text(A)).includes('۲ عضو'));
  await A.evaluate(() => document.querySelector('.sheet[open] .icon-button')?.click()); await sleep(500);
  await send(A, 'بعد از حذف B');
  check('C reads post after rotation', await waitFor(C, 'بعد از حذف B'));
  await shot(C, '10-C-after-rotation');

  // B cannot read new posts
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar'); await sleep(2500);
  const bT = await text(B);
  await shot(B, '11-B-after-removal');
  check('B no longer has the group / cannot read new posts', !bT.includes('بعد از حذف B'));
  check('B group row gone', !bT.includes('گروه تست'));
} catch (error) {
  console.log('ERROR', error);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `FAILURES: ${failures}` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
