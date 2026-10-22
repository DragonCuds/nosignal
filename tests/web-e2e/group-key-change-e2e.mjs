// A pinned group member changes identity while rotation is pending. No new key may be uploaded until A accepts it.
// NS-07b: A wrapped version 1; after B starts fresh and A rotates, A still reads the version-1 history and the new messages,
// B's new browser reads only the new ones, and the server stores the wrapper's key with every envelope.
// Needs a server like keychange-e2e.mjs (BASE=https://127.0.0.1:<port>, NODE_ENV=production TLS_MODE=auto OPEN_REGISTRATION=1).
import { launch, makeRun, fresh, goto, signup, login, clickText, waitFor, send, openChatRow, text, sleep, tag, apiJson, PASS } from './lib.mjs';

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

  await send(A, 'قدیمی از A');                                   // sealed with version 1, which A wrapped
  const keys1 = (await apiJson(A, `/api/groups/${groupId}/keys?version=1`)).body;
  run.check('server stores the wrapper key with the envelope', keys1?.length === 1 && /^[0-9a-f]{64}$/.test(keys1[0].wrapperFingerprint ?? '') && keys1[0].wrapperPublicKey?.kty === 'EC');

  // B starts fresh: the real flow needs an action grant for the current backup revision
  const rev = (await apiJson(B, '/api/crypto/backup')).body?.revision ?? 0;
  const grant = await apiJson(B, '/api/crypto/action-grant', 'POST', { action: 'identity.reset', expectedRevision: rev, password: PASS });
  run.check('B got an action grant', grant.status === 200 && Boolean(grant.body?.token), String(grant.status));
  const reset = await apiJson(B, '/api/crypto/identity/reset', 'POST', { expectedRevision: rev, actionToken: grant.body?.token });
  run.check('B reset identity', reset.status === 204, String(reset.status));
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

  // NS-07b: history. A (who wrapped version 1) reads the old message and writes a new one; B2 reads only the new one.
  await send(A, 'جدید از A');
  let aAll = false;
  for (let attempt = 0; attempt < 20 && !aAll; attempt += 1) { const tx = await text(A); aAll = tx.includes('قدیمی از A') && tx.includes('جدید از A'); if (!aAll) await sleep(500); }
  run.check('A reads the old message and the new one', aAll);
  await openChatRow(B2, 'گروه تغییر کلید');
  run.check('B2 (started fresh) reads the new message', await waitFor(B2, 'جدید از A', 25000));
  const b2 = await text(B2);
  run.check('B2 does not read the message from before B started fresh', !b2.includes('قدیمی از A'));
  const keysB = (await apiJson(B2, `/api/groups/${groupId}/keys`)).body;
  run.check('B2 only has the new key version on the server', keysB?.length === 1 && keysB[0].version === 2);
  const keysA = (await apiJson(A, `/api/groups/${groupId}/keys`)).body;
  run.check('A keeps both versions, each with its wrapper key', keysA?.length === 2 && keysA.every((entry) => entry.wrapperFingerprint));
  await A.screenshot({ path: run.shots + '/A-final.png' });
  await B2.screenshot({ path: run.shots + '/B2-final.png' });
} catch (error) { console.log('ERROR', error); run.fail(); }
finally { await browser.close(); }
run.done();
