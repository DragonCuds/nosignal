import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-crypto-backup-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'crypto-backup-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;
process.env.OPEN_REGISTRATION = '1';

const load = (name) => import(path.join(dist, name));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const { runMigrations } = await load('migrate.js');
const { db } = await load('db.js');
const { requireTrustedOrigin, requireUser, resetLoginAttempts } = await load('auth.js');
const { registerRegistration, resetRegistrationLimits } = await load('registration.js');
const { registerCryptoRoutes } = await load('crypto.js');
const { registerCryptoBackupRoutes } = await load('cryptoBackup.js');

let app;
let nextIp = 1;
const ip = () => `10.8.${nextIp >> 8}.${nextIp++ & 255}`;
const signup = async (username, password = 'correct-horse') => {
  const response = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password }, remoteAddress: ip(), headers: { origin } });
  assert.equal(response.statusCode, 204, response.body);
  return response.headers['set-cookie'].split(';')[0];
};
const call = (cookie, method, url, payload, ipOverride) => app.inject({ method, url, payload, headers: { origin, cookie }, remoteAddress: ipOverride ?? ip() });
const b64 = (n) => 'A'.repeat(n);
const goodBlob = (extra = {}) => ({ salt: b64(22), iterations: 600_000, wrapped: b64(300), version: 1, ...extra });
const pub = (seed) => ({ kty: 'EC', crv: 'P-256', x: `${seed}`.repeat(43).slice(0, 43), y: `${seed}`.repeat(43).slice(0, 43) });

before(async () => {
  await runMigrations();
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 1_000, timeWindow: '1 minute' });
  app.addHook('onRequest', requireTrustedOrigin);
  app.decorate('requireUser', requireUser);
  await registerRegistration(app);
  await registerCryptoRoutes(app);
  await registerCryptoBackupRoutes(app);
  await app.ready();
});
after(async () => { await app.close(); await db.end(); await rm(dataDir, { recursive: true, force: true }); });

test('all endpoints require a session', async () => {
  for (const [method, url, payload] of [['GET', '/api/crypto/backup'], ['PUT', '/api/crypto/backup', goodBlob()], ['DELETE', '/api/crypto/backup'], ['POST', '/api/crypto/identity/reset', { password: 'x' }]]) {
    const response = await app.inject({ method, url, payload, headers: { origin } });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});

test('GET is 404 until something is stored; PUT stores one row per user; PUT replaces', async () => {
  const cookie = await signup('bk_one');
  assert.equal((await call(cookie, 'GET', '/api/crypto/backup')).statusCode, 404);
  assert.equal((await call(cookie, 'PUT', '/api/crypto/backup', goodBlob())).statusCode, 204);
  const got = await call(cookie, 'GET', '/api/crypto/backup');
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['cache-control'], 'no-store');
  assert.equal(got.json().mode, 'auto');
  assert.deepEqual(got.json().backup, goodBlob());
  assert.equal((await call(cookie, 'PUT', '/api/crypto/backup', goodBlob({ wrapped: b64(400), iterations: 700_000 }))).statusCode, 204);
  assert.equal((await call(cookie, 'GET', '/api/crypto/backup')).json().backup.iterations, 700_000);
  const user = (await db.query('SELECT id FROM users WHERE username = $1', ['bk_one'])).rows[0];
  assert.equal((await db.query('SELECT 1 FROM user_crypto_backups WHERE user_id = $1', [user.id])).rowCount, 1);
});

test('validation: weak KDF cost, bad base64, oversize, wrong version and unknown shapes are rejected', async () => {
  const cookie = await signup('bk_valid');
  for (const bad of [
    goodBlob({ iterations: 1000 }), goodBlob({ iterations: 600_000.5 }), goodBlob({ iterations: 99_000_000 }), goodBlob({ iterations: '600000' }),
    goodBlob({ salt: 'short' }), goodBlob({ salt: '!'.repeat(22) }), goodBlob({ wrapped: b64(10) }), goodBlob({ wrapped: b64(5_000) }),
    goodBlob({ wrapped: 'a b'.repeat(20) }), goodBlob({ version: 2 }), goodBlob({ version: undefined }), {}
  ]) assert.equal((await call(cookie, 'PUT', '/api/crypto/backup', bad)).statusCode, 400, JSON.stringify(bad).slice(0, 80));
  const huge = await call(cookie, 'PUT', '/api/crypto/backup', { ...goodBlob(), junk: 'x'.repeat(40_000) });
  assert.equal(huge.statusCode, 413);
  assert.equal((await call(cookie, 'GET', '/api/crypto/backup')).statusCode, 404);
});

test('users only ever see their own row (no way to name another user)', async () => {
  const a = await signup('bk_a');
  const b = await signup('bk_b');
  assert.equal((await call(a, 'PUT', '/api/crypto/backup', goodBlob({ salt: b64(24) }))).statusCode, 204);
  assert.equal((await call(b, 'GET', '/api/crypto/backup')).statusCode, 404);
  assert.equal((await call(b, 'GET', '/api/crypto/backup?user_id=1&userId=1')).statusCode, 404);
  assert.equal((await call(a, 'GET', '/api/crypto/backup')).json().backup.salt, b64(24));
  const other = await call(b, 'PUT', '/api/crypto/backup', { ...goodBlob({ salt: b64(30) }), userId: 'x', user_id: 1 });
  assert.equal(other.statusCode, 204);
  assert.equal((await call(a, 'GET', '/api/crypto/backup')).json().backup.salt, b64(24), 'A untouched by B');
});

test('DELETE removes the copy and records mode "manual"; PUT switches back to auto', async () => {
  const cookie = await signup('bk_del');
  await call(cookie, 'PUT', '/api/crypto/backup', goodBlob());
  assert.equal((await call(cookie, 'DELETE', '/api/crypto/backup')).statusCode, 204);
  const got = await call(cookie, 'GET', '/api/crypto/backup');
  assert.equal(got.statusCode, 200);
  assert.deepEqual([got.json().mode, got.json().backup], ['manual', null]);
  assert.equal((await call(cookie, 'DELETE', '/api/crypto/backup')).statusCode, 204, 'idempotent');
  assert.equal((await call(cookie, 'PUT', '/api/crypto/backup', goodBlob())).statusCode, 204);
  assert.equal((await call(cookie, 'GET', '/api/crypto/backup')).json().mode, 'auto');
});

test('identity reset needs the right password, clears identity + envelopes + stored blob, keeps the mode', async () => {
  resetLoginAttempts();
  const cookie = await signup('bk_reset', 'right-password');
  const peer = await signup('bk_reset_peer');
  assert.equal((await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('a') })).statusCode, 200);
  assert.equal((await call(peer, 'PUT', '/api/crypto/identity', { publicKey: pub('b') })).statusCode, 200);
  assert.equal((await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('c') })).statusCode, 409, 'identity is bound');
  await call(cookie, 'PUT', '/api/crypto/backup', goodBlob());
  const me = (await db.query('SELECT id FROM users WHERE username = $1', ['bk_reset'])).rows[0].id;
  const other = (await db.query('SELECT id FROM users WHERE username = $1', ['bk_reset_peer'])).rows[0].id;
  const chat = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)', [chat, me, other]);
  for (const [r, s] of [[me, me], [other, me]]) await db.query("INSERT INTO chat_key_envelopes (chat_id, recipient_id, sender_id, version, nonce, ciphertext) VALUES ($1, $2, $3, 1, $4, $5)", [chat, r, s, b64(16), b64(60)]);

  assert.equal((await call(cookie, 'POST', '/api/crypto/identity/reset', {})).statusCode, 400);
  assert.equal((await call(cookie, 'POST', '/api/crypto/identity/reset', { password: 'wrong-password' })).statusCode, 403);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [me])).rowCount, 1, 'wrong password changes nothing');
  assert.equal((await call(cookie, 'POST', '/api/crypto/identity/reset', { password: 'right-password' })).statusCode, 204);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [me])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [other])).rowCount, 1, 'peer identity untouched');
  assert.equal((await db.query('SELECT 1 FROM chat_key_envelopes WHERE chat_id = $1', [chat])).rowCount, 0);
  const got = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  assert.deepEqual([got.mode, got.backup], ['auto', null]);
  assert.equal((await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('c') })).statusCode, 200, 'new identity can be bound');
});

test('password-check accepts only the right password', async () => {
  resetLoginAttempts();
  const cookie = await signup('bk_check', 'check-password');
  assert.equal((await call(cookie, 'POST', '/api/crypto/password-check', { password: 'check-password' })).statusCode, 204);
  assert.equal((await call(cookie, 'POST', '/api/crypto/password-check', { password: 'other-password' })).statusCode, 403);
  assert.equal((await call(cookie, 'POST', '/api/crypto/password-check', {})).statusCode, 400);
});

test('reset is throttled per account', async () => {
  resetLoginAttempts();
  const cookie = await signup('bk_throttle');
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call(cookie, 'POST', '/api/crypto/identity/reset', { password: 'nope-nope' })).statusCode;
  assert.ok([429].includes(last), `got ${last}`);
});

test('account deletion purges the stored copy', async () => {
  const cookie = await signup('bk_purge');
  await call(cookie, 'PUT', '/api/crypto/backup', goodBlob());
  const id = (await db.query('SELECT id FROM users WHERE username = $1', ['bk_purge'])).rows[0].id;
  assert.equal((await db.query('SELECT 1 FROM user_crypto_backups WHERE user_id = $1', [id])).rowCount, 1);
  await db.query('DELETE FROM users WHERE id = $1', [id]);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_backups WHERE user_id = $1', [id])).rowCount, 0);
});

test('new identity + backup in ONE request: no 404 afterwards; invalid blob rejected and nothing stored; existing identity ignores the blob', async () => {
  const cookie = await signup('bk_atomic');
  const bad = await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('b'), backup: goodBlob({ iterations: 10 }) });
  assert.equal(bad.statusCode, 400);
  assert.equal((await call(cookie, 'GET', '/api/crypto/backup')).statusCode, 404);
  const ok = await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('b'), backup: goodBlob() });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().backupSaved, true);
  const got = await call(cookie, 'GET', '/api/crypto/backup');
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().mode, 'auto');
  assert.deepEqual(got.json().backup, goodBlob());
  // same identity again: idempotent, blob ignored
  const again = await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('b'), backup: goodBlob({ wrapped: b64(500) }) });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().backupSaved, false);
  assert.deepEqual((await call(cookie, 'GET', '/api/crypto/backup')).json().backup, goodBlob());
  assert.equal((await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('c'), backup: goodBlob() })).statusCode, 409);
});

test('manual mode: a new identity does not silently create a server copy', async () => {
  const cookie = await signup('bk_manual_new');
  assert.equal((await call(cookie, 'DELETE', '/api/crypto/backup')).statusCode, 204);
  const r = await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('d'), backup: goodBlob() });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().backupSaved, false);
  const got = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  assert.equal(got.mode, 'manual');
  assert.equal(got.backup, null);
});
