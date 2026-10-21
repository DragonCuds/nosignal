import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from '../../node_modules/ws/wrapper.mjs';
import { bootApp, sleep } from '../weaknet/helpers.mjs';

let S;
let send;
const connections = [];

before(async () => {
  S = await bootApp({ routes: ['realtime'], prefix: 'security-ws-resources' });
  ({ send } = await import('../../apps/server/src/realtime.ts'));
});
after(async () => {
  for (const socket of connections) socket.terminate();
  await S?.close();
});

const status = (path = '/ws', cookie = S.cookies.a) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port: S.port, path,
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'),
      'Sec-WebSocket-Version': '13', Origin: S.origin,
      Cookie: `tel_session=${cookie}`
    }
  });
  req.once('response', (response) => { response.resume(); resolve(response.statusCode); });
  req.once('upgrade', () => reject(new Error('unexpected upgrade')));
  req.once('error', reject);
  req.end();
});

const open = () => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${S.port}/ws`, {
    headers: { Origin: S.origin, Cookie: `tel_session=${S.cookies.a}` }
  });
  socket.once('open', () => { connections.push(socket); resolve(socket); });
  socket.once('error', reject);
});

class FakeSocket extends EventEmitter {
  destroyed = false;
  response = '';
  end(response) { this.response = response; this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

test('unknown and malformed upgrade paths are rejected and the server stays healthy', async () => {
  assert.equal(await status('/missing'), 404);
  const socket = new FakeSocket();
  S.app.server.emit('upgrade', { url: 'http://[', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, socket, Buffer.alloc(0));
  assert.match(socket.response, /^HTTP\/1\.1 400 Bad Request/);
  assert.equal(socket.destroyed, true);
  assert.equal(await status('/missing'), 404);
});

test('one session cannot hold more than six WebSockets', async () => {
  for (let i = 0; i < 6; i++) await open();
  assert.equal(await status(), 503);
  connections[0].terminate();
  await new Promise((resolve) => connections[0].once('close', resolve));
  await open();
  for (const socket of connections) socket.terminate();
  await sleep(50);
});

test('pending authentication has a per-IP cap and a deadline', async () => {
  const originalQuery = S.db.query;
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  S.db.query = function (sql, params) {
    if (String(sql).includes('UPDATE sessions') && String(sql).includes('last_seen_at')) {
      return gate.then(() => originalQuery.call(this, sql, params));
    }
    return originalQuery.call(this, sql, params);
  };
  const sockets = [];
  try {
    for (let i = 0; i < 8; i++) {
      const socket = new FakeSocket();
      sockets.push(socket);
      S.app.server.emit('upgrade', {
        url: '/ws', headers: { origin: S.origin, cookie: `tel_session=${S.cookies.a}` },
        socket: { remoteAddress: '127.0.0.1' }
      }, socket, Buffer.alloc(0));
    }
    const excess = new FakeSocket();
    S.app.server.emit('upgrade', {
      url: '/ws', headers: { origin: S.origin, cookie: `tel_session=${S.cookies.a}` },
      socket: { remoteAddress: '127.0.0.1' }
    }, excess, Buffer.alloc(0));
    assert.match(excess.response, /^HTTP\/1\.1 503 Service Unavailable/);
    for (let i = 0; i < 52 && !sockets[0].destroyed; i++) await sleep(100);
    assert.match(sockets[0].response, /^HTTP\/1\.1 408 Request Timeout/);
    assert.ok(sockets.every((socket) => socket.destroyed));
  } finally {
    for (const socket of sockets) socket.destroy();
    unblock();
    S.db.query = originalQuery;
  }
});

test('a slow WebSocket receiver is terminated before its queue grows', () => {
  let terminated = 0;
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 1024 * 1024, terminate: () => { terminated++; }, send: () => assert.fail('must not queue another frame') };
  send(socket, { type: 'hello' });
  assert.equal(terminated, 1);
});

test('a chat broadcast queries membership once and observes removal', async () => {
  const socket = await open();
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  const originalQuery = S.db.query;
  let membershipQueries = 0;
  S.db.query = function (sql, params) {
    if (String(sql).includes('SELECT user_id FROM chat_members WHERE chat_id')) membershipQueries++;
    return originalQuery.call(this, sql, params);
  };
  try {
    S.app.realtime.broadcastToChat('1', { type: 'chat.new', chatId: '1' });
    await sleep(50);
    assert.equal(membershipQueries, 1);
    assert.equal(frames.filter((frame) => frame.type === 'chat.new').length, 1);
    await S.db.query('DELETE FROM chat_members WHERE chat_id = 1 AND user_id = 1');
    S.app.realtime.broadcastToChat('1', { type: 'chat.new', chatId: '1' });
    await sleep(100);
    assert.equal(membershipQueries, 2);
    assert.equal(frames.filter((frame) => frame.type === 'chat.new').length, 1);
  } finally {
    await S.db.query('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (1, 1)');
    S.db.query = originalQuery;
  }
});
