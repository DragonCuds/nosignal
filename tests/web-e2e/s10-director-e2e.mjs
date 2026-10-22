// S10 end to end (real server + headless chromium, see lib.mjs). Needs a server like keychange-e2e.mjs
// (BASE=https://127.0.0.1:<port>, NODE_ENV=production TLS_MODE=auto OPEN_REGISTRATION=1). Uses 5 signups (the per-IP cap).
//  R6: sending a sticker from the UI shares its pack into the chat (the other side can open the pack), and not before.
//  R4: in a group, a member whose pinned contact started fresh cannot send behind the warning, even after an admin already
//      rotated; the send shows the key-change notice, accepting it unlocks sending (no lockout), also after a reload.
import { readFileSync } from 'node:fs';
import { launch, makeRun, fresh, goto, signup, login, startChatWith, openChatRow, clickText, text, waitFor, send, sleep, tag, apiJson, PASS } from './lib.mjs';
const BASE = process.env.BASE ?? 'https://127.0.0.1:3105';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const run = makeRun('s10-director');
const t = tag();
const browser = await launch();
const resetIdentity = async (page) => {
  const rev = (await apiJson(page, '/api/crypto/backup')).body.revision;
  const grant = await apiJson(page, '/api/crypto/action-grant', 'POST', { action: 'identity.reset', expectedRevision: rev, password: PASS });
  return (await apiJson(page, '/api/crypto/identity/reset', 'POST', { expectedRevision: rev, actionToken: grant.body?.token })).status;
};
try {
  // ---- R6: sticker pack grant after a successful send ----
  const NA = `sa${t}`; const NB = `sb${t}`;
  const A = await fresh(browser, 'A'); await goto(A, BASE); await signup(A, NA);
  const B = await fresh(browser, 'B'); await goto(B, BASE); await signup(B, NB);
  const imported = await A.evaluate(async (zipB64) => {
    const bin = Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0));
    const fd = new FormData(); fd.append('file', new File([bin], 'pack.zip', { type: 'application/zip' }));
    const r = await fetch('/api/media/packs/import', { method: 'POST', body: fd, credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, readFileSync(FX + 'tgs-pack.zip').toString('base64'));
  run.check('pack imported', imported.status === 201, String(imported.status));
  const packId = imported.body?.id;
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForSelector('.sidebar');
  await startChatWith(A, NB);
  await send(A, 'سلام');
  const chatId = (await apiJson(A, '/api/chats')).body.find((chat) => chat.type === 'direct')?.id;
  const shared = () => apiJson(B, `/api/chats/${chatId}/sticker-packs/${packId}`);
  run.check('before any sticker: B cannot open the pack', (await shared()).status === 404, String((await shared()).status));
  await A.click('button[aria-label^="شکلک، استیکر"]'); await sleep(500);
  await A.click('button[role=tab][aria-label="استیکر"]'); await sleep(1500);
  await A.click('.sticker-grid button'); await sleep(4000);
  const after = await shared();
  run.check('after the sticker was sent from the UI: B can open the pack (grant made)', after.status === 200, String(after.status));
  await B.reload({ waitUntil: 'networkidle2' }); await B.waitForSelector('.sidebar'); await openChatRow(B, NA);
  const bSees = await B.evaluate(() => document.querySelectorAll('tg-sticker.msg__sticker, .msg__sticker').length);
  run.check('B sees the sticker', bSees >= 1, String(bSees));
  await A.close(); await B.close();

  // ---- R4: group warning blocks the send even after the admin rotated; accepting unlocks it ----
  const NL = `gl${t}`; const NM = `gm${t}`; const NN = `gn${t}`;
  const L = await fresh(browser, 'L'); await goto(L, BASE); await signup(L, NL);
  const M = await fresh(browser, 'M'); await goto(M, BASE); await signup(M, NM);
  const N = await fresh(browser, 'N'); await goto(N, BASE); await signup(N, NN);
  // M pins N through a direct chat
  await startChatWith(N, NM); await send(N, 'سلام از N');
  await M.reload({ waitUntil: 'networkidle2' }); await M.waitForSelector('.sidebar'); await openChatRow(M, NN);
  run.check('M reads N (M pins N)', await waitFor(M, 'سلام از N'));
  // L makes the group with M and N
  await L.click('button[aria-label="منو"]');
  await clickText(L, '.drawer__panel button', 'گروه جدید');
  await L.type('input[aria-label="نام گروه"]', 'گروه اس‌ده');
  for (const name of [NM, NN]) { await L.type('.group-form input[type=search]', name); await sleep(1200); await clickText(L, '.group-form .idsearch__result', name); await L.$eval('.group-form input[type=search]', (el) => { el.value = ''; }); }
  await clickText(L, '.group-form button[type=submit]', 'ساخت گروه');
  run.check('group opened', await waitFor(L, 'گروه اس‌ده'));
  const groupId = (await apiJson(L, '/api/chats')).body.find((chat) => chat.title === 'گروه اس‌ده')?.groupId;
  await sleep(2000);
  run.check('group key v1 uploaded', (await apiJson(L, `/api/groups/${groupId}`)).body.keyVersion === 1);
  await M.reload({ waitUntil: 'networkidle2' }); await M.waitForSelector('.sidebar'); await openChatRow(M, 'گروه اس‌ده');
  await send(M, 'پیام اول M');
  run.check('L reads M (v1)', await waitFor(L, 'پیام اول M'));
  // M's group tab stays open. N starts fresh; L (admin) accepts and rotates
  run.check('N reset its identity', (await resetIdentity(N)) === 204);
  const N2 = await fresh(browser, 'N2'); await goto(N2, BASE); await login(N2, NN);
  await N2.waitForSelector('.sidebar', { timeout: 30000 }); await sleep(2500);
  await L.reload({ waitUntil: 'networkidle2' }); await L.waitForSelector('.sidebar'); await openChatRow(L, 'گروه اس‌ده');
  run.check('L sees the key-change notice', await waitFor(L, 'تأیید کلید جدید', 20000));
  await clickText(L, '.keychange button', 'تأیید کلید جدید');
  let rotated = false;
  for (let i = 0; i < 30 && !rotated; i += 1) { await sleep(1000); const d = (await apiJson(L, `/api/groups/${groupId}`)).body; rotated = d.keyVersion === 2 && d.pendingKeyVersion == null; }
  run.check('L rotated to v2 after accepting', rotated);
  await sleep(12000); // M's open tab polls the group (10 s) and picks up v2
  // M tries to send behind the (not yet shown) warning
  await M.waitForSelector('textarea', { timeout: 10000 });
  await M.type('textarea', 'پشت هشدار'); await M.keyboard.press('Enter'); await sleep(3000);
  run.check('the message was NOT sent behind the warning', !(await waitFor(L, 'پشت هشدار', 5000)));
  run.check('M sees the key-change notice right away', await waitFor(M, 'تأیید کلید جدید', 10000));
  await M.screenshot({ path: run.shots + '/M-group-warning.png' });
  await clickText(M, '.keychange button', 'تأیید کلید جدید'); await sleep(2500);
  await send(M, 'بعد از تأیید M');
  run.check('after accepting, M sends (no lockout) and L reads it', await waitFor(L, 'بعد از تأیید M', 15000));
  await openChatRow(N2, 'گروه اس‌ده');
  run.check('N with the new identity reads it', await waitFor(N2, 'بعد از تأیید M', 15000));
  await M.reload({ waitUntil: 'networkidle2' }); await M.waitForSelector('.sidebar'); await openChatRow(M, 'گروه اس‌ده');
  await send(M, 'بعد از بارگذاری M');
  run.check('M still sends after a reload', await waitFor(L, 'بعد از بارگذاری M', 15000));
  const mText = await text(M);
  run.check('M still reads its history, nothing undecryptable', mText.includes('پیام اول M') && !mText.includes('قابل رمزگشایی نیست'));
  // the direct chat M-N: the accept in the group moved it on too; a new message reaches N's new identity
  await openChatRow(M, NN);
  const dmBanner = (await M.$('.keychange')) !== null;
  run.check('direct chat with N: no second warning (the pin was accepted in the group)', !dmBanner);
  await send(M, 'دایرکت بعد از تأیید');
  await openChatRow(N2, NM);
  run.check('N\'s new identity reads the direct message', await waitFor(N2, 'دایرکت بعد از تأیید', 15000));
} catch (e) { console.log('ERROR', e); run.fail(); }
finally { await browser.close(); }
run.done();
