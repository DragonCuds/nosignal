import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '../..');
const tsx = path.join(root, 'apps/server/node_modules/tsx/dist/cli.mjs');
const SECRET = 'wireup-test-only-secret-with-at-least-32-bytes';
const PW = 'correct horse battery staple';
const PORT = 4161;
const TLS_PORT = 4162;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dirs = [];
const children = [];
let dataDir;

const mkdir = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'tel-wireup-')); dirs.push(d); return d; };
const baseEnv = (dir, extra) => ({ ...process.env, NODE_ENV: 'test', DATA_DIR: dir, SESSION_SECRET: SECRET, WEBAUTHN_RP_ID: '127.0.0.1', TRUSTED_ORIGINS: ORIGIN, ...extra });
const migrate = (dir) => spawnSync(process.execPath, [tsx, 'apps/server/src/migrate.ts'], { cwd: root, env: baseEnv(dir, {}), encoding: 'utf8' });
const cli = (dir, args, env = {}) => spawnSync(process.execPath, [tsx, 'apps/server/src/cli/user-add.ts', ...args], {
  cwd: root, env: baseEnv(dir, env), input: `${PW}\n`, encoding: 'utf8'
});
const start = async (env, probe) => {
  const child = spawn(process.execPath, [tsx, 'apps/server/src/index.ts'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  children.push(child);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    if (child.exitCode !== null) throw new Error(`server exited: ${err}`);
    try { if (await probe()) return child; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server not ready: ${err}`);
};
const httpsReq = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port, path: p, method, headers, rejectUnauthorized: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  r.on('error', reject);
  r.end(body);
});

const jar = {};
const api = (method, url, { user = 'alice', body, headers = {} } = {}) => fetch(`${ORIGIN}${url}`, {
  method, body, headers: { Origin: ORIGIN, Cookie: `tel_session=${jar[user]}`, ...headers }
});
const json = (method, url, obj, user) => api(method, url, { user, body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } });
const login = async (user) => {
  const res = await fetch(`${ORIGIN}/api/auth/login`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW })
  });
  assert.equal(res.status, 204);
  const cookie = res.headers.get('set-cookie');
  jar[user] = /tel_session=([^;]+)/.exec(cookie)[1];
  return cookie;
};
const hex = () => randomUUID().replaceAll('-', '');
const upload = (user, chat, id, n = 116) => api('PUT', `/api/chats/${chat}/attachments/${id}`, { user, body: Buffer.alloc(n, 7), headers: { 'Content-Type': 'application/octet-stream' } });
const enc = () => ({ version: 2, cipherId: randomUUID(), nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(40) });

before(async () => {
  dataDir = await mkdir();
  assert.equal(migrate(dataDir).status, 0);
  for (const [u, extra] of [['alice', ['--admin']], ['bob', []]]) {
    const r = cli(dataDir, [u, u, ...extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, extra.length ? /Created admin user alice/ : /Created user bob/);
  }
  await start(baseEnv(dataDir, { PORT: String(PORT), TRUSTED_ORIGINS: ORIGIN, WEBAUTHN_RP_ID: '127.0.0.1', MAX_ATTACHMENT_MB: '1' }),
    async () => (await fetch(`${ORIGIN}/api/health`)).ok);
});
after(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test('--admin flag sets is_admin; invites registered (admin-only)', async () => {
  const cookie = await login('alice');
  assert.doesNotMatch(cookie, /Secure/i, 'TLS off + non-production: no Secure flag');
  await login('bob');
  assert.equal((await json('POST', '/api/invites', { maxUses: 1 }, 'alice')).status, 201);
  assert.equal((await json('POST', '/api/invites', { maxUses: 1 }, 'bob')).status, 403);
});

test('attachment message: send, read back, validations', async () => {
  const chat = await (await json('POST', '/api/chats', { userId: '2' }, 'alice')).json();
  const chatId = chat.id;
  for (const kind of ['photo', 'video', 'voice', 'file']) {
    const id = hex();
    assert.equal((await upload('alice', chatId, id)).status, 201);
    const res = await json('POST', `/api/chats/${chatId}/messages`, { kind, encrypted: enc(), attachmentId: id }, 'alice');
    assert.equal(res.status, 201, await res.clone().text());
    const msg = await res.json();
    assert.equal(msg.kind, kind);
    assert.equal(msg.attachmentId, id);
    const list = await (await api('GET', `/api/chats/${chatId}/messages`, { user: 'bob' })).json();
    assert.equal(list.find((m) => m.id === msg.id).attachmentId, id, 'recipient sees attachmentId');
    assert.equal((await api('GET', `/api/attachments/${id}`, { user: 'bob' })).status, 200, 'recipient can download once referenced');
  }
  const mine = hex();
  assert.equal((await upload('alice', chatId, mine)).status, 201);
  const send = (body, user = 'alice') => json('POST', `/api/chats/${chatId}/messages`, { encrypted: enc(), ...body }, user);
  assert.equal((await send({ kind: 'video', attachmentId: mine }, 'bob')).status, 404, 'uploader must be sender');
  assert.equal((await send({ kind: 'video', attachmentId: hex() })).status, 404, 'unknown attachment');
  assert.equal((await send({ kind: 'video', attachmentId: 'XYZ' })).status, 400, 'bad shape');
  assert.equal((await send({ kind: 'video' })).status, 400, 'video needs attachment');
  assert.equal((await send({ kind: 'text', attachmentId: mine })).status, 400);
  assert.equal((await send({ kind: 'sticker', attachmentId: mine })).status, 400);
  assert.equal((await send({ kind: 'bogus' })).status, 400);
  assert.equal((await send({ kind: 'text' })).status, 201, 'plain text still works');
  // attachment of another chat
  const other = await (await json('POST', '/api/chats', { userId: '2' }, 'alice')).json();
  if (other.id !== chatId) assert.equal((await send({ kind: 'file', attachmentId: mine }, 'alice')).status, 201);
});

test('login: unknown user still gets 401 (dummy verify) and repeated attempts end in 429', async () => {
  const bad = (u) => fetch(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'wrong-password-123' }) });
  assert.equal((await bad('nobody')).status, 401);
  let last;
  for (let i = 0; i < 12 && last !== 429; i++) last = (await bad('nobody')).status;
  assert.equal(last, 429);
});

test('migration 004 keeps rows, cipher ids, attachment_id, indexes and triggers; widens kind', () => {
  const dir = path.join(root, 'apps/server/migrations');
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('004_attachment_kinds.sql'));
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  const apply = (f) => { d.exec('BEGIN'); try { d.exec(readFileSync(path.join(dir, f), 'utf8')); d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; } };
  for (const f of files.filter((x) => x < '004')) apply(f);
  d.exec("INSERT INTO users (username, display_name, password_hash) VALUES ('a','a','x')");
  d.exec('INSERT INTO chats DEFAULT VALUES');
  d.exec('INSERT INTO chat_members (chat_id, user_id) VALUES (1, 1)');
  d.exec("INSERT INTO attachments (id, chat_id, uploader_id, byte_size) VALUES ('" + 'a'.repeat(32) + "', 1, 1, 100)");
  const ins = d.prepare(`INSERT INTO messages (chat_id, sender_id, kind, reply_to_id, encryption_version, cipher_id, nonce, ciphertext, attachment_id)
    VALUES (1, 1, ?, ?, 2, ?, 'AAAAAAAAAAAAAAAA', ?, ?)`);
  const c1 = randomUUID(); const c2 = randomUUID();
  ins.run('photo', null, c1, 'A'.repeat(40), 'a'.repeat(32));
  ins.run('text', 1, c2, 'A'.repeat(40), null);
  const objects = () => d.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name IN ('messages','message_cipher_ids') ORDER BY type, name").all();
  const before = objects();
  assert.throws(() => ins.run('video', null, randomUUID(), 'A'.repeat(40), null), /CHECK/);
  apply('004_attachment_kinds.sql');
  assert.deepEqual(objects(), before, 'same indexes/triggers/tables');
  assert.equal(d.prepare('SELECT count(*) n FROM messages').get().n, 2);
  assert.deepEqual(d.prepare('SELECT message_id, cipher_id FROM message_cipher_ids ORDER BY message_id').all(), [{ message_id: 1, cipher_id: c1 }, { message_id: 2, cipher_id: c2 }]);
  assert.equal(d.prepare('SELECT attachment_id a, reply_to_id r FROM messages WHERE id IN (1,2) ORDER BY id').all().map((x) => `${x.a}/${x.r}`).join(), `${'a'.repeat(32)}/null,null/1`);
  for (const kind of ['video', 'voice', 'file']) ins.run(kind, null, randomUUID(), 'A'.repeat(40), 'a'.repeat(32));
  assert.throws(() => ins.run('bogus', null, randomUUID(), 'A'.repeat(40), null), /CHECK/);
  assert.throws(() => ins.run('file', null, c1, 'A'.repeat(40), null), /UNIQUE|constraint/i, 'cipher id reuse still rejected');
  assert.throws(() => ins.run('file', null, randomUUID(), 'short', null), /v2 ciphertext/, 'v2 insert trigger still active');
  assert.deepEqual(d.pragma('foreign_key_check'), []);
  assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get().sql, /REFERENCES "?messages"?\(id\)/, 'self reference renamed');
  d.exec('DELETE FROM attachments');
  assert.equal(d.prepare('SELECT count(*) n FROM messages WHERE attachment_id IS NOT NULL').get().n, 0, 'ON DELETE SET NULL kept');
  d.close();
});

test('TLS_MODE=auto: https, Secure cookie, /ca.crt, SPA /join/*', async () => {
  const dir = await mkdir();
  assert.equal(migrate(dir).status, 0);
  assert.equal(cli(dir, ['carol', 'carol']).status, 0);
  const origin = `https://127.0.0.1:${TLS_PORT}`;
  await start(baseEnv(dir, { NODE_ENV: 'production', PORT: String(TLS_PORT), TLS_MODE: 'auto', TLS_HOSTS: 'localhost,127.0.0.1', TRUSTED_ORIGINS: origin, WEBAUTHN_RP_ID: '127.0.0.1' }),
    async () => (await httpsReq(TLS_PORT, '/api/health')).status === 200);
  const res = await httpsReq(TLS_PORT, '/api/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'carol', password: PW })
  });
  assert.equal(res.status, 204);
  assert.match(res.headers['set-cookie'][0], /; Secure/i);
  assert.match((await httpsReq(TLS_PORT, '/ca.crt')).body, /BEGIN CERTIFICATE/);
  if (existsSync(path.join(root, 'apps/web/dist/index.html'))) {
    const spa = await httpsReq(TLS_PORT, '/join/abc');
    assert.equal(spa.status, 200);
    assert.match(spa.body, /<html|<!doctype/i);
  }
});
