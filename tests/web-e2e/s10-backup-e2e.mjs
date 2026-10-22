// S10c end to end (real server + headless chromium, see lib.mjs). Needs a server like keychange-e2e.mjs. Uses 2 signups.
// The Settings backup section after the S10c change: switching to Power mode (with the account password), the recovery key and the
// passphrase file are offered, the downloaded file restores the identity in a new browser and the old messages open.
// Normal accounts see no "did not fit" notice.
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, makeRun, fresh, goto, signup, login, startChatWith, openChatRow, clickText, text, waitFor, send, sleep, tag, apiJson, PASS } from './lib.mjs';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3105';
const run = makeRun('s10-backup');
const t = tag(); const NA = `ba${t}`; const NB = `bb${t}`;
// snap Chromium cannot write into /tmp: DOWNLOAD_DIR must be a normal directory (e.g. under /root).
const downloads = mkdtempSync(path.join(process.env.DOWNLOAD_DIR ?? run.shots, 'dl-'));
const FILE_PASS = 'file-pass-phrase-77';
const browser = await launch();
const typeInLabel = async (page, label, value) => {
  const handle = await page.evaluateHandle((l) => [...document.querySelectorAll('dialog[open] label')].find((n) => n.textContent?.includes(l) && n.offsetParent !== null)?.querySelector('input'), label);
  const input = handle.asElement();
  if (!input) throw new Error(`no input labelled ${label}`);
  await input.type(value);
};
try {
  const A = await fresh(browser, 'A'); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B'); await goto(B, BASE); await signup(B, NB);
  await startChatWith(A, NB); await send(A, 'سلام از A');
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar'); await openChatRow(B, NA);
  await send(B, 'جواب از B');
  run.check('A reads B', await waitFor(A, 'جواب از B'));

  await A.click('button[aria-label="منو"]'); await sleep(500);
  await clickText(A, '.drawer__panel button', 'تنظیمات'); await sleep(2000);
  run.check('no "did not fit" notice for a normal account', !(await text(A)).includes('جا نشد'));
  await clickText(A, 'dialog[open] button', 'روشن کردن حالت امنیت بیشتر'); await sleep(800);
  const key = await A.evaluate(() => document.querySelector('dialog[open] textarea[aria-label="کلید بازیابی"]')?.value ?? '');
  run.check('recovery key shown before switching', key.startsWith('TELKEY1-'), `${key.length} chars`);
  await A.evaluate(() => document.querySelector('dialog[open] .backup-check input').click());
  await typeInLabel(A, 'رمز عبور حساب', PASS);
  await clickText(A, 'dialog[open] button', 'پاک کردن نسخهٔ سرور و روشن کردن'); await sleep(2500);
  const state = await apiJson(A, '/api/crypto/backup');
  run.check('server copy is gone and mode is manual', state.status === 200 && state.body.mode === 'manual' && state.body.backup === null, JSON.stringify(state.body).slice(0, 120));
  run.check('Power mode view shows the recovery key again', (await A.evaluate(() => document.querySelector('dialog[open] textarea[aria-label="کلید بازیابی"]')?.value ?? '')) === key);
  // Capture the file the app hands to the browser (headless Chromium in a separate context does not save downloads reliably).
  await A.evaluate(() => {
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__saved = { name: this.download, text: fetch(this.href).then((r) => r.text()) }; return undefined; }
      return original.call(this);
    };
  });
  await typeInLabel(A, 'رمز فایل', FILE_PASS);
  await clickText(A, 'dialog[open] button', 'دریافت فایل'); await sleep(2000);
  const saved = await A.evaluate(async () => (window.__saved ? { name: window.__saved.name, text: await window.__saved.text } : null));
  run.check('the app produced the backup file and said so', Boolean(saved?.name.endsWith('.telkey') && saved.text.length > 100) && (await text(A)).includes('فایل پشتیبان ذخیره شد'), saved?.name ?? 'none');
  const filePath = path.join(downloads, saved?.name ?? 'missing.telkey');
  writeFileSync(filePath, saved?.text ?? '');
  const files = [path.basename(filePath)];
  await A.screenshot({ path: run.shots + '/A-power-mode.png' });

  const A2 = await fresh(browser, 'A2'); await goto(A2, BASE); await login(A2, NA);
  run.check('new browser: recovery screen', await waitFor(A2, 'کلید رمزنگاری این دستگاه پیدا نشد', 30000));
  const [fileInput] = await A2.$$('input[type=file]');
  await fileInput.uploadFile(path.join(downloads, files[0]));
  const passInput = await A2.evaluateHandle(() => [...document.querySelectorAll('label')].find((n) => n.textContent?.trim().startsWith('رمز فایل'))?.querySelector('input'));
  await passInput.asElement().type(FILE_PASS);
  await clickText(A2, 'button[type=submit]', 'بازیابی کلید');
  await A2.waitForSelector('.sidebar', { timeout: 30000 }); await sleep(1500);
  await openChatRow(A2, NB); await sleep(2500);
  const restored = await text(A2);
  run.check('the file restores the identity and the old messages open', restored.includes('سلام از A') && restored.includes('جواب از B') && !restored.includes('قابل رمزگشایی نیست'));
  await send(A2, 'بعد از بازیابی');
  run.check('B reads what the restored browser sends', await waitFor(B, 'بعد از بازیابی', 15000));
  run.check('mode stays manual', (await apiJson(A2, '/api/crypto/backup')).body?.mode === 'manual');
} catch (e) { console.log('ERROR', e); run.fail(); }
finally { await browser.close(); }
run.done();
