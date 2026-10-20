import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../../apps/web/src/attachments/crypto.ts';

const mk = async (size, over = {}) => {
  const s = C.newAttachmentSecrets();
  return {
    key: await C.importAttachmentKey(s.key), noncePrefix: C.unb64u(s.noncePrefix),
    chatId: '7', id: s.id, size, ...over
  };
};
const bytes = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
const encryptAll = async (c, plain) => {
  const parts = [];
  for await (const p of C.encryptChunks(c, new Blob([plain]))) parts.push(p);
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const reader = (cipher) => async (a, b) => cipher.slice(a, b + 1);
const CS = C.CHUNK_SIZE;

test('round trip at chunk boundaries incl. empty', async () => {
  for (const size of [0, 1, CS - 1, CS, CS + 1, 3 * CS, 3 * CS + 5]) {
    const c = await mk(size);
    const plain = bytes(size);
    const cipher = await encryptAll(c, plain);
    assert.equal(cipher.length, C.cipherSize(size), `cipherSize ${size}`);
    assert.deepEqual(await C.decryptAll(c, reader(cipher)), plain, `size ${size}`);
  }
});

test('encryptToStream matches encryptChunks', async () => {
  const c = await mk(CS + 10);
  const plain = bytes(CS + 10);
  const chunks = [];
  const rd = C.encryptToStream(c, new Blob([plain])).getReader();
  for (;;) { const r = await rd.read(); if (r.done) break; chunks.push(r.value); }
  assert.equal(chunks.reduce((a, p) => a + p.length, 0), C.cipherSize(CS + 10));
});

test('range -> chunk math', () => {
  const size = 2 * CS + 100;
  const p = C.planRange(size, CS - 1, CS + 1);
  assert.deepEqual([p.firstChunk, p.lastChunk, p.skip, p.length], [0, 1, CS - 1, 3]);
  assert.equal(p.cipherStart, 0);
  assert.equal(p.cipherEnd, 2 * (CS + 16) - 1);
  const last = C.planRange(size, size - 1, size - 1);
  assert.equal(last.firstChunk, 2);
  assert.equal(last.cipherStart, 2 * (CS + 16));
  assert.equal(last.cipherEnd, C.cipherSize(size) - 1);
  assert.throws(() => C.planRange(size, 5, size), RangeError);
  assert.throws(() => C.planRange(size, 5, 4), RangeError);
  assert.throws(() => C.planRange(size, -1, 4), RangeError);
});

test('random ranges decrypt only the needed ciphertext', async () => {
  const size = 3 * CS + 777;
  const c = await mk(size);
  const plain = bytes(size);
  const cipher = await encryptAll(c, plain);
  const asked = [];
  for (const [a, b] of [[0, 0], [5, 9], [CS - 3, CS + 3], [CS, 2 * CS - 1], [size - 10, size - 1], [0, size - 1]]) {
    const got = await C.decryptRange(c, a, b, async (x, y) => { asked.push([x, y]); return cipher.slice(x, y + 1); });
    assert.deepEqual(got, plain.subarray(a, b + 1), `${a}-${b}`);
  }
  assert.deepEqual(asked[1], [0, CS + 15]); // 5..9 only touches chunk 0
});

test('tamper, truncation, reorder, cross-chat/id replay all fail', async () => {
  const size = 3 * CS + 5;
  const c = await mk(size);
  const cipher = await encryptAll(c, bytes(size));
  const F = CS + 16;
  const fail = (cc, data) => assert.rejects(C.decryptAll(cc, async (a, b) => data.slice(a, b + 1)));

  const flipped = cipher.slice(); flipped[100] ^= 1;
  await fail(c, flipped);

  const swapped = cipher.slice();
  swapped.set(cipher.subarray(F, 2 * F), 0); swapped.set(cipher.subarray(0, F), F);
  await fail(c, swapped); // reorder chunk 0/1

  await assert.rejects(C.decryptAll(c, async (a, b) => cipher.slice(a, Math.max(a, b - 20)))); // short data

  // truncation: drop last chunk, claim a size that ends at a chunk boundary -> lastFlag mismatch
  const t = { ...c, size: 2 * CS };
  await assert.rejects(C.decryptAll(t, async (a, b) => cipher.slice(a, b + 1)));

  await fail({ ...c, chatId: '8' }, cipher);
  await fail({ ...c, id: 'f'.repeat(32) }, cipher);
  const other = await mk(size);
  await fail({ ...c, key: other.key }, cipher);
  await fail({ ...c, noncePrefix: other.noncePrefix }, cipher);
});

test('nonce is never reused across chunks and attachments differ', async () => {
  const a = C.newAttachmentSecrets(), b = C.newAttachmentSecrets();
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.noncePrefix, b.noncePrefix);
  assert.equal(C.unb64u(a.key).length, 32);
  assert.equal(C.unb64u(a.noncePrefix).length, 8);
  assert.match(a.id, /^[0-9a-f]{32}$/u);
  const c = await mk(2 * CS);
  const one = await C.encryptChunk(c, 0, new Uint8Array(CS), false);
  const two = await C.encryptChunk(c, 1, new Uint8Array(CS), false);
  assert.notDeepEqual(one, two); // same plaintext, different nonce
});

test('b64u round trip', () => {
  const v = bytes(1000);
  assert.deepEqual(C.unb64u(C.b64u(v)), v);
  assert.doesNotMatch(C.b64u(v), /[+/=]/u);
});
