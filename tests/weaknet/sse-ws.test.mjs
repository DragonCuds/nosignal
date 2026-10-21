// Realtime transports against the REAL server process: SSE fallback stream, WS app-level ping/pong, typing over POST, presence, keepalive.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from '../../node_modules/ws/wrapper.mjs';
import { freePort, root, sleep, tmpDir } from './helpers.mjs';

const tsx = path.join(root, 'apps/server/node_modules/tsx/dist/cli.mjs');
const PW = 'correct horse battery staple';
let PORT, ORIGIN, dir, srv, chat;
const jar = {};
const cleanup = [];
const call = (u, method, url, body) => fetch(ORIGIN + url, { method, body: body && JSON.stringify(body), headers: { Origin: ORIGIN, Cookie: `tel_session=${jar[u]}`, 'Content-Type': 'application/json' } });
const sse = (u, headers = {}) => new Promise((resolve) => {
  const frames = [];
  const req = http.get(ORIGIN + '/api/events', { headers: { Cookie: `tel_session=${jar[u]}`, ...headers } }, (r) => { r.on('data', (c) => frames.push(String(c))); resolve({ r, frames, req }); });
  cleanup.push(() => req.destroy());
});

before(async () => {
  PORT = await freePort(); ORIGIN = `http://127.0.0.1:${PORT}`;
  dir = await tmpDir('wn-sse');
  const env = { ...process.env, NODE_ENV: 'test', DATA_DIR: dir, SESSION_SECRET: 'x'.repeat(40), WEBAUTHN_RP_ID: '127.0.0.1', TRUSTED_ORIGINS: ORIGIN, PORT: String(PORT) };
  const run = (args, input) => spawnSync(process.execPath, [tsx, ...args], { cwd: root, env, input, encoding: 'utf8' });
  assert.equal(run(['apps/server/src/migrate.ts']).status, 0);
  for (const u of ['alice', 'bob', 'carol']) assert.equal(run(['apps/server/src/cli/user-add.ts', u, u], `${PW}\n`).status, 0);
  srv = spawn(process.execPath, [tsx, 'apps/server/src/index.ts'], { cwd: root, env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${ORIGIN}/api/health`)).ok; } catch { await sleep(200); } }
  assert.ok(up, 'server started');
  for (const u of ['alice', 'bob', 'carol']) {
    const r = await fetch(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PW }) });
    jar[u] = /tel_session=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  }
  chat = await (await call('alice', 'POST', '/api/chats', { userId: '2' })).json();
});
after(async () => { cleanup.forEach((f) => f()); srv?.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); });

test('SSE stream + WS ping/pong + typing + presence + keepalive', async () => {
  const bob = await sse('bob');
  assert.equal(bob.r.statusCode, 200);
  assert.match(bob.r.headers['content-type'], /text\/event-stream/);
  assert.match(bob.r.headers['cache-control'], /no-cache/);
  assert.equal(bob.r.headers['x-accel-buffering'], 'no');
  await sleep(300);
  assert.equal(bob.frames[0], 'data: {"type":"hello"}\n\n');
  const carol = await sse('carol'); assert.equal(carol.r.statusCode, 200);
  const status = (headers) => new Promise((r) => http.get(ORIGIN + '/api/events', { headers }, (x) => { r(x.statusCode); x.resume(); }));
  assert.equal(await status({}), 401);
  assert.equal(await status({ Cookie: `tel_session=${jar.bob}`, Origin: 'http://evil.example' }), 403);
  // alice -> bob gets message.new on SSE, non-member carol does not
  const r = await call('alice', 'POST', `/api/chats/${chat.id}/messages`, { kind: 'text', encrypted: { version: 2, cipherId: crypto.randomUUID(), nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(40) } });
  assert.equal(r.status, 201);
  await sleep(500);
  assert.match(bob.frames.join(''), /data: \{"type":"message\.new"/);
  assert.doesNotMatch(carol.frames.join(''), /message\.new/);
  // WS ping -> pong (app-level heartbeat)
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: ORIGIN, Cookie: `tel_session=${jar.alice}` } });
  cleanup.push(() => ws.terminate());
  const wsMsgs = []; ws.on('message', (d) => wsMsgs.push(JSON.parse(d)));
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ type: 'ping', t: 12345 }));
  await sleep(300);
  assert.deepEqual(wsMsgs.find((m) => m.type === 'pong'), { type: 'pong', t: 12345 });
  // typing over POST (SSE clients' uplink) reaches the WS peer; validation + non-member + rate limit
  assert.equal((await call('bob', 'POST', '/api/typing', { chatId: chat.id, isTyping: true })).status, 204);
  await sleep(300);
  assert.ok(wsMsgs.find((m) => m.type === 'typing' && m.userId === '2'));
  ws.send(JSON.stringify({ type: 'typing', chatId: chat.id })); await sleep(300);
  assert.match(bob.frames.join(''), /"type":"typing","chatId":"\d+","userId":"1"/);
  assert.equal((await call('bob', 'POST', '/api/typing', { chatId: 'x' })).status, 400);
  await call('carol', 'POST', '/api/typing', { chatId: chat.id }); await sleep(200);
  assert.ok(!wsMsgs.some((m) => m.type === 'typing' && m.userId === '3'), 'non-member typing must not leak');
  const n0 = wsMsgs.filter((m) => m.type === 'typing').length;
  for (let i = 0; i < 40; i++) await call('bob', 'POST', '/api/typing', { chatId: chat.id });
  await sleep(400);
  const got = wsMsgs.filter((m) => m.type === 'typing').length - n0;
  assert.ok(got > 0 && got < 40, `typing rate-limited, got ${got} of 40`);
  // Bob must message Alice before Alice is allowed to see Bob's presence.
  const bobMessage = await call('bob', 'POST', `/api/chats/${chat.id}/messages`, { kind: 'text', encrypted: { version: 2, cipherId: crypto.randomUUID(), nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'B'.repeat(40) } });
  assert.equal(bobMessage.status, 201);
  // presence: bob's SSE closes -> alice's WS sees offline
  bob.req.destroy(); await sleep(400);
  assert.equal(wsMsgs.filter((m) => m.type === 'presence' && m.userId === '2').pop()?.online, false);
  // keepalive comment every 15 s keeps idle SSE alive through proxies
  await sleep(16000);
  assert.ok(carol.frames.join('').includes(': keepalive'));
  ws.close(); carol.req.destroy();
});
