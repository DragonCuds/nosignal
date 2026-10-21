// NS-07: direct-chat key epochs. Server side: version rows, per-version envelopes with the sender key, the current-version gate
// on send/edit, reset removing only the resetting user's envelopes, concurrent creators, Saved Messages, the 32-version cap.
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-dm-epochs-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'dm-epochs-test-secret-with-at-least-32-bytes';
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
const { registerCryptoBackupRoutes } = await load('cryptoBackup.js');

const PASSWORD = 'a-long-password-9';
let app;
const ids = {};
const cookies = {};
let nextIp = 1;
const ip = () => `10.9.${nextIp >> 8}.${nextIp++ & 255}`;
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
const send = (user, method, url, payload) => app.inject({ method, url, payload, remoteAddress: ip(), headers: { origin, cookie: cookies[user] } });
const b64 = (n) => randomBytes(n).toString('base64url');
const enc = () => ({ version: 2, cipherId: randomUUID(), nonce: b64(12), ciphertext: b64(40) });
const newKey = () => { const jwk = { kty: 'EC', crv: 'P-256', x: b64(32), y: b64(32) }; return { jwk, fp: createHash('sha256').update(`P-256:${jwk.x}:${jwk.y}`).digest('hex') }; };
const keys = {}; // user -> current { jwk, fp }

const setIdentity = async (user) => {
  keys[user] = newKey();
  const response = await send(user, 'PUT', '/api/crypto/identity', { expectedUserId: String(ids[user]), publicKey: keys[user].jwk });
  assert.equal(response.statusCode, 200, response.body);
};
const makeChat = async (a, b) => {
  const response = await send(a, 'POST', '/api/chats', { userId: ids[b] });
  assert.ok([200, 201].includes(response.statusCode), response.body);
  return response.json().id;
};
/** Envelope body as the browser sends it: `by` wraps for every member (fingerprints = what it sees on the server now). */
const body = (version, by, members, patch = {}) => ({
  version, senderFingerprint: keys[by].fp,
  envelopes: members.map((m) => ({ recipientId: ids[m], recipientFingerprint: keys[m].fp, nonce: b64(12), ciphertext: b64(48) })),
  ...patch
});
const putKey = (chatId, version, by, members) => send(by, 'POST', `/api/chats/${chatId}/crypto/envelopes`, body(version, by, members));
const post = (user, chatId, keyVersion) => send(user, 'POST', `/api/chats/${chatId}/messages`, { kind: 'text', encrypted: enc(), keyVersion, clientMsgId: `cm-${randomUUID()}` });
const reset = async (user) => {
  const state = await send(user, 'GET', '/api/crypto/backup');
  const revision = state.statusCode === 404 ? 0 : state.json().revision;
  const grant = await send(user, 'POST', '/api/crypto/action-grant', { action: 'identity.reset', expectedRevision: revision, password: PASSWORD });
  assert.equal(grant.statusCode, 200, grant.body);
  const done = await send(user, 'POST', '/api/crypto/identity/reset', { expectedRevision: revision, actionToken: grant.json().token });
  assert.equal(done.statusCode, 204, done.body);
  delete keys[user];
};
const stateOf = async (user, chatId) => (await send(user, 'GET', `/api/chats/${chatId}/crypto`)).json();
const rowOf = async (chatId) => (await db.query('SELECT key_version, pending_version FROM direct_chat_keys WHERE chat_id = $1', [chatId])).rows[0];

before(async () => {
  await runMigrations();
  for (const name of ['alice', 'bob', 'carol', 'dave', 'erin']) ids[name] = await createUser(name, name, PASSWORD);
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 10_000, timeWindow: '1 minute' });
  app.addHook('onRequest', auth.requireTrustedOrigin);
  app.decorate('requireUser', auth.requireUser);
  app.decorate('realtime', { broadcastToChat: () => undefined });
  app.get('/test/login/:id', async (request, reply) => { await auth.createSession(request.params.id, reply, request); return { ok: true }; });
  await registerCryptoRoutes(app);
  await registerCryptoBackupRoutes(app);
  await registerChatRoutes(app);
  await app.ready();
  for (const name of Object.keys(ids)) cookies[name] = cookieOf(await app.inject({ method: 'GET', url: `/test/login/${ids[name]}`, headers: { origin } }));
});
after(async () => { await app.close(); await db.end(); await rm(dataDir, { recursive: true, force: true }); });

let chatAB;
test('first key: required fields, wrong version 409, member without identity 409, then 201 with the sender key stored', async () => {
  await setIdentity('alice');
  chatAB = await makeChat('alice', 'bob');
  assert.deepEqual(await stateOf('alice', chatAB).then((s) => [s.keyVersion, s.pendingKeyVersion, s.envelope, s.envelopes]), [0, null, null, []]);
  assert.equal((await putKey(chatAB, 1, 'alice', ['alice', 'bob'].filter((m) => keys[m]))).statusCode, 400, 'bob has no envelope slot yet (one envelope instead of two)');
  await setIdentity('bob');
  const noVersion = body(1, 'alice', ['alice', 'bob']); delete noVersion.version;
  assert.equal((await send('alice', 'POST', `/api/chats/${chatAB}/crypto/envelopes`, noVersion)).statusCode, 400);
  const noFp = body(1, 'alice', ['alice', 'bob']); delete noFp.senderFingerprint;
  assert.equal((await send('alice', 'POST', `/api/chats/${chatAB}/crypto/envelopes`, noFp)).statusCode, 400);
  const noRecipientFp = body(1, 'alice', ['alice', 'bob']); delete noRecipientFp.envelopes[1].recipientFingerprint;
  assert.equal((await send('alice', 'POST', `/api/chats/${chatAB}/crypto/envelopes`, noRecipientFp)).statusCode, 400);
  assert.equal((await putKey(chatAB, 2, 'alice', ['alice', 'bob'])).statusCode, 409, 'a first key must be version 1');
  assert.equal((await send('alice', 'POST', `/api/chats/${chatAB}/crypto/envelopes`, body(1, 'alice', ['alice', 'bob'], { senderFingerprint: keys.bob.fp }))).statusCode, 409, 'sender fingerprint must be the caller\'s current identity');
  const staleRecipient = body(1, 'alice', ['alice', 'bob']); staleRecipient.envelopes[1].recipientFingerprint = newKey().fp;
  assert.equal((await send('alice', 'POST', `/api/chats/${chatAB}/crypto/envelopes`, staleRecipient)).statusCode, 409, 'the recipient key used must be the recipient\'s current identity');
  assert.equal((await rowOf(chatAB)), undefined, 'nothing was stored by the rejected attempts');

  const created = await putKey(chatAB, 1, 'alice', ['alice', 'bob']);
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(await rowOf(chatAB), { key_version: 1, pending_version: null });
  const forBob = await stateOf('bob', chatAB);
  assert.equal(forBob.keyVersion, 1);
  assert.equal(forBob.envelopes.length, 1);
  assert.equal(forBob.envelopes[0].senderId, ids.alice);
  assert.equal(forBob.envelopes[0].senderFingerprint, keys.alice.fp);
  assert.deepEqual(forBob.envelopes[0].senderPublicKey, keys.alice.jwk);
  assert.equal(forBob.envelope.version, 1, 'legacy field still carries the current envelope');
  // repeating the same version is a no-op (the other browser won the race)
  const again = await putKey(chatAB, 1, 'bob', ['alice', 'bob']);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((await db.query('SELECT count(*) AS n FROM chat_key_envelopes WHERE chat_id = $1', [chatAB])).rows[0].n, 2);
  assert.equal((await db.query('SELECT sender_id FROM chat_key_envelopes WHERE chat_id = $1 GROUP BY sender_id', [chatAB])).rowCount, 1, 'the first creator\'s envelopes were kept');
  assert.equal((await putKey(chatAB, 3, 'bob', ['alice', 'bob'])).statusCode, 409, 'a version that nobody asked for');
});

test('server enforces the current key version on send and edit', async () => {
  assert.equal((await post('alice', chatAB, undefined)).statusCode, 400, 'unversioned message');
  const stale = await post('alice', chatAB, 2);
  assert.equal(stale.statusCode, 400);
  assert.equal(stale.json().keyVersion, 1, 'the answer names the current version so the tab can re-fetch');
  const sent = await post('alice', chatAB, 1);
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal(sent.json().encrypted.keyVersion, 1);
  const list = (await send('bob', 'GET', `/api/chats/${chatAB}/messages`)).json();
  assert.equal(list[0].encrypted.keyVersion, 1, 'readers see which version sealed it');
  const edit = (keyVersion) => send('alice', 'PATCH', `/api/chats/${chatAB}/messages/${sent.json().id}`, { encrypted: enc(), keyVersion });
  assert.equal((await edit(undefined)).statusCode, 400);
  assert.equal((await edit(2)).statusCode, 400);
  assert.equal((await edit(1)).statusCode, 200);
  assert.equal((await send('bob', 'DELETE', `/api/chats/${chatAB}/messages/${sent.json().id}`)).statusCode, 404, 'delete is not version gated (still only the sender)');
  assert.equal((await send('alice', 'DELETE', `/api/chats/${chatAB}/messages/${sent.json().id}`)).statusCode, 200);
});

test('a chat that never had a key row (channels, unopened chats) must not claim a key version', async () => {
  await setIdentity('carol');
  const empty = await makeChat('alice', 'carol');
  assert.equal((await post('alice', empty, 1)).statusCode, 400);
  assert.equal((await post('alice', empty, undefined)).statusCode, 201, 'an unversioned message in a chat without any key row is accepted as before (version 1 on the reading side)');
});

test('reset removes only the resetting user\'s envelopes; the contact keeps the old version and its sender key', async () => {
  const oldBob = keys.bob;
  await reset('bob');
  assert.deepEqual(await rowOf(chatAB), { key_version: 1, pending_version: 2 });
  const holders = (await db.query('SELECT recipient_id, version FROM chat_key_envelopes WHERE chat_id = $1', [chatAB])).rows;
  assert.deepEqual(holders.map((r) => `${r.recipient_id}:${r.version}`), [`${ids.alice}:1`]);
  const forAlice = await stateOf('alice', chatAB);
  assert.equal(forAlice.pendingKeyVersion, 2);
  assert.equal(forAlice.envelopes.length, 1);
  assert.equal(forAlice.envelopes[0].version, 1);
  assert.equal(forAlice.envelopes[0].senderFingerprint, keys.alice.fp, 'old envelope keeps the key it was wrapped with');
  assert.equal(forAlice.members.find((m) => m.userId === ids.bob).publicKey, null, 'bob has no identity until he registers a new one');
  // nobody can send while the new version is missing
  const blocked = await post('alice', chatAB, 1);
  assert.equal(blocked.statusCode, 409);
  assert.deepEqual([blocked.json().keyVersion, blocked.json().pendingKeyVersion], [1, 2]);
  assert.equal((await post('alice', chatAB, 2)).statusCode, 409);
  assert.equal((await send('alice', 'PATCH', `/api/chats/${chatAB}/messages/1`, { encrypted: enc(), keyVersion: 1 })).statusCode, 409);
  // bob has not registered yet: the version cannot be created
  keys.bob = oldBob; // the browser still only knows bob's previous key: the server has no identity for him
  assert.equal((await putKey(chatAB, 2, 'alice', ['alice', 'bob'])).statusCode, 409);
  delete keys.bob;
  await setIdentity('bob');
  assert.notEqual(keys.bob.fp, oldBob.fp);
  // wrong versions
  assert.equal((await putKey(chatAB, 1, 'alice', ['alice', 'bob'])).statusCode, 409, 'cannot recreate the old version');
  assert.equal((await putKey(chatAB, 3, 'alice', ['alice', 'bob'])).statusCode, 409);
});

test('two browsers creating the same new version: one wins, the other gets a harmless 200', async () => {
  const results = await Promise.all([putKey(chatAB, 2, 'alice', ['alice', 'bob']), putKey(chatAB, 2, 'bob', ['alice', 'bob'])]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 201], results.map((r) => r.body).join(' | '));
  assert.deepEqual(await rowOf(chatAB), { key_version: 2, pending_version: null });
  const all = (await db.query('SELECT recipient_id, version, sender_id FROM chat_key_envelopes WHERE chat_id = $1 ORDER BY version, recipient_id', [chatAB])).rows;
  assert.equal(all.length, 3, 'v1 for alice + v2 for both');
  assert.equal(new Set(all.filter((r) => r.version === 2).map((r) => r.sender_id)).size, 1, 'both v2 envelopes come from the same creator');
  // old messages stay at their version, new ones need version 2
  assert.equal((await post('alice', chatAB, 1)).statusCode, 400);
  assert.equal((await post('alice', chatAB, 2)).statusCode, 201);
  assert.equal((await post('bob', chatAB, 2)).statusCode, 201);
  const forAlice = await stateOf('alice', chatAB);
  assert.deepEqual(forAlice.envelopes.map((e) => e.version), [2, 1], 'newest first');
  assert.equal(forAlice.envelopes.find((e) => e.version === 1).senderFingerprint, keys.alice.fp);
  const forBob = await stateOf('bob', chatAB);
  assert.deepEqual(forBob.envelopes.map((e) => e.version), [2], 'bob (new identity) only has the new version');
  // the old sender key of a creator that later reset stays attached to the envelopes it wrapped
  const v2Creator = all.find((r) => r.version === 2).sender_id;
  const creator = v2Creator === ids.alice ? 'alice' : 'bob';
  assert.equal(forAlice.envelopes[0].senderFingerprint, keys[creator].fp);
});

test('an incomplete envelope set no longer ends in a 500: the server asks for a new version instead', async () => {
  await setIdentity('dave');
  const chat = await makeChat('carol', 'dave');
  assert.equal((await putKey(chat, 1, 'carol', ['carol', 'dave'])).statusCode, 201);
  await db.query('DELETE FROM chat_key_envelopes WHERE chat_id = $1 AND recipient_id = $2', [chat, ids.carol]);
  const attempt = await putKey(chat, 1, 'carol', ['carol', 'dave']);
  assert.equal(attempt.statusCode, 409, attempt.body);
  assert.deepEqual([attempt.json().keyVersion, attempt.json().pendingKeyVersion], [1, 2]);
  assert.deepEqual(await rowOf(chat), { key_version: 1, pending_version: 2 });
  assert.equal((await putKey(chat, 2, 'carol', ['carol', 'dave'])).statusCode, 201);
  assert.deepEqual(await rowOf(chat), { key_version: 2, pending_version: null });
  assert.equal((await post('carol', chat, 2)).statusCode, 201);
});

test('envelopes without a version row are adopted (no primary-key 500)', async () => {
  await setIdentity('erin');
  const chat = await makeChat('dave', 'erin');
  for (const [r, s] of [[ids.dave, ids.dave], [ids.erin, ids.dave]]) {
    await db.query('INSERT INTO chat_key_envelopes (chat_id, recipient_id, sender_id, version, nonce, ciphertext) VALUES ($1, $2, $3, 1, $4, $5)', [chat, r, s, b64(16), b64(60)]);
  }
  const response = await putKey(chat, 1, 'erin', ['dave', 'erin']);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await rowOf(chat), { key_version: 1, pending_version: null });
});

test('Saved Messages: reset removes the only envelope; the next version is created by its owner', async () => {
  const saved = (await send('dave', 'POST', '/api/chats/saved')).json().id;
  const one = (version) => send('dave', 'POST', `/api/chats/${saved}/crypto/envelopes`, body(version, 'dave', ['dave']));
  assert.equal((await one(1)).statusCode, 201);
  assert.equal((await post('dave', saved, 1)).statusCode, 201);
  await reset('dave');
  assert.equal((await db.query('SELECT 1 FROM chat_key_envelopes WHERE chat_id = $1', [saved])).rowCount, 0);
  assert.deepEqual(await rowOf(saved), { key_version: 1, pending_version: 2 });
  assert.equal((await post('dave', saved, 1)).statusCode, 409);
  await setIdentity('dave');
  assert.equal((await one(1)).statusCode, 409);
  assert.equal((await one(2)).statusCode, 201);
  assert.equal((await post('dave', saved, 2)).statusCode, 201);
  assert.deepEqual((await stateOf('dave', saved)).envelopes.map((e) => e.version), [2]);
});

test('the response carries at most the newest 32 versions; creating more versions is never refused', async () => {
  const chat = await makeChat('carol', 'erin');
  assert.equal((await putKey(chat, 1, 'carol', ['carol', 'erin'])).statusCode, 201);
  const senderJwk = JSON.stringify(keys.carol.jwk);
  for (let version = 2; version <= 40; version += 1) {
    for (const user of ['carol', 'erin']) {
      await db.query(
        'INSERT INTO chat_key_envelopes (chat_id, version, recipient_id, sender_id, sender_fingerprint, sender_public_jwk, nonce, ciphertext) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [chat, version, ids[user], ids.carol, keys.carol.fp, senderJwk, b64(16), b64(60)]);
    }
  }
  await db.query('UPDATE direct_chat_keys SET key_version = 40 WHERE chat_id = $1', [chat]);
  const state = await stateOf('erin', chat);
  assert.equal(state.envelopes.length, 32);
  assert.deepEqual([state.envelopes[0].version, state.envelopes[31].version], [40, 9]);
  assert.equal(state.keyVersion, 40);
  assert.equal((await db.query('SELECT count(*) AS n FROM chat_key_envelopes WHERE chat_id = $1 AND recipient_id = $2', [chat, ids.erin])).rows[0].n, 40, 'nothing was deleted for the cap');
  await db.query('UPDATE direct_chat_keys SET pending_version = 41 WHERE chat_id = $1', [chat]);
  assert.equal((await putKey(chat, 41, 'erin', ['carol', 'erin'])).statusCode, 201);
});

test('migration 019 is recorded', async () => {
  assert.equal((await db.query("SELECT name FROM schema_migrations WHERE name = '019_dm_key_epochs.sql'")).rowCount, 1);
});
