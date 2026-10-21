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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-saved-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'saved-test-secret-with-at-least-32-bytes';
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
const jwk = () => ({ kty: 'EC', crv: 'P-256', x: b64(32), y: b64(32) });

before(async () => {
  await runMigrations();
  for (const name of ['alice', 'bob', 'carol', 'alice_two', 'a_b']) {
    ids[name] = await createUser(name, name, 'a-long-password-9');
  }
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

let savedId;
test('POST /api/chats/saved is get-or-create, one per user', async () => {
  const first = await send('alice', 'POST', '/api/chats/saved');
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().created, true);
  savedId = first.json().id;
  const again = await send('alice', 'POST', '/api/chats/saved');
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { id: savedId, created: false });
  const bob = await send('bob', 'POST', '/api/chats/saved');
  assert.notEqual(bob.json().id, savedId);
  assert.equal((await send('alice', 'POST', '/api/chats/saved')).json().id, savedId);
  assert.equal((await send('bob', 'GET', `/api/chats/${savedId}/messages`)).statusCode, 404);
});

test('nobody else can be added to a saved chat; DB enforces one member', async () => {
  await assert.rejects(db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [savedId, ids.bob]), /single member/);
  await assert.rejects(db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [savedId, ids.alice]));
  await assert.rejects(db.query('INSERT INTO saved_chats (user_id, chat_id) VALUES ($1, $2)', [ids.alice, savedId]));
});

test('GET /api/chats lists it as type saved with no peer, direct chats keep their peer', async () => {
  const direct = await send('alice', 'POST', '/api/chats', { userId: ids.bob });
  assert.equal(direct.statusCode, 201);
  const list = (await send('alice', 'GET', '/api/chats')).json();
  const saved = list.find((c) => c.id === savedId);
  assert.equal(saved.type, 'saved');
  assert.equal(saved.peer, null);
  assert.equal(saved.unreadCount, 0);
  const d = list.find((c) => c.id === direct.json().id);
  assert.equal(d.type, 'direct');
  assert.equal(d.peer.username, 'bob');
  // the direct lookup never reuses the saved chat
  assert.equal((await send('alice', 'POST', '/api/chats', { userId: ids.bob })).json().created, false);
  assert.equal((await send('alice', 'POST', '/api/chats', { userId: ids.alice })).statusCode, 400);
});

test('key envelope: a single envelope to itself for the saved chat', async () => {
  assert.equal((await send('alice', 'PUT', '/api/crypto/identity', { expectedUserId: ids.alice, publicKey: jwk() })).statusCode, 200);
  const env = { recipientId: ids.alice, version: 1, nonce: b64(12), ciphertext: b64(48) };
  assert.equal((await send('alice', 'POST', `/api/chats/${savedId}/crypto/envelopes`, { envelopes: [env, env] })).statusCode, 400);
  assert.equal((await send('alice', 'POST', `/api/chats/${savedId}/crypto/envelopes`, { envelopes: [{ ...env, recipientId: ids.bob }] })).statusCode, 400);
  assert.equal((await send('alice', 'POST', `/api/chats/${savedId}/crypto/envelopes`, { envelopes: [env] })).statusCode, 201);
  const state = (await send('alice', 'GET', `/api/chats/${savedId}/crypto`)).json();
  assert.equal(state.members.length, 1);
  assert.equal(state.envelope.senderId, ids.alice);
});

test('messages: send, dedupe, edit, delete, attachment kind, read, sync (single member)', async () => {
  const body = { kind: 'text', encrypted: enc(), clientMsgId: 'client-msg-0001' };
  const sent = await send('alice', 'POST', `/api/chats/${savedId}/messages`, body);
  assert.equal(sent.statusCode, 201, sent.body);
  const msg = sent.json();
  assert.equal(msg.chatId, savedId);
  assert.equal((await send('alice', 'POST', `/api/chats/${savedId}/messages`, body)).statusCode, 200);
  assert.ok(events.some((e) => e.chatId === savedId && e.event.type === 'message.new'));
  assert.equal((await send('bob', 'POST', `/api/chats/${savedId}/messages`, { ...body, clientMsgId: 'client-msg-0002', encrypted: enc() })).statusCode, 404);

  const edited = await send('alice', 'PATCH', `/api/chats/${savedId}/messages/${msg.id}`, { encrypted: enc() });
  assert.equal(edited.statusCode, 200);
  assert.ok(edited.json().editedAt);

  // a photo message through an E2EE attachment row
  const attId = randomBytes(16).toString('hex');
  await db.query('INSERT INTO attachments (id, chat_id, uploader_id, byte_size) VALUES ($1, $2, $3, 64)', [attId, savedId, ids.alice]);
  const photo = await send('alice', 'POST', `/api/chats/${savedId}/messages`, { kind: 'photo', attachmentId: attId, encrypted: enc() });
  assert.equal(photo.statusCode, 201, photo.body);
  assert.equal(photo.json().attachmentId, attId);

  assert.equal((await send('alice', 'POST', `/api/chats/${savedId}/read`, { messageId: photo.json().id })).statusCode, 204);
  const listed = (await send('alice', 'GET', `/api/chats/${savedId}/messages`)).json();
  assert.equal(listed.length, 2);

  const sync = (await send('alice', 'GET', '/api/sync?since=0')).json();
  assert.equal(sync.reset, false);
  assert.deepEqual(sync.events.filter((e) => e.chatId === savedId).map((e) => e.type), ['message.new', 'message.edited', 'message.new']);
  assert.equal((await send('bob', 'GET', '/api/sync?since=0')).json().events.filter((e) => e.chatId === savedId).length, 0);

  const del = await send('alice', 'DELETE', `/api/chats/${savedId}/messages/${msg.id}`);
  assert.equal(del.statusCode, 200);
  assert.ok(del.json().deletedAt);
  assert.equal(del.json().encrypted, null);
  const last = (await send('alice', 'GET', '/api/chats')).json().find((c) => c.id === savedId).lastMessage;
  assert.equal(last.kind, 'photo');
});

test('users/search: prefix, @ stripped, min 3, never self, max 20, wildcard-safe', async () => {
  const names = (r) => r.json().map((u) => u.username);
  assert.deepEqual(names(await send('bob', 'GET', '/api/users/search?q=ali')), ['alice', 'alice_two']);
  assert.deepEqual(names(await send('bob', 'GET', '/api/users/search?q=%40alice')), ['alice', 'alice_two']);
  assert.deepEqual(names(await send('bob', 'GET', '/api/users/search?q=ALICE_TWO')), ['alice_two']);
  assert.deepEqual(names(await send('alice', 'GET', '/api/users/search?q=alice')), ['alice_two']);
  assert.deepEqual((await send('bob', 'GET', '/api/users/search?q=al')).json(), []);
  assert.deepEqual((await send('bob', 'GET', '/api/users/search?q=%25%25%25')).json(), []);
  assert.deepEqual(names(await send('bob', 'GET', '/api/users/search?q=a_b')), ['a_b']);
  assert.deepEqual((await send('bob', 'GET', '/api/users/search?q=a_c')).json(), []);
  assert.equal((await send('bob', 'GET', '/api/users/search')).statusCode, 400);
  const u = (await send('bob', 'GET', '/api/users/search?q=carol')).json()[0];
  assert.deepEqual(Object.keys(u).sort(), ['avatarPath', 'displayName', 'id', 'username']);
  for (let i = 0; i < 25; i++) await createUser(`many_${String(i).padStart(2, '0')}`, 'm', 'a-long-password-9');
  assert.equal((await send('bob', 'GET', '/api/users/search?q=many')).json().length, 20);
  assert.equal((await send('alice', 'GET', '/api/users/search')).statusCode, 400);
});

test('GET /api/users lists only people the caller shares a chat with', async () => {
  assert.deepEqual((await send('alice', 'GET', '/api/users')).json().map((u) => u.username), ['bob']);
  assert.deepEqual((await send('carol', 'GET', '/api/users')).json(), []);
  const fresh = await send('carol', 'POST', '/api/chats/saved');
  assert.equal(fresh.statusCode, 201);
  assert.deepEqual((await send('carol', 'GET', '/api/users')).json(), []);
});
