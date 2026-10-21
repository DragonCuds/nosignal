import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-open-signup-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'open-signup-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;
process.env.OPEN_REGISTRATION = '1';

const load = (name) => import(path.join(dist, name));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const { runMigrations } = await load('migrate.js');
const { db } = await load('db.js');
const { config } = await load('config.js');
const { requireTrustedOrigin, requireUser, verifyLoginPassword } = await load('auth.js');
const { registerRegistration, resetRegistrationLimits } = await load('registration.js');

let app;
let nextIp = 1;
const freshIp = () => `10.2.${nextIp >> 8}.${nextIp++ & 255}`;
const register = (payload, { ip = freshIp(), headers = { origin } } = {}) => app.inject({
  method: 'POST', url: '/api/register', payload, remoteAddress: ip, headers
});
const cookieOf = (response) => response.headers['set-cookie'].split(';')[0];

before(async () => {
  await runMigrations();
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 1_000, timeWindow: '1 minute' });
  app.addHook('onRequest', requireTrustedOrigin);
  await registerRegistration(app);
  app.get('/api/me', { preHandler: requireUser }, async (request) => request.user);
  // Same credential check the real /api/auth/login performs.
  app.post('/test/login', async (request, reply) => {
    const { username, password } = request.body;
    const row = (await db.query('SELECT password_hash FROM users WHERE username = $1', [username])).rows[0];
    return (await verifyLoginPassword(row?.password_hash, password)) ? reply.code(204).send() : reply.code(401).send();
  });
  await app.ready();
});

after(async () => {
  await app.close();
  await db.end();
  await rm(dataDir, { recursive: true, force: true });
});

test('register keeps Persian displayName with ZWNJ intact', async () => {
  const name = 'بچه\u200cهای دانشگاه';
  const response = await register({ username: 'zwnj_user', password: 'correct-horse', displayName: name });
  assert.equal(response.statusCode, 204, response.body);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(response) } });
  assert.equal(me.json().displayName, name);
});

test('register creates a non-admin user, sets a session, and login works', async () => {
  const response = await register({ username: 'Alice_1', password: 'correct-horse', displayName: 'Alice' });
  assert.equal(response.statusCode, 204, response.body);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(response) } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().username, 'alice_1');
  assert.equal(me.json().displayName, 'Alice');
  const row = (await db.query('SELECT is_admin FROM users WHERE username = $1', ['alice_1'])).rows[0];
  assert.equal(Number(row.is_admin), 0);
  const login = await app.inject({ method: 'POST', url: '/test/login', payload: { username: 'alice_1', password: 'correct-horse' }, headers: { origin } });
  assert.equal(login.statusCode, 204);
  const bad = await app.inject({ method: 'POST', url: '/test/login', payload: { username: 'alice_1', password: 'wrong-password' }, headers: { origin } });
  assert.equal(bad.statusCode, 401);
});

test('display name defaults to the ID', async () => {
  const response = await register({ username: 'no_display', password: 'correct-horse' });
  assert.equal(response.statusCode, 204);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(response) } });
  assert.equal(me.json().displayName, 'no_display');
});

test('duplicate username (any case) returns 409', async () => {
  assert.equal((await register({ username: 'dupe_user', password: 'correct-horse' })).statusCode, 204);
  assert.equal((await register({ username: 'DUPE_user', password: 'another-pass-1' })).statusCode, 409);
});

test('invalid input returns 400', async () => {
  const bad = [
    { username: 'ab', password: 'correct-horse' },
    { username: 'x'.repeat(33), password: 'correct-horse' },
    { username: 'bad name', password: 'correct-horse' },
    { username: 'bad-name', password: 'correct-horse' },
    { username: 'ok_name', password: 'short' },
    { username: 'ok_name', password: 'x'.repeat(1025) },
    { username: 'ok_name', password: 'correct-horse', displayName: 'd'.repeat(101) },
    { username: 'ok_name', password: 12345678 },
    { password: 'correct-horse' },
    { username: 'admin', password: 'correct-horse' },
    { username: 'Root', password: 'correct-horse' },
    { username: 'saved', password: 'correct-horse' },
    { username: 'support', password: 'correct-horse' }
  ];
  for (const payload of bad) {
    const response = await register(payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 80) + ' -> ' + response.statusCode);
  }
  assert.equal((await db.query("SELECT 1 FROM users WHERE username IN ('ok_name','admin','root')")).rows.length, 0);
});

test('operator CLI path (allowReserved) may create admin; the default path may not', async () => {
  const { createUser } = await load('users.js');
  await assert.rejects(() => createUser('root', 'Root', 'correct-horse-1'), /reserved/);
  const id = await createUser('admin', 'Admin', 'correct-horse-1', { allowReserved: true });
  assert.ok(id);
  assert.equal((await register({ username: 'admin', password: 'correct-horse' })).statusCode, 400);
  assert.equal((await register({ username: 'root', password: 'correct-horse' })).statusCode, 400);
  await assert.rejects(() => createUser('ab', 'X', 'correct-horse-1', { allowReserved: true }), /Username must be/);
  await db.query("DELETE FROM users WHERE username = 'admin'");
});

test('untrusted origin is rejected', async () => {
  assert.equal((await register({ username: 'evil_site', password: 'correct-horse' }, { headers: { origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await register({ username: 'evil_site', password: 'correct-horse' }, { headers: {} })).statusCode, 403);
});

test('username-available reports valid and available', async () => {
  const get = (u) => app.inject({ method: 'GET', url: `/api/username-available${u === undefined ? '' : `?u=${encodeURIComponent(u)}`}` });
  assert.deepEqual((await get('fresh_name')).json(), { available: true, valid: true });
  assert.deepEqual((await get('alice_1')).json(), { available: false, valid: true });
  assert.deepEqual((await get('ALICE_1')).json(), { available: false, valid: true });
  assert.deepEqual((await get('ab')).json(), { available: false, valid: false });
  assert.deepEqual((await get('admin')).json(), { available: false, valid: false });
  assert.deepEqual((await get('bad name!')).json(), { available: false, valid: false });
  assert.deepEqual((await get()).json(), { available: false, valid: false });
});

test('per-IP rate limit returns 429 after 5 attempts', async () => {
  resetRegistrationLimits();
  const ip = '10.9.9.9';
  for (let i = 0; i < 5; i++) {
    assert.equal((await register({ username: `limited_${i}`, password: 'correct-horse' }, { ip })).statusCode, 204);
  }
  assert.equal((await register({ username: 'limited_6', password: 'correct-horse' }, { ip })).statusCode, 429);
  // Another IP is unaffected.
  assert.equal((await register({ username: 'limited_other', password: 'correct-horse' })).statusCode, 204);
});

test('flag off returns 404 on both endpoints', async () => {
  config.openRegistration = false;
  try {
    assert.equal((await register({ username: 'flag_off', password: 'correct-horse' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/username-available?u=abc' })).statusCode, 404);
    assert.equal((await db.query("SELECT 1 FROM users WHERE username = 'flag_off'")).rows.length, 0);
  } finally {
    config.openRegistration = true;
  }
});
