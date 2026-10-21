import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from '../../node_modules/ws/wrapper.mjs';
import { bootApp, enc, sleep } from '../weaknet/helpers.mjs';

let S;
const connections = [];

before(async () => { S = await bootApp({ routes: ['realtime'], prefix: 'security-presence' }); });
after(async () => {
  for (const connection of connections) connection.destroy?.() ?? connection.terminate?.();
  await S?.close();
});

const openWs = (user) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${S.port}/ws`, {
    headers: { Origin: S.origin, Cookie: `tel_session=${S.cookies[user]}` }
  });
  connections.push(socket);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  socket.once('open', () => resolve({ socket, frames }));
  socket.once('error', reject);
});

const openSse = (user) => new Promise((resolve, reject) => {
  const req = http.get(`${S.origin}/api/events`, { headers: { Cookie: `tel_session=${S.cookies[user]}` } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(String(chunk)));
    resolve({ req, chunks });
  });
  connections.push(req);
  req.once('error', reject);
});

const presence = (frames, userId) => frames.filter((frame) => frame.type === 'presence' && frame.userId === userId);
const ssePresence = (chunks, userId) => chunks.join('').split('\n\n').filter((frame) => frame.includes(`"type":"presence","userId":"${userId}"`));
const until = async (condition) => {
  for (let i = 0; i < 40; i++) {
    if (condition()) return;
    await sleep(25);
  }
  assert.fail('expected presence event did not arrive');
};

const addMessage = async (chatId, senderId) => {
  const encrypted = enc();
  await S.db.query(
    `INSERT INTO messages (chat_id, sender_id, kind, encryption_version, cipher_id, nonce, ciphertext)
     VALUES ($1, $2, 'text', 2, $3, $4, $5)`,
    [chatId, senderId, encrypted.cipherId, encrypted.nonce, encrypted.ciphertext]
  );
};

test('presence reaches only recipients the user has messaged in a current direct chat', async () => {
  // Fixture chat 1 is a+b; chat 2 is b+c. A group or an empty direct chat
  // can be created unilaterally, so neither makes c an audience for a.
  await addMessage('1', '1');
  await S.db.query('INSERT INTO chats DEFAULT VALUES');
  await S.db.query('INSERT INTO chat_members (chat_id, user_id) VALUES (3, 1), (3, 3)');
  await S.db.query('INSERT INTO chats DEFAULT VALUES');
  await S.db.query("INSERT INTO groups (chat_id, title, created_by, key_version, pending_version) VALUES (4, 'group', 1, 0, 1)");
  await S.db.query('INSERT INTO chat_members (chat_id, user_id) VALUES (4, 1), (4, 3)');
  await addMessage('4', '1');

  const b = await openWs('b');
  const c = await openSse('c');
  const a1 = await openWs('a');
  await until(() => presence(b.frames, '1').length === 1);
  assert.equal(presence(b.frames, '1')[0].online, true);
  assert.equal(ssePresence(c.chunks, '1').length, 0, 'unrelated and group-only users see nothing');

  const a2 = await openSse('a');
  a1.socket.close();
  await new Promise((resolve) => a1.socket.once('close', resolve));
  await sleep(100);
  assert.equal(presence(b.frames, '1').length, 1, 'closing one of two sessions is not offline');
  a2.req.destroy();
  await until(() => presence(b.frames, '1').length === 2);
  assert.equal(presence(b.frames, '1')[1].online, false);
  assert.equal(ssePresence(c.chunks, '1').length, 0);

  await S.db.query('UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE chat_id = 1 AND sender_id = 1');
  const a3 = await openWs('a');
  await sleep(100);
  assert.equal(presence(b.frames, '1').length, 2, 'deleted messages revoke the audience immediately');
  assert.equal(ssePresence(c.chunks, '1').length, 0);
  a3.socket.close();
  await new Promise((resolve) => a3.socket.once('close', resolve));
  await sleep(100);
  assert.equal(presence(b.frames, '1').length, 2);

  await addMessage('3', '1');
  const a4 = await openWs('a');
  await until(() => ssePresence(c.chunks, '1').length === 1);
  assert.equal(presence(b.frames, '1').length, 2);
  a4.socket.close();
  await new Promise((resolve) => a4.socket.once('close', resolve));
  await until(() => ssePresence(c.chunks, '1').length === 2);

  await S.db.query('DELETE FROM chat_members WHERE chat_id = 3 AND user_id = 3');
  const a5 = await openWs('a');
  await sleep(100);
  assert.equal(ssePresence(c.chunks, '1').length, 2, 'removed chat members lose presence access');
  a5.socket.close();
  await new Promise((resolve) => a5.socket.once('close', resolve));
  await sleep(100);
  assert.equal(ssePresence(c.chunks, '1').length, 2);
});
