import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tel-hardening-'));
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-with-at-least-thirty-two-bytes';
process.env.TRUSTED_ORIGINS = 'http://localhost:3050';
process.env.DATA_DIR = dataDir;

const auth = await import('../../apps/server/dist/auth.js');
const totp = await import('../../apps/server/dist/totp.js');
const { db } = await import('../../apps/server/dist/db.js');
const { runMigrations } = await import('../../apps/server/dist/migrate.js');
await runMigrations();

after(async () => {
  await db.end();
  rmSync(dataDir, { recursive: true, force: true });
});

const addUser = async (name, hash = 'x') =>
  (await db.query('INSERT INTO users (username, display_name, password_hash) VALUES ($1, $1, $2) RETURNING id', [name, hash])).rows[0].id;

const login = async (userId) => {
  let token;
  const reply = { setCookie: (_name, value) => { token = value; return reply; } };
  await auth.createSession(userId, reply, { headers: { 'user-agent': 'test' }, ip: '127.0.0.1' });
  return token;
};

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

test('(a) login limiter is per username: 10 per 15 min, case/space-insensitive, other names unaffected', () => {
  auth.resetLoginAttempts();
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i += 1) assert.equal(auth.allowLoginAttempt('Alice', t0 + i), true);
  assert.equal(auth.allowLoginAttempt('alice', t0 + 11), false);
  assert.equal(auth.allowLoginAttempt('  ALICE ', t0 + 12), false);
  assert.equal(auth.allowLoginAttempt('bob', t0 + 13), true);
  // window slides: after 15 minutes the name is allowed again
  assert.equal(auth.allowLoginAttempt('alice', t0 + 15 * 60_000 + 20), true);
  auth.resetLoginAttempts();
});

test('(b) unknown username costs about the same as a wrong password (dummy argon2 verify)', async () => {
  const hash = await auth.hashPassword('correct horse battery staple');
  assert.equal(await auth.verifyLoginPassword(hash, 'wrong password!!'), false);
  assert.equal(await auth.verifyLoginPassword(hash, 'correct horse battery staple'), true);
  assert.equal(await auth.verifyLoginPassword(undefined, 'anything at all'), false);
  assert.equal(await auth.verifyLoginPassword(null, 'anything at all'), false);

  const time = async (fn) => { const s = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - s) / 1e6; };
  const known = [];
  const unknown = [];
  for (let i = 0; i < 9; i += 1) { // interleaved to cancel drift
    known.push(await time(() => auth.verifyLoginPassword(hash, 'wrong password!!')));
    unknown.push(await time(() => auth.verifyLoginPassword(undefined, 'wrong password!!')));
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const diff = Math.abs(median(known) - median(unknown)) / Math.max(median(known), median(unknown));
  assert.ok(diff < 0.2, `timing differs by ${(diff * 100).toFixed(1)}% (known ${median(known).toFixed(1)} ms, unknown ${median(unknown).toFixed(1)} ms)`);
});

test('(c) sessions: idle 14 days expires, 13 days is fine, activity refreshes, 30-day max set', async () => {
  const id = await addUser('idle-user');
  const token = await login(id);
  assert.equal((await auth.getSessionUserForToken(token))?.username, 'idle-user');

  const max = (await db.query('SELECT expires_at, created_at FROM sessions WHERE user_id = $1', [id])).rows[0];
  const days = (Date.parse(max.expires_at) - Date.parse(max.created_at)) / 86_400_000;
  assert.ok(days > 29.9 && days < 30.1, `max lifetime ${days} days`);

  await db.query('UPDATE sessions SET last_seen_at = $1 WHERE user_id = $2', [ago(13), id]);
  assert.ok(await auth.getSessionUserForToken(token), '13 days idle still valid');
  const refreshed = (await db.query('SELECT last_seen_at FROM sessions WHERE user_id = $1', [id])).rows[0].last_seen_at;
  assert.ok(Date.now() - Date.parse(refreshed) < 60_000, 'activity refreshes last_seen_at');

  await db.query('UPDATE sessions SET last_seen_at = $1 WHERE user_id = $2', [ago(15), id]);
  assert.equal(await auth.getSessionUserForToken(token), null, '15 days idle is expired');
  assert.equal(await auth.getSessionId({ cookies: { tel_session: token } }), null);

  // a stale session cannot be revived by touching it, and the next login sweeps it away
  assert.equal(await auth.getSessionUserForToken(token), null);
  await login(id);
  assert.equal((await db.query('SELECT count(*) AS n FROM sessions WHERE user_id = $1', [id])).rows[0].n, 1);

  // absolute 30-day cap still applies to an active session
  const token2 = await login(id);
  await db.query(`UPDATE sessions SET expires_at = $1 WHERE token_hash = (SELECT token_hash FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1)`, [ago(1)]);
  assert.equal(await auth.getSessionUserForToken(token2), null);
});

test('(d) MFA secrets: v2 key is separate (HKDF); migration re-encrypts old rows, idempotent, round-trips', async () => {
  const secret = totp.generateTotpSecret();
  const legacy = totp.encryptMfaSecretLegacy(secret);
  const v2 = totp.encryptMfaSecret(secret);
  assert.notDeepEqual(legacy.subarray(28), v2.subarray(28)); // different keys/ivs
  assert.equal(totp.decryptMfaSecret(legacy), secret); // old rows keep working before migration
  assert.equal(totp.decryptMfaSecret(v2), secret);

  const uLegacy = await addUser('mfa-legacy');
  const uNew = await addUser('mfa-new');
  const secretNew = totp.generateTotpSecret();
  await db.query(`INSERT INTO user_security (user_id, totp_secret_enc, totp_enabled_at) VALUES ($1, $2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, [uLegacy, legacy]);
  const v2Blob = totp.encryptMfaSecret(secretNew);
  await db.query(`INSERT INTO user_security (user_id, totp_secret_enc, totp_enabled_at) VALUES ($1, $2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, [uNew, v2Blob]);
  const sessionId = (await db.query('SELECT id FROM sessions LIMIT 1')).rows[0]?.id ?? (await (async () => { await login(uLegacy); return (await db.query('SELECT id FROM sessions LIMIT 1')).rows[0].id; })());
  const pending = totp.generateTotpSecret();
  await db.query(`INSERT INTO mfa_enrollments (session_id, secret_enc, expires_at) VALUES ($1, $2, $3)`, [sessionId, totp.encryptMfaSecretLegacy(pending), new Date(Date.now() + 600_000).toISOString()]);

  assert.equal(await totp.migrateMfaSecrets(), 2); // the legacy user row + the pending enrollment

  const rowLegacy = (await db.query('SELECT totp_secret_enc AS b FROM user_security WHERE user_id = $1', [uLegacy])).rows[0].b;
  assert.notDeepEqual(rowLegacy, legacy);
  assert.equal(totp.decryptMfaSecret(rowLegacy), secret);
  const rowNew = (await db.query('SELECT totp_secret_enc AS b FROM user_security WHERE user_id = $1', [uNew])).rows[0].b;
  assert.deepEqual(rowNew, v2Blob); // already-v2 rows untouched
  const enrol = (await db.query('SELECT secret_enc AS b FROM mfa_enrollments WHERE session_id = $1', [sessionId])).rows[0].b;
  assert.equal(totp.decryptMfaSecret(enrol), pending);

  assert.equal(await totp.migrateMfaSecrets(), 0); // idempotent
  // codes derived from the migrated secret still verify
  const now = Date.now();
  const step = Math.floor(now / 30_000);
  assert.equal(totp.verifyTotp(totp.decryptMfaSecret(rowLegacy), totp.totpForStep(secret, step), now), step);
});
