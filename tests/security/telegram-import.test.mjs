import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { FFMPEG, skipNoFfmpeg } from './ffmpeg.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-tgimp-'));
const work = await mkdtemp(path.join(os.tmpdir(), 'tel-tgimp-src-'));
// Obviously fake token, only ever sent to the local fake Bot API below.
const TOKEN = '123456789:FAKE_test_token_only_local_AAAA';
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'tg-import-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;
// The fake Bot API below is plain HTTP on loopback, which needs the explicit NS-13 opt-in.
process.env.TELEGRAM_API_ALLOW_LOCAL_HTTP = '1';

const load = (name) => import(path.join(dist, name));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const { db } = await load('db.js');
const { createUser } = await load('users.js');
const { createSession, requireTrustedOrigin } = await load('auth.js');
const { redact, parsePackName, telegramImportEnabled } = await load('media/telegram-import.js');

// ---- fixtures + fake Bot API ----
const webp = (color) => { if (skipNoFfmpeg) return Buffer.alloc(0); const f = path.join(work, `${color}.webp`); execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${color}:s=512x256`, '-frames:v', '1', f]); return readFile(f); };
const webm = async () => { if (skipNoFfmpeg) return Buffer.alloc(0); const f = path.join(work, 'a.webm'); execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=512x256:d=1:r=10', '-c:v', 'libvpx-vp9', '-b:v', '50k', f]); return readFile(f); };
const tgs = gzipSync(Buffer.from(JSON.stringify({ v: '5.5.2', fr: 30, ip: 0, op: 30, w: 512, h: 512, layers: [], assets: [] })));
const files = {
  'stickers/a.webp': await webp('ff0000'), 'stickers/b.tgs': tgs, 'stickers/c.webm': await webm(),
  'stickers/big.webp': Buffer.concat([await webp('00ff00'), Buffer.alloc(600 * 1024)]),
};
const sticker = (id, extra = {}) => ({ file_id: id, file_unique_id: id, emoji: '😀', ...extra });
const sets = {
  TestPack: { name: 'TestPack', title: 'My Test Pack', stickers: [sticker('f-a'), sticker('f-b', { is_animated: true }), sticker('f-c', { is_video: true })] },
  MixedPack: { name: 'MixedPack', title: 'Mixed', stickers: [sticker('f-a'), sticker('f-big'), sticker('f-trav'), sticker('f-redir')] },
  HugePack: { name: 'HugePack', title: 'Huge', stickers: Array.from({ length: 121 }, (_, i) => sticker(`f-a`, { emoji: String(i) })) },
};
const fileIds = { 'f-a': 'stickers/a.webp', 'f-b': 'stickers/b.tgs', 'f-c': 'stickers/c.webm', 'f-big': 'stickers/big.webp', 'f-trav': '../../etc/passwd', 'f-redir': 'stickers/redir.webp' };
const hits = [];
const fake = http.createServer((req, res) => {
  hits.push(req.url);
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const prefix = `/bot${TOKEN}/`;
  if (url.pathname.startsWith(prefix)) {
    const method = url.pathname.slice(prefix.length);
    if (method === 'getStickerSet') { const set = sets[url.searchParams.get('name')]; return set ? send(200, { ok: true, result: set }) : send(400, { ok: false, error_code: 400, description: 'Bad Request: STICKERSET_INVALID' }); }
    if (method === 'getFile') { const p = fileIds[url.searchParams.get('file_id')]; return p ? send(200, { ok: true, result: { file_id: 'x', file_path: p } }) : send(400, { ok: false, error_code: 400 }); }
  }
  if (url.pathname.startsWith(`/file/bot${TOKEN}/`)) {
    const p = url.pathname.slice(`/file/bot${TOKEN}/`.length);
    if (p === 'stickers/redir.webp') { res.writeHead(302, { location: 'http://127.0.0.1:1/evil' }); return res.end(); }
    if (files[p]) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(files[p]); }
  }
  send(404, { ok: false, error_code: 404 });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

let app;
const cookies = {}; const ids = {}; const bodies = [];
const cookieOf = (response) => response.headers['set-cookie'].split(';')[0];
const send = async (method, url, { user, payload, headers } = {}) => {
  const r = await app.inject({ method, url, payload, remoteAddress: '10.0.0.1', headers: { origin, ...(user ? { cookie: cookies[user] } : {}), ...headers } });
  bodies.push(r.body);
  return r;
};
const post = (user, pack) => send('POST', '/api/stickers/import/telegram', { user, payload: { pack } });
const finish = async (user, jobId) => {
  for (let i = 0; i < 200; i += 1) {
    const job = (await send('GET', `/api/stickers/import/telegram/${jobId}`, { user })).json();
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
};
const run = async (user, pack) => { const r = await post(user, pack); assert.equal(r.statusCode, 202, r.body); return finish(user, r.json().id); };

before(async () => {
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
  for (const name of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    ids[name] = await createUser(name, name, 'a-long-password-9');
    cookies[name] = cookieOf(await send('GET', `/test/login/${ids[name]}`));
  }
});
after(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_API_ALLOW_LOCAL_HTTP; delete process.env.TELEGRAM_API_BASE;
  await app.close(); await db.end(); await new Promise((r) => fake.close(r));
  await rm(dataDir, { recursive: true, force: true }); await rm(work, { recursive: true, force: true });
});

test('feature is fully off without a token', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  assert.deepEqual((await send('GET', '/api/stickers/import/telegram/status', { user: 'alice' })).json(), { enabled: false });
  const r = await post('alice', 'TestPack');
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, 'telegram_not_configured');
  assert.equal(hits.length, 0);
});

test('link parsing is strict', () => {
  for (const ok of ['Abc_1', 'https://t.me/addstickers/Abc_1', 'https://telegram.me/addstickers/Abc_1', 'tg://addstickers?set=Abc_1', 't.me/addstickers/Abc_1']) assert.equal(parsePackName(ok), 'Abc_1', ok);
  for (const bad of ['', 'a-b', 'a b', 'x'.repeat(65), 'https://evil.com/addstickers/Abc', 'http://t.me/addstickers/Abc', 'https://t.me.evil.com/addstickers/Abc', 'https://t.me@evil.com/addstickers/Abc', 'tg://resolve?domain=Abc', 'https://t.me/addemoji/Abc', 42, null, { a: 1 }])
    assert.equal(parsePackName(bad), null, String(bad));
});

test('auth, origin and invalid links are rejected', async () => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN; process.env.TELEGRAM_API_BASE = fakeBase;
  assert.equal((await send('POST', '/api/stickers/import/telegram', { payload: { pack: 'TestPack' } })).statusCode, 401);
  assert.equal((await send('GET', '/api/stickers/import/telegram/status')).statusCode, 401);
  assert.equal((await send('POST', '/api/stickers/import/telegram', { user: 'alice', payload: { pack: 'TestPack' }, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  for (const bad of ['', 'bad name!', 'https://evil.com/addstickers/x', undefined]) {
    const r = await post('alice', bad);
    assert.equal(r.statusCode, 400); assert.equal(r.json().code, 'invalid_pack');
  }
  assert.deepEqual((await send('GET', '/api/stickers/import/telegram/status', { user: 'alice' })).json(), { enabled: true });
});

test('NS-13: plain-HTTP Bot API base is only accepted for opted-in literal loopback', () => {
  const warnings = []; const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, base: process.env.TELEGRAM_API_BASE, allow: process.env.TELEGRAM_API_ALLOW_LOCAL_HTTP };
  const enabled = (base, allow) => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    if (base === undefined) delete process.env.TELEGRAM_API_BASE; else process.env.TELEGRAM_API_BASE = base;
    if (allow === undefined) delete process.env.TELEGRAM_API_ALLOW_LOCAL_HTTP; else process.env.TELEGRAM_API_ALLOW_LOCAL_HTTP = allow;
    return telegramImportEnabled();
  };
  try {
    // HTTPS keeps working, with or without the opt-in, and so does the default.
    assert.equal(enabled('https://api.telegram.org', undefined), true);
    assert.equal(enabled(undefined, undefined), true);
    assert.equal(enabled('https://mirror.example.com/tg', '1'), true);
    // Remote or named HTTP is never accepted, even with the opt-in.
    assert.equal(enabled('http://api.example.com', undefined), false);
    assert.equal(enabled('http://api.example.com', '1'), false);
    // Loopback HTTP needs the opt-in (exactly "1").
    assert.equal(enabled('http://127.0.0.1:8081', undefined), false);
    assert.equal(enabled('http://127.0.0.1:8081', '0'), false);
    assert.equal(enabled('http://127.0.0.1:8081', 'true'), false);
    assert.equal(enabled('http://127.0.0.1:8081', '1'), true);
    assert.equal(enabled('http://127.5.6.7:8081/botapi', '1'), true);
    assert.equal(enabled('http://[::1]:8081', '1'), true);
    assert.equal(enabled('http://[::1]:8081', undefined), false);
    // Names (even localhost), private ranges and look-alikes are rejected with the opt-in.
    for (const bad of ['http://localhost:8081', 'http://10.0.0.5', 'http://192.168.1.10:8081', 'http://0.0.0.0:8081', 'http://127.0.0.1.evil.example', 'http://[::ffff:7f00:1]:8081', 'http://[::2]:8081', 'http://169.254.169.254', 'ftp://127.0.0.1', 'http://user:pw@127.0.0.1:8081'])
      assert.equal(enabled(bad, '1'), false, bad);
    // The refusal is logged without the token or the configured URL.
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every((line) => !line.includes('FAKE_test_token') && !line.includes(TOKEN) && !line.includes('pw@') && !line.includes('evil.example')), warnings.join('\n'));
  } finally {
    console.warn = originalWarn;
    for (const [key, value] of [['TELEGRAM_BOT_TOKEN', saved.token], ['TELEGRAM_API_BASE', saved.base], ['TELEGRAM_API_ALLOW_LOCAL_HTTP', saved.allow]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('imports static, animated and video stickers into the user library', { skip: skipNoFfmpeg }, async () => {
  const job = await run('alice', 'https://t.me/addstickers/TestPack');
  assert.equal(job.state, 'done'); assert.deepEqual([job.imported, job.skipped, job.failed], [3, 0, 0]);
  const packs = (await send('GET', '/api/media/packs', { user: 'alice' })).json();
  assert.equal(packs.length, 1); assert.equal(packs[0].title, 'My Test Pack');
  const detail = (await send('GET', `/api/media/packs/${packs[0].id}`, { user: 'alice' })).json();
  assert.deepEqual(detail.stickers.map((s) => s.format).sort(), ['tgs', 'webm', 'webp']);
  assert.ok(detail.stickers.every((s) => s.emoji === '😀'));
  const file = await send('GET', detail.stickers.find((s) => s.format === 'tgs').fileUrl, { user: 'alice' });
  assert.equal(file.statusCode, 200);
  // other users do not see it
  assert.deepEqual((await send('GET', '/api/media/packs', { user: 'bob' })).json(), []);
  assert.equal((await send('GET', `/api/stickers/import/telegram/${job.id}`, { user: 'bob' })).statusCode, 404);
});

test('re-import is idempotent and a second user gets their own pack', { skip: skipNoFfmpeg }, async () => {
  const again = await run('alice', 'tg://addstickers?set=TestPack');
  assert.equal(again.state, 'done'); assert.deepEqual([again.imported, again.skipped], [0, 3]);
  const packs = (await send('GET', '/api/media/packs', { user: 'alice' })).json();
  assert.equal(packs.length, 1);
  assert.equal((await db.query('SELECT count(*) AS n FROM stickers WHERE pack_id = $1', [packs[0].id])).rows[0].n, 3);
  const other = await run('bob', 'TestPack');
  assert.equal(other.imported, 3);
  assert.equal((await send('GET', '/api/media/packs', { user: 'bob' })).json().length, 1);
});

test('oversize files, path traversal and redirects fail per sticker without leaving the host', { skip: skipNoFfmpeg }, async () => {
  const job = await run('carol', 'MixedPack');
  assert.equal(job.state, 'done');
  assert.deepEqual([job.imported, job.failed], [1, 3]);
  assert.ok(hits.every((u) => !u.includes('passwd') && !u.includes('evil')));
});

test('pack with too many stickers, unknown pack and unreachable Telegram', async () => {
  const huge = await run('dave', 'HugePack');
  assert.equal(huge.state, 'error'); assert.equal(huge.code, 'too_large');
  const missing = await run('dave', 'NoSuchPack');
  assert.equal(missing.state, 'error'); assert.equal(missing.code, 'pack_not_found');
  process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:1';
  const down = await run('dave', 'TestPack');
  assert.equal(down.state, 'error'); assert.equal(down.code, 'telegram_unreachable');
  process.env.TELEGRAM_API_BASE = fakeBase;
});

test('the token never appears in responses and is redacted from text', { skip: skipNoFfmpeg }, async () => {
  assert.equal(redact(`GET https://x/bot${TOKEN}/getFile failed ${TOKEN}`).includes('FAKE_test_token'), false);
  assert.equal(redact('https://api.telegram.org/bot987654:ABCDEFGHIJ_klm/getMe').includes('ABCDEFGHIJ'), false);
  assert.ok(bodies.length > 10);
  assert.ok(bodies.every((b) => !b.includes('FAKE_test_token') && !b.includes(TOKEN)));
});

test('imports are rate-limited per user', { skip: skipNoFfmpeg }, async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await run('erin', 'TestPack')).state, 'done');
  const r = await post('erin', 'TestPack');
  assert.equal(r.statusCode, 429); assert.equal(r.json().code, 'rate_limited');
  assert.equal((await post('alice', 'TestPack')).statusCode, 202);
});
