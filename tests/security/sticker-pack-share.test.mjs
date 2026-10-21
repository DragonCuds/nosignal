import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { FFMPEG, skipNoFfmpeg } from './ffmpeg.mjs';

// "Add to my stickers": a pack shared into a chat can be previewed and added by CURRENT members of that chat only.
const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-pack-share-'));
const work = await mkdtemp(path.join(os.tmpdir(), 'tel-pack-share-src-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'pack-share-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;

const load = (name) => import(path.join(dist, name));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const { db } = await load('db.js');
const { createUser } = await load('users.js');
const { createSession, requireTrustedOrigin } = await load('auth.js');
const { runMigrations } = await load('migrate.js');

let app;
const cookies = {};
const ids = {};
const cookieOf = (response) => response.headers['set-cookie'].split(';')[0];
const send = (method, url, { user, payload, headers } = {}) => app.inject({
  method, url, payload, remoteAddress: '10.0.0.1',
  headers: { origin, ...(user ? { cookie: cookies[user] } : {}), ...headers }
});
const multipart = (filename, bytes) => {
  const boundary = '----share' + Math.random().toString(16).slice(2);
  return {
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
};
const makeZip = async (name, seed) => {
  const dir = path.join(work, name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 2; i += 1) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${seed}${i}${i}${i}${i}:s=512x256`, '-frames:v', '1', path.join(dir, `s${i}.webp`)]);
  }
  const zip = path.join(work, `${name}.zip`);
  execFileSync('python3', ['-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor f in sorted(os.listdir(sys.argv[2])): z.write(os.path.join(sys.argv[2],f),f)\nz.close()', zip, dir]);
  return readFile(zip);
};
const importPack = async (user, name, seed) => {
  const res = await send('POST', '/api/media/packs/import', { user, ...multipart(`${name}.zip`, await makeZip(name, seed)) });
  assert.equal(res.statusCode, 201, res.body);
  const pack = res.json();
  const detail = (await send('GET', `/api/media/packs/${pack.id}`, { user })).json();
  return { ...pack, ...detail };
};
const newChat = async (...members) => {
  await db.query('INSERT INTO chats DEFAULT VALUES');
  const id = (await db.query('SELECT max(id) AS id FROM chats')).rows[0].id;
  for (const member of members) await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [id, ids[member]]);
  return id;
};
const preview = (user, chat, pack) => send('GET', `/api/chats/${chat}/sticker-packs/${pack}`, { user });
const grant = (user, chat, pack) => send('POST', `/api/chats/${chat}/sticker-packs/${pack}/grant`, { user });
const add = (user, chat, pack) => send('PUT', `/api/chats/${chat}/sticker-packs/${pack}/library`, { user });
const remove = (user, pack) => send('DELETE', `/api/media/packs/${pack}/library`, { user });
const library = async (user) => (await send('GET', '/api/media/packs', { user })).json().map((p) => String(p.id));
const grants = async (chat, pack) => (await db.query('SELECT 1 FROM chat_sticker_pack_grants WHERE chat_id = $1 AND pack_id = $2', [chat, pack])).rowCount;

let P; let Q; let chatAB; let chatAC; let chatAD;

before(async () => {
  await runMigrations();
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 10_000, timeWindow: '1 minute' });
  app.addHook('onRequest', requireTrustedOrigin);
  app.get('/test/login/:id', async (request, reply) => { await createSession(request.params.id, reply, request); return { ok: true }; });
  const { registerMediaRoutes } = await load('media/routes.js');
  await registerMediaRoutes(app);
  await app.ready();
  for (const name of ['alice', 'bob', 'carol', 'dave']) ids[name] = await createUser(name, name, 'a-long-password-9');
  for (const [name, id] of Object.entries(ids)) cookies[name] = cookieOf(await send('GET', `/test/login/${id}`));
  chatAB = await newChat('alice', 'bob');
  chatAC = await newChat('alice', 'carol');
  chatAD = await newChat('alice', 'dave');
  if (!skipNoFfmpeg) { P = await importPack('alice', 'p', 'ff'); Q = await importPack('alice', 'q', 'ee'); }
});

after(async () => {
  await app.close();
  await db.end();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test('nothing is previewable before the pack was shared into the chat; pack id guessing is a uniform 404', { skip: skipNoFfmpeg }, async () => {
  const refusal = await preview('bob', chatAB, P.id);
  assert.equal(refusal.statusCode, 404);
  assert.deepEqual(refusal.json(), { error: 'Pack not found' });
  assert.deepEqual((await preview('bob', chatAB, '99999')).json(), refusal.json(), 'missing pack looks exactly like a not-shared pack');
  assert.equal((await preview('bob', chatAC, P.id)).statusCode, 404, 'a chat bob is not in');
  assert.equal((await preview('alice', chatAB, P.id)).statusCode, 404, 'even the owner needs a grant for the chat route');
  assert.equal((await send('GET', `/api/chats/${chatAB}/sticker-packs/${P.id}`)).statusCode, 401);
  assert.equal((await send('GET', `/api/chats/${chatAB}/sticker-packs/abc`, { user: 'bob' })).statusCode, 400);
  assert.equal((await send('GET', P.stickers[0].fileUrl, { user: 'bob' })).statusCode, 404);
  assert.equal((await add('bob', chatAB, P.id)).statusCode, 404);
  assert.deepEqual(await library('bob'), []);
});

test('only a chat member who holds a live pack can grant it', { skip: skipNoFfmpeg }, async () => {
  assert.equal((await send('POST', `/api/chats/${chatAB}/sticker-packs/${P.id}/grant`)).statusCode, 401);
  assert.equal((await grant('alice', chatAB, 'x1')).statusCode, 400);
  assert.equal((await grant('carol', chatAB, P.id)).statusCode, 404, 'non-member');
  assert.equal((await grant('bob', chatAB, P.id)).statusCode, 404, 'member who does not hold the pack');
  assert.equal((await grant('alice', chatAB, '99999')).statusCode, 404);
  assert.equal(await grants(chatAB, P.id), 0);
  assert.equal((await grant('alice', chatAB, P.id)).statusCode, 204);
  assert.equal((await grant('alice', chatAB, P.id)).statusCode, 204, 'idempotent');
  assert.equal(await grants(chatAB, P.id), 1);
  assert.equal(String((await db.query('SELECT granted_by FROM chat_sticker_pack_grants WHERE chat_id = $1 AND pack_id = $2', [chatAB, P.id])).rows[0].granted_by), String(ids.alice));
  assert.equal(await grants(chatAB, Q.id), 0, 'the other pack was never shared');
});

test('a member opens the whole pack through the grant; strangers and other packs stay 404', { skip: skipNoFfmpeg }, async () => {
  const res = await preview('bob', chatAB, P.id);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.id, P.id);
  assert.equal(body.title, P.title);
  assert.equal(body.inLibrary, false);
  assert.equal(body.owned, false);
  assert.equal(body.slug, undefined, 'no slug is exposed');
  assert.equal(body.stickers.length, 2);
  assert.equal((await preview('alice', chatAB, P.id)).json().owned, true);
  assert.equal((await preview('carol', chatAB, P.id)).statusCode, 404);
  assert.equal((await preview('carol', chatAC, P.id)).statusCode, 404, 'a grant in another chat does not help');
  assert.equal((await preview('bob', chatAB, Q.id)).statusCode, 404, 'an unshared pack of the same owner');
  // the preview grid loads: every sticker and the pack thumb, for members only
  for (const sticker of body.stickers) {
    assert.equal((await send('GET', sticker.fileUrl, { user: 'bob' })).statusCode, 200);
    assert.equal((await send('GET', sticker.fileUrl, { user: 'carol' })).statusCode, 404);
  }
  assert.equal((await send('GET', body.thumbUrl, { user: 'bob' })).statusCode, 200);
  assert.equal((await send('GET', Q.stickers[0].fileUrl, { user: 'bob' })).statusCode, 404);
  assert.deepEqual(await library('bob'), [], 'previewing does not add anything');
});

test('add puts a shared reference in the library, is idempotent, and unlocks the files', { skip: skipNoFfmpeg }, async () => {
  assert.equal((await add('carol', chatAB, P.id)).statusCode, 404);
  assert.equal((await add('bob', chatAB, P.id)).statusCode, 204);
  assert.equal((await add('bob', chatAB, P.id)).statusCode, 204);
  assert.deepEqual(await library('bob'), [String(P.id)]);
  assert.equal((await db.query('SELECT count(*) AS n FROM user_sticker_packs WHERE user_id = $1', [ids.bob])).rows[0].n, 1);
  const listed = (await send('GET', '/api/media/packs', { user: 'bob' })).json()[0];
  assert.equal(listed.owned, false);
  const detail = (await send('GET', `/api/media/packs/${P.id}`, { user: 'bob' }));
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().stickers.length, 2);
  for (const sticker of detail.json().stickers) assert.equal((await send('GET', sticker.fileUrl, { user: 'bob' })).statusCode, 200);
  assert.equal((await preview('bob', chatAB, P.id)).json().inLibrary, true);
  // nothing was copied: no new pack, no new sticker rows, no storage charged to bob
  assert.equal((await db.query('SELECT count(*) AS n FROM sticker_packs')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*) AS n FROM sticker_packs WHERE owner_id = $1', [ids.bob])).rows[0].n, 0);
  assert.equal((await send('POST', `/api/media/stickers/${P.stickers[0].id}/recent`, { user: 'bob' })).statusCode, 204);
});

test('a viewer can neither rename nor delete the owner\'s pack, and removing only drops his own link', { skip: skipNoFfmpeg }, async () => {
  assert.equal((await send('DELETE', `/api/media/packs/${P.id}`, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('PATCH', `/api/media/packs/${P.id}`, { user: 'bob', payload: { title: 'x' } })).statusCode, 404, 'there is no rename route at all');
  assert.equal((await db.query('SELECT title FROM sticker_packs WHERE id = $1', [P.id])).rows[0].title, P.title);
  assert.equal((await remove('alice', P.id)).statusCode, 409, 'the owner deletes instead');
  assert.equal((await remove('carol', P.id)).statusCode, 204, 'no-op for somebody who never had it');
  assert.deepEqual(await library('alice'), [String(P.id), String(Q.id)]);
  assert.equal((await remove('bob', P.id)).statusCode, 204);
  assert.deepEqual(await library('bob'), []);
  assert.deepEqual((await send('GET', '/api/media/stickers/recent', { user: 'bob' })).json(), [], 'his recents of that pack went with the link');
  assert.equal((await send('GET', P.stickers[0].fileUrl, { user: 'bob' })).statusCode, 200, 'still a chat member, so the shared files stay visible');
  assert.deepEqual(await library('alice'), [String(P.id), String(Q.id)], 'the owner is untouched');
  assert.equal((await remove('bob', P.id)).statusCode, 204, 'removing twice is fine');
  assert.equal((await send('GET', `/api/media/packs/${P.id}`, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('GET', `/api/chats/${chatAC}/sticker-packs/${P.id}`, { user: 'bob' })).statusCode, 404);
});

test('leaving the chat ends preview and add at once; the library copy keeps working until removed', { skip: skipNoFfmpeg }, async () => {
  assert.equal((await add('bob', chatAB, P.id)).statusCode, 204);
  await db.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatAB, ids.bob]);
  assert.equal((await preview('bob', chatAB, P.id)).statusCode, 404);
  assert.equal((await add('bob', chatAB, P.id)).statusCode, 404);
  assert.equal((await grant('bob', chatAB, P.id)).statusCode, 404);
  assert.equal((await send('GET', P.stickers[0].fileUrl, { user: 'bob' })).statusCode, 200, 'it is in his library');
  assert.equal((await remove('bob', P.id)).statusCode, 204);
  assert.equal((await send('GET', P.stickers[0].fileUrl, { user: 'bob' })).statusCode, 404, 'no library link and no chat any more');
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chatAB, ids.bob]);
  assert.equal((await preview('bob', chatAB, P.id)).statusCode, 200, 'a re-joined member sees it again');
  await remove('bob', P.id);
});

test('the pack cap applies to added packs with the usual quota_packs error', { skip: skipNoFfmpeg }, async () => {
  await grant('alice', chatAD, P.id);
  for (let i = 0; i < 20; i += 1) {
    await db.query(`INSERT INTO sticker_packs (slug, title, owner_id) VALUES ($1, 't', $2)`, [`cap-${i}`, ids.carol]);
    const packId = (await db.query('SELECT max(id) AS id FROM sticker_packs')).rows[0].id;
    await db.query('INSERT INTO user_sticker_packs (user_id, pack_id, sort) VALUES ($1, $2, $3)', [ids.dave, packId, i]);
  }
  const res = await add('dave', chatAD, P.id);
  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().code, 'quota_packs');
  assert.match(res.json().error, /at most 20 sticker packs/);
  assert.equal((await db.query('SELECT 1 FROM user_sticker_packs WHERE user_id = $1 AND pack_id = $2', [ids.dave, P.id])).rowCount, 0);
  // a full library also blocks importing, like any other pack
  const imported = await send('POST', '/api/media/packs/import', { user: 'dave', ...multipart('d.zip', await makeZip('d', 'dd')) });
  assert.equal(imported.statusCode, 413, imported.body);
  assert.equal(imported.json().code, 'quota_packs');
  await db.query('DELETE FROM user_sticker_packs WHERE user_id = $1 AND pack_id = (SELECT min(pack_id) FROM user_sticker_packs WHERE user_id = $1)', [ids.dave]);
  assert.equal((await add('dave', chatAD, P.id)).statusCode, 204);
  assert.equal((await add('dave', chatAD, P.id)).statusCode, 204, 'already in the library: no quota check, no duplicate');
  await db.query('DELETE FROM user_sticker_packs WHERE user_id = $1', [ids.dave]);
});

test('only people who may post can grant into a channel', { skip: skipNoFfmpeg }, async () => {
  const chat = await newChat('alice', 'bob');
  await db.query('INSERT INTO channels (chat_id, owner_id, title, key_wrapped) VALUES ($1, $2, $3, $4)', [chat, ids.alice, 'ch', 'x']);
  const channel = (await db.query('SELECT id FROM channels WHERE chat_id = $1', [chat])).rows[0].id;
  await db.query(`INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [channel, ids.alice, ids.bob]);
  const mine = await importPack('bob', 'bobpack', 'cc');
  assert.equal((await grant('bob', chat, mine.id)).statusCode, 403, 'a plain subscriber cannot post, so cannot share');
  assert.equal(await grants(chat, mine.id), 0);
  assert.equal((await grant('alice', chat, P.id)).statusCode, 204, 'the owner can');
  assert.equal((await add('bob', chat, P.id)).statusCode, 204);
  await remove('bob', P.id);
});

test('deleting the pack: sent stickers are released, everybody else loses it, grants end', { skip: skipNoFfmpeg }, async () => {
  const R = await importPack('alice', 'r', 'aa');
  assert.equal((await grant('alice', chatAB, R.id)).statusCode, 204);
  assert.equal((await add('bob', chatAB, R.id)).statusCode, 204);
  assert.equal((await send('POST', `/api/media/stickers/${R.stickers[0].id}/recent`, { user: 'bob' })).statusCode, 204);
  // a sticker of R was sent in a chat in the old, readable way, so the pack can only be released
  await db.query(`INSERT INTO messages (chat_id, sender_id, kind, payload, encryption_version, nonce, ciphertext, cipher_id)
    VALUES ($1, $2, 'sticker', $3, 2, 'AAAAAAAAAAAAAAAA', $4, '00000000-0000-4000-8000-0000000000aa')`, [chatAB, ids.alice, JSON.stringify({ stickerId: R.stickers[0].id }), 'A'.repeat(30)]);
  assert.equal((await send('DELETE', `/api/media/packs/${R.id}`, { user: 'bob' })).statusCode, 404);
  assert.equal((await send('DELETE', `/api/media/packs/${R.id}`, { user: 'alice' })).statusCode, 204);
  assert.ok(!(await library('bob')).includes(String(R.id)), 'bob lost it from his library');
  assert.ok(!(await library('alice')).includes(String(R.id)));
  assert.equal(await grants(chatAB, R.id), 0, 'grants are gone');
  assert.equal((await send('GET', `/api/media/packs/${R.id}`, { user: 'bob' })).statusCode, 404);
  assert.equal((await preview('bob', chatAB, R.id)).statusCode, 404);
  assert.equal((await add('bob', chatAB, R.id)).statusCode, 404, 'a released pack cannot be added');
  assert.equal((await grant('alice', chatAB, R.id)).statusCode, 404, 'nor shared again');
  assert.equal((await db.query('SELECT count(*) AS n FROM recent_stickers WHERE sticker_id = $1', [R.stickers[0].id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT owner_id FROM sticker_packs WHERE id = $1', [R.id])).rows[0].owner_id, null);
  // the sticker that was actually sent keeps loading for its chat only, the rest of the pack does not
  assert.equal((await send('GET', R.stickers[0].fileUrl, { user: 'bob' })).statusCode, 200);
  assert.equal((await send('GET', R.stickers[0].fileUrl, { user: 'carol' })).statusCode, 404);
  assert.equal((await send('GET', R.stickers[1].fileUrl, { user: 'bob' })).statusCode, 404);

  // an unused pack is erased with its files; the grants and library links go with it
  const S = await importPack('alice', 's', 'bb');
  await grant('alice', chatAB, S.id);
  await add('bob', chatAB, S.id);
  const file = path.join(dataDir, 'media', S.stickers[0].fileUrl.slice('/media/'.length));
  assert.ok(existsSync(file));
  assert.equal((await send('DELETE', `/api/media/packs/${S.id}`, { user: 'alice' })).statusCode, 204);
  assert.ok(!existsSync(file));
  assert.equal(await grants(chatAB, S.id), 0);
  assert.equal((await db.query('SELECT 1 FROM user_sticker_packs WHERE pack_id = $1', [S.id])).rowCount, 0);
  assert.ok(!(await library('bob')).includes(String(S.id)));
});
