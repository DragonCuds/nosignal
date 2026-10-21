import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-channels-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'channels-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;

const load = (name) => import(path.join(dist, name));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const { runMigrations } = await load('migrate.js');
const { db } = await load('db.js');
const { createUser } = await load('users.js');
const auth = await load('auth.js');
const { registerChatRoutes } = await load('chats.js');
const { registerCryptoRoutes } = await load('crypto.js');

let app;
const ids = {};
const cookies = {};
const events = [];
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
const send = (user, method, url, payload) => app.inject({ method, url, payload, remoteAddress: '10.0.0.1', headers: { origin, cookie: cookies[user] } });
const b64 = (n) => randomBytes(n).toString('base64url');
const enc = () => ({ version: 2, cipherId: randomUUID(), nonce: b64(12), ciphertext: b64(40) });
const post = (user, chatId) => send(user, 'POST', `/api/chats/${chatId}/messages`, { kind: 'text', encrypted: enc() });

before(async () => {
  await runMigrations();
  for (const name of ['owner', 'adm', 'reader', 'outsider', 'reader2']) ids[name] = await createUser(name, name, 'a-long-password-9');
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 10_000, timeWindow: '1 minute' });
  app.addHook('onRequest', auth.requireTrustedOrigin);
  app.decorate('requireUser', auth.requireUser);
  app.decorate('realtime', { broadcastToChat: (chatId, event) => events.push({ chatId, event }) });
  app.get('/test/login/:id', async (request, reply) => { await auth.createSession(request.params.id, reply, request); return { ok: true }; });
  await registerCryptoRoutes(app);
  await registerChatRoutes(app);
  await app.ready();
  for (const name of Object.keys(ids)) cookies[name] = cookieOf(await app.inject({ method: 'GET', url: `/test/login/${ids[name]}`, headers: { origin } }));
});

after(async () => {
  await app.close();
  await db.end();
  await rm(dataDir, { recursive: true, force: true });
});

const state = {};

test('channel title accepts ZWNJ/ZWJ but rejects other format chars', async () => {
  const fa = await send('owner', 'POST', '/api/channels', { title: 'کانال می\u200cخواهم' });
  assert.equal(fa.statusCode, 201, fa.body);
  assert.equal((await send('owner', 'POST', '/api/channels', { title: 'a\u200db' })).statusCode, 201);
  for (const bad of ['a\u202eb', 'a\u0000b', 'a\u200bb']) assert.equal((await send('owner', 'POST', '/api/channels', { title: bad })).statusCode, 400);
});

test('create channel, invite, join, list', async () => {
  assert.equal((await send('owner', 'POST', '/api/channels', { title: '  ' })).statusCode, 400);
  const created = await send('owner', 'POST', '/api/channels', { title: 'News' });
  assert.equal(created.statusCode, 201);
  state.id = created.json().id;
  state.chatId = created.json().chatId;
  const inv = await send('owner', 'POST', `/api/channels/${state.id}/invites`);
  assert.equal(inv.statusCode, 201);
  state.token = inv.json().token;
  state.invId = inv.json().id;
  assert.ok(state.token.length >= 16);
  const preview = await send('reader', 'GET', `/api/channels/join/${state.token}`);
  assert.deepEqual(preview.json(), { title: 'News', memberCount: 1 });
  assert.equal((await send('reader', 'GET', '/api/channels/join/doesnotexist-doesnotexist')).statusCode, 404);
  const joined = await send('reader', 'POST', `/api/channels/join/${state.token}`);
  assert.equal(joined.statusCode, 200);
  assert.equal(joined.json().id, state.id);
  assert.equal((await send('reader', 'POST', `/api/channels/join/${state.token}`)).statusCode, 200); // idempotent
  assert.equal((await send('reader2', 'POST', `/api/channels/join/${state.token}`)).statusCode, 200);
  const list = (await send('reader', 'GET', '/api/chats')).json();
  const item = list.find((c) => c.id === state.chatId);
  assert.equal(item.type, 'channel');
  assert.equal(item.title, 'News');
  assert.equal(item.channelId, state.id);
  assert.equal(item.role, 'member');
  assert.equal(item.memberCount, 3);
  assert.equal(item.peer, null);
  assert.equal(list.filter((c) => c.type !== 'channel').length, 0);
  const ownerItem = (await send('owner', 'GET', '/api/chats')).json().find((c) => c.id === state.chatId);
  assert.equal(ownerItem.role, 'owner');
});

test('info shapes by role', async () => {
  const owner = (await send('owner', 'GET', `/api/channels/${state.id}`)).json();
  assert.equal(owner.role, 'owner');
  assert.equal(owner.memberCount, 3);
  assert.equal(owner.members.length, 3);
  assert.equal(owner.invites.length, 1);
  const member = (await send('reader', 'GET', `/api/channels/${state.id}`)).json();
  assert.equal(member.members, undefined);
  assert.equal(member.invites, undefined);
  assert.equal(member.memberCount, 3);
});

test('only owner/admins post; members read', async () => {
  const p = await post('owner', state.chatId);
  assert.equal(p.statusCode, 201);
  state.msgId = p.json().id;
  assert.equal((await post('reader', state.chatId)).statusCode, 403);
  assert.equal((await send('reader', 'PATCH', `/api/chats/${state.chatId}/messages/${state.msgId}`, { encrypted: enc() })).statusCode, 403);
  assert.equal((await send('reader', 'DELETE', `/api/chats/${state.chatId}/messages/${state.msgId}`)).statusCode, 403);
  const read = await send('reader', 'GET', `/api/chats/${state.chatId}/messages`);
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().length, 1);
  const key = await send('reader', 'GET', `/api/channels/${state.id}/key`);
  assert.equal(key.statusCode, 200);
  assert.equal(Buffer.from(key.json().key, 'base64url').length, 32);
  assert.equal((await send('owner', 'GET', `/api/channels/${state.id}/key`)).json().key, key.json().key);
  // admins
  assert.equal((await send('owner', 'POST', `/api/channels/${state.id}/admins/${ids.adm}`)).statusCode, 404); // not a member yet
  await send('adm', 'POST', `/api/channels/join/${state.token}`);
  assert.equal((await send('reader', 'POST', `/api/channels/${state.id}/admins/${ids.adm}`)).statusCode, 403);
  assert.equal((await send('owner', 'POST', `/api/channels/${state.id}/admins/${ids.adm}`)).statusCode, 204);
  assert.equal((await post('adm', state.chatId)).statusCode, 201);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/admins/${ids.adm}`)).statusCode, 204);
  assert.equal((await post('adm', state.chatId)).statusCode, 403);
});

test('non-member gets 404 everywhere', async () => {
  const checks = [
    ['GET', `/api/channels/${state.id}`], ['PATCH', `/api/channels/${state.id}`, { title: 'x' }], ['DELETE', `/api/channels/${state.id}`],
    ['GET', `/api/channels/${state.id}/key`], ['POST', `/api/channels/${state.id}/invites`], ['DELETE', `/api/channels/${state.id}/invites/${state.invId}`],
    ['POST', `/api/channels/${state.id}/leave`], ['POST', `/api/channels/${state.id}/admins/${ids.reader}`],
    ['DELETE', `/api/channels/${state.id}/admins/${ids.reader}`], ['DELETE', `/api/channels/${state.id}/members/${ids.reader}`],
    ['GET', `/api/chats/${state.chatId}/messages`], ['POST', `/api/chats/${state.chatId}/messages`, { kind: 'text', encrypted: enc() }],
    ['PATCH', `/api/chats/${state.chatId}/messages/${state.msgId}`, { encrypted: enc() }], ['DELETE', `/api/chats/${state.chatId}/messages/${state.msgId}`],
    ['POST', `/api/chats/${state.chatId}/read`, { messageId: state.msgId }], ['GET', `/api/chats/${state.chatId}/crypto`],
    ['GET', `/api/sync?since=0`]
  ];
  for (const [method, url, body] of checks) {
    const r = await send('outsider', method, url, body);
    if (url.startsWith('/api/sync')) { assert.ok(!r.body.includes('"chatId":"' + state.chatId + '"'), 'sync leaked'); continue; }
    assert.equal(r.statusCode, 404, `${method} ${url} -> ${r.statusCode}`);
  }
  assert.equal((await send('outsider', 'GET', '/api/chats')).json().length, 0);
  // members-only management is 403 (not 404) for plain members
  for (const [method, url, body] of [['PATCH', `/api/channels/${state.id}`, { title: 'x' }], ['DELETE', `/api/channels/${state.id}`], ['POST', `/api/channels/${state.id}/invites`], ['DELETE', `/api/channels/${state.id}/members/${ids.reader2}`]]) {
    assert.equal((await send('reader', method, url, body)).statusCode, 403, `${method} ${url}`);
  }
});

test('channels never leak into direct-chat paths', async () => {
  // reader and reader2 share only a channel: not in each other's /api/users, and POST /api/chats makes a NEW direct chat.
  const users = (await send('reader', 'GET', '/api/users')).json();
  assert.deepEqual(users, []);
  const direct = await send('reader', 'POST', '/api/chats', { userId: ids.reader2 });
  assert.equal(direct.statusCode, 201);
  assert.notEqual(direct.json().id, state.chatId);
  // two-member channel (owner + one) must not be returned for owner/peer lookup
  const solo = (await send('owner', 'POST', '/api/channels', { title: 'Two' })).json();
  const inv = (await send('owner', 'POST', `/api/channels/${solo.id}/invites`)).json();
  await send('outsider', 'POST', `/api/channels/join/${inv.token}`);
  const d2 = await send('owner', 'POST', '/api/chats', { userId: ids.outsider });
  assert.equal(d2.statusCode, 201);
  assert.notEqual(d2.json().id, solo.chatId);
  assert.deepEqual((await send('owner', 'GET', '/api/users')).json().map((u) => u.username), ['outsider']);
  const chats = (await send('owner', 'GET', '/api/chats')).json();
  assert.equal(chats.find((c) => c.id === solo.chatId).type, 'channel');
  assert.equal(chats.find((c) => c.id === d2.json().id).type, 'direct');
});

test('revoke invite, leave, remove member', async () => {
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/invites/${state.invId}`)).statusCode, 204);
  assert.equal((await send('outsider', 'GET', `/api/channels/join/${state.token}`)).statusCode, 404);
  assert.equal((await send('outsider', 'POST', `/api/channels/join/${state.token}`)).statusCode, 404);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/invites/${state.invId}`)).statusCode, 404);
  assert.equal((await send('reader', 'POST', `/api/channels/${state.id}/leave`)).statusCode, 204);
  assert.equal((await send('reader', 'GET', `/api/chats/${state.chatId}/messages`)).statusCode, 404);
  assert.equal((await send('owner', 'POST', `/api/channels/${state.id}/leave`)).statusCode, 409);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/members/${ids.owner}`)).statusCode, 409);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/members/${ids.reader2}`)).statusCode, 204);
  assert.equal((await send('reader2', 'GET', `/api/channels/${state.id}`)).statusCode, 404);
  assert.equal((await send('owner', 'GET', `/api/channels/${state.id}`)).json().memberCount, 2);
});

test('removed member cannot rejoin with the same invite link; leaving does not ban; owner can lift the ban', async () => {
  const inv = (await send('owner', 'POST', `/api/channels/${state.id}/invites`)).json();
  // reader2 was removed in the previous test, so the old removal already banned them.
  assert.equal((await send('reader2', 'POST', `/api/channels/join/${inv.token}`)).statusCode, 403);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/bans/${ids.reader2}`)).statusCode, 204);
  assert.equal((await send('reader2', 'POST', `/api/channels/join/${inv.token}`)).statusCode, 200);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/members/${ids.reader2}`)).statusCode, 204);
  const again = await send('reader2', 'POST', `/api/channels/join/${inv.token}`);
  assert.equal(again.statusCode, 403);
  assert.equal((await send('reader2', 'GET', `/api/chats/${state.chatId}/messages`)).statusCode, 404, 'still not a member');
  assert.equal((await send('owner', 'GET', `/api/channels/${state.id}`)).json().bans.length, 1);
  // someone who left on their own may come back
  assert.equal((await send('reader', 'POST', `/api/channels/join/${inv.token}`)).statusCode, 200);
  assert.equal((await send('reader', 'POST', `/api/channels/${state.id}/leave`)).statusCode, 204);
  assert.equal((await send('reader', 'POST', `/api/channels/join/${inv.token}`)).statusCode, 200);
  // only the owner lifts bans
  assert.equal((await send('reader', 'DELETE', `/api/channels/${state.id}/bans/${ids.reader2}`)).statusCode, 403);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/bans/${ids.reader2}`)).statusCode, 204);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}/bans/${ids.reader2}`)).statusCode, 404);
  assert.equal((await send('reader2', 'POST', `/api/channels/join/${inv.token}`)).statusCode, 200);
  await send('owner', 'DELETE', `/api/channels/${state.id}/members/${ids.reader2}`);
  await send('owner', 'DELETE', `/api/channels/${state.id}/bans/${ids.reader2}`);
  await send('reader', 'POST', `/api/channels/${state.id}/leave`);
  await send('owner', 'DELETE', `/api/channels/${state.id}/invites/${inv.id}`);
});

test('rename and delete', async () => {
  const patched = await send('owner', 'PATCH', `/api/channels/${state.id}`, { title: 'Renamed' });
  assert.equal(patched.statusCode, 200);
  assert.equal((await send('owner', 'GET', `/api/channels/${state.id}`)).json().title, 'Renamed');
  assert.equal((await send('owner', 'PATCH', `/api/channels/${state.id}`, { title: '' })).statusCode, 400);
  assert.equal((await send('owner', 'DELETE', `/api/channels/${state.id}`)).statusCode, 204);
  assert.equal((await send('owner', 'GET', `/api/channels/${state.id}`)).statusCode, 404);
  assert.equal((await send('adm', 'GET', `/api/chats/${state.chatId}/messages`)).statusCode, 404);
});
