// Run twice, restarting the server in between (the signup limiter allows 5 signups per IP per 15 min):
//   node fix3-e2e.mjs        (scenarios 1-3)      PART=warn node fix3-e2e.mjs   (scenario 4)
// fix-3 end-to-end: real server (BASE, default https://127.0.0.1:3095, OPEN_REGISTRATION=1, TLS_MODE=auto), headless chromium.
// Proves the key backup is on the server the moment the identity key exists, so killing the browser right after signup
// (UI) or right after the first UI login of an API-registered user loses nothing.
import puppeteer from 'puppeteer-core';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3095';
const SHOTS = process.env.SHOTS ?? '/root/os-fix3/shots';
mkdirSync(SHOTS, { recursive: true });
const tag = Math.random().toString(36).slice(2, 7);
const NAME = { A: `fa${tag}`, B: `fb${tag}`, C: `fc${tag}`, D: `fd${tag}` };
const PASS = 'pass-word-1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'] });
const text = (page) => page.evaluate(() => document.body.innerText);
const waitFor = async (page, needle, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await text(page)).includes(needle)) return true; await sleep(300); } return false; };
const clickText = async (page, selector, label) => {
  const ok = await page.evaluate((sel, lab) => { const el = [...document.querySelectorAll(sel)].find((n) => n.textContent?.includes(lab) && n.offsetParent !== null); if (el) { el.click(); return true; } return false; }, selector, label);
  if (!ok) throw new Error(`no ${selector} with "${label}"`);
};
const newCtx = async (who) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message));
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  return { ctx, page };
};
const login = async (page, who) => {
  await page.waitForSelector('input[name=username]', { timeout: 20000 }).catch(async (e) => { console.log('login page text:', (await text(page)).slice(0, 200)); throw e; });
  await page.type('input[name=username]', NAME[who]);
  await page.type('input[name=password]', PASS);
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
const send = async (page, msg) => { await page.waitForSelector('textarea', { timeout: 10000 }); await page.type('textarea', msg); await page.keyboard.press('Enter'); await sleep(1200); };
const startChat = async (page, peer) => {
  await page.type('input[aria-label="جستجوی آیدی"]', NAME[peer]); await sleep(1500);
  await clickText(page, '.idsearch__result', NAME[peer]); await sleep(2000);
};
const apiRegister = async (who) => {
  const r = await fetch(`${BASE}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ username: NAME[who], password: PASS, displayName: NAME[who] }) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] };
};

const PART = process.env.PART ?? 'main';
try {
  if (PART === 'main') {
  // ---- Scenario 1: UI signup in A, send, kill at once; B (fresh) logs in with the password -------------------
  const peer = await newCtx('D'); await signup(peer.page, 'D');
  const a = await newCtx('A'); await signup(a.page, 'A');
  const backupRightAfterSignup = await apiGet(a.page, '/api/crypto/backup'); // no waiting at all after the app opened
  check('S1 server holds an auto backup the moment the app opens after UI signup', backupRightAfterSignup.status === 200 && backupRightAfterSignup.body.mode === 'auto' && Boolean(backupRightAfterSignup.body.backup?.wrapped));
  await startChat(a.page, 'D');
  await send(a.page, 'پیام اول از A');
  await a.ctx.close(); // killed with no waiting
  const a2 = await newCtx('A2'); await login(a2.page, 'A');
  await a2.page.waitForSelector('.sidebar', { timeout: 30000 });
  check('S1 fresh browser: no «key not found» screen', !(await text(a2.page)).includes('کلید رمزنگاری این دستگاه پیدا نشد'));
  await openChatRow(a2.page, NAME.D); await sleep(2500);
  const t1 = await text(a2.page);
  check('S1 old message sent by A decrypts in fresh browser', t1.includes('پیام اول از A') && !t1.includes('قابل رمزگشایی نیست'));
  await a2.ctx.close();

  // ---- Scenario 1b: UI signup then killed with ZERO wait (nothing sent) -----------------------------------
  const z = await newCtx('Z'); await signup(z.page, 'B');
  await z.ctx.close();
  const z2 = await newCtx('Z2'); await login(z2.page, 'B');
  const ok1b = await z2.page.waitForSelector('.sidebar', { timeout: 30000 }).then(() => true).catch(() => false);
  check('S1b zero-wait kill after signup: password login in fresh browser opens the app', ok1b && !(await text(z2.page)).includes('کلید رمزنگاری این دستگاه پیدا نشد'));
  await z2.ctx.close();

  // ---- Scenario 2: registered via raw API (no key ever), first UI login in A, send, kill; login in B ------
  const reg = await apiRegister('C');
  check('S2 API register ok', reg.status === 204 || reg.status === 200 || reg.status === 201, String(reg.status));
  const c1 = await newCtx('C1'); await login(c1.page, 'C');
  await c1.page.waitForSelector('.sidebar', { timeout: 30000 });
  const copy = await apiGet(c1.page, '/api/crypto/backup'); // immediately after the app opens
  check('S2 first UI login of an API user stores the backup at once', copy.status === 200 && copy.body.mode === 'auto' && Boolean(copy.body.backup?.wrapped), JSON.stringify({ s: copy.status, m: copy.body?.mode }));
  await startChat(c1.page, 'D');
  await send(c1.page, 'پیام از کاربر API');
  await c1.ctx.close();
  const c2 = await newCtx('C2'); await login(c2.page, 'C');
  await c2.page.waitForSelector('.sidebar', { timeout: 30000 });
  check('S2 fresh browser: no «key not found» screen', !(await text(c2.page)).includes('کلید رمزنگاری این دستگاه پیدا نشد'));
  await openChatRow(c2.page, NAME.D); await sleep(2500);
  const t2 = await text(c2.page);
  check('S2 old message decrypts in fresh browser', t2.includes('پیام از کاربر API') && !t2.includes('قابل رمزگشایی نیست'));
  await c2.ctx.close();

  // ---- Scenario 3: identity on the server but NO backup and no local key (old data-loss state) -> clear way out
  NAME.E = `fe${tag}`;
  const e = await fetch(`${BASE}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ username: NAME.E, password: PASS, displayName: NAME.E }) });
  const cookie = e.headers.get('set-cookie')?.split(';')[0];
  const userId = (await (await fetch(`${BASE}/api/me`, { headers: { origin: BASE, cookie } })).json()).id;
  const { publicKey } = await (async () => { const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']); const j = await crypto.subtle.exportKey('jwk', kp.publicKey); return { publicKey: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } }; })();
  const put = await fetch(`${BASE}/api/crypto/identity`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ expectedUserId: userId, publicKey }) });
  check('S3 setup: identity registered without backup', put.status === 200);
  const e1 = await newCtx('E1'); await login(e1.page, 'E');
  check('S3 recovery screen explains there is no server copy and offers a fresh start', await waitFor(e1.page, 'هیچ نسخهٔ پشتیبانی از کلید این حساب روی سرور نیست.') && (await text(e1.page)).includes('شروع تازه'));
  await e1.page.screenshot({ path: `${SHOTS}/s3-recovery.png` });
  const forms = await e1.page.$$('form.group');
  const freshForm = forms[forms.length - 1];
  await (await freshForm.$('input[type=password]')).type(PASS);
  await (await freshForm.$('input[type=checkbox]')).click();
  await (await freshForm.$('button[type=submit]')).click();
  await e1.page.waitForSelector('.sidebar', { timeout: 30000 });
  await sleep(1500);
  const afterFresh = await apiGet(e1.page, '/api/crypto/backup');
  check('S3 start-fresh lands in the app and uploads a new backup', afterFresh.status === 200 && Boolean(afterFresh.body?.backup?.wrapped));
  await e1.ctx.close();
  const e2 = await newCtx('E2'); await login(e2.page, 'E');
  await e2.page.waitForSelector('.sidebar', { timeout: 30000 });
  check('S3 after fresh start a new browser restores automatically', !(await text(e2.page)).includes('کلید رمزنگاری این دستگاه پیدا نشد'));
  await e2.ctx.close();

  }
  if (PART === 'warn') {
  // ---- Scenario 4: backup upload fails -> visible warning, then retry succeeds ---------------------------------
  NAME.F = `ff${tag}`;
  const f = await newCtx('F');
  await f.page.setRequestInterception(true);
  let blockBackup = true;
  f.page.on('request', (req) => {
    if (blockBackup && req.method() === 'PUT' && req.url().endsWith('/api/crypto/backup')) { void req.abort('failed'); return; }
    if (blockBackup && req.method() === 'PUT' && req.url().endsWith('/api/crypto/identity')) { // strip the atomic backup so only the (blocked) separate upload could save it
      const body = JSON.parse(req.postData() ?? '{}'); delete body.backup; void req.continue({ postData: JSON.stringify(body) }); return;
    }
    void req.continue();
  });
  await signup(f.page, 'F').catch(async (e) => { console.log('F signup text:', (await text(f.page)).slice(-250)); throw e; });
  check('S4 visible warning when the backup could not be saved', await waitFor(f.page, 'نسخهٔ پشتیبان کلید شما هنوز روی سرور ذخیره نشده است.', 15000));
  await f.page.screenshot({ path: `${SHOTS}/s4-warning.png` });
  blockBackup = false;
  const saved = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 30000) { const r = await apiGet(f.page, '/api/crypto/backup'); if (r.status === 200 && r.body.backup) return true; await sleep(1000); } return false; })();
  check('S4 background retry saves the backup once the network works', saved);
  await f.ctx.close();
  }
} catch (error) {
  console.log('ERROR', error.stack ?? error.message); failures++;
}
await browser.close();
console.log(failures ? `FAILED: ${failures}` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
