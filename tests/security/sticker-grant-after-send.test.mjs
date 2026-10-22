// S9d + S10d: a sticker pack is shared into a chat (server-side grant) only AFTER the server accepted the sticker message,
// and the pack id travels in the persisted outbox row's own field (grantPackId), produced by the REAL row builder that
// Conversation.tsx calls (apps/web/src/outboxRow.ts). Bundles the real outbox.ts, stickerGrant.ts, outboxRow.ts and api.ts with
// esbuild (only IndexedDB is faked; fetch is scripted), so the HTTP requests the server would see are asserted directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const src = path.join(root, 'apps/web/src');
const { build } = createRequire(path.join(root, 'apps/server/package.json'))('esbuild');

// IndexedDB stand-in. The store lives on globalThis so a second bundle instance ("reload") sees what the first one persisted.
const dbMock = `const store = (globalThis.__outboxStore ??= new Map());
  export const db = { outbox: {
    put: async (r) => { store.set(r.clientMsgId, structuredClone(r)); },
    delete: async (id) => { store.delete(id); },
    toArray: async () => [...store.values()].map((r) => structuredClone(r)),
  } };
  export const safe = async (run, fallback) => { try { return await run(); } catch { return fallback; } };`;

const dir = await mkdtemp(path.join(tmpdir(), 'sticker-grant-test-'));
const outfile = path.join(dir, 'bundle.mjs');
await build({
  stdin: { contents: `export * from './outbox.ts'; export * from './stickerGrant.ts'; export { buildOutboxRow } from './outboxRow.ts';`, resolveDir: src, sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  plugins: [{ name: 'fake-db', setup(b) {
    b.onResolve({ filter: /^\.\/db\.js$/ }, () => ({ path: 'db', namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: dbMock, loader: 'js' }));
  } }],
});
const load = (tag) => import(`${pathToFileURL(outfile).href}?${tag}`);
let m = await load('first');

// Scripted network. `script` entries are consumed by message POSTs only: a number = that HTTP status, 'net' = connection error.
const requests = [];
const script = [];
const grantScript = [];
const isGrant = (url) => /\/sticker-packs\/[^/]+\/grant$/.test(url);
globalThis.fetch = async (url, init = {}) => {
  const body = typeof init.body === 'string' ? init.body : undefined;
  requests.push({ url: String(url), method: init.method ?? 'GET', body });
  const step = isGrant(String(url)) ? grantScript.shift() : script.shift();
  if (step === 'net') throw new TypeError('network down');
  const status = typeof step === 'number' ? step : (isGrant(String(url)) ? 204 : 201);
  if (status >= 400) return new Response(JSON.stringify({ error: 'x' }), { status });
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify({ id: 'm1', clientMsgId: body ? JSON.parse(body).clientMsgId : null }), { status });
};
const sends = () => requests.filter((r) => r.method === 'POST' && /\/messages$/.test(r.url));
const grants = () => requests.filter((r) => isGrant(r.url));

const enc = { version: 2, keyVersion: 1, ciphertext: 'c', iv: 'i' };
const stickerPlain = (packId = '7') => ({ text: null, payload: { packId, stickerId: '70', fileUrl: '/f', format: 'webp', emoji: 'x', w: 1, h: 1 } });
// The very function Conversation.tsx `queue` calls.
const produce = (mod, id, kind, plain, extra = {}) => mod.buildOutboxRow({ clientMsgId: id, chatId: '5', kind, encrypted: enc, encryptedMediaId: kind === 'text' ? undefined : 'em1', replyTo: null, plain, ...extra });
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 5)); } };
const settle = () => new Promise((r) => setTimeout(r, 60));
const reset = () => {
  for (const r of m.listOutbox('5').concat(m.listOutbox('6'))) m.discard(r.clientMsgId);
  requests.length = 0; script.length = 0; grantScript.length = 0; globalThis.__outboxStore.clear(); m.resetPackGrants();
};

test('the real row builder keeps the plaintext out of the row and stores only the sticker pack id', () => {
  const row = produce(m, 'p1', 'sticker', stickerPlain('7'));
  assert.equal(row.grantPackId, '7');
  assert.equal(row.payload, null);
  assert.equal(row.text, null);
  assert.doesNotMatch(JSON.stringify(row), /stickerId|fileUrl|emoji/, 'no plaintext payload field leaks into the stored row');
  assert.equal('grantPackId' in produce(m, 'p2', 'gif', { text: null, payload: { gifId: '9', mp4Url: '/g', w: 1, h: 1, durationMs: 1 } }), false);
  assert.equal('grantPackId' in produce(m, 'p3', 'text', { text: 'hi', payload: null }), false);
  for (const bad of [undefined, '', 7, null, {}, 'a/b', '../x', 'x'.repeat(65)]) {
    assert.equal('grantPackId' in produce(m, 'p4', 'sticker', { text: null, payload: { packId: bad } }), false, `rejects ${String(bad)}`);
  }
});

test('an accepted sticker send (row from the real builder) creates exactly one grant with the right chat and pack', async () => {
  reset();
  m.enqueue(produce(m, 's1', 'sticker', stickerPlain('7')));
  await until(() => grants().length === 1);
  await settle();
  assert.equal(grants().length, 1);
  assert.equal(grants()[0].url, '/api/chats/5/sticker-packs/7/grant');
  assert.equal(grants()[0].method, 'POST');
  assert.ok(requests.indexOf(grants()[0]) > requests.indexOf(sends()[0]), 'grant is requested after the message POST');
  assert.equal(m.listOutbox('5').length, 0);
});

test('the message body sent to the server is unchanged and never carries grantPackId or the plaintext payload', async () => {
  reset();
  m.enqueue(produce(m, 'b1', 'sticker', stickerPlain('7')));
  m.enqueue(produce(m, 'b2', 'gif', { text: null, payload: { gifId: '9', mp4Url: '/g', w: 1, h: 1, durationMs: 1 } }, { chatId: '6' }));
  m.enqueue(produce(m, 'b3', 'text', { text: 'hello', payload: null }, { chatId: '6' }));
  await until(() => sends().length === 3);
  await settle();
  for (const s of sends()) {
    assert.doesNotMatch(s.body, /grantPackId|packId|stickerId|fileUrl|hello/, s.url);
    assert.deepEqual(Object.keys(JSON.parse(s.body)).sort(), (JSON.parse(s.body).encryptedMediaId ? ['clientMsgId', 'encrypted', 'encryptedMediaId', 'keyVersion', 'kind', 'replyToId'] : ['clientMsgId', 'encrypted', 'keyVersion', 'kind', 'replyToId']).sort());
  }
  assert.equal(grants().length, 1, 'only the sticker caused a grant');
});

test('a rejected send (non-retryable) creates no grant; the error-queue manual resend then grants once it succeeds', async () => {
  reset();
  script.push(400);
  m.enqueue(produce(m, 'e1', 'sticker', stickerPlain('7')));
  await until(() => m.listOutbox('5')[0]?.state === 'failed');
  await settle();
  assert.equal(grants().length, 0);
  assert.equal(m.listOutbox('5')[0].grantPackId, '7', 'the failed row still remembers the pack');
  m.retryNow('e1');
  await until(() => grants().length === 1);
  assert.equal(grants()[0].url, '/api/chats/5/sticker-packs/7/grant');
});

test('a send that keeps failing on the network creates no grant until it finally succeeds (automatic retry keeps the pack)', async () => {
  reset();
  script.push(503, 'net');
  m.enqueue(produce(m, 'r1', 'sticker', stickerPlain('7')));
  await until(() => m.listOutbox('5')[0]?.attempts >= 1);
  assert.equal(m.listOutbox('5')[0].grantPackId, '7');
  m.retryNow('r1');
  await until(() => m.listOutbox('5')[0]?.attempts >= 2);
  await settle();
  assert.equal(grants().length, 0, 'still failing: no grant');
  m.retryNow('r1');
  await until(() => grants().length === 1);
  assert.equal(grants()[0].url, '/api/chats/5/sticker-packs/7/grant');
});

test('a stored row survives a reload (fresh module state) and grants after the retry succeeds; before success nothing is granted', async () => {
  reset();
  script.push(503);
  m.enqueue(produce(m, 'l1', 'sticker', stickerPlain('7')));
  await until(() => m.listOutbox('5')[0]?.attempts >= 1);
  await settle();
  const stored = [...globalThis.__outboxStore.values()];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].grantPackId, '7', 'persisted to the (fake) IndexedDB');
  assert.equal(stored[0].payload, null);
  assert.equal(grants().length, 0);
  // Reload: the old page is gone (drop its memory and timer without touching IndexedDB), a new module instance starts with empty memory.
  m.discard('l1');
  for (const r of stored) globalThis.__outboxStore.set(r.clientMsgId, r);
  const m2 = await load('reloaded');
  assert.equal(m2.listOutbox('5').length, 0, 'fresh instance starts empty');
  m2.startOutbox();
  await until(() => grants().length === 1);
  assert.equal(grants()[0].url, '/api/chats/5/sticker-packs/7/grant');
  assert.equal(globalThis.__outboxStore.size, 0);
  m = m2;
});

test('same chat+pack is granted once per session; a different pack in the same chat is granted too', async () => {
  reset();
  m.enqueue(produce(m, 'o1', 'sticker', stickerPlain('7')));
  await until(() => grants().length === 1);
  m.enqueue(produce(m, 'o2', 'sticker', stickerPlain('7')));
  await until(() => sends().length === 2 && m.listOutbox('5').length === 0);
  await settle();
  assert.equal(grants().length, 1);
  m.enqueue(produce(m, 'o3', 'sticker', stickerPlain('8')));
  await until(() => grants().length === 2);
  assert.equal(grants()[1].url, '/api/chats/5/sticker-packs/8/grant');
});

test('gif, text, packless and old-format (payload-only) rows never grant', async () => {
  reset();
  m.enqueue(produce(m, 't1', 'text', { text: 'hi', payload: null }));
  m.enqueue(produce(m, 't2', 'gif', { text: null, payload: { gifId: '9', mp4Url: '/g', w: 1, h: 1, durationMs: 1 } }, { chatId: '6' }));
  m.enqueue(produce(m, 't3', 'sticker', { text: null, payload: { stickerId: '70' } }, { chatId: '8' }));
  // A row written by an older build, or by hand, with the pack id only inside payload: not trusted as a grant source.
  m.enqueue({ clientMsgId: 't4', chatId: '9', kind: 'sticker', encrypted: enc, encryptedMediaId: 'em1', replyToId: null, text: null, payload: { packId: '7' } });
  await until(() => sends().length === 4);
  await settle();
  assert.deepEqual(grants(), []);
});

test('a failed grant is forgotten (next sticker tries again) and never breaks the sent message', async () => {
  reset();
  grantScript.push(500);
  m.enqueue(produce(m, 'g1', 'sticker', stickerPlain('7')));
  await until(() => grants().length === 1);
  await until(() => m.listOutbox('5').length === 0);
  await settle();
  m.enqueue(produce(m, 'g2', 'sticker', stickerPlain('7')));
  await until(() => grants().length === 2);
});

test('Conversation.tsx builds its row with buildOutboxRow, and neither it nor StickerPackSheet grants before the send', async () => {
  for (const file of ['Conversation.tsx', 'chat/StickerPackSheet.tsx']) {
    const text = await readFile(path.join(src, file), 'utf8');
    assert.doesNotMatch(text, /grantStickerPack|sharePackInChat/, file);
  }
  const conv = await readFile(path.join(src, 'Conversation.tsx'), 'utf8');
  assert.match(conv, /enqueue\(buildOutboxRow\(/);
  assert.doesNotMatch(conv, /enqueue\(\{/, 'no hand-built row left in the component');
  const outbox = await readFile(path.join(src, 'outbox.ts'), 'utf8');
  const call = outbox.indexOf('grantPackAfterSend(sent)');
  assert.ok(call > outbox.indexOf('await sendRow(row)'), 'grant comes after the awaited send');
});
