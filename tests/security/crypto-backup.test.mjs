import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { generateBackupablePair, wrapForServer, unwrapFromServer } from '../../apps/web/src/backup/crypto.ts';

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
const { requireTrustedOrigin, requireUser, resetLoginAttempts, tokenHash } = await load('auth.js');
const { registerRegistration, resetRegistrationLimits } = await load('registration.js');
const { registerCryptoRoutes } = await load('crypto.js');
const { registerCryptoBackupRoutes } = await load('cryptoBackup.js');
const { registerSecurityRoutes } = await load('security.js');
const { totpForStep } = await load('totp.js');

let app;
let nextIp = 1;
const ip = () => `10.8.${nextIp >> 8}.${nextIp++ & 255}`;
const passwords = new Map();
const userIds = new Map();
const signup = async (username, password = 'correct-horse') => {
  const response = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password }, remoteAddress: ip(), headers: { origin } });
  assert.equal(response.statusCode, 204, response.body);
  const cookie = response.headers['set-cookie'].split(';')[0];
  passwords.set(cookie, password);
  userIds.set(cookie, (await db.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id);
  return cookie;
};
const call = async (cookie, method, url, payload, ipOverride) => {
  if (method === 'PUT' && (url === '/api/crypto/backup' || url === '/api/crypto/identity') || method === 'POST' && url === '/api/security/password') {
    payload = { expectedUserId: userIds.get(cookie), ...payload };
  }
  if (passwords.has(cookie) && ((method === 'PUT' || method === 'DELETE') && url === '/api/crypto/backup' || method === 'POST' && url === '/api/crypto/identity/reset' && payload?.password)) {
    const state = await app.inject({ method: 'GET', url: '/api/crypto/backup', headers: { origin, cookie }, remoteAddress: ip() });
    const revision = state.statusCode === 404 ? 0 : state.json().revision;
    const action = method === 'PUT' ? 'backup.replace' : method === 'DELETE' ? 'backup.delete' : 'identity.reset';
    let token;
    if (method !== 'PUT' || state.statusCode === 200 && (state.json().backup || state.json().mode === 'manual')) {
      const grant = await app.inject({ method: 'POST', url: '/api/crypto/action-grant',
        payload: { action, expectedRevision: revision, password: payload?.password ?? passwords.get(cookie) },
        headers: { origin, cookie }, remoteAddress: ip() });
      if (grant.statusCode !== 200) return grant;
      token = grant.json().token;
    }
    payload = method === 'PUT' ? { ...payload, password: passwords.get(cookie), expectedRevision: revision, actionToken: token }
      : { expectedRevision: revision, actionToken: token };
  }
  return app.inject({ method, url, payload, headers: { origin, cookie }, remoteAddress: ipOverride ?? ip() });
};
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
  await registerSecurityRoutes(app);
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

test('a delayed backup or initial identity from A cannot be written under B even when passwords match', async () => {
  const a = await signup('bk_switch_a', 'same long password');
  const b = await signup('bk_switch_b', 'same long password');
  const aId = userIds.get(a);
  const bId = userIds.get(b);
  assert.notEqual(aId, bId);
  const foreign = await call(b, 'PUT', '/api/crypto/backup', { ...goodBlob(), expectedUserId: aId });
  assert.equal(foreign.statusCode, 403);
  assert.equal((await call(b, 'GET', '/api/crypto/backup')).statusCode, 404);
  const initial = await call(b, 'PUT', '/api/crypto/identity', { publicKey: pub('q'), backup: goodBlob(), expectedUserId: aId });
  assert.equal(initial.statusCode, 403);
  assert.equal((await call(b, 'PUT', '/api/crypto/identity', { publicKey: pub('q'), expectedUserId: aId })).statusCode, 403);
  const wrongPasswordChange = await call(b, 'POST', '/api/security/password', {
    expectedUserId: aId, currentPassword: 'same long password', newPassword: 'replacement long password', expectedBackupRevision: 0
  });
  assert.equal(wrongPasswordChange.statusCode, 403);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [bId])).rowCount, 0);
  assert.equal((await call(b, 'GET', '/api/crypto/backup')).statusCode, 404);
  assert.equal((await call(a, 'PUT', '/api/crypto/backup', goodBlob())).statusCode, 204);
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

test('destructive backup actions need a matching one-use grant bound to this session, action and revision', async () => {
  resetLoginAttempts();
  const cookie = await signup('bk_grant', 'grant password');
  const other = await signup('bk_grant_other', 'other password');
  await call(cookie, 'PUT', '/api/crypto/backup', goodBlob());
  await call(other, 'PUT', '/api/crypto/backup', goodBlob());
  const revision = (await call(cookie, 'GET', '/api/crypto/backup')).json().revision;
  const direct = (payload) => app.inject({ method: 'DELETE', url: '/api/crypto/backup', payload,
    headers: { origin, cookie }, remoteAddress: ip() });
  assert.equal((await direct({ expectedRevision: revision })).statusCode, 403, 'session alone cannot delete');
  const grant = await call(cookie, 'POST', '/api/crypto/action-grant', { action: 'backup.delete', expectedRevision: revision, password: 'grant password' });
  assert.equal(grant.statusCode, 200, grant.body);
  const token = grant.json().token;
  assert.equal((await app.inject({ method: 'POST', url: '/api/crypto/identity/reset', payload: { expectedRevision: revision, actionToken: token }, headers: { origin, cookie }, remoteAddress: ip() })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/crypto/backup', payload: { expectedRevision: revision, actionToken: token }, headers: { origin, cookie: other }, remoteAddress: ip() })).statusCode, 403);
  const secondSession = 'tel_session=another-session-token';
  await db.query("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, (SELECT id FROM users WHERE username = $2), $3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'))",
    ['a1234567-1234-1234-1234-123456789abc', 'bk_grant', tokenHash('another-session-token')]);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/crypto/backup', payload: { expectedRevision: revision, actionToken: token }, headers: { origin, cookie: secondSession }, remoteAddress: ip() })).statusCode, 403);
  assert.equal((await direct({ expectedRevision: revision, actionToken: token })).statusCode, 204);
  assert.equal((await direct({ expectedRevision: revision, actionToken: token })).statusCode, 409, 'used grant cannot be replayed');
  const events = (await call(cookie, 'GET', '/api/crypto/security-events')).json();
  assert.deepEqual(events.slice(0, 2).map((event) => event.action), ['backup.deleted', 'backup.created']);
});

test('expired grants and grants for another revision cannot erase the backup', async () => {
  resetLoginAttempts();
  const cookie = await signup('bk_grant_expiry', 'expiry password');
  await call(cookie, 'PUT', '/api/crypto/backup', goodBlob());
  const revision = (await call(cookie, 'GET', '/api/crypto/backup')).json().revision;
  const grant = await call(cookie, 'POST', '/api/crypto/action-grant', { action: 'backup.delete', expectedRevision: revision, password: 'expiry password' });
  assert.equal(grant.statusCode, 200);
  const token = grant.json().token;
  const stale = await app.inject({ method: 'DELETE', url: '/api/crypto/backup', payload: { expectedRevision: revision + 1, actionToken: token }, headers: { origin, cookie }, remoteAddress: ip() });
  assert.equal(stale.statusCode, 409);
  await db.query("UPDATE crypto_action_grants SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE user_id = (SELECT id FROM users WHERE username = $1)", ['bk_grant_expiry']);
  const expired = await app.inject({ method: 'DELETE', url: '/api/crypto/backup', payload: { expectedRevision: revision, actionToken: token }, headers: { origin, cookie }, remoteAddress: ip() });
  assert.equal(expired.statusCode, 403);
  assert.ok((await call(cookie, 'GET', '/api/crypto/backup')).json().backup);
});

test('enabled MFA is required for identity reset authorization', async () => {
  resetLoginAttempts();
  const cookie = await signup('bk_grant_mfa', 'mfa password');
  const setup = await call(cookie, 'POST', '/api/security/totp/setup', { password: 'mfa password' });
  assert.equal(setup.statusCode, 200);
  const secret = setup.json().secret;
  const code = () => totpForStep(secret, Math.floor(Date.now() / 30_000));
  const enabled = await call(cookie, 'POST', '/api/security/totp/enable', { code: code() });
  assert.equal(enabled.statusCode, 200);
  const missing = await call(cookie, 'POST', '/api/crypto/action-grant', { action: 'identity.reset', expectedRevision: 0, password: 'mfa password' });
  assert.equal(missing.statusCode, 403);
  const wrong = await call(cookie, 'POST', '/api/crypto/action-grant', { action: 'identity.reset', expectedRevision: 0, password: 'mfa password', secondFactor: '000000' });
  assert.equal(wrong.statusCode, 403);
  const valid = await call(cookie, 'POST', '/api/crypto/action-grant', { action: 'identity.reset', expectedRevision: 0, password: 'mfa password', secondFactor: enabled.json().recoveryCodes[0] });
  assert.equal(valid.statusCode, 200, valid.body);
  const reset = await app.inject({ method: 'POST', url: '/api/crypto/identity/reset', payload: { expectedRevision: 0, actionToken: valid.json().token }, headers: { origin, cookie }, remoteAddress: ip() });
  assert.equal(reset.statusCode, 204, reset.body);
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
  await db.query('INSERT INTO direct_chat_keys (chat_id, key_version) VALUES ($1, 1)', [chat]);
  // NS-07: a second chat whose version row is missing (reset must still keep the contact's envelope and ask for a new version).
  const rowless = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)', [rowless, me, other]);
  for (const [r, s] of [[me, other], [other, other]]) await db.query("INSERT INTO chat_key_envelopes (chat_id, recipient_id, sender_id, version, nonce, ciphertext) VALUES ($1, $2, $3, 1, $4, $5)", [rowless, r, s, b64(16), b64(60)]);
  // Saved Messages: a single member, one envelope to itself.
  const saved = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [saved, me]);
  await db.query('INSERT INTO saved_chats (user_id, chat_id) VALUES ($1, $2)', [me, saved]);
  await db.query("INSERT INTO chat_key_envelopes (chat_id, recipient_id, sender_id, version, nonce, ciphertext) VALUES ($1, $2, $2, 1, $3, $4)", [saved, me, b64(16), b64(60)]);
  await db.query('INSERT INTO direct_chat_keys (chat_id, key_version) VALUES ($1, 1)', [saved]);
  // A chat the user is not in must not be touched.
  const unrelated = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [unrelated, other]);
  await db.query("INSERT INTO chat_key_envelopes (chat_id, recipient_id, sender_id, version, nonce, ciphertext) VALUES ($1, $2, $2, 1, $3, $4)", [unrelated, other, b64(16), b64(60)]);
  await db.query('INSERT INTO direct_chat_keys (chat_id, key_version) VALUES ($1, 1)', [unrelated]);
  const impact = await call(cookie, 'GET', '/api/crypto/identity/reset-impact');
  assert.equal(impact.statusCode, 200);
  assert.deepEqual(impact.json(), { chats: 2 }, 'direct chat + Saved Messages (the version-less chat is counted only after reconciliation)');

  const gchat = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)', [gchat, me, other]);
  const group = (await db.query('INSERT INTO groups (chat_id, title, created_by, key_version) VALUES ($1, $2, $3, 2) RETURNING id', [gchat, 'g', other])).rows[0].id;
  const ochat = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [ochat, other]);
  const otherGroup = (await db.query('INSERT INTO groups (chat_id, title, created_by, key_version) VALUES ($1, $2, $3, 1) RETURNING id', [ochat, 'o', other])).rows[0].id;
  assert.equal((await call(cookie, 'POST', '/api/crypto/identity/reset', {})).statusCode, 400);
  assert.equal((await call(cookie, 'POST', '/api/crypto/identity/reset', { password: 'wrong-password' })).statusCode, 403);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [me])).rowCount, 1, 'wrong password changes nothing');
  assert.equal((await call(cookie, 'POST', '/api/crypto/identity/reset', { password: 'right-password' })).statusCode, 204);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [me])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [other])).rowCount, 1, 'peer identity untouched');
  const holders = async (c) => (await db.query('SELECT recipient_id, version FROM chat_key_envelopes WHERE chat_id = $1 ORDER BY recipient_id', [c])).rows.map((r) => `${r.recipient_id}:${r.version}`);
  assert.deepEqual(await holders(chat), [`${other}:1`], 'only the resetting user\'s envelope is removed; the contact keeps theirs');
  assert.deepEqual(await holders(rowless), [`${other}:1`]);
  assert.deepEqual(await holders(saved), [], 'Saved Messages: the only envelope was the user\'s own');
  assert.deepEqual(await holders(unrelated), [`${other}:1`], 'chats without this user are untouched');
  const versions = async (c) => (await db.query('SELECT key_version, pending_version FROM direct_chat_keys WHERE chat_id = $1', [c])).rows[0];
  assert.deepEqual(await versions(chat), { key_version: 1, pending_version: 2 });
  assert.deepEqual(await versions(rowless), { key_version: 1, pending_version: 2 }, 'a missing version row is reconstructed');
  assert.deepEqual(await versions(saved), { key_version: 1, pending_version: 2 });
  assert.deepEqual(await versions(unrelated), { key_version: 1, pending_version: null });
  assert.equal((await db.query('SELECT pending_version FROM groups WHERE id = $1', [group])).rows[0].pending_version, 3, 'group needs a key rotation after the member reset');
  assert.equal((await db.query('SELECT pending_version FROM groups WHERE id = $1', [otherGroup])).rows[0].pending_version, null, 'unrelated group untouched');
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

test('password change atomically rewraps the same identity and rejects stale backups', async () => {
  const oldPassword = 'original long password';
  const newPassword = 'replacement long password';
  const cookie = await signup('bk_password_change', oldPassword);
  const userId = (await db.query('SELECT id FROM users WHERE username = $1', ['bk_password_change'])).rows[0].id;
  const pair = await generateBackupablePair();
  const identity = { userId, publicKey: pair.publicJwk, privateKey: pair.privateJwk };
  const oldBlob = await wrapForServer(identity, oldPassword);
  assert.equal((await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pair.publicJwk, backup: oldBlob })).statusCode, 200);
  const before = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  const newBlob = await wrapForServer(identity, newPassword);
  const missing = await call(cookie, 'POST', '/api/security/password', { currentPassword: oldPassword, newPassword, expectedBackupRevision: before.revision });
  assert.equal(missing.statusCode, 409, missing.body);
  assert.deepEqual((await call(cookie, 'GET', '/api/crypto/backup')).json().backup, oldBlob);
  const changed = await call(cookie, 'POST', '/api/security/password', {
    currentPassword: oldPassword, newPassword, backup: newBlob, expectedBackupRevision: before.revision
  });
  assert.equal(changed.statusCode, 204, changed.body);
  const latest = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  assert.equal(latest.revision, before.revision + 1);
  assert.deepEqual(await unwrapFromServer(latest.backup, newPassword, userId), identity);
  await assert.rejects(unwrapFromServer(latest.backup, oldPassword, userId), /bad-passphrase/);
  const stale = await app.inject({ method: 'PUT', url: '/api/crypto/backup', payload: {
    ...oldBlob, expectedUserId: userId, password: oldPassword, expectedRevision: before.revision
  }, headers: { origin, cookie }, remoteAddress: ip() });
  assert.equal(stale.statusCode, 403);
  const staleWithCurrentPassword = await app.inject({ method: 'PUT', url: '/api/crypto/backup', payload: {
    ...oldBlob, expectedUserId: userId, password: newPassword, expectedRevision: before.revision
  }, headers: { origin, cookie }, remoteAddress: ip() });
  assert.equal(staleWithCurrentPassword.statusCode, 409);
  assert.deepEqual((await call(cookie, 'GET', '/api/crypto/backup')).json().backup, newBlob);
  const second = await call(cookie, 'POST', '/api/security/password', {
    currentPassword: oldPassword, newPassword: 'third long password', backup: oldBlob, expectedBackupRevision: latest.revision
  });
  assert.equal(second.statusCode, 403);
});

test('manual mode changes password without creating an automatic copy', async () => {
  const cookie = await signup('bk_manual_password', 'manual old password');
  await call(cookie, 'DELETE', '/api/crypto/backup');
  assert.equal((await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pub('m'), backup: goodBlob() })).statusCode, 200);
  const state = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  const response = await call(cookie, 'POST', '/api/security/password', {
    currentPassword: 'manual old password', newPassword: 'manual new password', expectedBackupRevision: state.revision
  });
  assert.equal(response.statusCode, 204, response.body);
  const next = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  assert.equal(next.mode, 'manual');
  assert.equal(next.backup, null);
  assert.equal(next.revision, state.revision + 1);
});

test('a password update failure rolls back the backup replacement', async () => {
  const cookie = await signup('bk_rollback', 'rollback old password');
  const userId = (await db.query('SELECT id FROM users WHERE username = $1', ['bk_rollback'])).rows[0].id;
  const pair = await generateBackupablePair();
  const identity = { userId, publicKey: pair.publicJwk, privateKey: pair.privateJwk };
  const oldBlob = await wrapForServer(identity, 'rollback old password');
  await call(cookie, 'PUT', '/api/crypto/identity', { publicKey: pair.publicJwk, backup: oldBlob });
  const state = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  const replacement = await wrapForServer(identity, 'rollback new password');
  await db.query(`CREATE TRIGGER fail_password_hash BEFORE UPDATE OF password_hash ON users
    WHEN OLD.username = 'bk_rollback' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
  try {
    const failed = await call(cookie, 'POST', '/api/security/password', {
      currentPassword: 'rollback old password', newPassword: 'rollback new password',
      backup: replacement, expectedBackupRevision: state.revision
    });
    assert.equal(failed.statusCode, 500);
  } finally { await db.query('DROP TRIGGER fail_password_hash'); }
  const after = (await call(cookie, 'GET', '/api/crypto/backup')).json();
  assert.deepEqual(after.backup, oldBlob);
  assert.equal(after.revision, state.revision);
  assert.equal((await call(cookie, 'POST', '/api/crypto/password-check', { password: 'rollback old password' })).statusCode, 204);
});
