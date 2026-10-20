import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-media-own-'));
const work = await mkdtemp(path.join(os.tmpdir(), 'tel-media-own-src-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'media-own-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;

const load = (name) => import(path.join(dist, name));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const { db } = await load('db.js');
const { createUser } = await load('users.js');
const { createSession, requireTrustedOrigin } = await load('auth.js');

let app;
const cookies = {};
const ids = {};
const cookieOf = (response) => response.headers['set-cookie'].split(';')[0];
const send = (method, url, { user, payload, headers } = {}) => app.inject({
  method, url, payload, remoteAddress: '10.0.0.1',
  headers: { origin, ...(user ? { cookie: cookies[user] } : {}), ...headers }
});
const multipart = (filename, bytes, fields = {}) => {
  const boundary = '----own' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
};
const upload = (url, user, filename, bytes, fields) => send('POST', url, { user, ...multipart(filename, bytes, fields) });

const makeZip = async (name, seed) => {
  const dir = path.join(work, name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 2; i += 1) {
    execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${seed}${i}${i}${i}${i}:s=512x256`, '-frames:v', '1', path.join(dir, `s${i}.webp`)]);
  }
  const zip = path.join(work, `${name}.zip`);
  execFileSync('python3', ['-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor f in sorted(os.listdir(sys.argv[2])): z.write(os.path.join(sys.argv[2],f),f)\nz.close()', zip, dir]);
  return readFile(zip);
};
const makeGif = async (name, color) => {
  const file = path.join(work, `${name}.gif`);
  execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1:r=5`, file]);
  return readFile(file);
};

const sendMessage = async (chatId, senderId, kind, payload, n) => {
  const hex = (x) => x.toString(16).padStart(12, '0');
  await db.query(
    `INSERT INTO messages (chat_id, sender_id, kind, payload, encryption_version, nonce, ciphertext, cipher_id)
     VALUES ($1, $2, $3, $4, 2, $5, $6, $7)`,
    [chatId, senderId, kind, JSON.stringify(payload), 'AAAAAAAAAAAAAAAA', 'A'.repeat(30), `00000000-0000-4000-8000-${hex(n)}`]
  );
  return (await db.query('SELECT max(id) AS id FROM messages')).rows[0].id;
};

before(async () => {
  // Build a "live looking" DB first: migrations 001-007, legacy media rows, then 008 must backfill owners.
  const { readdir: ls } = await import('node:fs/promises');
  const migrationsDir = path.join(root, 'apps/server/migrations');
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
  const files = (await ls(migrationsDir)).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
  for (const file of files.filter((f) => f < '008')) {
    await db.query('BEGIN');
    await db.query(await readFile(path.join(migrationsDir, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
  ids.first = await createUser('firstuser', 'First', 'a-long-password-9');
  ids.other = await createUser('otheruser', 'Other', 'a-long-password-9');
  await db.query(`INSERT INTO sticker_packs (slug, title, thumb_path) VALUES ('legacy', 'Legacy', 'stickers/${'a'.repeat(64)}.webp')`);
  await db.query(`INSERT INTO stickers (pack_id, file_path, format, w, h) VALUES (1, 'stickers/${'a'.repeat(64)}.webp', 'webp', 512, 256)`);
  await db.query('INSERT INTO user_sticker_packs (user_id, pack_id, sort) VALUES ($1, 1, 0), ($2, 1, 0)', [ids.first, ids.other]);
  await db.query(`INSERT INTO gifs (owner_id, mp4_path, poster_path, w, h, duration_ms) VALUES (NULL, 'gifs/${'b'.repeat(64)}.mp4', 'gifs/${'b'.repeat(64)}.webp', 64, 64, 1000)`);
  await db.query(`INSERT INTO gifs (owner_id, mp4_path, poster_path, w, h, duration_ms) VALUES ($1, 'gifs/${'c'.repeat(64)}.mp4', 'gifs/${'c'.repeat(64)}.webp', 64, 64, 1000)`, [ids.other]);
  await db.query(`INSERT INTO gifs (owner_id, mp4_path, poster_path, w, h, duration_ms) VALUES (NULL, 'gifs/${'d'.repeat(64)}.mp4', 'gifs/${'d'.repeat(64)}.webp', 64, 64, 1000)`);
  await db.query('INSERT INTO saved_gifs (user_id, gif_id) VALUES ($1, 3)', [ids.other]);
  const { runMigrations } = await load('migrate.js');
  await runMigrations();

  const { registerMediaRoutes } = await load('media/routes.js');
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 10_000, timeWindow: '1 minute' });
  app.addHook('onRequest', requireTrustedOrigin);
  app.get('/test/login/:id', async (request, reply) => { await createSession(request.params.id, reply, request); return { ok: true }; });
  await registerMediaRoutes(app);
  await app.ready();

  ids.alice = await createUser('alice', 'Alice', 'a-long-password-9');
  ids.bob = await createUser('bob', 'Bob', 'a-long-password-9');
  ids.carol = await createUser('carol', 'Carol', 'a-long-password-9');
  for (const [name, id] of Object.entries(ids)) cookies[name] = cookieOf(await send('GET', `/test/login/${id}`));
  await db.query('INSERT INTO chats DEFAULT VALUES');
  ids.chat = (await db.query('SELECT max(id) AS id FROM chats')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)', [ids.chat, ids.alice, ids.bob]);
});

after(async () => {
  await app.close();
  await db.end();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test('migration 008 backfills owners and loses nothing', async () => {
  const pack = (await db.query('SELECT owner_id FROM sticker_packs WHERE id = 1')).rows[0];
  assert.equal(String(pack.owner_id), String(ids.first));
  const links = (await db.query('SELECT user_id FROM user_sticker_packs WHERE pack_id = 1')).rows.map((r) => String(r.user_id));
  assert.deepEqual(links, [String(ids.first)]);
  const gifs = (await db.query('SELECT id, owner_id FROM gifs ORDER BY id')).rows.map((r) => [String(r.id), String(r.owner_id)]);
  assert.deepEqual(gifs, [['1', String(ids.first)], ['2', String(ids.other)], ['3', String(ids.other)]]);
  assert.equal((await db.query('SELECT count(*) AS n FROM stickers')).rows[0].n, 1);
  // the legacy owner sees exactly his own, the other user keeps only what he owns or saved
  const first = (await send('GET', '/api/media/packs', { user: 'first' })).json();
  assert.equal(first.length, 1);
  assert.equal((await send('GET', '/api/media/packs', { user: 'other' })).json().length, 0);
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'first' })).json().map((g) => g.id), ['1']);
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'other' })).json().map((g) => g.id).sort(), ['2', '3']);
});

test('a brand-new user starts empty', async () => {
  assert.deepEqual((await send('GET', '/api/media/packs', { user: 'carol' })).json(), []);
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'carol' })).json(), []);
  assert.deepEqual((await send('GET', '/api/media/gifs/saved', { user: 'carol' })).json(), []);
  assert.deepEqual((await send('GET', '/api/media/stickers/recent', { user: 'carol' })).json(), []);
  assert.equal((await send('GET', '/api/media/packs')).statusCode, 401);
});

let pack; let packDetail;
test('a user imports a pack and sees only their own', async () => {
  const zip = await makeZip('p1', 'ff');
  const res = await upload('/api/media/packs/import', 'alice', 'one.zip', zip, { slug: 'same', title: 'Mine' });
  assert.equal(res.statusCode, 201, res.body);
  pack = res.json();
  assert.equal(pack.count, 2);
  assert.equal((await send('GET', '/api/media/packs', { user: 'alice' })).json().length, 1);
  assert.equal((await send('GET', '/api/media/packs', { user: 'bob' })).json().length, 0);
  assert.equal((await send('GET', `/api/media/packs/${pack.id}`, { user: 'bob' })).statusCode, 404);
  packDetail = (await send('GET', `/api/media/packs/${pack.id}`, { user: 'alice' })).json();
  assert.equal(packDetail.stickers.length, 2);
  // same slug from another user must not fail or reveal anything
  const again = await upload('/api/media/packs/import', 'bob', 'two.zip', await makeZip('p2', 'ee'), { slug: 'same', title: 'Bob pack' });
  assert.equal(again.statusCode, 201, again.body);
  assert.notEqual(again.json().slug, 'same');
  assert.equal((await send('GET', '/api/media/packs', { user: 'bob' })).json().length, 1);
  assert.equal((await send('GET', '/api/media/packs', { user: 'alice' })).json().length, 1);
});

test('/media is private: owner yes, stranger and anonymous no', async () => {
  const url = packDetail.stickers[0].fileUrl;
  assert.equal((await send('GET', url, { user: 'alice' })).statusCode, 200);
  assert.equal((await send('GET', url, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('GET', url, { user: 'carol' })).statusCode, 404);
  assert.equal((await send('GET', url)).statusCode, 401);
  assert.equal((await send('GET', pack && `/media/${packDetail.thumbUrl?.slice(7) ?? ''}`, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('GET', `/media/stickers/${'0'.repeat(64)}.webp`, { user: 'alice' })).statusCode, 404);
  // recent-sticker probing of somebody else's sticker id is refused
  assert.equal((await send('POST', `/api/media/stickers/${packDetail.stickers[0].id}/recent`, { user: 'carol' })).statusCode, 404);
  assert.equal((await send('POST', `/api/media/stickers/${packDetail.stickers[0].id}/recent`, { user: 'alice' })).statusCode, 204);
});

test('a sticker sent in a chat loads for its members only, and stops when the message is deleted', async () => {
  const sticker = packDetail.stickers[0];
  const messageId = await sendMessage(ids.chat, ids.alice, 'sticker', { stickerId: sticker.id }, 1);
  assert.equal((await send('GET', sticker.fileUrl, { user: 'bob' })).statusCode, 200);
  assert.equal((await send('GET', sticker.fileUrl, { user: 'carol' })).statusCode, 404);
  // the sticker the message did not use stays hidden from bob
  assert.equal((await send('GET', packDetail.stickers[1].fileUrl, { user: 'bob' })).statusCode, 404);
  // but bob still has no pack of his own from it
  assert.equal((await send('GET', `/api/media/packs/${pack.id}`, { user: 'bob' })).statusCode, 404);
  await db.query("UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1", [messageId]);
  assert.equal((await send('GET', sticker.fileUrl, { user: 'bob' })).statusCode, 404);
});

let gif;
test('GIF upload is private; list and saved are per user', async () => {
  const res = await upload('/api/media/gifs/upload', 'alice', 'a.gif', await makeGif('g1', 'red'), { tags: 'red' });
  assert.equal(res.statusCode, 201, res.body);
  gif = res.json();
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'alice' })).json().map((g) => g.id), [gif.id]);
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'bob' })).json(), []);
  assert.equal((await send('GET', gif.mp4Url, { user: 'alice' })).statusCode, 200);
  assert.equal((await send('GET', gif.posterUrl, { user: 'alice' })).statusCode, 200);
  assert.equal((await send('GET', gif.mp4Url, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('PUT', `/api/media/gifs/${gif.id}/save`, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('PUT', `/api/media/gifs/${gif.id}/save`, { user: 'alice' })).statusCode, 204);
});

test('a GIF sent in a chat loads for members and can be saved by them', async () => {
  await sendMessage(ids.chat, ids.alice, 'gif', { gifId: gif.id }, 2);
  assert.equal((await send('GET', gif.mp4Url, { user: 'bob' })).statusCode, 200);
  assert.equal((await send('GET', gif.mp4Url, { user: 'carol' })).statusCode, 404);
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'bob' })).json(), []);
  assert.equal((await send('PUT', `/api/media/gifs/${gif.id}/save`, { user: 'bob' })).statusCode, 204);
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'bob' })).json().map((g) => g.id), [gif.id]);
});

test('delete is owner only; sent items are released, not erased', async () => {
  assert.equal((await send('DELETE', `/api/media/gifs/${gif.id}`, { user: 'carol' })).statusCode, 404);
  assert.equal((await send('DELETE', `/api/media/gifs/${gif.id}`, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('DELETE', `/api/media/gifs/${gif.id}`)).statusCode, 401);
  assert.equal((await send('DELETE', `/api/media/gifs/abc`, { user: 'alice' })).statusCode, 400);
  assert.equal((await send('DELETE', `/api/media/gifs/${gif.id}`, { user: 'alice' })).statusCode, 204);
  assert.deepEqual((await send('GET', '/api/media/gifs', { user: 'alice' })).json(), []);
  assert.equal((await send('GET', gif.mp4Url, { user: 'bob' })).statusCode, 200, 'still shown in chat / saved by bob');
  assert.equal((await send('GET', gif.mp4Url, { user: 'alice' })).statusCode, 200, 'alice is a chat member and the message still exists');
  // a GIF nobody uses is erased with its files
  const lone = (await upload('/api/media/gifs/upload', 'carol', 'b.gif', await makeGif('g2', 'blue'))).json();
  const loneFile = path.join(dataDir, 'media', lone.mp4Url.slice('/media/'.length));
  assert.ok(existsSync(loneFile));
  assert.equal((await send('DELETE', `/api/media/gifs/${lone.id}`, { user: 'carol' })).statusCode, 204);
  assert.ok(!existsSync(loneFile));
  assert.equal((await db.query('SELECT 1 FROM gifs WHERE id = $1', [lone.id])).rowCount, 0);

  assert.equal((await send('DELETE', `/api/media/packs/${pack.id}`, { user: 'bob' })).statusCode, 404);
  const sentSticker = packDetail.stickers[0];
  await sendMessage(ids.chat, ids.alice, 'sticker', { stickerId: sentSticker.id }, 3);
  assert.equal((await send('DELETE', `/api/media/packs/${pack.id}`, { user: 'alice' })).statusCode, 204);
  assert.deepEqual((await send('GET', '/api/media/packs', { user: 'alice' })).json(), []);
  assert.equal((await send('GET', sentSticker.fileUrl, { user: 'bob' })).statusCode, 200);
  // bob's own pack is untouched, and an unused pack is erased with its files
  const bobPack = (await send('GET', '/api/media/packs', { user: 'bob' })).json()[0];
  const bobDetail = (await send('GET', `/api/media/packs/${bobPack.id}`, { user: 'bob' })).json();
  const file = path.join(dataDir, 'media', bobDetail.stickers[0].fileUrl.slice('/media/'.length));
  assert.ok(existsSync(file));
  assert.equal((await send('DELETE', `/api/media/packs/${bobPack.id}`, { user: 'bob' })).statusCode, 204);
  assert.ok(!existsSync(file));
  assert.equal((await db.query('SELECT 1 FROM sticker_packs WHERE id = $1', [bobPack.id])).rowCount, 0);
});

test('quotas: packs, GIFs and bytes give clear errors', async () => {
  const zip = await makeZip('p3', 'dd');
  // GIF count
  for (let i = 0; i < 200; i += 1) {
    await db.query(`INSERT INTO gifs (owner_id, mp4_path, poster_path, w, h, duration_ms, byte_size) VALUES ($1, $2, $3, 8, 8, 100, 10)`,
      [ids.carol, `gifs/${String(i).padStart(64, '1')}.mp4`, `gifs/${String(i).padStart(64, '1')}.webp`]);
  }
  let res = await upload('/api/media/gifs/upload', 'carol', 'c.gif', await makeGif('g3', 'green'));
  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().code, 'quota_gifs');
  assert.match(res.json().error, /at most 200 GIFs/);
  // pack count
  for (let i = 0; i < 20; i += 1) await db.query(`INSERT INTO sticker_packs (slug, title, owner_id) VALUES ($1, 't', $2)`, [`q-${i}`, ids.bob]);
  res = await upload('/api/media/packs/import', 'bob', 'q.zip', zip);
  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().code, 'quota_packs');
  // bytes
  await db.query('UPDATE gifs SET byte_size = 0 WHERE owner_id = $1', [ids.carol]);
  await db.query('DELETE FROM gifs WHERE owner_id = $1 AND id > (SELECT min(id) + 5 FROM gifs WHERE owner_id = $1)', [ids.carol]);
  await db.query('UPDATE gifs SET byte_size = $2 WHERE id = (SELECT min(id) FROM gifs WHERE owner_id = $1)', [ids.carol, 50 * 1024 * 1024]);
  res = await upload('/api/media/gifs/upload', 'carol', 'c.gif', await makeGif('g3', 'green'));
  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().code, 'quota_bytes');
  assert.match(res.json().error, /50 MB/);
  // other users are unaffected
  res = await upload('/api/media/gifs/upload', 'alice', 'c.gif', await makeGif('g3', 'green'));
  assert.equal(res.statusCode, 201, res.body);
});
