import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createBot, parsePackName, redact, buildZip, assemblePack, MAX_STICKERS, MAX_ZIP_BYTES } from '../bot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = '123456:TESTTOKENabcdefghijklmnop';
const haveTools = existsSync('/usr/bin/unzip') && existsSync('/usr/bin/ffmpeg') && existsSync('/usr/bin/ffprobe');
// NoSignal's real validators (the same code the server's zip import runs).
const validation = haveTools ? await import('../../../apps/server/src/media/validation.ts') : null;
const skip = haveTools ? false : 'needs unzip, ffmpeg and ffprobe';

const work = mkdtempSync(join(tmpdir(), 'stickerbot-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

const makeFixtures = () => {
  const webp = join(work, 'a.webp'); const webp2 = join(work, 'b.webp'); const webm = join(work, 'c.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=512x512', '-frames:v', '1', webp]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=512x300', '-frames:v', '1', '-vf', 'scale=512:300', webp2]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=512x512:d=1:r=10', '-c:v', 'libvpx-vp9', '-b:v', '50k', webm]);
  const lottie = { v: '5.5.2', fr: 30, ip: 0, op: 30, w: 512, h: 512, layers: [], assets: [] };
  return { webp: readFileSync(webp), webp2: readFileSync(webp2), webm: readFileSync(webm), tgs: gzipSync(Buffer.from(JSON.stringify(lottie))) };
};

/** Mock Telegram Bot API: long-poll getUpdates, getStickerSet, getFile, file download, sendDocument. */
const mockTelegram = async (packs, files) => {
  const state = { updates: [], sent: [], docs: [], hits: [], redirectTargetHit: false, nextId: 1 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      state.hits.push(req.url);
      const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/elsewhere') { state.redirectTargetHit = true; res.end('x'); return; }
      const file = req.url.match(/^\/file\/bot([^/]+)\/(.+)$/);
      if (file) {
        if (file[1] !== TOKEN) { res.writeHead(404); res.end(); return; }
        if (file[2].startsWith('redir/')) { res.writeHead(302, { location: '/elsewhere' }); res.end(); return; }
        const data = files.get(file[2]);
        if (!data) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-length': data.length }); res.end(data); return;
      }
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m || m[1] !== TOKEN) { json({ ok: false, description: 'Unauthorized' }, 401); return; }
      const method = m[2];
      if (method === 'getUpdates') {
        const params = JSON.parse(body.toString() || '{}');
        const deadline = Date.now() + 300;
        while (Date.now() < deadline && !state.updates.some((u) => u.update_id >= (params.offset ?? 0))) await new Promise((r) => setTimeout(r, 20));
        json({ ok: true, result: state.updates.filter((u) => u.update_id >= (params.offset ?? 0)) }); return;
      }
      if (method === 'sendMessage') { state.sent.push(JSON.parse(body.toString())); json({ ok: true, result: {} }); return; }
      if (method === 'getStickerSet') {
        const { name } = JSON.parse(body.toString());
        const pack = packs[name];
        if (!pack) { json({ ok: false, description: 'Bad Request: STICKERSET_INVALID' }, 400); return; }
        json({ ok: true, result: pack }); return;
      }
      if (method === 'getFile') {
        const { file_id } = JSON.parse(body.toString());
        json({ ok: true, result: { file_id, file_path: file_id } }); return;
      }
      if (method === 'sendDocument') {
        const type = req.headers['content-type'];
        const boundary = Buffer.from('--' + type.split('boundary=')[1]);
        const start = body.indexOf('name="document"');
        const dataStart = body.indexOf('\r\n\r\n', start) + 4;
        const dataEnd = body.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), dataStart);
        const caption = body.toString('utf8').match(/name="caption"\r\n\r\n([\s\S]*?)\r\n--/)?.[1];
        const filename = body.subarray(start, dataStart).toString().match(/filename="([^"]+)"/)?.[1];
        state.docs.push({ zip: body.subarray(dataStart, dataEnd), caption, filename });
        json({ ok: true, result: {} }); return;
      }
      json({ ok: false }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state, base, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
    say: (from, text, extra = {}) => state.updates.push({ update_id: state.nextId++, message: { chat: { id: from, type: 'private' }, from: { id: from }, text, ...extra } })
  };
};

const runBot = (mock, extra = {}) => {
  const logs = [];
  const bot = createBot({ token: TOKEN, base: mock.base, pollSeconds: 1, retryMs: 30, log: (l) => logs.push(l), ...extra });
  const running = bot.start();
  return { logs, stop: async () => { bot.stop(); await running; } };
};

const waitFor = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out waiting');
};

/** Re-implements the importer's zip checks (import-pack.ts) and runs NoSignal's real media validators. */
const assertAcceptedByNoSignal = async (zipBuffer) => {
  const zipPath = join(work, `check-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(zipPath, zipBuffer);
  assert.ok(zipBuffer.length <= 12 * 1024 * 1024, 'zip <= 12 MB');
  assert.equal(spawnSync('/usr/bin/unzip', ['-tq', zipPath]).status, 0, 'zip integrity');
  const names = execFileSync('/usr/bin/unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.ok(names.length >= 1 && names.length <= 200);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.some((n) => n.split('/').includes('..') || n.startsWith('/') || n.includes('\\') || /[\0-\x1f*?\[]/.test(n)));
  const manifest = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', zipPath, 'pack.json']).toString());
  assert.ok(manifest.title && manifest.title.length <= 120);
  assert.match(manifest.slug, /^[a-z0-9-]{1,80}$/);
  const assets = names.filter((n) => /\.(tgs|webm|webp)$/.test(n));
  assert.ok(assets.length >= 1 && assets.length <= 120);
  assert.equal(manifest.stickers.length, assets.length);
  assert.ok(assets.includes(manifest.thumb));
  let total = 0; const checked = new Set();
  for (const name of assets) {
    const bytes = execFileSync('/usr/bin/unzip', ['-p', zipPath, name], { maxBuffer: 1 << 20 });
    total += bytes.length;
    const key = `${name.split('.').pop()}:${bytes.length}:${bytes.subarray(0, 64).toString('hex')}`;
    if (checked.has(key)) continue;   // identical content was already validated
    checked.add(key);
    assert.ok(bytes.length <= 512 * 1024);
    const ext = name.split('.').pop();
    if (ext === 'tgs') { assert.equal(bytes[0], 0x1f); validation.validateTgs(bytes); }
    else {
      const tmp = join(work, `v-${name}`);
      writeFileSync(tmp, bytes);
      if (ext === 'webm') await validation.validateWebmSticker(tmp, bytes.length); else await validation.validateWebpSticker(tmp, bytes.length);
    }
  }
  assert.ok(total <= 32 * 1024 * 1024);
  return { names, manifest };
};

test('parsePackName accepts links and names, rejects the rest', () => {
  assert.equal(parsePackName('https://t.me/addstickers/Cats_1'), 'Cats_1');
  assert.equal(parsePackName('t.me/addstickers/Cats_1'), 'Cats_1');
  assert.equal(parsePackName('tg://addstickers?set=Cats_1'), 'Cats_1');
  assert.equal(parsePackName(' Cats_1 '), 'Cats_1');
  for (const bad of ['', 'a b', 'http://t.me/addstickers/x', 'https://evil.com/addstickers/x', 'https://t.me/joinchat/x', '../x', 'a'.repeat(65), 'x/../y', 'https://t.me:8080/addstickers/x']) assert.equal(parsePackName(bad), null, bad);
});

test('redact hides the token and bot URL segments', () => {
  const text = redact(`fetch failed https://x/bot${TOKEN}/getFile ${TOKEN}`, TOKEN);
  assert.ok(!text.includes('TESTTOKEN'));
  assert.ok(!redact('/bot999999:AAAAAAAAAAAAAAAA/y', undefined).includes('AAAAAAAA'));
});

test('zip writer output is readable by unzip (stored and deflate)', { skip }, () => {
  const zip = buildZip([{ name: 'pack.json', data: Buffer.from('{"a":1}'.repeat(100)), deflate: true }, { name: '001.webp', data: Buffer.from('hello') }]);
  const p = join(work, 'w.zip'); writeFileSync(p, zip);
  assert.equal(spawnSync('/usr/bin/unzip', ['-tq', p]).status, 0);
  assert.equal(execFileSync('/usr/bin/unzip', ['-p', p, '001.webp']).toString(), 'hello');
  assert.throws(() => buildZip([{ name: '../x.webp', data: Buffer.alloc(1) }]));
});

test('assemblePack trims at the sticker-count and byte limits', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);
  const many = assemblePack('Big', 'Big', Array.from({ length: 150 }, () => ({ ext: 'webp', bytes: webp })));
  assert.equal(many.included, MAX_STICKERS);
  assert.equal(many.leftOut, 30);
  const fat = Buffer.concat([webp, Buffer.alloc(500 * 1024)]);
  const heavy = assemblePack('Heavy', 'Heavy', Array.from({ length: 60 }, () => ({ ext: 'webp', bytes: fat })));
  assert.ok(heavy.zip.length <= MAX_ZIP_BYTES);
  assert.ok(heavy.included < 60 && heavy.included >= 20);
  assert.equal(heavy.included + heavy.leftOut, 60);
});

test('end to end: link in, NoSignal-valid zip out (mock Telegram)', { skip }, async () => {
  const f = makeFixtures();
  const files = new Map([['f/1.webp', f.webp], ['f/2.webp', f.webp2], ['f/3.tgs', f.tgs], ['f/4.webm', f.webm], ['f/big.webp', Buffer.concat([f.webp, Buffer.alloc(600 * 1024)])], ['f/bad.webp', Buffer.from('not a webp at all')]]);
  const st = (file_id, extra = {}) => ({ file_id, emoji: '😀', file_size: files.get(file_id)?.length, ...extra });
  const packs = {
    Mix_Pack: { name: 'Mix_Pack', title: 'پک ترکیبی', stickers: [st('f/1.webp'), st('f/2.webp'), st('f/3.tgs', { is_animated: true }), st('f/4.webm', { is_video: true }), st('f/big.webp'), st('f/bad.webp'), st('redir/x.webp', { file_size: 100 })] }
  };
  const mock = await mockTelegram(packs, files);
  const bot = runBot(mock);
  try {
    mock.say(7, 'https://t.me/addstickers/Mix_Pack');
    await waitFor(() => mock.state.docs.length === 1);
    const doc = mock.state.docs[0];
    assert.equal(doc.filename, 'mix-pack.zip');
    const { names, manifest } = await assertAcceptedByNoSignal(doc.zip);
    assert.deepEqual(names.sort(), ['001.webp', '002.webp', '003.tgs', '004.webm', 'pack.json']);
    assert.equal(manifest.title, 'پک ترکیبی');
    assert.equal(manifest.stickers[0].emoji, '😀');
    assert.match(doc.caption, /4 استیکر از 7/);
    assert.match(doc.caption, /3 استیکر به‌خاطر بزرگ‌بودن/);
    assert.equal(mock.state.redirectTargetHit, false, 'redirect must not be followed');
    assert.ok(mock.state.sent.some((m) => /Mix_Pack|پک ترکیبی/.test(m.text)), 'progress message');
  } finally { await bot.stop(); await mock.close(); }
});

test('sticker message, /start, bad link, unknown pack, allow-list, rate limit', { skip }, async () => {
  const f = makeFixtures();
  const files = new Map([['f/1.webp', f.webp]]);
  const packs = { One: { name: 'One', title: 'One', stickers: [{ file_id: 'f/1.webp', emoji: 'a', file_size: f.webp.length }] } };
  const mock = await mockTelegram(packs, files);
  const bot = runBot(mock, { allowedUserIds: new Set(['7', '8']) });
  try {
    mock.say(7, '/start');
    mock.say(7, 'this is not a link');
    mock.say(7, 'Nope_Pack');
    mock.say(7, '', { text: undefined, sticker: { set_name: null } });
    mock.say(99, 'One');
    await waitFor(() => mock.state.sent.length >= 5);
    const texts = mock.state.sent.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes('سلام')));
    assert.ok(texts.some((t) => t.includes('معتبر نیست')));
    assert.ok(texts.some((t) => t.includes('پیدا نشد')));
    assert.ok(texts.some((t) => t.includes('به هیچ بسته')));
    assert.ok(texts.some((t) => t.includes('اجازه')));
    assert.equal(mock.state.docs.length, 0);
    // a bare sticker works, and the 6th request within the hour is refused (unknown pack attempts count too)
    mock.say(8, '', { text: undefined, sticker: { set_name: 'One' } });
    await waitFor(() => mock.state.docs.length === 1);
    await assertAcceptedByNoSignal(mock.state.docs[0].zip);
    for (let i = 0; i < 5; i += 1) { mock.say(8, 'One'); await waitFor(() => mock.state.docs.length === 2 + i || mock.state.sent.some((m) => m.text.includes('سقف'))); }
    await waitFor(() => mock.state.sent.some((m) => m.text.includes('سقف')));
    assert.equal(mock.state.docs.length, 5);
  } finally { await bot.stop(); await mock.close(); }
});

test('pack with more than 120 stickers is trimmed and the user is told', { skip }, async () => {
  const f = makeFixtures();
  const files = new Map(); const stickers = [];
  for (let i = 0; i < 130; i += 1) { files.set(`f/${i}.webp`, f.webp); stickers.push({ file_id: `f/${i}.webp`, file_size: f.webp.length, emoji: 'x' }); }
  const mock = await mockTelegram({ Huge: { name: 'Huge', title: 'Huge', stickers } }, files);
  const bot = runBot(mock);
  try {
    mock.say(5, 'Huge');
    await waitFor(() => mock.state.docs.length === 1, 40000);
    const { names } = await assertAcceptedByNoSignal(mock.state.docs[0].zip);
    assert.equal(names.length, 121);
    assert.match(mock.state.docs[0].caption, /10 استیکر به‌خاطر محدودیت/);
  } finally { await bot.stop(); await mock.close(); }
});

test('token never appears in logs or user-visible text when Telegram is unreachable', async () => {
  const mock = await mockTelegram({}, new Map());
  const base = mock.base; await mock.close();      // port is now closed
  const logs = []; const sent = [];
  const bot = createBot({ token: TOKEN, base, pollSeconds: 1, retryMs: 20, log: (l) => logs.push(l) });
  const running = bot.start();
  await new Promise((r) => setTimeout(r, 200));
  bot.stop(); await running;
  assert.ok(logs.length > 0);
  assert.ok(![...logs, ...sent].join('\n').includes(TOKEN));
  assert.ok(![...logs].join('\n').includes('TESTTOKEN'));
});
