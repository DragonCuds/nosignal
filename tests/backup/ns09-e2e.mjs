// Run after `npm run build`: TMPDIR=/root/nosignal-tmp node tests/backup/ns09-e2e.mjs
// (snap Chromium cannot use /tmp, so point TMPDIR at a normal directory.)
//
// A failed backup retry (or a request still in flight) of account A must never survive an account switch
// and write under account B's session. Fake accounts, throwaway server and data directory only.
//   a) A's backup PUT fails (5xx), user switches to B without reload, retry timer runs -> no A write under B
//   b) A's retry PUT is still in flight (response held) / not yet sent (request held) at logout -> no effect on B
//   c) `online` event after the switch does not restart A's retry (positive control: it does while A is active)
//   d) two tabs share one cookie jar: tab 1 still holds A's job while tab 2 logs in as B -> server refuses it
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '../..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (label, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(100); }
  throw new Error(`Timed out: ${label}`);
};
// Node-side HTTPS client that trusts only the throwaway server's own local CA (certificate validation stays on).
let serverCa = null;
const nodeFetch = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = https.request(url, { method, headers, ca: serverCa }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: { get: (name) => res.headers[name.toLowerCase()]?.toString() ?? null }, json: async () => JSON.parse(text) });
    });
  });
  req.on('error', reject);
  req.end(body);
});
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
// Signup is limited to 5 per IP and 15 minutes, so each scenario gets its own throwaway server and data directory.
let origin = '';
const startServer = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nosignal-ns09-'));
  const port = await freePort();
  origin = `https://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir, PORT: String(port), TLS_MODE: 'auto',
      SESSION_SECRET: 'ns09-browser-test-secret-at-least-32-bytes', TRUSTED_ORIGINS: origin, OPEN_REGISTRATION: '1',
      CHANNEL_KEYRING: `test:${Buffer.alloc(32, 7).toString('base64url')}`, CHANNEL_ACTIVE_KEY_ID: 'test' },
    stdio: 'ignore'
  });
  let ready = false;
  for (let i = 0; i < 400 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      serverCa = await readFile(path.join(dataDir, 'tls', 'ca.crt'));
      ready = (await nodeFetch(`${origin}/api/health`)).ok;
    } catch { await wait(200); }
  }
  assert.ok(ready, 'isolated server started');
  return async () => { child.kill('SIGTERM'); await rm(dataDir, { recursive: true, force: true }); };
};
const BANNER = 'نسخهٔ پشتیبان کلید شما هنوز روی سرور ذخیره نشده است.';
const apiHeaders = (cookie) => ({ Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) });
const asB64 = (value) => Buffer.from(value).toString('base64');
let browser;

// --- fake accounts (server API) -------------------------------------------------------------------------
const register = async (username, password) => {
  const response = await nodeFetch(`${origin}/api/register`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ username, password, displayName: username }) });
  assert.equal(response.status, 204);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const me = await (await nodeFetch(`${origin}/api/me`, { headers: apiHeaders(cookie) })).json();
  return { username, password, cookie, id: me.id };
};
const readBackup = async (account) => {
  const response = await nodeFetch(`${origin}/api/crypto/backup`, { headers: apiHeaders(account.cookie) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};

// --- browser helpers ------------------------------------------------------------------------------------
/**
 * Intercepts /api/crypto/* with CDP Fetch. `decide(info)` returns 'pass' | 'fail503' | 'hold' | 'strip-backup'.
 * Every backup PUT is recorded with the identity and password the page put in the body.
 */
const control = async (page, tag, decide) => {
  const cdp = await page.createCDPSession();
  const calls = [];
  const held = [];
  const byNetworkId = new Map();
  await cdp.send('Fetch.enable', { patterns: [
    { urlPattern: '*/api/crypto/*', requestStage: 'Request' },
    { urlPattern: '*/api/crypto/backup', requestStage: 'Response' }] });
  const settle = (fn) => fn().catch((error) => { if (process.env.NS09_DEBUG) console.log('cdp', tag, error.message); /* request already cancelled by the page: expected after logout */ });
  cdp.on('Fetch.requestPaused', (event) => {
    const { requestId, request } = event;
    const stage = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined ? 'response' : 'request';
    const pathname = new URL(request.url).pathname;
    const backupPut = request.method === 'PUT' && pathname === '/api/crypto/backup';
    const identityPut = request.method === 'PUT' && pathname === '/api/crypto/identity';
    let body = {};
    try { body = JSON.parse(request.postData ?? '{}'); } catch { /* not JSON */ }
    let call;
    if (backupPut && stage === 'request') {
      call = { tag, at: Date.now(), expectedUserId: body.expectedUserId, password: body.password, status: null };
      calls.push(call); byNetworkId.set(event.networkId, call);
    } else if (backupPut) {
      call = byNetworkId.get(event.networkId);
      if (call) call.status = event.responseStatusCode;
    }
    if (process.env.NS09_DEBUG) console.log(tag, stage, request.method, pathname, event.networkId, event.responseStatusCode);
    const action = decide({ stage, backupPut, identityPut, call, calls }) ?? 'pass';
    const cont = () => settle(() => cdp.send(stage === 'response' ? 'Fetch.continueResponse' : 'Fetch.continueRequest', { requestId }));
    if (action === 'hold') { held.push({ call, stage, release: cont }); return; }
    if (action === 'fail503' && stage === 'request') {
      if (call) call.status = 503;
      void settle(() => cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: asB64('{"error":"injected outage"}') }));
      return;
    }
    if (action === 'strip-backup' && stage === 'request' && identityPut) {
      delete body.backup; // force the separate backup PUT that the retry machinery handles
      void settle(() => cdp.send('Fetch.continueRequest', { requestId, postData: asB64(JSON.stringify(body)) }));
      return;
    }
    void cont();
  });
  return { calls, held };
};
const newPage = async (context, tag, decide) => {
  const page = await context.newPage();
  const ctl = await control(page, tag, decide);
  await page.goto(origin, { waitUntil: 'networkidle2' });
  return { page, ...ctl };
};
const signup = async (page, account) => {
  await page.waitForSelector('.login__tabs', { timeout: 10_000 });
  await page.evaluate(() => [...document.querySelectorAll('.login__tabs button')].find((button) => button.textContent.includes('ثبت‌نام')).click());
  await page.type('input[name=username]', account.username);
  await page.type('input[name=password]', account.password);
  await page.type('input[name=password-repeat]', account.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 45_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(os.tmpdir(), 'ns09-signup-fail.png') });
    throw new Error(`Signup did not open the app: ${(await page.evaluate(() => document.body.innerText)).slice(0, 300)}`, { cause: error });
  });
};
const hasBanner = (page) => page.evaluate((text) => document.body.innerText.includes(text), BANNER);
const logout = async (page) => {
  await page.click('button[aria-label="منو"]');
  await page.click('.drawer__danger');
  await page.waitForSelector('input[name=username]');
};
const login = async (page, account, wait = true) => {
  await page.type('input[name=username]', account.username);
  await page.type('input[name=password]', account.password);
  await page.keyboard.press('Enter');
  if (wait) await page.waitForSelector('.sidebar', { timeout: 45_000 });
};
const online = (page) => page.evaluate(() => window.dispatchEvent(new Event('online')));
const putsBy = (calls, account) => calls.filter((call) => call.expectedUserId === account.id || call.password === account.password);
// B gets its own backup first (own context), so any later write to B's row is visible as a revision change.
const prepareB = async (name, password) => {
  const b = await register(name, password);
  const context = await browser.createBrowserContext();
  const { page } = await newPage(context, 'prepare-B', () => 'pass');
  await page.waitForSelector('input[name=username]', { timeout: 10_000 });
  await login(page, b);
  await until('B backup stored', async () => (await readBackup(b)).status === 200);
  await context.close();
  const row = (await readBackup(b)).body;
  assert.ok(row.backup?.wrapped);
  return { ...b, row };
};
const assertRowUntouched = async (b) => {
  const now = (await readBackup(b)).body;
  assert.deepEqual(now.backup, b.row.backup, 'B backup blob changed');
  assert.equal(now.revision, b.row.revision, 'B backup revision changed');
};

// Common A setup: sign up, first backup attempt fails, retry keeps failing -> "not saved yet" banner.
const startPendingA = async (context, a, extra) => {
  const state = { phase: 'A' };
  const tab = await newPage(context, 'A', (info) => {
    if (state.phase === 'A') {
      if (info.stage === 'request' && info.identityPut) return 'strip-backup';
      return info.backupPut ? (extra?.(info, state) ?? 'fail503') : 'pass';
    }
    return extra?.(info, state) ?? 'pass';
  });
  await signup(tab.page, a);
  a.id = await tab.page.evaluate(async () => (await (await fetch('/api/me')).json()).id);
  await until('A banner', () => hasBanner(tab.page));
  await until('A first PUT failed', () => putsBy(tab.calls, a).some((call) => call.status === 503));
  return { ...tab, state };
};
// B has no key and no backup row yet. B's first request (creating its identity) is held, so B's row is EMPTY while any
// leftover A job could run: exactly the moment where an A write under B's cookie would succeed on an unfixed server.
const holdBIdentity = (info) => (info.stage === 'request' && info.identityPut ? 'hold' : 'pass');

const scenarios = [];

scenarios.push(['a) A PUT fails 5xx, switch to B without reload, retry timer runs while B has no backup yet', async () => {
  const a = { username: 'ns09_a1', password: 'aaaa-first-account-password-1' }; // signs up through the UI
  const b = await register('ns09_b1', 'bbbb-second-account-password-1');
  const context = await browser.createBrowserContext();
  const tab = await startPendingA(context, a, (info, state) => (state.phase === 'B' ? holdBIdentity(info) : 'fail503'));
  await logout(tab.page);
  tab.state.phase = 'B'; // the server answers normally from here on: nothing is masked by the injected outage
  const mark = tab.calls.length;
  await login(tab.page, b, false);
  await until('B first request held', () => tab.held.length === 1);
  assert.equal((await readBackup(b)).status, 404, 'B has no backup row yet');
  await wait(7_500); // one full retry interval (6 s) plus slack; the app times a request out after 15 s
  assert.deepEqual(putsBy(tab.calls.slice(mark), a), [], 'A identity/password reached a backup PUT after the account switch');
  assert.equal((await readBackup(b)).status, 404, 'a backup row appeared for B while only B identity creation was pending');
  await tab.held[0].release();
  await tab.page.waitForSelector('.sidebar', { timeout: 45_000 });
  await until('B own backup stored', async () => (await readBackup(b)).status === 200);
  b.row = (await readBackup(b)).body;
  await wait(7_500);
  assert.deepEqual(putsBy(tab.calls.slice(mark), a), [], 'A job ran after B finished logging in');
  assert.deepEqual(tab.calls.slice(mark).filter((call) => call.expectedUserId !== b.id), [], 'a PUT of another identity ran under B');
  assert.ok(!(await hasBanner(tab.page)), 'B shows A pending warning');
  await assertRowUntouched(b);
  // The server alone also refuses a leftover A job riding on B's cookie.
  const forged = await nodeFetch(`${origin}/api/crypto/backup`, { method: 'PUT', headers: apiHeaders(b.cookie), body: JSON.stringify({ expectedUserId: a.id, expectedRevision: b.row.revision, password: a.password, ...b.row.backup }) });
  assert.equal(forged.status, 403);
  await assertRowUntouched(b);
  await context.close();
}]);

for (const stage of ['response', 'request']) {
  scenarios.push([`b) A retry PUT held at ${stage === 'response' ? 'RESPONSE (reached the server, answer delayed)' : 'REQUEST (not sent yet)'} during logout; B logs in; then released`, async () => {
    const a = { username: `ns09_a2${stage[2]}`, password: 'aaaa-first-account-password-2' }; // signs up through the UI
    const b = await register(`ns09_b2${stage[2]}`, 'bbbb-second-account-password-2'); // B has no backup yet: its own upload is pending too
    const context = await browser.createBrowserContext();
    let aPuts = 0;
    const tab = await startPendingA(context, a, (info, state) => {
      if (state.phase === 'A') { // 1st attempt fails; the 2nd (retry timer) is held; later ones pass
        aPuts += 1;
        return aPuts >= 2 && info.stage === stage ? 'hold' : (aPuts >= 2 ? 'pass' : 'fail503');
      }
      if (info.stage === 'request' && info.identityPut) return 'strip-backup'; // B: key created, its own backup PUT is separate...
      if (info.backupPut) return state.phase === 'B' ? 'fail503' : 'pass'; // ...and fails until we let it through
      return 'pass';
    });
    await until('A retry PUT held', () => tab.held.length > 0, 20_000);
    const held = tab.held[0];
    assert.equal(held.call.password, a.password);
    await logout(tab.page);
    tab.state.phase = 'B';
    const mark = tab.calls.length;
    await login(tab.page, b);
    await until('B banner (B upload pending)', () => hasBanner(tab.page));
    await held.release(); // A's delayed request/response finishes now, while B is logged in
    await wait(1_500);
    assert.ok(await hasBanner(tab.page), 'late A completion cleared B pending state');
    assert.deepEqual(putsBy(tab.calls.slice(mark), a), [], 'A job issued a new PUT under B');
    const lateAccepted = tab.calls.filter((call) => call.expectedUserId === a.id && call.status !== null && call.status < 300);
    if (stage === 'request') assert.deepEqual(lateAccepted, [], 'held A request was accepted after B logged in');
    // B's own retry keeps working (its retry was not cancelled by A's late completion) and stores B's blob.
    tab.state.phase = 'B-ok';
    await until('B banner cleared by B retry', async () => !(await hasBanner(tab.page)), 20_000);
    const row = await readBackup(b);
    assert.equal(row.status, 200);
    assert.ok(row.body.backup?.wrapped, 'B backup stored by B retry');
    const bPuts = tab.calls.slice(mark).filter((call) => call.expectedUserId === b.id && call.password === b.password);
    assert.ok(bPuts.length >= 1);
    assert.deepEqual(tab.calls.slice(mark).filter((call) => call.expectedUserId !== b.id), [], 'a PUT of another identity ran under B');
    await context.close();
  }]);
}

scenarios.push(['c) `online` after the switch does not restart A retry (positive control while A is active)', async () => {
  const a = { username: 'ns09_a3', password: 'aaaa-first-account-password-3' }; // signs up through the UI
  const b = await register('ns09_b3', 'bbbb-second-account-password-3');
  const context = await browser.createBrowserContext();
  const tab = await startPendingA(context, a, (info, state) => (state.phase === 'B' ? holdBIdentity(info) : 'fail503'));
  const control = tab.calls.length;
  await online(tab.page);
  await until('online restarts A retry while A is active', () => putsBy(tab.calls.slice(control), a).length >= 1, 5_000);
  await logout(tab.page);
  tab.state.phase = 'B';
  const mark = tab.calls.length;
  await online(tab.page); // on the login screen
  await login(tab.page, b, false);
  await until('B first request held', () => tab.held.length === 1);
  await online(tab.page); // B session, B has no backup row: an A retry would be accepted here on an unfixed build
  await wait(400);
  await online(tab.page);
  await wait(2_000); // shorter than the 6 s retry timer: only the online listener could fire
  assert.deepEqual(putsBy(tab.calls.slice(mark), a), [], 'online event restarted A retry after logout/switch');
  assert.equal((await readBackup(b)).status, 404, 'a backup row appeared for B');
  await tab.held[0].release();
  await tab.page.waitForSelector('.sidebar', { timeout: 45_000 });
  await online(tab.page);
  await wait(1_500);
  assert.deepEqual(putsBy(tab.calls.slice(mark), a), [], 'online event restarted A retry after B opened');
  await context.close();
}]);

// Two tabs share one cookie jar, so tab 1's JavaScript is not told directly about a login done in tab 2. Logging in
// with A's cookie revokes A's session and the server closes tab 1's realtime socket (4401), which makes tab 1 clear its
// backup job and abort its held request. The assertion is the outcome that matters: A's write is never accepted under
// B (aborted by tab 1, or refused by the server; the server's expectedUserId check is exercised directly in scenario a).
// `direct` = tab 2 swaps the cookie with an API login; otherwise it uses the UI (logout, then login).
const twoTabs = async (direct) => {
  const a = { username: direct ? 'ns09_a4' : 'ns09_a5', password: 'aaaa-first-account-password-4' }; // signs up through the UI
  const b = await prepareB(direct ? 'ns09_b4' : 'ns09_b5', 'bbbb-second-account-password-4');
  const context = await browser.createBrowserContext();
  let hold = false;
  const tab1 = await startPendingA(context, a, (info, state, passthrough) => {
    if (passthrough) return 'pass';
    if (hold && info.stage === 'request') return 'hold'; // keep the retry unsent until tab 2 has switched accounts
    return 'fail503';
  });
  const tab2 = await newPage(context, 'tab2', () => 'pass'); // shares the cookie jar: opens as A
  await tab2.page.waitForSelector('.sidebar', { timeout: 20_000 });
  hold = true; // the app gives up on a request after 15 s, so tab 2 is ready before the retry is held
  await until('tab 1 retry held', () => tab1.held.length > 0, 20_000);
  if (direct) {
    const status = await tab2.page.evaluate(async (username, password) => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })).status, b.username, b.password);
    assert.ok(status === 200 || status === 204, `login status ${status}`);
    assert.equal(await tab2.page.evaluate(async () => (await (await fetch('/api/me')).json()).id), b.id, 'cookie jar now holds B');
  } else {
    await logout(tab2.page);
    await login(tab2.page, b);
  }
  const held = tab1.held[0];
  await held.release(); // A's retry now travels with B's cookie (or was cancelled by tab 1 itself after a 401)
  await wait(2_000);
  assert.ok(held.call.status === null || [401, 403].includes(held.call.status), `A write answered ${held.call.status} under B session`);
  tab1.state.phase = 'done';
  await wait(7_500);
  assert.deepEqual(tab1.calls.filter((call) => call.expectedUserId === a.id && call.status !== null && call.status < 300), [], 'an A write was accepted');
  assert.deepEqual(tab1.calls.filter((call) => call.expectedUserId === a.id && call.at > held.call.at), [], 'tab 1 kept retrying after refusal');
  await assertRowUntouched(b);
  await context.close();
};
scenarios.push(['d1) two tabs, tab 2 swaps the cookie to B by API login: A held write aborted or refused', () => twoTabs(true)]);
scenarios.push(['d2) two tabs, tab 2 does UI logout + login as B: A held write aborted or refused', () => twoTabs(false)]);

try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'] });
  let failed = 0;
  for (const [name, run] of scenarios.filter(([name]) => !process.env.NS09_ONLY || name.startsWith(process.env.NS09_ONLY))) {
    const stop = await startServer();
    try { await run(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.log(`FAIL ${name}\n  ${error.stack?.split('\n').slice(0, 5).join('\n  ')}`); }
    await stop();
  }
  if (failed) process.exitCode = 1;
  else console.log('PASS NS-09: A retry never wrote under B (timer, in-flight request, online event, second tab).');
} finally {
  await browser?.close();
}
