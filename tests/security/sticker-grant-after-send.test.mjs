// S9d: a sticker pack is shared into a chat (server-side grant) only AFTER the server accepted the sticker message.
// Bundles the real apps/web/src/outbox.ts + stickerGrant.ts with esbuild (db/api mocked) and drives the send queue in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const src = path.join(root, 'apps/web/src');
const { build } = createRequire(path.join(root, 'apps/server/package.json'))('esbuild');

const mocks = {
  db: `export const store = new Map();
    export const db = { outbox: {
      put: async (r) => { store.set(r.clientMsgId, structuredClone(r)); },
      delete: async (id) => { store.delete(id); },
      toArray: async () => [...store.values()].map((r) => structuredClone(r)),
    } };
    export const safe = async (run, fallback) => { try { return await run(); } catch { return fallback; } };`,
  api: `export class ApiError extends Error { constructor(m, status) { super(m); this.status = status; } }
    export const calls = []; export const script = []; export const grants = []; export const grantScript = [];
    const go = async (name, args) => {
      calls.push({ name, args });
      const step = script.shift();
      if (step) await step();
      return { id: 'm-' + calls.length, clientMsgId: args.at(-1) };
    };
    export const api = {
      sendMessage: (...a) => go('text', a), sendSticker: (...a) => go('sticker', a),
      sendGif: (...a) => go('gif', a), sendAttachment: (...a) => go('attachment', a),
      grantStickerPack: async (chatId, packId) => { grants.push([chatId, packId]); const step = grantScript.shift(); if (step) await step(); },
    };`,
};

const dir = await mkdtemp(path.join(tmpdir(), 'sticker-grant-test-'));
const outfile = path.join(dir, 'bundle.mjs');
await build({
  stdin: { contents: `export * from './outbox.ts'; export * from './stickerGrant.ts'; export { calls, script, grants, grantScript, ApiError } from './api.js'; export { store } from './db.js';`, resolveDir: src, sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  plugins: [{ name: 'mocks', setup(b) {
    b.onResolve({ filter: /^\.\/(db|api)\.js$/ }, (a) => ({ path: a.path.slice(2, -3), namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: mocks[a.path], loader: 'js' }));
  } }],
});
const m = await import(pathToFileURL(outfile).href);

const row = (id, extra = {}) => ({ clientMsgId: id, chatId: 'C1', kind: 'sticker', encrypted: { version: 2 }, encryptedMediaId: 'em1', replyToId: null, text: null, payload: { packId: 'P1', stickerId: 'S1' }, ...extra });
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 5)); } };
const settle = () => new Promise((r) => setTimeout(r, 40));
const reset = () => {
  for (const r of m.listOutbox('C1').concat(m.listOutbox('C2'))) m.discard(r.clientMsgId);
  m.calls.length = 0; m.script.length = 0; m.grants.length = 0; m.grantScript.length = 0; m.store.clear(); m.resetPackGrants();
};

test('a rejected send (non-retryable) creates no grant', async () => {
  reset();
  m.script.push(async () => { throw new m.ApiError('refused', 400); });
  m.enqueue(row('s1'));
  await until(() => m.listOutbox('C1')[0]?.state === 'failed');
  await settle();
  assert.deepEqual(m.grants, []);
});

test('a send that keeps failing on the network creates no grant until it finally succeeds', async () => {
  reset();
  m.script.push(async () => { throw new m.ApiError('down', 503) }, async () => { throw new m.ApiError('down', 503); });
  m.enqueue(row('s2'));
  await until(() => m.calls.length >= 1 && m.listOutbox('C1')[0]?.state === 'pending' && m.listOutbox('C1')[0].attempts >= 1);
  await settle();
  assert.deepEqual(m.grants, [], 'still queued/failing: no grant');
  m.retryNow('s2'); // second scripted failure, then success on the third attempt
  await until(() => m.calls.length >= 2);
  await settle();
  assert.deepEqual(m.grants, []);
  m.retryNow('s2');
  await until(() => m.listOutbox('C1').length === 0);
  await until(() => m.grants.length === 1);
  assert.deepEqual(m.grants, [['C1', 'P1']]);
});

test('an accepted send creates exactly one grant, with the chat and pack of the row', async () => {
  reset();
  m.enqueue(row('s3'));
  await until(() => m.grants.length === 1);
  assert.deepEqual(m.grants, [['C1', 'P1']]);
  m.enqueue(row('s4', { payload: { packId: 'P1', stickerId: 'S2' } }));
  await until(() => m.calls.length === 2 && m.listOutbox('C1').length === 0);
  await settle();
  assert.equal(m.grants.length, 1, 'same chat+pack is granted once per session');
});

test('non-sticker messages and packless stickers never grant', async () => {
  reset();
  m.enqueue(row('t1', { kind: 'text', payload: null, text: 'hi', encryptedMediaId: undefined }));
  m.enqueue(row('t2', { chatId: 'C2', payload: { stickerId: 'S9' } }));
  await until(() => m.calls.length === 2 && m.listOutbox('C1').length + m.listOutbox('C2').length === 0);
  await settle();
  assert.deepEqual(m.grants, []);
});

test('a failed grant is forgotten (next sticker tries again) and never breaks the sent message', async () => {
  reset();
  m.grantScript.push(async () => { throw new m.ApiError('boom', 500); });
  m.enqueue(row('g1'));
  await until(() => m.grants.length === 1);
  await until(() => m.listOutbox('C1').length === 0);
  m.enqueue(row('g2', { payload: { packId: 'P1', stickerId: 'S3' } }));
  await until(() => m.grants.length === 2);
});

test('Conversation.tsx / StickerPackSheet.tsx no longer grant before the send', async () => {
  for (const file of ['Conversation.tsx', 'chat/StickerPackSheet.tsx']) {
    const text = await readFile(path.join(src, file), 'utf8');
    assert.doesNotMatch(text, /grantStickerPack|sharePackInChat/, file);
  }
  const outbox = await readFile(path.join(src, 'outbox.ts'), 'utf8');
  const call = outbox.indexOf('grantPackAfterSend(sent)');
  assert.ok(call > outbox.indexOf('await sendRow(row)'), 'grant comes after the awaited send');
});
