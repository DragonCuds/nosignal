// S9c (independent review "A" and "B"): the membership / key-version / role checks of the message and group-key routes
// must be decided again INSIDE the write transaction. Each test pauses ONE request between its route gate and BEGIN
// (by wrapping db.connect in the test only), commits the changing event meanwhile, then lets the write continue.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-tx-gates-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'tx-gates-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;
process.env.CHANNEL_KEYRING = `test:${Buffer.alloc(32, 7).toString('base64url')}`;
process.env.CHANNEL_ACTIVE_KEY_ID = 'test';

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
const keys = {};
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
const b64 = (n) => randomBytes(n).toString('base64url');
const enc = () => ({ version: 2, cipherId: randomUUID(), nonce: b64(12), ciphertext: b64(40) });
const fpOf = (jwk) => createHash('sha256').update(`P-256:${jwk.x}:${jwk.y}`).digest('hex');
const send = async (user, method, url, payload) => {
  if (method === 'PUT' && /\/api\/groups\/\d+\/keys$/.test(url) && payload && !payload.expectedMembers) {
    const detail = await app.inject({ method: 'GET', url: url.replace(/\/keys$/, ''), headers: { origin, cookie: cookies[user] } });
    if (detail.statusCode === 200) payload = { ...payload, expectedMembers: detail.json().members.map((m) => ({ userId: m.id, fingerprint: fpOf(m.publicKey) })) };
  }
  return app.inject({ method, url, payload, remoteAddress: '10.0.0.1', headers: { origin, cookie: cookies[user] } });
};
const wrap = () => b64(60);
const envs = (...names) => names.map((n) => ({ userId: ids[n], wrapped: wrap() }));
const post = (user, chatId, keyVersion) => send(user, 'POST', `/api/chats/${chatId}/messages`, { kind: 'text', encrypted: enc(), keyVersion });
const count = async (chatId) => Number((await db.query('SELECT count(*) AS n FROM messages WHERE chat_id = $1', [chatId])).rows[0].n);

/**
 * Pause the NEXT db.connect() caller right before its BEGIN. Returns { arrived, resume }.
 * Everything after the first connect() is untouched, so the changing event can use the real routes meanwhile.
 */
const pauseNextTransaction = () => {
  const original = db.connect;
  let resume;
  let reached;
  const hold = new Promise((resolve) => { resume = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  db.connect = async function connect() {
    db.connect = original;
    const client = await original.call(db);
    const query = client.query.bind(client);
    client.query = async (sql, params) => {
      if (String(sql).trim().toUpperCase() === 'BEGIN') { reached(); await hold; }
      return query(sql, params);
    };
    return client;
  };
  return { arrived, resume };
};
/** Run `request` (a function returning the HTTP promise), pause it before BEGIN, run `change`, resume, return the response. */
const raceWith = async (request, change) => {
  const pause = pauseNextTransaction();
  const pending = request();
  await pause.arrived;
  try { await change(); } finally { pause.resume(); }
  return pending;
};

const newGroup = async (title, members, upload = true) => {
  const created = await send('owner', 'POST', '/api/groups', { title, memberIds: members.map((m) => ids[m]) });
  assert.equal(created.statusCode, 201, created.body);
  const group = { id: created.json().id, chatId: created.json().chatId };
  if (upload) assert.equal((await send('owner', 'PUT', `/api/groups/${group.id}/keys`, { version: 1, envelopes: envs('owner', ...members) })).statusCode, 204);
  return group;
};

before(async () => {
  await runMigrations();
  for (const name of ['owner', 'adm', 'bob', 'carol', 'alice', 'dan']) ids[name] = String(await createUser(name, name, 'a-long-password-9'));
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
    keys[name] = { x: b64(32), y: b64(32) };
    const jwk = { kty: 'EC', crv: 'P-256', ...keys[name] };
    assert.equal((await send(name, 'PUT', '/api/crypto/identity', { expectedUserId: ids[name], publicKey: jwk })).statusCode, 200);
  }
});
after(async () => { await app.close(); await db.end(); await rm(dataDir, { recursive: true, force: true }); });

test('group post: a rotation that commits after the route gate refuses the stale message (409)', async () => {
  const g = await newGroup('rotate', ['bob', 'carol']);
  assert.equal((await post('bob', g.chatId, 1)).statusCode, 201);
  const before = await count(g.chatId);
  const response = await raceWith(() => post('bob', g.chatId, 1), async () => {
    assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/members/${ids.carol}`)).statusCode, 204); // key must rotate now
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /rotation pending/);
  assert.equal(await count(g.chatId), before, 'nothing was written');
});

test('group post: a member removed after the route gate cannot write (404, same answer as outside the transaction)', async () => {
  const g = await newGroup('removed', ['bob', 'carol']);
  const response = await raceWith(() => post('bob', g.chatId, 1), async () => {
    assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/members/${ids.bob}`)).statusCode, 204);
  });
  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), { error: 'Chat not found' });
  assert.equal(await count(g.chatId), 0);
});

test('group edit: a removed member cannot rewrite their message after the route gate', async () => {
  const g = await newGroup('edit', ['bob', 'carol']);
  const posted = await post('bob', g.chatId, 1);
  assert.equal(posted.statusCode, 201);
  const original = (await db.query('SELECT ciphertext FROM messages WHERE id = $1', [posted.json().id])).rows[0].ciphertext;
  const response = await raceWith(
    () => send('bob', 'PATCH', `/api/chats/${g.chatId}/messages/${posted.json().id}`, { encrypted: enc(), keyVersion: 1 }),
    async () => { assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/members/${ids.bob}`)).statusCode, 204); }
  );
  assert.equal(response.statusCode, 404, response.body);
  assert.equal((await db.query('SELECT ciphertext FROM messages WHERE id = $1', [posted.json().id])).rows[0].ciphertext, original, 'the message was not changed');
});

test('group edit: a rotation after the route gate refuses the edit (409)', async () => {
  const g = await newGroup('edit-rot', ['bob', 'carol']);
  const posted = await post('bob', g.chatId, 1);
  const response = await raceWith(
    () => send('bob', 'PATCH', `/api/chats/${g.chatId}/messages/${posted.json().id}`, { encrypted: enc(), keyVersion: 1 }),
    async () => { assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/members/${ids.carol}`)).statusCode, 204); }
  );
  assert.equal(response.statusCode, 409, response.body);
});

test('group delete: an admin demoted after the route gate can no longer delete someone else\'s message', async () => {
  const g = await newGroup('delete', ['adm', 'bob']);
  assert.equal((await send('owner', 'POST', `/api/groups/${g.id}/admins/${ids.adm}`)).statusCode, 204);
  const posted = await post('bob', g.chatId, 1);
  assert.equal(posted.statusCode, 201);
  const response = await raceWith(
    () => send('adm', 'DELETE', `/api/chats/${g.chatId}/messages/${posted.json().id}`),
    async () => { assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/admins/${ids.adm}`)).statusCode, 204); }
  );
  assert.equal(response.statusCode, 404, response.body);
  assert.equal((await db.query('SELECT deleted_at FROM messages WHERE id = $1', [posted.json().id])).rows[0].deleted_at, null, 'message survived');
});

test('group delete: a member removed after the route gate cannot delete (404)', async () => {
  const g = await newGroup('delete-removed', ['bob', 'carol']);
  const posted = await post('bob', g.chatId, 1);
  const response = await raceWith(
    () => send('bob', 'DELETE', `/api/chats/${g.chatId}/messages/${posted.json().id}`),
    async () => { assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/members/${ids.bob}`)).statusCode, 204); }
  );
  assert.equal(response.statusCode, 404, response.body);
  assert.equal((await db.query('SELECT deleted_at FROM messages WHERE id = $1', [posted.json().id])).rows[0].deleted_at, null);
});

test('direct chat: a key reset or new version after the route gate refuses the old-key message', async () => {
  const chat = (await send('alice', 'POST', '/api/chats', { userId: ids.dan })).json().id;
  const envelope = (from, to) => ({ recipientId: ids[to], recipientFingerprint: fpOf(keys[to]), nonce: b64(12), ciphertext: b64(48) });
  const put = (version) => send('alice', 'POST', `/api/chats/${chat}/crypto/envelopes`, {
    version, senderFingerprint: fpOf(keys.alice), envelopes: [envelope('alice', 'alice'), envelope('alice', 'dan')]
  });
  assert.equal((await put(1)).statusCode, 201);
  assert.equal((await post('alice', chat, 1)).statusCode, 201);

  // (1) the peer starts a reset (pending version) between the gate and the write
  let response = await raceWith(() => post('alice', chat, 1), async () => {
    await db.query('UPDATE direct_chat_keys SET pending_version = key_version + 1 WHERE chat_id = $1', [chat]);
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().pendingKeyVersion, 2);
  assert.equal(await count(chat), 1);
  assert.equal((await put(2)).statusCode, 201); // new version exists, nothing pending

  // (2) a new version becomes current between the gate and the write
  response = await raceWith(() => post('alice', chat, 2), async () => {
    await db.query('UPDATE direct_chat_keys SET key_version = 3 WHERE chat_id = $1', [chat]);
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().keyVersion, 3);
  assert.equal(await count(chat), 1);
});

test('direct chat: a member removed from chat_members after the route gate cannot post', async () => {
  const chat = (await send('alice', 'POST', '/api/chats', { userId: ids.carol })).json().id;
  const response = await raceWith(() => post('alice', chat, undefined), async () => {
    await db.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chat, ids.alice]);
  });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(await count(chat), 0);
});

test('channel: an admin demoted after the route gate cannot post (403)', async () => {
  const created = await send('owner', 'POST', '/api/channels', { title: 'News' });
  const channel = created.json();
  const invite = (await send('owner', 'POST', `/api/channels/${channel.id}/invites`)).json();
  const joined = await send('adm', 'POST', `/api/channels/join/${invite.token}`);
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal((await send('owner', 'POST', `/api/channels/${channel.id}/admins/${ids.adm}`)).statusCode, 204);
  assert.equal((await post('adm', channel.chatId)).statusCode, 201);
  const response = await raceWith(() => post('adm', channel.chatId), async () => {
    assert.equal((await send('owner', 'DELETE', `/api/channels/${channel.id}/admins/${ids.adm}`)).statusCode, 204);
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(await count(channel.chatId), 1);
});

test('group key upload (PUT): an admin demoted after the route gate cannot publish the key (403)', async () => {
  const g = await newGroup('key-demote', ['adm', 'bob'], false);
  assert.equal((await send('owner', 'POST', `/api/groups/${g.id}/admins/${ids.adm}`)).statusCode, 204);
  const response = await raceWith(
    () => send('adm', 'PUT', `/api/groups/${g.id}/keys`, { version: 1, envelopes: envs('owner', 'adm', 'bob') }),
    async () => { assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/admins/${ids.adm}`)).statusCode, 204); }
  );
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(response.json(), { error: 'Only owners and admins can rotate the key' });
  assert.equal((await db.query('SELECT count(*) AS n FROM group_key_envelopes WHERE group_id = $1', [g.id])).rows[0].n, 0);
  const state = (await db.query('SELECT key_version, pending_version FROM groups WHERE id = $1', [g.id])).rows[0];
  assert.deepEqual(state, { key_version: 0, pending_version: 1 }, 'the group key did not move');
});

test('group key upload (PUT): an admin removed from the group after the route gate gets 403, not a crash', async () => {
  const g = await newGroup('key-removed', ['adm', 'bob'], false);
  assert.equal((await send('owner', 'POST', `/api/groups/${g.id}/admins/${ids.adm}`)).statusCode, 204);
  const response = await raceWith(
    () => send('adm', 'PUT', `/api/groups/${g.id}/keys`, { version: 1, envelopes: envs('owner', 'adm', 'bob') }),
    async () => { assert.equal((await send('owner', 'DELETE', `/api/groups/${g.id}/members/${ids.adm}`)).statusCode, 204); }
  );
  assert.equal(response.statusCode, 403, response.body);
});

test('sanity: with nothing changing in between, the same requests still succeed', async () => {
  const g = await newGroup('plain', ['adm', 'bob']);
  assert.equal((await raceWith(() => post('bob', g.chatId, 1), async () => undefined)).statusCode, 201);
});
