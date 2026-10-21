// A pinned group member changes identity while rotation is pending. No new key may be uploaded until A accepts it.
import { launch, makeRun, fresh, goto, signup, login, clickText, waitFor, sleep, tag, apiJson, PASS } from './lib.mjs';

const BASE = process.env.BASE ?? 'https://127.0.0.1:3067';
const run = makeRun('group-key-change');
const suffix = tag();
const nameA = `gka${suffix}`;
const nameB = `gkb${suffix}`;
const browser = await launch();

try {
  const A = await fresh(browser, 'group-A'); await goto(A, BASE); await signup(A, nameA);
  const B = await fresh(browser, 'group-B'); await goto(B, BASE); await signup(B, nameB);

  await A.click('button[aria-label="منو"]');
  await clickText(A, '.drawer__panel button', 'گروه جدید');
  await A.type('input[aria-label="نام گروه"]', 'گروه تغییر کلید');
  await A.type('.group-form input[type=search]', nameB);
  await sleep(1200);
  await clickText(A, '.group-form .idsearch__result', nameB);
  await clickText(A, '.group-form button[type=submit]', 'ساخت گروه');
  run.check('group opened', await waitFor(A, 'گروه تغییر کلید'));

  const chats = await apiJson(A, '/api/chats');
  const groupId = chats.body.find((chat) => chat.title === 'گروه تغییر کلید')?.groupId;
  if (!groupId) throw new Error('group ID unavailable');
  run.check('initial key uploaded', (await apiJson(A, `/api/groups/${groupId}`)).body.keyVersion === 1);

  const reset = await apiJson(B, '/api/crypto/identity/reset', 'POST', { password: PASS });
  run.check('B reset identity', reset.status === 204);
  const B2 = await fresh(browser, 'group-B2'); await goto(B2, BASE); await login(B2, nameB);
  await B2.waitForSelector('.sidebar', { timeout: 30000 });
  run.check('changed key is shown to A', await waitFor(A, 'تأیید کلید جدید', 25000));
  const blocked = (await apiJson(A, `/api/groups/${groupId}`)).body;
  run.check('background rotation blocked before acceptance', blocked.keyVersion === 1 && blocked.pendingKeyVersion === 2);
  run.check('composer blocked before acceptance', (await A.$('textarea')) === null);

  await clickText(A, '.keychange button', 'تأیید کلید جدید');
  let rotated = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const detail = (await apiJson(A, `/api/groups/${groupId}`)).body;
    if (detail.keyVersion === 2 && detail.pendingKeyVersion === null) { rotated = true; break; }
    await sleep(500);
  }
  run.check('rotation completes only after acceptance', rotated);
} catch (error) { console.log('ERROR', error); run.fail(); }
finally { await browser.close(); }
run.done();
