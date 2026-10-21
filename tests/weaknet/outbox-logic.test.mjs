// Bundles apps/web/src/outbox.ts with esbuild, swapping ./db.js and ./api.js for in-memory mocks, then drives it in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = path.join(root, 'apps/web/src');
const mocks = {
  db: `export const store = new Map();
    export const db = { outbox: {
      put: async (r) => { store.set(r.clientMsgId, structuredClone(r)); },
      delete: async (id) => { store.delete(id); },
      toArray: async () => [...store.values()].map((r) => structuredClone(r)),
    } };
    export const safe = async (run, fallback) => { try { return await run(); } catch { return fallback; } };`,
  api: `export class ApiError extends Error { constructor(m, status) { super(m); this.status = status; } }
    export const calls = []; export const script = [];
    const go = async (name, args) => {
      calls.push({ name, args });
      const step = script.shift();
      if (step) await step();
      return { id: 'm-' + calls.length, clientMsgId: args.at(-1) };
    };
    export const api = {
      sendMessage: (...a) => go('text', a), sendSticker: (...a) => go('sticker', a),
      sendGif: (...a) => go('gif', a), sendAttachment: (...a) => go('attachment', a),
    };`,
};

const dir = await mkdtemp(path.join(tmpdir(), 'outbox-test-'));
const outfile = path.join(dir, 'bundle.mjs');
await build({
  stdin: { contents: `export * from './outbox.ts'; export { calls, script, ApiError } from './api.js'; export { store } from './db.js';`, resolveDir: src, sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  plugins: [{ name: 'mocks', setup(b) {
    b.onResolve({ filter: /^\.\/(db|api)\.js$/ }, (a) => ({ path: a.path.slice(2, -3), namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: mocks[a.path], loader: 'js' }));
  } }],
});
const m = await import(pathToFileURL(outfile).href);
const { backoffMs, isRetryable, planFlush } = m.outboxLogic;

const base = (id, chatId, createdAt, extra = {}) => ({ clientMsgId: id, chatId, kind: 'text', encrypted: { version: 2 }, replyToId: null, text: 't', payload: null, createdAt, ...extra });
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 5)); } };
const reset = () => { for (const r of m.listOutbox('A').concat(m.listOutbox('B'))) m.discard(r.clientMsgId); m.calls.length = 0; m.script.length = 0; m.store.clear(); };

test('backoff grows 1s -> 30s cap with bounded jitter', () => {
  assert.equal(backoffMs(1, () => 0.5), 1000);
  assert.equal(backoffMs(2, () => 0.5), 2000);
  assert.equal(backoffMs(5, () => 0.5), 16000);
  assert.equal(backoffMs(6, () => 0.5), 30000);
  assert.equal(backoffMs(40, () => 1), 30000);
  assert.equal(backoffMs(1, () => 0), 800);
});

test('isRetryable: network/408/429/5xx retry, other 4xx stop', () => {
  assert.equal(isRetryable(new Error('net')), true);
  for (const s of [0, 408, 429, 500, 503]) assert.equal(isRetryable(new m.ApiError('x', s)), true, String(s));
  for (const s of [400, 401, 403, 404, 413]) assert.equal(isRetryable(new m.ApiError('x', s)), false, String(s));
});

test('planFlush keeps per-chat order and lets failed rows through', () => {
  const r = (id, chat, at, state, next = 0) => ({ ...base(id, chat, at), state, attempts: 0, nextAttemptAt: next });
  const plan = planFlush([
    r('b2', 'B', 2, 'pending'), r('a2', 'A', 2, 'pending'), r('a1', 'A', 1, 'pending'),
    r('b1', 'B', 1, 'sending'),
    r('c0', 'C', 0, 'failed'), r('c1', 'C', 1, 'pending'),
    r('d1', 'D', 1, 'pending', 5000), r('d2', 'D', 2, 'pending'),
  ], 1000);
  assert.deepEqual(plan.ready.map((x) => x.clientMsgId).sort(), ['a1', 'c1']);
  assert.equal(plan.wakeAt, 5000);
});

test('flow: one chat sends in order, one at a time; sent rows leave db', async () => {
  reset();
  let release;
  m.script.push(() => new Promise((r) => { release = r; })); // first send hangs until released
  m.enqueue(base('a-1', 'A', 1)); m.enqueue(base('a-2', 'A', 2)); m.enqueue(base('b-1', 'B', 1));
  await until(() => m.calls.length === 2); // a-1 and b-1 start, a-2 must wait
  assert.deepEqual(m.calls.map((c) => c.args.at(-1)).sort(), ['a-1', 'b-1']);
  assert.equal(m.listOutbox('A').find((r) => r.clientMsgId === 'a-1').state, 'sending');
  assert.equal(m.store.get('a-1').state, 'sending');
  release();
  await until(() => m.calls.length === 3);
  assert.equal(m.calls[2].args.at(-1), 'a-2');
  await until(() => m.listOutbox('A').length === 0 && m.store.size === 0);
});

test('flow: network error -> pending with backoff, 400 -> failed and next row still goes, retryNow resends same id', async () => {
  reset();
  m.script.push(async () => { throw new m.ApiError('net', 0); });
  m.enqueue(base('a-1', 'A', 1));
  await until(() => m.listOutbox('A')[0]?.attempts === 1);
  let row = m.listOutbox('A')[0];
  assert.equal(row.state, 'pending');
  assert.ok(row.nextAttemptAt > Date.now() + 500 && row.nextAttemptAt <= Date.now() + 1300);
  m.retryNow('a-1');
  await until(() => m.listOutbox('A').length === 0);
  assert.deepEqual(m.calls.map((c) => c.args.at(-1)), ['a-1', 'a-1']); // same clientMsgId both times

  reset();
  m.script.push(async () => { throw new m.ApiError('bad', 400); });
  m.enqueue(base('a-1', 'A', 1)); m.enqueue(base('a-2', 'A', 2));
  await until(() => m.listOutbox('A').length === 1 && m.calls.length === 2);
  assert.equal(m.calls[1].args.at(-1), 'a-2'); // failed head did not block a-2
  m.script.push(async () => {}); // nothing: a-2 already sent
});

test('flow: kinds map to the right api call, missing media id fails fast', async () => {
  reset();
  m.enqueue(base('s-1', 'A', 1, { kind: 'sticker', encryptedMediaId: 'em1', payload: { stickerId: 'x' } }));
  await until(() => m.calls.length === 1);
  assert.equal(m.calls[0].name, 'sticker');
  await until(() => m.listOutbox('A').length === 0);
  m.enqueue(base('p-1', 'A', 2, { kind: 'photo', attachmentId: 'a'.repeat(32) }));
  await until(() => m.calls.length === 2);
  assert.equal(m.calls[1].name, 'attachment');
  await until(() => m.listOutbox('A').length === 0);
  m.enqueue(base('g-1', 'A', 3, { kind: 'gif' })); // no encryptedMediaId
  await until(() => m.listOutbox('A')[0]?.state === 'failed');
  assert.equal(m.calls.length, 2);
});

test('startOutbox: persisted rows load, sending is reset to pending, then they send', async () => {
  reset();
  m.store.set('r-1', { ...base('r-1', 'B', 1), state: 'sending', attempts: 2, nextAttemptAt: 0 });
  m.store.set('r-2', { ...base('r-2', 'B', 2), state: 'failed', attempts: 1, nextAttemptAt: 0 });
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const stop = m.startOutbox();
  await until(() => m.calls.length === 1);
  assert.equal(m.calls[0].args.at(-1), 'r-1');
  await until(() => m.store.has('r-1') === false);
  assert.equal(m.listOutbox('B')[0].clientMsgId, 'r-2'); // failed row stays, waits for retryNow
  assert.equal(m.listOutbox('B')[0].state, 'failed');
  stop();
});

// NS-07: a queued message refused because its chat key version is stale.
const stale = (status = 409) => {
  const error = new m.ApiError('stale', status);
  error.data = status === 409 ? { error: 'pending', keyVersion: 1, pendingKeyVersion: 2 } : { error: 'stale', keyVersion: 2, pendingKeyVersion: null };
  return error;
};

test('stale key: a queued text is sealed again with the new key and goes out; the attempt counter is not burnt', async () => {
  reset();
  const sealed = [];
  const stop = m.setStaleKeyRecovery(async (row) => { sealed.push(row.clientMsgId); return { version: 2, cipherId: 'c2', nonce: 'n2', ciphertext: 't2', keyVersion: 2 }; });
  m.script.push(async () => { throw stale(409); });
  m.enqueue(base('a-1', 'A', 1));
  await until(() => m.calls.length === 2 && m.listOutbox('A').length === 0);
  assert.deepEqual(sealed, ['a-1']);
  assert.equal(m.calls[0].args[1].version, 2, 'first send used the old envelope');
  assert.equal(m.calls[1].args[1].keyVersion, 2, 'second send carries the new key version');
  assert.equal(m.calls[1].args.at(-1), 'a-1', 'same clientMsgId, so the server dedupes');
  stop();
});

test('stale key: recovery that cannot run fails the row with a clear message; media rows never pretend; the cap stops a loop', async () => {
  reset();
  let stop = m.setStaleKeyRecovery(async () => { throw new Error('کلید رمزنگاری مخاطب عوض شده است. پس از تأیید آن، پیام را دوباره بفرستید.'); });
  m.script.push(async () => { throw stale(400); });
  m.enqueue(base('a-1', 'A', 1));
  await until(() => m.listOutbox('A')[0]?.state === 'failed');
  assert.match(m.listOutbox('A')[0].error, /کلید رمزنگاری مخاطب عوض شده/);
  assert.equal(m.calls.length, 1, 'nothing was sent behind the user\'s back');
  stop();

  reset();
  stop = m.setStaleKeyRecovery(async () => { throw new Error('must not be called for media'); });
  m.script.push(async () => { throw stale(409); });
  m.enqueue(base('s-1', 'A', 1, { kind: 'sticker', encryptedMediaId: 'em1', payload: { stickerId: 'x' } }));
  await until(() => m.listOutbox('A')[0]?.state === 'failed');
  assert.match(m.listOutbox('A')[0].error, /دوباره بفرستید/);
  stop();

  reset();
  stop = m.setStaleKeyRecovery(async () => ({ version: 2, cipherId: 'c', nonce: 'n', ciphertext: 't', keyVersion: 2 }));
  for (let i = 0; i < 4; i += 1) m.script.push(async () => { throw stale(409); });
  m.enqueue(base('a-1', 'A', 1));
  await until(() => m.listOutbox('A')[0]?.state === 'failed');
  assert.equal(m.calls.length, 3, 'original send + two re-encryptions, then it stops and tells the user');
  m.retryNow('a-1'); // a manual retry gets a fresh allowance
  await until(() => m.calls.length >= 4);
  stop();
});

test('stale key: without a recovery handler (page reloaded, plaintext gone) the row fails clearly', async () => {
  reset();
  m.setStaleKeyRecovery(undefined);
  m.script.push(async () => { throw stale(409); });
  m.enqueue(base('a-1', 'A', 1));
  await until(() => m.listOutbox('A')[0]?.state === 'failed');
  assert.match(m.listOutbox('A')[0].error, /کلید گفت‌وگو عوض شده/);
});
