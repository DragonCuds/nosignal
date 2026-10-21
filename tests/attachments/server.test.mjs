import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as C from '../../apps/web/src/attachments/crypto.ts';

const root = path.resolve(import.meta.dirname, '../..');
const PORT = 4151;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SECRET = 'attachment-test-only-secret-with-at-least-32-bytes';
let app, db, mod, dataDir;
const cookies = {};

const api = (method, url, { user = 'a', body, headers = {} } = {}) => fetch(`${ORIGIN}${url}`, {
  method, body, headers: { Origin: ORIGIN, Cookie: `tel_session=${cookies[user]}`, ...headers }
});
const put = (user, chat, id, data, headers = {}) => api('PUT', `/api/chats/${chat}/attachments/${id}`, { user, body: data, headers: { 'Content-Type': 'application/octet-stream', ...headers } });
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
const encrypt = async (size, chatId, id) => {
  const s = C.newAttachmentSecrets();
  const c = { key: await C.importAttachmentKey(s.key), noncePrefix: C.unb64u(s.noncePrefix), chatId, id, size };
  const plain = new Uint8Array(randomBytes(size));
  const parts = [];
  for await (const p of C.encryptChunks(c, new Blob([plain]))) parts.push(Buffer.from(p));
  return { c, plain, cipher: Buffer.concat(parts) };
};

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-att-test-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: dataDir, SESSION_SECRET: SECRET,
    MAX_ATTACHMENT_MB: '1', USER_QUOTA_MB: '1', TRUSTED_ORIGINS: ORIGIN, WEBAUTHN_RP_ID: '127.0.0.1'
  });
  const { register } = await import(pathToFileURL(path.join(root, 'apps/server/node_modules/tsx/dist/esm/api/index.mjs')));
  register();
  const src = (f) => pathToFileURL(path.join(root, 'apps/server/src', f)).href;
  const { default: Fastify } = await import(pathToFileURL(path.join(root, 'apps/server/node_modules/fastify/fastify.js')).href).catch(() => import('fastify'));
  const { default: cookie } = await import('@fastify/cookie');
  ({ db } = await import(src('db.ts')));
  const { runMigrations } = await import(src('migrate.ts'));
  const { requireTrustedOrigin } = await import(src('auth.ts'));
  mod = await import(src('attachments/index.ts'));
  await runMigrations();
  for (const [i, u] of ['a', 'b', 'c'].entries()) {
    await db.query('INSERT INTO users (username, display_name, password_hash) VALUES ($1, $1, $2)', [u, 'x']);
    const token = `token-${u}`;
    cookies[u] = token;
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))`,
      [`00000000-0000-4000-8000-00000000000${i}`, i + 1, createHmac('sha256', SECRET).update(token).digest('hex')]
    );
  }
  await db.query('INSERT INTO chats DEFAULT VALUES');
  for (const u of [1, 2]) await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES (1, $1)', [u]);
  app = Fastify();
  await app.register(cookie);
  app.addHook('onRequest', requireTrustedOrigin);
  await mod.registerAttachments(app);
  await app.listen({ host: '127.0.0.1', port: PORT });
});
after(async () => { app?.server.closeAllConnections(); await app?.close(); await db?.end(); await rm(dataDir, { recursive: true, force: true }); });

test('upload -> fresh sender read -> reference -> member read with Range -> decrypt', async () => {
  const id = hex();
  const size = 600_000;
  const { c, plain, cipher } = await encrypt(size, '1', id);
  const r = await put('a', 1, id, cipher);
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { id, size: cipher.length });
  assert.equal((await api('GET', `/api/attachments/${id}`, { user: 'b' })).status, 404, 'recipient cannot read unreferenced upload');
  assert.equal((await api('GET', `/api/attachments/${id}`, { user: 'c' })).status, 404, 'non-member');
  const own = await api('GET', `/api/attachments/${id}`, { user: 'a' });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('accept-ranges'), 'bytes');
  assert.equal(own.headers.get('cache-control'), 'private, no-store');
  assert.equal(own.headers.get('content-disposition'), 'attachment');
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), cipher);
  await db.query(
    `INSERT INTO messages (chat_id, sender_id, kind, encryption_version, cipher_id, nonce, ciphertext, attachment_id)
     VALUES (1, 1, 'photo', 2, '00000000-0000-4000-8000-000000000001', 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb', $1)`, [id]);
  const fetchCipher = async (a, b) => {
    const res = await api('GET', `/api/attachments/${id}`, { user: 'b', headers: { Range: `bytes=${a}-${b}` } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes ${a}-${b}/${cipher.length}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  assert.deepEqual(await C.decryptRange(c, 100, 300_000, fetchCipher), plain.subarray(100, 300_001));
  assert.deepEqual(await C.decryptAll(c, fetchCipher), plain);
  const tail = await api('GET', `/api/attachments/${id}`, { user: 'b', headers: { Range: 'bytes=-10' } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), cipher.subarray(-10));
  const open = await api('GET', `/api/attachments/${id}`, { user: 'b', headers: { Range: `bytes=${cipher.length - 5}-` } });
  assert.equal(open.status, 206);
  for (const bad of [`bytes=${cipher.length}-`, 'bytes=5-2', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-']) {
    const res = await api('GET', `/api/attachments/${id}`, { user: 'b', headers: { Range: bad } });
    assert.equal(res.status, 416, bad);
    assert.equal(res.headers.get('content-range'), `bytes */${cipher.length}`);
  }
  assert.equal((await api('GET', `/api/attachments/${id}`, { user: 'c' })).status, 404);
  const anon = await fetch(`${ORIGIN}/api/attachments/${id}`);
  assert.equal(anon.status, 401);
});

test('upload guards: auth, origin, membership, type, size, id reuse, bad length', async () => {
  const { cipher } = await encrypt(1000, '1', 'x');
  const id = hex();
  assert.equal((await fetch(`${ORIGIN}/api/chats/1/attachments/${id}`, { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type': 'application/octet-stream' }, body: cipher })).status, 401);
  assert.equal((await fetch(`${ORIGIN}/api/chats/1/attachments/${id}`, { method: 'PUT', headers: { Origin: 'http://evil.example', Cookie: 'tel_session=token-a', 'Content-Type': 'application/octet-stream' }, body: cipher })).status, 403);
  assert.equal((await put('c', 1, id, cipher)).status, 404, 'non-member');
  assert.equal((await put('a', 1, 'nothex', cipher)).status, 400);
  assert.equal((await put('a', 1, id, cipher, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await put('a', 1, id, Buffer.alloc(5))).status, 400, 'shorter than one tag');
  assert.equal((await put('a', 1, id, Buffer.alloc(C.CHUNK_SIZE + 16 + 3))).status, 400, 'impossible chunk layout');
  assert.equal((await put('a', 1, id, Buffer.alloc(1024 * 1024 + 4096))).status, 413, 'over cap');
  assert.equal((await put('a', 1, id, cipher)).status, 201);
  assert.equal((await put('a', 1, id, cipher)).status, 409, 'id reuse');
  assert.equal((await put('b', 1, id, cipher)).status, 409, 'id reuse by other member');
  const empty = await encrypt(0, '1', 'y');
  assert.equal(empty.cipher.length, 16);
  assert.equal((await put('a', 1, hex(), empty.cipher)).status, 201, 'empty file ok');
});

test('per-user quota counts live attachments', async () => {
  // user a already has ~ <1 MB? top up until refused, then another user is unaffected
  let refused = false;
  for (let i = 0; i < 4 && !refused; i++) {
    const { cipher } = await encrypt(400_000, '1', 'z');
    const res = await put('a', 1, hex(), cipher);
    if (res.status === 413) { refused = true; assert.match((await res.json()).error, /quota/iu); }
  }
  assert.ok(refused, 'quota must trigger');
  const { cipher } = await encrypt(400_000, '1', 'z');
  assert.equal((await put('b', 1, hex(), cipher)).status, 201);
});

test('orphan cleanup removes unreferenced old uploads and stale parts, keeps referenced; retention expires', async () => {
  const rows = (await db.query('SELECT id FROM attachments')).rows.map((r) => r.id);
  const referenced = (await db.query('SELECT attachment_id AS id FROM messages WHERE attachment_id IS NOT NULL')).rows[0].id;
  const fresh = rows.filter((r) => r !== referenced);
  assert.ok(fresh.length > 2);
  // fresh orphans survive the grace period
  assert.deepEqual(await mod.cleanupAttachments(), { orphans: 0, expired: 0, strays: 0, uploads: 0 });
  await db.query(`UPDATE attachments SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours')`);
  const stray = path.join(mod.attachmentsDir(), `${hex()}.part`);
  await writeFile(stray, 'x');
  const old = new Date(Date.now() - 2 * 3_600_000);
  await (await import('node:fs/promises')).utimes(stray, old, old);
  const res = await mod.cleanupAttachments();
  assert.equal(res.orphans, fresh.length);
  assert.equal(res.strays, 1);
  assert.ok(!existsSync(stray));
  for (const id of fresh) assert.ok(!existsSync(path.join(mod.attachmentsDir(), `${id}.bin`)));
  assert.ok(existsSync(path.join(mod.attachmentsDir(), `${referenced}.bin`)));
  assert.equal((await api('GET', `/api/attachments/${referenced}`, { user: 'b' })).status, 200);

  process.env.ATTACHMENT_RETENTION_DAYS = '1';
  await db.query(`UPDATE attachments SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days')`);
  const r2 = await mod.cleanupAttachments();
  delete process.env.ATTACHMENT_RETENTION_DAYS;
  assert.equal(r2.expired, 1);
  assert.equal((await api('GET', `/api/attachments/${referenced}`, { user: 'b' })).status, 410);
});
