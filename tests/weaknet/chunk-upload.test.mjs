// Server: chunked attachment upload (out of order, duplicates, resume via GET status, concurrent finalize, quota, cleanup).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as C from '../../apps/web/src/attachments/crypto.ts';
import { bootApp } from './helpers.mjs';

const FC = 262160;
let S;
before(async () => { S = await bootApp({ routes: ['attachments'], prefix: 'wn-chunk', env: { MAX_ATTACHMENT_MB: '2', USER_QUOTA_MB: '4' } }); });
after(async () => { await S?.close(); });

const api = (method, url, { user = 'a', body, headers = {} } = {}) => S.req(method, url, { user, body, headers });
const put = (user, chat, id, data) => api('PUT', `/api/chats/${chat}/attachments/${id}`, { user, body: data, headers: { 'Content-Type': 'application/octet-stream' } });
const chunkPut = (user, chat, id, n, total, data) => api('PUT', `/api/chats/${chat}/attachments/${id}/chunks/${n}`, { user, body: data, headers: { 'Content-Type': 'application/octet-stream', 'X-Total-Length': String(total) } });
const hex = () => randomBytes(16).toString('hex');
const encrypt = async (size, chatId, id) => {
  const s = C.newAttachmentSecrets();
  const c = { key: await C.importAttachmentKey(s.key), noncePrefix: C.unb64u(s.noncePrefix), chatId, id, size };
  const plain = new Uint8Array(randomBytes(size));
  const parts = [];
  for await (const p of C.encryptChunks(c, new Blob([plain]))) parts.push(Buffer.from(p));
  return { c, plain, cipher: Buffer.concat(parts) };
};

test('chunked upload out of order, dup, resume', async () => {
  const id = hex();
  const { c, plain, cipher } = await encrypt(1_300_000, '1', id);
  const total = cipher.length;
  const slice = (n) => cipher.subarray(n * FC, Math.min(total, (n + 1) * FC));
  assert.equal(Math.ceil(total / FC), 5);
  assert.equal((await api('GET', `/api/chats/1/attachments/${id}/upload`)).status, 404);
  let r = await chunkPut('a', 1, id, 3, total, slice(3));
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { received: 1, total: 5, complete: false });
  r = await chunkPut('a', 1, id, 3, total, slice(3)); // duplicate
  assert.deepEqual(await r.json(), { received: 1, total: 5, complete: false });
  assert.equal((await chunkPut('a', 1, id, 0, total, slice(1).subarray(0, 100))).status, 400, 'wrong length');
  assert.equal((await chunkPut('a', 1, id, 9, total, slice(1))).status, 400, 'index out of range');
  assert.equal((await chunkPut('c', 1, id, 1, total, slice(1))).status, 404, 'non-member');
  assert.equal((await chunkPut('b', 1, id, 1, total, slice(1))).status, 409, 'other uploader');
  assert.equal((await chunkPut('a', 1, id, 1, total + 1, slice(1))).status, 409, 'mismatched total');
  await chunkPut('a', 1, id, 1, total, slice(1));
  const st = await (await api('GET', `/api/chats/1/attachments/${id}/upload`)).json();
  assert.deepEqual(st, { total, chunkBytes: FC, received: [1, 3], complete: false });
  assert.equal((await api('GET', `/api/chats/1/attachments/${id}/upload`, { user: 'b' })).status, 404);
  for (const n of [4, 0]) assert.equal((await chunkPut('a', 1, id, n, total, slice(n))).status, 200);
  r = await chunkPut('a', 1, id, 2, total, slice(2));
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { id, size: total, complete: true, received: 5, total: 5 });
  r = await chunkPut('a', 1, id, 2, total, slice(2));
  assert.equal(r.status, 200); assert.equal((await r.json()).complete, true);
  const fin = await (await api('GET', `/api/chats/1/attachments/${id}/upload`)).json();
  assert.equal(fin.complete, true); assert.deepEqual(fin.received, [0, 1, 2, 3, 4]);
  assert.deepEqual(await readFile(path.join(S.dataDir, 'attachments', id + '.bin')), cipher);
  const names = await readdir(path.join(S.dataDir, 'attachments'));
  assert.ok(!names.some((x) => x.endsWith('.part') && x.startsWith(id)), 'no .part left');
  assert.equal((await S.db.query('SELECT COUNT(*) AS c FROM attachment_upload_chunks')).rows[0].c, 0);
  const g = await api('GET', `/api/attachments/${id}`, { headers: { Range: 'bytes=300000-300099' } });
  assert.equal(g.status, 206);
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), cipher.subarray(300000, 300100));
  const rd = async (a, b) => new Uint8Array(cipher.subarray(a, b + 1));
  assert.deepEqual(await C.decryptAll(c, rd), plain);
});

test('concurrent chunks finalize once; old PUT still works; quota; cleanup', async () => {
  const id = hex();
  const { cipher } = await encrypt(700_000, '1', id);
  const total = cipher.length; const count = Math.ceil(total / FC);
  const rs = await Promise.all(Array.from({ length: count }, (_, n) => chunkPut('a', 1, id, n, total, cipher.subarray(n * FC, Math.min(total, (n + 1) * FC)))));
  assert.equal(rs.filter((x) => x.status === 201).length, 1, rs.map((x) => x.status).join());
  assert.deepEqual(await readFile(path.join(S.dataDir, 'attachments', id + '.bin')), cipher);
  const id2 = hex(); const e2 = await encrypt(100_000, '1', id2);
  assert.equal((await put('a', 1, id2, e2.cipher)).status, 201, 'old PUT');
  // quota: a 2 MB declared total must be refused at the first chunk
  const r = await chunkPut('a', 1, hex(), 0, 2 * 1024 * 1024 + 8 * 16, Buffer.alloc(FC));
  assert.ok([413, 400].includes(r.status), String(r.status));
  // cleanup of a stale upload
  const id4 = hex(); const e4 = await encrypt(600_000, '1', id4);
  await chunkPut('a', 1, id4, 0, e4.cipher.length, e4.cipher.subarray(0, FC));
  const part = path.join(S.dataDir, 'attachments', id4 + '.part');
  assert.ok(existsSync(part));
  const out0 = await S.attachments.cleanupAttachments();
  assert.equal(out0.uploads, 0); assert.ok(existsSync(part));
  await S.db.query("UPDATE attachment_uploads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE id = $1", [id4]);
  const old = new Date(Date.now() - 7200_000); await utimes(part, old, old);
  const out = await S.attachments.cleanupAttachments();
  assert.equal(out.uploads, 1); assert.equal(out.strays, 1);
  assert.ok(!existsSync(part));
  assert.equal((await api('GET', `/api/chats/1/attachments/${id4}/upload`)).status, 404);
});
