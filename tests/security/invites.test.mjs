import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const adminPassword = 'admin-password-123';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-invites-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'invites-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;

const load = (name) => import(path.join(dist, name));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const { runMigrations } = await load('migrate.js');
const { db } = await load('db.js');
const { createUser } = await load('users.js');
const { createSession, requireTrustedOrigin } = await load('auth.js');
const { registerInvites } = await load('invites.js');

let app;
let adminCookie;
let memberCookie;

const cookieOf = (response) => response.headers['set-cookie'].split(';')[0];
const send = (method, url, { cookie, payload } = {}) => app.inject({
  method, url, payload,
  remoteAddress: '10.0.0.1',
  headers: { origin, ...(cookie ? { cookie } : {}) }
});
const createInvite = async (body = {}) => {
  const response = await send('POST', '/api/invites', { cookie: adminCookie, payload: body });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
};
let nextIp = 1;
// Each call gets its own client IP unless one is given, so the accept rate limit only trips where tested.
const accept = (token, payload, remoteAddress) => app.inject({
  method: 'POST', url: `/api/invites/${token}/accept`, payload, remoteAddress: remoteAddress ?? `10.1.${nextIp >> 8}.${nextIp++ & 255}`, headers: { origin }
});
const newUser = (n) => ({ username: `friend_${n}`, displayName: `Friend ${n}`, password: 'a-long-password-9' });

before(async () => {
  await runMigrations();
  const adminId = await createUser('boss', 'Boss', adminPassword);
  const memberId = await createUser('member', 'Member', adminPassword);
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 1_000, timeWindow: '1 minute' });
  app.addHook('onRequest', requireTrustedOrigin);
  app.get('/test/login/:id', async (request, reply) => {
    await createSession(request.params.id, reply, request);
    return { ok: true };
  });
  await registerInvites(app);
  await app.ready();
  adminCookie = cookieOf(await send('GET', `/test/login/${adminId}`));
  memberCookie = cookieOf(await send('GET', `/test/login/${memberId}`));
});

after(async () => {
  await app.close();
  await db.end();
  await rm(dataDir, { recursive: true, force: true });
});

test('fresh users are not admin until promoted (migration only promotes pre-existing users)', async () => {
  const rows = (await db.query('SELECT username, is_admin FROM users ORDER BY id')).rows;
  assert.deepEqual(rows.map((r) => [r.username, Number(r.is_admin)]), [['boss', 0], ['member', 0]]);
  await db.query('UPDATE users SET is_admin = 1 WHERE username = $1', ['boss']);
});

test('non-admin and anonymous cannot create, list or delete', async () => {
  assert.equal((await send('POST', '/api/invites', { cookie: memberCookie, payload: {} })).statusCode, 403);
  assert.equal((await send('GET', '/api/invites', { cookie: memberCookie })).statusCode, 403);
  assert.equal((await send('DELETE', '/api/invites/1', { cookie: memberCookie })).statusCode, 403);
  assert.equal((await send('POST', '/api/invites', { payload: {} })).statusCode, 401);
  assert.equal((await send('GET', '/api/invites')).statusCode, 401);
});

test('admin creates an invite; only a hash is stored; list never leaks the token', async () => {
  const invite = await createInvite();
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invite.path, `/join/${invite.token}`);
  assert.equal(invite.maxUses, 1);
  const days = (Date.parse(invite.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.99 && days <= 7.001, `expiry ${days} days`);
  const stored = (await db.query('SELECT token_hash FROM invites WHERE id = $1', [invite.id])).rows[0];
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.token_hash, invite.token);
  const list = await send('GET', '/api/invites', { cookie: adminCookie });
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes(invite.token));
  const entry = list.json().find((row) => row.id === invite.id);
  assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'expiresAt', 'id', 'maxUses', 'status', 'uses']);
  assert.equal(entry.status, 'active');
  assert.equal((await send('POST', '/api/invites', { cookie: adminCookie, payload: { maxUses: 0 } })).statusCode, 400);
  assert.equal((await send('POST', '/api/invites', { cookie: adminCookie, payload: { maxUses: 101 } })).statusCode, 400);
});

test('valid invite is accepted once: user created, session issued, token burned', async () => {
  const invite = await createInvite();
  const check = await send('GET', `/api/invites/${invite.token}`);
  assert.deepEqual(check.json(), { valid: true });
  const response = await accept(invite.token, newUser(1));
  assert.equal(response.statusCode, 204, response.body);
  const cookie = cookieOf({ headers: { 'set-cookie': [].concat(response.headers['set-cookie'])[0] } });
  assert.match(cookie, /^[^=]+=.+/);
  const created = (await db.query('SELECT is_admin FROM users WHERE username = $1', ['friend_1'])).rows[0];
  assert.equal(Number(created.is_admin), 0);
  assert.deepEqual((await send('GET', `/api/invites/${invite.token}`)).json(), { valid: false });
  assert.equal((await accept(invite.token, newUser(2))).statusCode, 404);
  assert.equal((await db.query('SELECT 1 FROM users WHERE username = $1', ['friend_2'])).rowCount, 0);
  const list = (await send('GET', '/api/invites', { cookie: adminCookie })).json();
  assert.equal(list.find((row) => row.id === invite.id).status, 'used');
});

test('wrong, malformed and expired tokens are rejected', async () => {
  const wrong = 'A'.repeat(43);
  assert.deepEqual((await send('GET', `/api/invites/${wrong}`)).json(), { valid: false });
  assert.deepEqual((await send('GET', '/api/invites/short')).json(), { valid: false });
  assert.equal((await accept(wrong, newUser(3))).statusCode, 404);
  assert.equal((await accept('short', newUser(3))).statusCode, 404);
  const invite = await createInvite();
  await db.query("UPDATE invites SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE id = $1", [invite.id]);
  assert.deepEqual((await send('GET', `/api/invites/${invite.token}`)).json(), { valid: false });
  assert.equal((await accept(invite.token, newUser(4))).statusCode, 404);
  const list = (await send('GET', '/api/invites', { cookie: adminCookie })).json();
  assert.equal(list.find((row) => row.id === invite.id).status, 'expired');
  assert.equal((await db.query('SELECT 1 FROM users WHERE username = $1', ['friend_4'])).rowCount, 0);
});

test('bad input does not burn the invite; taken username returns 409 and keeps the invite', async () => {
  const invite = await createInvite({ maxUses: 2 });
  assert.equal((await accept(invite.token, { ...newUser(5), password: 'short' })).statusCode, 400);
  assert.equal((await accept(invite.token, { ...newUser(5), username: 'A!' })).statusCode, 400);
  assert.equal((await accept(invite.token, { username: 5, password: 'a-long-password-9' })).statusCode, 400);
  assert.equal((await accept(invite.token, { ...newUser(5), username: 'boss' })).statusCode, 409);
  assert.equal(Number((await db.query('SELECT uses FROM invites WHERE id = $1', [invite.id])).rows[0].uses), 0);
  assert.equal((await accept(invite.token, newUser(5))).statusCode, 204);
  assert.equal((await accept(invite.token, newUser(6))).statusCode, 204);
  assert.equal((await accept(invite.token, newUser(7))).statusCode, 404);
});

test('invite accept still rejects reserved usernames and does not burn the invite', async () => {
  const invite = await createInvite();
  for (const username of ['admin', 'root']) {
    assert.equal((await accept(invite.token, { username, password: 'a-long-password-9' })).statusCode, 400);
  }
  assert.equal((await db.query("SELECT 1 FROM users WHERE username IN ('admin','root')")).rowCount, 0);
  assert.equal(Number((await db.query('SELECT uses FROM invites WHERE id = $1', [invite.id])).rows[0].uses), 0);
});

test('concurrent accepts of a one-use invite create exactly one user', async () => {
  const invite = await createInvite();
  const results = await Promise.all([8, 9, 10, 11].map((n) => accept(invite.token, newUser(n))));
  assert.equal(results.filter((r) => r.statusCode === 204).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 404).length, 3);
});

test('admin can delete an invite; the link then stops working', async () => {
  const invite = await createInvite();
  assert.equal((await send('DELETE', `/api/invites/${invite.id}`, { cookie: adminCookie })).statusCode, 204);
  assert.equal((await send('DELETE', `/api/invites/${invite.id}`, { cookie: adminCookie })).statusCode, 404);
  assert.equal((await send('DELETE', '/api/invites/abc', { cookie: adminCookie })).statusCode, 404);
  assert.deepEqual((await send('GET', `/api/invites/${invite.token}`)).json(), { valid: false });
});

test('public routes are rate-limited per route (20 checks / 10 accepts)', async () => {
  const token = 'B'.repeat(43);
  const statuses = [];
  for (let i = 0; i < 22; i += 1) statuses.push((await app.inject({ method: 'GET', url: `/api/invites/${token}`, remoteAddress: '10.0.0.77', headers: { origin } })).statusCode);
  assert.equal(statuses.filter((s) => s === 200).length, 20);
  assert.deepEqual(statuses.slice(20), [429, 429]);
  const accepts = [];
  for (let i = 0; i < 12; i += 1) accepts.push((await accept(token, newUser(100 + i), '10.0.0.88')).statusCode);
  assert.equal(accepts.filter((s) => s === 404).length, 10);
  assert.deepEqual(accepts.slice(10), [429, 429]);
});

test('cross-origin state-changing calls are refused', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/invites', payload: {}, headers: { origin: 'https://evil.example', cookie: adminCookie } });
  assert.equal(response.statusCode, 403);
});
