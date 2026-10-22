// NS-07b server side: group key envelopes record the wrapper's public key + fingerprint (taken from the server's own identity record,
// never from the request body), and "start fresh" deletes only the resetting member's OWN group envelopes.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-group-history-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'group-history-test-secret-with-at-least-32-bytes';
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
const ip = () => `10.11.${nextIp >> 8}.${nextIp++ & 255}`;
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
const send = (user, method, url, payload) => app.inject({ method, url, payload, remoteAddress: ip(), headers: { origin, cookie: cookies[user] } });
const b64 = (n) => randomBytes(n).toString('base64url');
const newKey = () => { const jwk = { kty: 'EC', crv: 'P-256', x: b64(32), y: b64(32) }; return { jwk, fp: createHash('sha256').update(`P-256:${jwk.x}:${jwk.y}`).digest('hex') }; };
const keys = {}; // user -> current { jwk, fp }

const setIdentity = async (user) => {
  keys[user] = newKey();
  const response = await send(user, 'PUT', '/api/crypto/identity', { expectedUserId: String(ids[user]), publicKey: keys[user].jwk });
  assert.equal(response.statusCode, 200, response.body);
};
const reset = async (user) => {
  const state = await send(user, 'GET', '/api/crypto/backup');
  const revision = state.statusCode === 404 ? 0 : state.json().revision;
  const grant = await send(user, 'POST', '/api/crypto/action-grant', { action: 'identity.reset', expectedRevision: revision, password: PASSWORD });
  assert.equal(grant.statusCode, 200, grant.body);
  const done = await send(user, 'POST', '/api/crypto/identity/reset', { expectedRevision: revision, actionToken: grant.json().token });
  assert.equal(done.statusCode, 204, done.body);
  delete keys[user];
};
const wrapped = () => b64(60);
/** `by` uploads `version` for `members`, exactly as the browser does (expectedMembers = what it sees on the server now). */
const putKeys = async (groupId, by, version, members, extra = {}) => {
  const detail = (await send(by, 'GET', `/api/groups/${groupId}`)).json();
  return send(by, 'PUT', `/api/groups/${groupId}/keys`, {
    version,
    expectedMembers: detail.members.map((member) => ({ userId: member.id, fingerprint: createHash('sha256').update(`P-256:${member.publicKey.x}:${member.publicKey.y}`).digest('hex') })),
    envelopes: members.map((m) => ({ userId: ids[m], wrapped: wrapped(), ...(extra.perEnvelope ?? {}) })),
    ...(extra.body ?? {})
  });
};
const rows = async (groupId) => (await db.query(
  'SELECT version, user_id, wrapped_by, wrapper_fingerprint, wrapper_public_jwk FROM group_key_envelopes WHERE group_id = $1 ORDER BY version, user_id', [groupId])).rows;

before(async () => {
  await runMigrations();
  for (const name of ['uma', 'pat', 'quin', 'rex']) ids[name] = String(await createUser(name, name, PASSWORD));
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
  for (const name of Object.keys(ids)) {
    cookies[name] = cookieOf(await app.inject({ method: 'GET', url: `/test/login/${ids[name]}`, headers: { origin } }));
    await setIdentity(name);
  }
});
after(async () => { await app.close(); await db.end(); await rm(dataDir, { recursive: true, force: true }); });

const S = {};
test('the server stores the uploader\'s CURRENT key and fingerprint with each envelope; the request body cannot choose them', async () => {
  // uma (owner) and pat (admin) wrap; quin is a member
  const created = await send('uma', 'POST', '/api/groups', { title: 'تاریخچه', memberIds: [ids.pat, ids.quin] });
  assert.equal(created.statusCode, 201, created.body);
  S.id = created.json().id;
  assert.equal((await send('uma', 'POST', `/api/groups/${S.id}/admins/${ids.pat}`)).statusCode, 204);
  const evil = newKey();
  const put = await putKeys(S.id, 'uma', 1, ['uma', 'pat', 'quin'], {
    body: { wrapperFingerprint: evil.fp, wrapperPublicKey: evil.jwk, wrapper_public_jwk: evil.jwk, wrappedBy: ids.rex },
    perEnvelope: { wrapperFingerprint: evil.fp, wrapperPublicKey: evil.jwk, wrappedBy: ids.rex }
  });
  assert.equal(put.statusCode, 204, put.body);
  const stored = await rows(S.id);
  assert.equal(stored.length, 3);
  for (const row of stored) {
    assert.equal(String(row.wrapped_by), ids.uma);
    assert.equal(row.wrapper_fingerprint, keys.uma.fp, 'from user_crypto_identities, not from the body');
    assert.deepEqual(JSON.parse(row.wrapper_public_jwk), keys.uma.jwk);
  }
  const mine = (await send('pat', 'GET', `/api/groups/${S.id}/keys?version=latest`)).json();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].wrappedBy, ids.uma);
  assert.equal(mine[0].wrapperFingerprint, keys.uma.fp);
  assert.deepEqual(mine[0].wrapperPublicKey, keys.uma.jwk);
  S.uma1 = keys.uma;
});

test('another wrapper: each version carries its own wrapper key', async () => {
  // quin leaves nothing; pat rotates to version 2 after adding rex (membership change sets a pending version)
  assert.equal((await send('uma', 'POST', `/api/groups/${S.id}/members`, { userId: ids.rex })).statusCode, 204);
  assert.equal((await putKeys(S.id, 'pat', 2, ['uma', 'pat', 'quin', 'rex'])).statusCode, 204);
  const v2 = (await rows(S.id)).filter((row) => row.version === 2);
  assert.equal(v2.length, 4);
  assert.ok(v2.every((row) => String(row.wrapped_by) === ids.pat && row.wrapper_fingerprint === keys.pat.fp));
  const all = (await send('quin', 'GET', `/api/groups/${S.id}/keys`)).json();
  assert.deepEqual(all.map((e) => [e.version, e.wrappedBy, e.wrapperFingerprint]), [[1, ids.uma, keys.uma.fp], [2, ids.pat, keys.pat.fp]]);
});

test('start fresh deletes only the resetting member\'s OWN envelopes; what she wrapped for others stays with her old key', async () => {
  assert.equal((await rows(S.id)).length, 7);
  await reset('uma');
  const after = await rows(S.id);
  assert.equal(after.length, 5, 'her two envelopes (recipient uma, versions 1 and 2) are gone, the other five stay');
  assert.ok(after.every((row) => String(row.user_id) !== ids.uma));
  const wrappedByUma = after.filter((row) => String(row.wrapped_by) === ids.uma);
  assert.deepEqual(wrappedByUma.map((row) => [String(row.user_id), row.version]).sort(), [[ids.pat, 1], [ids.quin, 1]].sort());
  for (const row of wrappedByUma) assert.equal(row.wrapper_fingerprint, S.uma1.fp, 'the stored wrapper key is the one from before the reset');
  // everyone else still gets every version
  assert.deepEqual((await send('pat', 'GET', `/api/groups/${S.id}/keys`)).json().map((e) => e.version), [1, 2]);
  assert.deepEqual((await send('quin', 'GET', `/api/groups/${S.id}/keys`)).json().map((e) => e.version), [1, 2]);
  assert.deepEqual((await send('uma', 'GET', `/api/groups/${S.id}/keys`)).json(), [], 'uma starts fresh in this group');
  // the usual rotation flow: posting waits for a new version, the group says so
  const detail = (await send('pat', 'GET', `/api/groups/${S.id}`)).json();
  assert.equal(detail.keyVersion, 2);
  assert.equal(detail.pendingKeyVersion, 3);
  assert.equal(detail.members.find((m) => m.id === ids.uma).publicKey, null, 'uma has no identity until she registers a new one');
});

test('rotation after the reset: the new identity gets a new envelope; old rows keep the old wrapper key; the new rows carry the CURRENT key', async () => {
  await setIdentity('uma');                      // uma registers her NEW identity
  assert.notEqual(keys.uma.fp, S.uma1.fp);
  assert.equal((await putKeys(S.id, 'uma', 3, ['uma', 'pat', 'quin', 'rex'])).statusCode, 204);   // she rotates herself (owner)
  const v3 = (await rows(S.id)).filter((row) => row.version === 3);
  assert.equal(v3.length, 4);
  assert.ok(v3.every((row) => row.wrapper_fingerprint === keys.uma.fp && String(row.wrapped_by) === ids.uma));
  const old = (await rows(S.id)).filter((row) => row.version === 1);
  assert.equal(old.length, 2);
  assert.ok(old.every((row) => row.wrapper_fingerprint === S.uma1.fp), 'version 1 still says which key wrapped it');
  assert.deepEqual((await send('uma', 'GET', `/api/groups/${S.id}/keys`)).json().map((e) => e.version), [3]);
});

test('a second reset (the admin pat): his own envelopes go, the version-2 envelopes he wrapped for others stay with his old key, the owner rotates', async () => {
  const patOld = keys.pat;
  await reset('pat');
  assert.deepEqual((await rows(S.id)).filter((row) => String(row.user_id) === ids.pat), []);
  const patWrapped = (await rows(S.id)).filter((row) => String(row.wrapped_by) === ids.pat);
  assert.deepEqual(patWrapped.map((row) => [String(row.user_id), row.version]).sort(), [[ids.quin, 2], [ids.rex, 2]].sort());
  assert.ok(patWrapped.every((row) => row.wrapper_fingerprint === patOld.fp));
  await setIdentity('pat');
  assert.equal((await send('uma', 'GET', `/api/groups/${S.id}`)).json().pendingKeyVersion, 4);
  assert.equal((await putKeys(S.id, 'uma', 4, ['uma', 'pat', 'quin', 'rex'])).statusCode, 204);
  assert.deepEqual((await send('pat', 'GET', `/api/groups/${S.id}/keys`)).json().map((e) => e.version), [4]);
  assert.deepEqual((await send('quin', 'GET', `/api/groups/${S.id}/keys`)).json().map((e) => [e.version, e.wrapperFingerprint === patOld.fp ? 'pat-old' : e.wrapperFingerprint === S.uma1.fp ? 'uma-old' : 'other']),
    [[1, 'uma-old'], [2, 'pat-old'], [3, 'other'], [4, 'other']]);
});

test('resetting leaves other groups and other people\'s envelopes alone', async () => {
  const before = (await rows(S.id)).filter((row) => String(row.user_id) !== ids.rex).length;
  // rex is in no other group, and a user without any group envelope can reset without touching anything
  const other = await send('rex', 'POST', '/api/groups', { title: 'دوم', memberIds: [ids.quin] });
  assert.equal(other.statusCode, 201, other.body);
  assert.equal((await putKeys(other.json().id, 'rex', 1, ['rex', 'quin'])).statusCode, 204);
  const rexRowsBefore = (await rows(S.id)).filter((row) => String(row.user_id) === ids.rex).length;
  await reset('rex');
  assert.equal((await rows(S.id)).filter((row) => String(row.user_id) === ids.rex).length, 0, `rex had ${rexRowsBefore}`);
  assert.equal((await rows(S.id)).filter((row) => String(row.user_id) !== ids.rex).length, before, 'nobody else lost an envelope in the first group');
  const second = await rows(other.json().id);
  assert.deepEqual(second.map((row) => String(row.user_id)), [ids.quin], 'quin keeps her envelope in the second group (wrapped by rex)');
  assert.equal((await send('quin', 'GET', `/api/groups/${other.json().id}/keys`)).json()[0].wrapperFingerprint !== null, true);
});
