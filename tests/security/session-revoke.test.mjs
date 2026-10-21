// Revoked sessions lose their live WebSocket/SSE connections; media uploads are rate limited per user, not per IP.
// Runs against the REAL server process.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from '../../node_modules/ws/wrapper.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const tsx = path.join(root, 'apps/server/node_modules/tsx/dist/cli.mjs');
const PW = 'correct horse battery staple';
const PORT = Number(process.env.TEST_PORT ?? 3101);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dir, srv, chat, bobCookie, carolCookie, aliceNew;
const cleanup = [];

const login = async (username, password = PW) => {
  const r = await fetch(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 204);
  return /tel_session=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
};
const call = (cookie, method, url, body) => fetch(ORIGIN + url, { method, body: body && JSON.stringify(body), headers: { Origin: ORIGIN, Cookie: `tel_session=${cookie}`, ...(body ? { 'Content-Type': 'application/json' } : {}) } });
const openWs = async (cookie) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: ORIGIN, Cookie: `tel_session=${cookie}` } });
  cleanup.push(() => ws.terminate());
  const state = { frames: [], closed: null };
  ws.on('message', (d) => state.frames.push(JSON.parse(d)));
  ws.on('close', (code) => { state.closed = code; });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  state.ws = ws;
  return state;
};
const openSse = (cookie) => new Promise((resolve) => {
  const state = { frames: [], ended: false };
  const req = http.get(ORIGIN + '/api/events', { headers: { Cookie: `tel_session=${cookie}` } }, (r) => {
    r.on('data', (c) => state.frames.push(String(c)));
    r.on('end', () => { state.ended = true; });
    r.on('close', () => { state.ended = true; });
    resolve(state);
  });
  cleanup.push(() => req.destroy());
});
const message = (cookie) => call(cookie, 'POST', `/api/chats/${chat}/messages`, { kind: 'text', encrypted: { version: 2, cipherId: crypto.randomUUID(), nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(40) } });
const upload = (cookie, bytes = 64, ip) => {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes).fill(7)], { type: 'application/octet-stream' }), 'blob.bin');
  return fetch(`${ORIGIN}/api/chats/${chat}/encrypted-media`, { method: 'POST', body: form, headers: { Origin: ORIGIN, Cookie: `tel_session=${cookie}` } });
};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tel-revoke-'));
  const env = { ...process.env, NODE_ENV: 'test', DATA_DIR: dir, SESSION_SECRET: 'x'.repeat(40), WEBAUTHN_RP_ID: '127.0.0.1', TRUSTED_ORIGINS: ORIGIN, PORT: String(PORT) };
  const run = (args, input) => spawnSync(process.execPath, [tsx, ...args], { cwd: root, env, input, encoding: 'utf8' });
  assert.equal(run(['apps/server/src/migrate.ts']).status, 0);
  for (const u of ['alice', 'bob', 'carol']) assert.equal(run(['apps/server/src/cli/user-add.ts', u, u], `${PW}\n`).status, 0);
  srv = spawn(process.execPath, [tsx, 'apps/server/src/index.ts'], { cwd: root, env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${ORIGIN}/api/health`)).ok; } catch { await sleep(200); } }
  assert.ok(up, 'server started');
  const alice = await login('alice');
  bobCookie = await login('bob');
  carolCookie = await login('carol');
  chat = (await (await call(alice, 'POST', '/api/chats', { userId: '2' })).json()).id;
});
after(async () => { cleanup.forEach((f) => f()); srv?.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); });

test('logout from another session closes that session\'s WebSocket and SSE; no further events arrive', async () => {
  const a1 = await login('alice');
  const a2 = await login('alice');
  const bob = bobCookie;
  const ws = await openWs(a1);
  const sse = await openSse(a1);
  const bobWs = await openWs(bob);
  await sleep(300);
  assert.equal((await message(bob)).status, 201);
  await sleep(300);
  assert.ok(ws.frames.some((f) => f.type === 'message.new'), 'live before revoke');
  // session 2 revokes session 1 via the sessions list
  const list = await (await call(a2, 'GET', '/api/security/sessions')).json();
  const other = list.find((s) => !s.current);
  assert.equal((await call(a2, 'DELETE', `/api/security/sessions/${other.id}`)).status, 204);
  await sleep(500);
  assert.equal(ws.closed, 4401);
  assert.equal(sse.ended, true);
  const seen = ws.frames.length;
  const seenSse = sse.frames.join('').length;
  assert.equal((await message(bob)).status, 201);
  await sleep(400);
  assert.equal(ws.frames.length, seen, 'revoked socket gets nothing');
  assert.equal(sse.frames.join('').length, seenSse);
  assert.equal(bobWs.closed, null, 'other users untouched');
  // the surviving session still works live
  const ws2 = await openWs(a2);
  await sleep(200);
  assert.equal(ws2.closed, null);
  // own logout closes own socket
  assert.equal((await call(a2, 'POST', '/api/auth/logout')).status, 204);
  await sleep(400);
  assert.equal(ws2.closed, 4401);
});

test('revoke-others and password change close every other session but keep the current one', async () => {
  const keep = await login('alice');
  const other1 = await login('alice');
  const ws1 = await openWs(other1);
  const sseKeep = await openSse(keep);
  const wsKeep = await openWs(keep);
  await sleep(200);
  assert.equal((await call(keep, 'POST', '/api/security/sessions/revoke-others')).status, 204);
  await sleep(400);
  assert.equal(ws1.closed, 4401);
  assert.equal(wsKeep.closed, null);
  assert.equal(sseKeep.ended, false);
  // password change
  const ws2 = await openWs(await login('alice'));
  await sleep(200);
  const pw = await call(keep, 'POST', '/api/security/password', { expectedUserId: '1', currentPassword: PW, newPassword: 'another long passphrase 42', expectedBackupRevision: 0 });
  assert.equal(pw.status, 204);
  await sleep(400);
  assert.equal(ws2.closed, 4401);
  assert.equal(wsKeep.closed, null, 'current session survives the password change');
});

test('encrypted-media rate limit is per user, generous for small blobs, clear 429 with Retry-After', async () => {
  const alice = aliceNew = await login('alice', 'another long passphrase 42');
  const bob = bobCookie;
  let last;
  for (let i = 0; i < 120; i++) { last = await upload(alice); assert.equal(last.status, 201, `upload ${i + 1}`); }
  const blocked = await upload(alice);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.match((await blocked.json()).message ?? '', /Too many uploads/);
  // same IP, different user: not affected
  assert.equal((await upload(bob)).status, 201);
});

test('chat.new is pushed to the other member when a direct chat or a group is created for them', async () => {
  const ws = await openWs(carolCookie);
  await sleep(200);
  const direct = await (await call(aliceNew, 'POST', '/api/chats', { userId: '3' })).json();
  await sleep(300);
  assert.ok(ws.frames.some((f) => f.type === 'chat.new' && f.chatId === direct.id), 'direct chat announced');
  assert.ok(!ws.frames.some((f) => f.type === 'chat.new' && f.chatId === chat), 'unrelated chats are not announced');
  // not announced to the creator or to a non-member
  const bobWs = await openWs(bobCookie);
  await sleep(200);
  const again = await (await call(aliceNew, 'POST', '/api/chats', { userId: '3' })).json();
  assert.equal(again.created, false);
  await sleep(300);
  assert.ok(!bobWs.frames.some((f) => f.type === 'chat.new'));
});

test('heartbeat fallback: a session deleted behind the app\'s back still loses its socket within one heartbeat', async () => {
  const cookie = bobCookie;
  const ws = await openWs(cookie);
  await sleep(200);
  assert.equal(ws.closed, null);
  // Delete only this session directly in the database (no hook runs).
  const del = spawnSync('sqlite3', [path.join(dir, 'tel.db'), "PRAGMA busy_timeout=5000; DELETE FROM sessions WHERE id = (SELECT id FROM sessions WHERE user_id = 2 ORDER BY created_at DESC, rowid DESC LIMIT 1);"], { encoding: 'utf8' });
  assert.equal(del.status, 0, del.stderr);
  for (let i = 0; i < 60 && ws.closed === null; i++) await sleep(500);
  assert.equal(ws.closed, 4401);
});
