// S9c / finding 8: /api/events (SSE) must obey the same connection caps as /ws, and the two transports share one budget.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { after, afterEach, before, test } from 'node:test';
import WebSocket from '../../node_modules/ws/wrapper.mjs';
import { bootApp, sleep } from '../weaknet/helpers.mjs';

const SECRET = 'weaknet-test-only-secret-with-at-least-32-bytes';
let S;
let nextSession = 100;
const open = new Set();

before(async () => { S = await bootApp({ routes: ['realtime'], prefix: 'security-sse-limits' }); });
afterEach(async () => { for (const c of [...open]) c.close(); await sleep(100); });
after(async () => { for (const c of [...open]) c.close(); await S?.close(); });

/** A new session (cookie) for user 1..3. */
const session = async (userId) => {
  const token = `sse-limit-token-${nextSession}`;
  await S.db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))`,
    [`00000000-0000-4000-8000-${String(nextSession++).padStart(12, '0')}`, userId, createHmac('sha256', SECRET).update(token).digest('hex')]);
  return token;
};
/** Open /api/events; resolves { status, close() } as soon as the headers arrive. The stream is kept open. */
const sse = (cookie) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: S.port, path: '/api/events', agent: false, headers: { Cookie: `tel_session=${cookie}` } }, (res) => {
    const handle = { status: res.statusCode, close: () => { res.destroy(); req.destroy(); open.delete(handle); } };
    if (res.statusCode === 200) open.add(handle); else res.resume();
    resolve(handle);
  });
  req.once('error', reject);
});
const ws = (cookie) => new Promise((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:${S.port}/ws`, { headers: { Origin: S.origin, Cookie: `tel_session=${cookie}` } });
  const handle = { socket, close: () => { socket.terminate(); open.delete(handle); } };
  socket.once('open', () => { open.add(handle); resolve({ ...handle, status: 101 }); });
  socket.once('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode, close: () => undefined }); });
  socket.once('error', () => undefined);
});
const closeAll = async () => { for (const c of [...open]) c.close(); await sleep(150); };

test('SSE: per-session cap, refusal is 503 before any stream starts, and a closed stream frees its slot', async () => {
  const token = await session(1);
  const streams = [];
  for (let i = 0; i < 6; i++) { const s = await sse(token); assert.equal(s.status, 200, `stream ${i + 1}`); streams.push(s); }
  assert.equal((await sse(token)).status, 503);
  streams[0].close();
  await sleep(200);
  const again = await sse(token);
  assert.equal(again.status, 200, 'slot freed');
  await closeAll();
});

test('SSE and WebSocket share one per-session budget', async () => {
  const token = await session(2);
  for (let i = 0; i < 3; i++) assert.equal((await ws(token)).status, 101);
  for (let i = 0; i < 3; i++) assert.equal((await sse(token)).status, 200);
  assert.equal((await sse(token)).status, 503, 'SSE refused: 3 WS + 3 SSE fill the session');
  assert.equal((await ws(token)).status, 503, 'WS refused for the same reason');
  await closeAll();
  // the other direction: SSE streams count against a later WebSocket
  const token2 = await session(2);
  for (let i = 0; i < 6; i++) assert.equal((await sse(token2)).status, 200);
  assert.equal((await ws(token2)).status, 503);
  await closeAll();
});

test('SSE: per-user cap holds across sessions (12)', async () => {
  const tokens = [await session(3), await session(3), await session(3)];
  for (const token of tokens.slice(0, 2)) for (let i = 0; i < 6; i++) assert.equal((await sse(token)).status, 200);
  assert.equal((await sse(tokens[2])).status, 503, 'a third session of the same user is over the user cap');
  await closeAll();
});

test('SSE: per-IP cap holds across users (32)', async () => {
  const plan = [[1, 6], [1, 5], [2, 6], [2, 5], [3, 6], [3, 4]]; // [user, streams]: 11 + 11 + 10 = 32
  for (const [user, n] of plan) {
    const token = await session(user);
    for (let i = 0; i < n; i++) assert.equal((await sse(token)).status, 200);
  }
  assert.equal((await sse(await session(3))).status, 503, 'the 33rd connection from one address is refused');
  await closeAll();
});

test('SSE: below the caps a normal client still connects and gets the hello event', async () => {
  const token = await session(1);
  const hello = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: S.port, path: '/api/events', agent: false, headers: { Cookie: `tel_session=${token}` } }, (res) => {
      res.setEncoding('utf8');
      res.once('data', (chunk) => { res.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'], chunk }); });
    }).once('error', reject);
  });
  assert.equal(hello.status, 200);
  assert.match(hello.type, /text\/event-stream/);
  assert.match(hello.chunk, /"type":"hello"/);
});
