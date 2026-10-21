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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-groups-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'groups-test-secret-with-at-least-32-bytes';
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
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
const send = (user, method, url, payload) => app.inject({ method, url, payload, remoteAddress: '10.0.0.1', headers: { origin, cookie: cookies[user] } });
const b64 = (n) => randomBytes(n).toString('base64url');
const enc = () => ({ version: 2, cipherId: randomUUID(), nonce: b64(12), ciphertext: b64(40) });
const post = (user, chatId, keyVersion) => send(user, 'POST', `/api/chats/${chatId}/messages`, { kind: 'text', encrypted: enc(), keyVersion });
const wrap = () => b64(60);
const envs = (...names) => names.map((n) => ({ userId: ids[n], wrapped: wrap() }));

before(async () => {
  await runMigrations();
  for (const name of ['owner', 'adm', 'bob', 'carol', 'dave', 'outsider', 'noid']) ids[name] = String(await createUser(name, name, 'a-long-password-9'));
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 10_000, timeWindow: '1 minute' });
  app.addHook('onRequest', auth.requireTrustedOrigin);
  app.decorate('requireUser', auth.requireUser);
  app.decorate('realtime', { broadcastToChat: () => undefined });
  app.get('/test/login/:id', async (request, reply) => { await auth.createSession(request.params.id, reply, request); return { ok: true }; });
  await registerCryptoRoutes(app);
  await registerChatRoutes(app);
  await app.ready();
  for (const name of Object.keys(ids)) cookies[name] = cookieOf(await app.inject({ method: 'GET', url: `/test/login/${ids[name]}`, headers: { origin } }));
  for (const name of Object.keys(ids)) {
    if (name === 'noid') continue;
    assert.equal((await send(name, 'PUT', '/api/crypto/identity', { publicKey: { kty: 'EC', crv: 'P-256', x: b64(32), y: b64(32) } })).statusCode, 200);
  }
});

after(async () => {
  await app.close();
  await db.end();
  await rm(dataDir, { recursive: true, force: true });
});

const state = {};

test('group title accepts ZWNJ/ZWJ (Persian) but rejects other control/format chars', async () => {
  const fa = await send('owner', 'POST', '/api/groups', { title: 'بچه\u200cهای دانشگاه', memberIds: [ids.bob] });
  assert.equal(fa.statusCode, 201, fa.body);
  assert.equal((await send('owner', 'POST', '/api/groups', { title: 'a\u200db', memberIds: [ids.bob] })).statusCode, 201);
  for (const bad of ['a\u202eb', 'a\u0000b', 'a\u200bb', 'a\u2066b']) {
    assert.equal((await send('owner', 'POST', '/api/groups', { title: bad, memberIds: [ids.bob] })).statusCode, 400, JSON.stringify(bad));
  }
});

test('create group: validation, owner, list, keys', async () => {
  assert.equal((await send('owner', 'POST', '/api/groups', { title: ' ', memberIds: [ids.bob] })).statusCode, 400);
  assert.equal((await send('owner', 'POST', '/api/groups', { title: 'G', memberIds: [] })).statusCode, 400);
  assert.equal((await send('owner', 'POST', '/api/groups', { title: 'G', memberIds: ['x'] })).statusCode, 400);
  assert.equal((await send('owner', 'POST', '/api/groups', { title: 'G', memberIds: [ids.noid] })).statusCode, 409); // no identity
  assert.equal((await send('owner', 'POST', '/api/groups', { title: 'G', memberIds: ['99999'] })).statusCode, 409);
  const created = await send('owner', 'POST', '/api/groups', { title: 'Friends', memberIds: [ids.bob, ids.adm, ids.bob] });
  assert.equal(created.statusCode, 201);
  state.id = created.json().id; state.chatId = created.json().chatId;
  // not keyed yet: posting is refused until version 1 is uploaded
  assert.equal((await post('owner', state.chatId, 1)).statusCode, 409);
  assert.equal((await send('owner', 'GET', `/api/groups/${state.id}`)).json().pendingKeyVersion, 1);
  // PUT keys: must cover every member exactly
  assert.equal((await send('bob', 'PUT', `/api/groups/${state.id}/keys`, { version: 1, envelopes: envs('owner', 'bob', 'adm') })).statusCode, 403);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 1, envelopes: envs('owner', 'bob') })).statusCode, 400);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 1, envelopes: envs('owner', 'bob', 'carol') })).statusCode, 400);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 1, envelopes: [...envs('owner', 'bob'), { userId: ids.owner, wrapped: wrap() }] })).statusCode, 400);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 3, envelopes: envs('owner', 'bob', 'adm') })).statusCode, 409);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 1, envelopes: envs('owner', 'bob', 'adm') })).statusCode, 204);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 1, envelopes: envs('owner', 'bob', 'adm') })).statusCode, 409); // already uploaded
  const info = (await send('bob', 'GET', `/api/groups/${state.id}`)).json();
  assert.equal(info.role, 'member');
  assert.equal(info.keyVersion, 1);
  assert.equal(info.memberCount, 3);
  assert.equal(info.members.length, 3);
  assert.equal(info.members[0].role, 'owner');
  assert.ok(info.members.every((m) => m.publicKey && m.publicKey.kty === 'EC' && m.username));
  const mine = (await send('bob', 'GET', `/api/groups/${state.id}/keys?version=latest`)).json();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].version, 1);
  assert.equal(mine[0].wrappedBy, ids.owner);
  assert.equal((await send('bob', 'GET', `/api/groups/${state.id}/keys?version=2`)).json().length, 0);
  assert.equal((await send('bob', 'GET', `/api/groups/${state.id}/keys?version=zzz`)).statusCode, 400);
  const list = (await send('bob', 'GET', '/api/chats')).json();
  const item = list.find((c) => c.id === state.chatId);
  assert.equal(item.type, 'group');
  assert.equal(item.groupId, state.id);
  assert.equal(item.title, 'Friends');
  assert.equal(item.role, 'member');
  assert.equal(item.memberCount, 3);
  assert.equal(item.peer, null);
});

test('groups never appear in /api/users or direct-chat lookup', async () => {
  const users = (await send('bob', 'GET', '/api/users')).json();
  assert.equal(users.length, 0);
  // a real direct chat between owner and bob is separate from the group chat
  const direct = await send('owner', 'POST', '/api/chats', { userId: ids.bob });
  assert.equal(direct.statusCode, 201);
  assert.notEqual(direct.json().id, state.chatId);
  assert.equal((await send('bob', 'GET', '/api/users')).json().length, 1);
  // creating a direct chat with a stranger still works
  assert.equal((await send('carol', 'POST', '/api/chats', { userId: ids.adm })).statusCode, 201);
});

test('messages: key version, post/edit/delete roles, key-version in payload', async () => {
  assert.equal((await post('bob', state.chatId)).statusCode, 400);
  assert.equal((await post('bob', state.chatId, 2)).statusCode, 400);
  const p = await post('bob', state.chatId, 1);
  assert.equal(p.statusCode, 201);
  assert.equal(p.json().encrypted.keyVersion, 1);
  state.msg = p.json().id;
  const ownerMsg = await post('owner', state.chatId, 1);
  assert.equal(ownerMsg.statusCode, 201);
  const list = (await send('adm', 'GET', `/api/chats/${state.chatId}/messages`)).json();
  assert.equal(list.length, 2);
  assert.equal(list[0].encrypted.keyVersion, 1);
  assert.equal(list[0].sender.username, 'bob');
  const chatList = (await send('adm', 'GET', '/api/chats')).json().find((c) => c.id === state.chatId);
  assert.equal(chatList.lastMessage.encrypted.keyVersion, 1);
  // edit: sender only (even the owner cannot edit someone else's message)
  assert.equal((await send('owner', 'PATCH', `/api/chats/${state.chatId}/messages/${state.msg}`, { encrypted: enc(), keyVersion: 1 })).statusCode, 404);
  assert.equal((await send('bob', 'PATCH', `/api/chats/${state.chatId}/messages/${state.msg}`, { encrypted: enc() })).statusCode, 400);
  assert.equal((await send('bob', 'PATCH', `/api/chats/${state.chatId}/messages/${state.msg}`, { encrypted: enc(), keyVersion: 1 })).statusCode, 200);
  // delete: sender, or admin/owner; other plain members cannot
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/members`, { userId: ids.carol, envelope: wrap() })).statusCode, 204);
  assert.equal((await send('carol', 'DELETE', `/api/chats/${state.chatId}/messages/${state.msg}`)).statusCode, 404);
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/admins/${ids.adm}`)).statusCode, 204);
  const del = await send('adm', 'DELETE', `/api/chats/${state.chatId}/messages/${state.msg}`);
  assert.equal(del.statusCode, 200);
  assert.ok(del.json().deletedAt);
  const own = await post('carol', state.chatId, 1);
  assert.equal(own.statusCode, 201);
  assert.equal((await send('carol', 'DELETE', `/api/chats/${state.chatId}/messages/${own.json().id}`)).statusCode, 200);
});

test('add member: roles, current key only, cap, duplicates, no identity', async () => {
  assert.equal((await send('bob', 'POST', `/api/groups/${state.id}/members`, { userId: ids.dave, envelope: wrap() })).statusCode, 403);
  assert.equal((await send('adm', 'POST', `/api/groups/${state.id}/members`, { userId: ids.carol, envelope: wrap() })).statusCode, 409); // already
  assert.equal((await send('adm', 'POST', `/api/groups/${state.id}/members`, { userId: ids.noid, envelope: wrap() })).statusCode, 409);
  assert.equal((await send('adm', 'POST', `/api/groups/${state.id}/members`, { userId: '99999', envelope: wrap() })).statusCode, 404);
  assert.equal((await send('adm', 'POST', `/api/groups/${state.id}/members`, { userId: ids.dave })).statusCode, 400);
  assert.equal((await send('adm', 'POST', `/api/groups/${state.id}/members`, { userId: ids.dave, envelope: wrap() })).statusCode, 204);
  const keys = (await send('dave', 'GET', `/api/groups/${state.id}/keys`)).json();
  assert.deepEqual(keys.map((k) => k.version), [1]);
  assert.equal(keys[0].wrappedBy, ids.adm);
  assert.equal((await send('dave', 'GET', `/api/groups/${state.id}`)).json().memberCount, 5);
});

test('remove / leave bump rotation; rotation rules', async () => {
  // plain member cannot remove; admin cannot remove owner; admin cannot remove admin
  assert.equal((await send('bob', 'DELETE', `/api/groups/${state.id}/members/${ids.carol}`)).statusCode, 403);
  assert.equal((await send('adm', 'DELETE', `/api/groups/${state.id}/members/${ids.owner}`)).statusCode, 409);
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/admins/${ids.dave}`)).statusCode, 204);
  assert.equal((await send('adm', 'DELETE', `/api/groups/${state.id}/members/${ids.dave}`)).statusCode, 403);
  assert.equal((await send('owner', 'DELETE', `/api/groups/${state.id}/admins/${ids.dave}`)).statusCode, 204);
  // admin removes bob
  assert.equal((await send('adm', 'DELETE', `/api/groups/${state.id}/members/${ids.bob}`)).statusCode, 204);
  let info = (await send('owner', 'GET', `/api/groups/${state.id}`)).json();
  assert.equal(info.keyVersion, 1);
  assert.equal(info.pendingKeyVersion, 2);
  assert.equal(info.memberCount, 4);
  // removed member is out everywhere
  for (const [m, u, b] of [['GET', `/api/groups/${state.id}`], ['GET', `/api/groups/${state.id}/keys`], ['GET', `/api/chats/${state.chatId}/messages`], ['POST', `/api/chats/${state.chatId}/messages`, { kind: 'text', encrypted: enc(), keyVersion: 1 }]]) {
    assert.equal((await send('bob', m, u, b)).statusCode, 404, `${m} ${u}`);
  }
  assert.equal((await send('bob', 'GET', '/api/chats')).json().some((c) => c.id === state.chatId), false);
  // posting / adding blocked while the rotation is pending
  assert.equal((await post('carol', state.chatId, 1)).statusCode, 409);
  assert.equal((await post('carol', state.chatId, 2)).statusCode, 409);
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/members`, { userId: ids.bob, envelope: wrap() })).statusCode, 409);
  // members cannot rotate; wrong versions / incomplete coverage rejected
  assert.equal((await send('carol', 'PUT', `/api/groups/${state.id}/keys`, { version: 2, envelopes: envs('owner', 'adm', 'carol', 'dave') })).statusCode, 403);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 3, envelopes: envs('owner', 'adm', 'carol', 'dave') })).statusCode, 409);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 2, envelopes: envs('owner', 'adm', 'carol', 'bob') })).statusCode, 400); // removed member
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 2, envelopes: envs('owner', 'adm', 'carol') })).statusCode, 400);
  assert.equal((await send('adm', 'PUT', `/api/groups/${state.id}/keys`, { version: 2, envelopes: envs('owner', 'adm', 'carol', 'dave') })).statusCode, 204);
  info = (await send('owner', 'GET', `/api/groups/${state.id}`)).json();
  assert.equal(info.keyVersion, 2);
  assert.equal(info.pendingKeyVersion, null);
  assert.equal((await post('carol', state.chatId, 1)).statusCode, 400);
  assert.equal((await post('carol', state.chatId, 2)).statusCode, 201);
  assert.deepEqual((await send('carol', 'GET', `/api/groups/${state.id}/keys`)).json().map((k) => k.version), [1, 2]);
  assert.equal((await send('carol', 'GET', `/api/groups/${state.id}/keys?version=latest`)).json()[0].version, 2);
  // a voluntary rotation is allowed too (version = keyVersion + 1)
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 3, envelopes: envs('owner', 'adm', 'carol', 'dave') })).statusCode, 204);
  // leave: member leaves -> pending again; owner cannot leave
  assert.equal((await send('dave', 'POST', `/api/groups/${state.id}/leave`)).statusCode, 204);
  assert.equal((await send('owner', 'GET', `/api/groups/${state.id}`)).json().pendingKeyVersion, 4);
  assert.equal((await send('dave', 'GET', `/api/groups/${state.id}`)).statusCode, 404);
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/leave`)).statusCode, 409);
  assert.equal((await send('owner', 'DELETE', `/api/groups/${state.id}/members/${ids.owner}`)).statusCode, 409);
  // a second removal keeps the same pending version
  assert.equal((await send('owner', 'DELETE', `/api/groups/${state.id}/members/${ids.carol}`)).statusCode, 204);
  assert.equal((await send('owner', 'GET', `/api/groups/${state.id}`)).json().pendingKeyVersion, 4);
  assert.equal((await send('owner', 'PUT', `/api/groups/${state.id}/keys`, { version: 4, envelopes: envs('owner', 'adm') })).statusCode, 204);
});

test('transfer ownership, rename, admins', async () => {
  assert.equal((await send('adm', 'PATCH', `/api/groups/${state.id}`, { title: 'New name' })).statusCode, 200);
  assert.equal((await send('owner', 'PATCH', `/api/groups/${state.id}`, { title: '' })).statusCode, 400);
  assert.equal((await send('adm', 'POST', `/api/groups/${state.id}/admins/${ids.owner}`)).statusCode, 403);
  assert.equal((await send('adm', 'POST', `/api/groups/${state.id}/owner/${ids.adm}`)).statusCode, 403);
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/owner/${ids.outsider}`)).statusCode, 404);
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/owner/${ids.adm}`)).statusCode, 204);
  assert.equal((await send('adm', 'GET', `/api/groups/${state.id}`)).json().role, 'owner');
  assert.equal((await send('owner', 'GET', `/api/groups/${state.id}`)).json().role, 'admin');
  assert.equal((await send('owner', 'POST', `/api/groups/${state.id}/leave`)).statusCode, 204);
  assert.equal((await send('owner', 'DELETE', `/api/groups/${state.id}`)).statusCode, 404);
});

test('non-member gets 404 on every route', async () => {
  const c = (await send('adm', 'POST', '/api/groups', { title: 'Priv', memberIds: [ids.bob], envelopes: envs('adm', 'bob') })).json();
  assert.equal((await send('adm', 'GET', `/api/groups/${c.id}`)).json().keyVersion, 1);
  const m = (await post('adm', c.chatId, 1)).json();
  const checks = [
    ['GET', `/api/groups/${c.id}`], ['PATCH', `/api/groups/${c.id}`, { title: 'x' }], ['DELETE', `/api/groups/${c.id}`],
    ['POST', `/api/groups/${c.id}/leave`], ['POST', `/api/groups/${c.id}/members`, { userId: ids.carol, envelope: wrap() }],
    ['DELETE', `/api/groups/${c.id}/members/${ids.bob}`], ['GET', `/api/groups/${c.id}/keys`], ['GET', `/api/groups/${c.id}/keys?version=latest`],
    ['PUT', `/api/groups/${c.id}/keys`, { version: 2, envelopes: envs('adm', 'bob') }], ['POST', `/api/groups/${c.id}/admins/${ids.bob}`],
    ['DELETE', `/api/groups/${c.id}/admins/${ids.bob}`], ['POST', `/api/groups/${c.id}/owner/${ids.bob}`],
    ['GET', `/api/chats/${c.chatId}/messages`], ['POST', `/api/chats/${c.chatId}/messages`, { kind: 'text', encrypted: enc(), keyVersion: 1 }],
    ['PATCH', `/api/chats/${c.chatId}/messages/${m.id}`, { encrypted: enc(), keyVersion: 1 }], ['DELETE', `/api/chats/${c.chatId}/messages/${m.id}`],
    ['POST', `/api/chats/${c.chatId}/read`, { messageId: m.id }], ['GET', `/api/chats/${c.chatId}/crypto`], ['POST', `/api/chats/${c.chatId}/crypto/envelopes`, { envelopes: [] }]
  ];
  for (const [method, url, body] of checks) assert.equal((await send('outsider', method, url, body)).statusCode, 404, `${method} ${url}`);
  assert.equal((await send('adm', 'GET', `/api/groups/999999`)).statusCode, 404);
  assert.equal((await send('adm', 'GET', `/api/groups/abc`)).statusCode, 404);
  assert.equal((await send('outsider', 'GET', '/api/chats')).json().some((x) => x.id === c.chatId), false);
  // members of a group must not use the 1:1 envelope route
  assert.equal((await send('bob', 'POST', `/api/chats/${c.chatId}/crypto/envelopes`, { envelopes: [] })).statusCode, 409);
  // delete group: owner only, removes the chat
  assert.equal((await send('bob', 'DELETE', `/api/groups/${c.id}`)).statusCode, 403);
  assert.equal((await send('adm', 'DELETE', `/api/groups/${c.id}`)).statusCode, 204);
  assert.equal((await send('bob', 'GET', `/api/groups/${c.id}`)).statusCode, 404);
  assert.equal((await send('bob', 'GET', `/api/chats/${c.chatId}/messages`)).statusCode, 404);
});

test('member cap is 100', async () => {
  const extra = [];
  for (let i = 0; i < 100; i += 1) {
    const uid = await createUser(`cap${i}`, `cap${i}`, 'a-long-password-9');
    await db.query(`INSERT INTO user_crypto_identities (user_id, public_jwk, fingerprint) VALUES ($1, json($2), $3)`, [uid, JSON.stringify({ kty: 'EC', crv: 'P-256', x: b64(32), y: b64(32) }), randomBytes(32).toString("hex")]);
    extra.push(String(uid));
  }
  assert.equal((await send('owner', 'POST', '/api/groups', { title: 'Big', memberIds: extra })).statusCode, 409); // 101 incl. creator
  const ok = await send('owner', 'POST', '/api/groups', { title: 'Big', memberIds: extra.slice(0, 98), envelopes: [{ userId: ids.owner, wrapped: wrap() }, ...extra.slice(0, 98).map((userId) => ({ userId, wrapped: wrap() }))] });
  assert.equal(ok.statusCode, 201); // 99 members
  assert.equal((await send('owner', 'POST', `/api/groups/${ok.json().id}/members`, { userId: extra[98], envelope: wrap() })).statusCode, 204); // 100
  assert.equal((await send('owner', 'POST', `/api/groups/${ok.json().id}/members`, { userId: extra[99], envelope: wrap() })).statusCode, 409); // 101
});
