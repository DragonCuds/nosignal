// Third transport: WebSocket and SSE both blocked -> the web client polls /api/sync and still gets messages.
// Spawns its OWN throwaway production-mode server (fresh DATA_DIR, own port) and kills only that PID.
// Run: node tests/web-e2e/poll-fallback-e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { launch, makeRun, fresh, goto, signup, startChatWith, openChatRow, text, waitFor, send, sleep, tag } from './lib.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = makeRun('poll-fallback');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = Number(process.env.PORT ?? await freePort());
const BASE = `https://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poll-e2e-'));
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR: dataDir, SESSION_SECRET: randomBytes(32).toString('hex'),
    TRUSTED_ORIGINS: BASE, WEBAUTHN_RP_ID: '127.0.0.1', TLS_MODE: 'auto', OPEN_REGISTRATION: '1' },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on('exit', cleanup);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ } await sleep(500); if (i === 59) { console.log(serverLog); throw new Error('server did not start'); } }

// occurrences in the open conversation only (the sidebar preview repeats the last message)
const count = (page, needle) => page.evaluate((n) => {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('.sidebar').forEach((el) => el.remove());
  return clone.innerText.split(n).length - 1;
}, needle);
const t = tag(); const NA = `pa${t}`; const NB = `pb${t}`;
const browser = await launch();
try {
  const A = await fresh(browser, 'A', 1000, 800); await goto(A, BASE); await signup(A, NA);

  // B: WS handshakes and the SSE stream are blocked from the very first request
  const B = await fresh(browser, 'B', 1000, 800);
  // WS upgrade: Chromium does not let CDP block it, so the page's WebSocket fails like a filtered handshake (error + close 1006);
  // the SSE stream is blocked at the network layer (request aborted).
  await B.evaluateOnNewDocument(() => {
    const Real = window.WebSocket;
    window.__blockRt = true;
    window.WebSocket = new Proxy(Real, {
      construct(target, args) {
        if (window.__blockRt && /\/ws$/.test(String(args[0]))) {
          const fake = { readyState: 0, send() {}, close() { fake.readyState = 3; }, onopen: null, onmessage: null, onclose: null, onerror: null };
          setTimeout(() => { fake.readyState = 3; fake.onerror?.({}); fake.onclose?.({ code: 1006 }); }, 400);
          return fake;
        }
        return new target(...args);
      },
    });
  });
  const cdp = await B.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*/api/events'] });
  let wsOpened = 0; let syncCalls = 0; let eventsOk = 0;
  cdp.on('Network.webSocketHandshakeResponseReceived', () => { wsOpened++; });
  B.on('response', (r) => { if (r.url().includes('/api/events') && r.ok()) eventsOk++; });
  B.on('request', (r) => { if (r.url().includes('/api/sync')) syncCalls++; });
  await goto(B, BASE); await signup(B, NB);

  // wait for the client to give up on WS (3x) and SSE (2x) and start polling: sync calls keep coming
  const t0 = Date.now(); let polling = false; let last = -1;
  while (Date.now() - t0 < 150_000) {
    await sleep(2000);
    if (Date.now() - t0 > 40_000 && syncCalls >= 3 && last >= 0 && syncCalls - last >= 1) { polling = true; break; }
    if (Date.now() - t0 > 40_000 && last < 0) last = syncCalls;
  }
  run.check('B fell back to polling (WS + SSE blocked, /api/sync polled)', polling, `sync calls=${syncCalls} after ${Math.round((Date.now() - t0) / 1000)}s`);
  run.check('no WS handshake or SSE stream got through', wsOpened === 0 && eventsOk === 0);

  // A (WS online) writes to B: chat is new for B, arrives through polling
  await startChatWith(A, NB);
  let tm = Date.now();
  await send(A, 'hello-0');
  await B.waitForFunction((l) => [...document.querySelectorAll('.chat-row')].some((n) => n.textContent?.includes(l)), { timeout: 12_000 }, NA).then(() => run.check('new chat + first message reached B via polling in <12 s', true, `${Date.now() - tm} ms`), () => run.check('new chat + first message reached B via polling in <12 s', false));
  await openChatRow(B, NA);
  run.check('B reads hello-0', await waitFor(B, 'hello-0', 10_000));

  tm = Date.now();
  await send(A, 'msg-1');
  const got1 = await waitFor(B, 'msg-1', 12_000);
  run.check('B (chat open) receives msg-1 within 12 s via polling', got1, `${Date.now() - tm} ms`);
  await B.screenshot({ path: run.shots + '/B-polling.png' });

  // B sends over the normal HTTP API; A is on WS
  await send(B, 'reply-b1');
  run.check('B can send while polling; A receives it', await waitFor(A, 'reply-b1', 10_000));

  // network recovers: unblock, A sends right away -> exactly once, nothing lost
  await send(A, 'msg-2');
  await cdp.send('Network.setBlockedURLs', { urls: [] });
  await B.evaluate(() => { window.__blockRt = false; });
  await send(A, 'msg-3');
  const t1 = Date.now();
  while (Date.now() - t1 < 100_000 && wsOpened === 0 && eventsOk === 0) await sleep(2000);
  run.check('B switched back up (WS or SSE connected) within ~100 s of recovery', wsOpened > 0 || eventsOk > 0, `ws=${wsOpened} sse=${eventsOk} after ${Math.round((Date.now() - t1) / 1000)}s`);
  await send(A, 'msg-4');
  for (const m of ['msg-2', 'msg-3', 'msg-4']) run.check(`B got ${m}`, await waitFor(B, m, 15_000));
  await sleep(10_000); // let any late poll/live duplicate show up
  for (const m of ['hello-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4', 'reply-b1']) run.check(`exactly one ${m} in B's view`, (await count(B, m)) === 1, `x${await count(B, m)}`);
  run.check('reply-b1 exactly once on A', (await count(A, 'reply-b1')) === 1);
  const calls0 = syncCalls; await sleep(20_000);
  run.check('polling stopped after the upgrade', syncCalls === calls0, `${syncCalls - calls0} extra sync calls`);
} catch (e) { console.log('ERROR', e); console.log(serverLog.slice(-1500)); run.fail(); }
finally { await browser.close(); cleanup(); }
run.done();
