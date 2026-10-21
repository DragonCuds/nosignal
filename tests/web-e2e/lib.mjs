// Shared helpers for the headless browser e2e tests in this folder (real server, puppeteer-core + system chromium).
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

export const PASS = 'pass-word-1234';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tag = () => Math.random().toString(36).slice(2, 7);

export const makeRun = (name) => {
  let failures = 0;
  const shots = `${process.env.SHOTS_DIR ?? '/root/tel-dev/shots'}/${name}`;
  mkdirSync(shots, { recursive: true });
  return {
    shots,
    check(label, ok, extra = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!ok) failures++; },
    get failures() { return failures; },
    fail() { failures++; },
    done() { console.log(failures ? `FAILURES: ${failures}` : 'ALL PASSED'); process.exit(failures ? 1 : 0); },
  };
};

export const launch = (extraArgs = []) => puppeteer.launch({
  executablePath: '/snap/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
});
export const text = (page) => page.evaluate(() => document.body.innerText);
export const waitFor = async (page, needle, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await text(page)).includes(needle)) return true; await sleep(300); } return false; };
export const clickText = async (page, selector, label) => {
  const ok = await page.evaluate((sel, lab) => { const el = [...document.querySelectorAll(sel)].find((n) => n.textContent?.includes(lab) && n.offsetParent !== null); if (el) { el.click(); return true; } return false; }, selector, label);
  if (!ok) throw new Error(`no ${selector} with "${label}"`);
};
export const fresh = async (browser, who, width = 1100, height = 900) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message));
  // The emoji picker would fetch hundreds of PNGs and trip the server's per-IP request limit (300/min); tests do not need them.
  await page.setRequestInterception(true);
  page.on('request', (r) => { if (/\/emoji\/.*\.png/.test(r.url())) void r.abort(); else void r.continue(); });
  return page;
};
export const goto = (page, base) => page.goto(base, { waitUntil: 'networkidle2' });
export const login = async (page, name, password = PASS) => {
  await page.waitForSelector('input[name=username]');
  await page.type('input[name=username]', name);
  await page.type('input[name=password]', password);
  await page.keyboard.press('Enter');
};
export const signup = async (page, name) => {
  await page.waitForSelector('.login__tabs');
  await clickText(page, '.login__tabs button', 'ثبت‌نام');
  await page.waitForSelector('input[name=username]');
  await page.type('input[name=username]', name);
  await page.type('input[name=password]', PASS);
  await page.type('input[name=password-repeat]', PASS);
  await clickText(page, 'button[type=submit]', 'ساخت حساب');
  await page.waitForSelector('.sidebar', { timeout: 30000 });
  await sleep(2000);
};
export const apiJson = (page, path, method = 'GET', body) => page.evaluate(async (p, m, b) => {
  const r = await fetch(p, { method: m, credentials: 'include', headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, path, method, body);
export const openChatRow = async (page, label) => {
  await page.waitForFunction((l) => [...document.querySelectorAll('.chat-row')].some((n) => n.textContent?.includes(l)), { timeout: 20000 }, label);
  await clickText(page, '.chat-row', label);
  await sleep(1200);
};
export const startChatWith = async (page, name) => {
  await page.type('input[aria-label="جستجوی آیدی"]', name); await sleep(1500);
  await clickText(page, '.idsearch__result', name); await sleep(2500);
};
export const send = async (page, msg) => { await page.waitForSelector('textarea', { timeout: 10000 }); await page.type('textarea', msg); await page.keyboard.press('Enter'); await sleep(1500); };
// The server rate-limits every request per IP (300/min, emoji PNGs included); the emoji picker burns most of it, so wait a window before reloads.
export const coolDown = () => sleep(500);
