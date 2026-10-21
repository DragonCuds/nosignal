import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootApp, imp } from '../weaknet/helpers.mjs';

let S;
const hex = () => randomBytes(16).toString('hex');
const media = (user, size, type = 'application/octet-stream', chat = 1) => {
  const body = new FormData();
  body.set('file', new Blob([Buffer.alloc(size, 7)], { type }), 'opaque.bin');
  return S.req('POST', `/api/chats/${chat}/encrypted-media`, { user, body });
};
const attachment = (user, size) => S.req('PUT', `/api/chats/1/attachments/${hex()}`, {
  user, body: Buffer.alloc(size, 9), headers: { 'content-type': 'application/octet-stream' }
});
const used = async (userId) => {
  const row = (await S.db.query(`SELECT
    (SELECT COALESCE(SUM(byte_size), 0) FROM encrypted_chat_media WHERE uploader_id = $1)
    + (SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE uploader_id = $1 AND expired_at IS NULL) AS bytes`, [userId])).rows[0];
  return Number(row.bytes);
};

before(async () => {
  S = await bootApp({ routes: ['attachments', 'media'], prefix: 'storage-quota', env: {
    USER_QUOTA_MB: '0.002', MIN_FREE_STORAGE_MB: '0'
  } });
});
after(async () => { await S?.close(); });

test('encrypted media and attachments share the committed quota', async () => {
  assert.equal((await media('a', 900)).status, 201);
  assert.equal((await attachment('a', 900)).status, 201);
  const before = await used('1');
  assert.equal(before, 1800);
  const denied = await media('a', 400);
  assert.equal(denied.status, 413);
  assert.match((await denied.json()).error, /quota/i);
  assert.equal(await used('1'), before);
  assert.equal((await media('b', 900)).status, 201, 'quota is per user');
});

test('chunk reservation blocks media and releases on completion', async () => {
  const id = hex();
  const chunk = Buffer.alloc(1000, 5);
  const url = `/api/chats/1/attachments/${id}/chunks/0`;
  const res = await S.req('PUT', url, { user: 'c', body: chunk,
    headers: { 'content-type': 'application/octet-stream', 'x-total-length': String(chunk.length) } });
  assert.equal(res.status, 404, 'non-member cannot reserve');
  const reserved = await S.req('PUT', url, { user: 'b', body: chunk,
    headers: { 'content-type': 'application/octet-stream', 'x-total-length': String(chunk.length) } });
  assert.equal(reserved.status, 201);
  assert.equal((await media('b', 900)).status, 413, 'committed media + attachment + chunk cannot exceed quota');
  assert.equal((await S.db.query('SELECT 1 FROM attachment_uploads WHERE id = $1', [id])).rowCount, 0);
});

test('parallel uploads reserve atomically, and failed requests release reservations', async () => {
  const [first, second] = await Promise.all([media('c', 1300, undefined, 2), media('c', 1300, undefined, 2)]);
  assert.deepEqual([first.status, second.status].sort(), [201, 413]);
  assert.equal(await used('3'), 1300);
  assert.equal((await media('c', 100, 'text/plain', 2)).status, 400);
  assert.equal((await S.db.query('SELECT 1 FROM storage_reservations WHERE user_id = 3')).rowCount, 0);
  assert.equal((await media('c', 300, undefined, 2)).status, 201);
});

test('expired reservations are reclaimed; global and free-space limits reject safely', async () => {
  const quota = await imp('apps/server/src/storage-quota.ts');
  const id = await quota.reserveStorage('3', 100);
  await S.db.query(`UPDATE storage_reservations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`, [id]);
  const fresh = await quota.reserveStorage('3', 100);
  await quota.releaseStorage(fresh);
  assert.equal((await S.db.query('SELECT 1 FROM storage_reservations WHERE id = $1', [id])).rowCount, 0);
  process.env.SERVER_STORAGE_QUOTA_MB = '0.001';
  try { assert.equal((await media('a', 100)).status, 503); }
  finally { delete process.env.SERVER_STORAGE_QUOTA_MB; }
  process.env.MIN_FREE_STORAGE_MB = '999999999';
  try { assert.equal((await media('a', 100)).status, 503); }
  finally { process.env.MIN_FREE_STORAGE_MB = '0'; }
});

test('partial chunk upload blocks one-shot quota bypass and keeps its upload id', async () => {
  process.env.USER_QUOTA_MB = '0.3';
  try {
    const id = hex();
    const total = 262_200;
    const first = `/api/chats/1/attachments/${id}/chunks/0`;
    const last = `/api/chats/1/attachments/${id}/chunks/1`;
    const headers = { 'content-type': 'application/octet-stream', 'x-total-length': String(total) };
    assert.equal((await S.req('PUT', first, { user: 'b', body: Buffer.alloc(262_160), headers })).status, 200);
    assert.equal((await attachment('b', 60_000)).status, 413, 'one-shot cannot spend chunk reservation');
    assert.equal((await S.req('PUT', `/api/chats/1/attachments/${id}`, { user: 'b', body: Buffer.alloc(1_000),
      headers: { 'content-type': 'application/octet-stream' } })).status, 409, 'one-shot cannot reuse chunk id');
    assert.equal((await S.db.query('SELECT 1 FROM attachment_uploads WHERE id = $1', [id])).rowCount, 1);
    assert.equal((await S.req('PUT', last, { user: 'b', body: Buffer.alloc(40), headers })).status, 201);
    assert.equal((await S.db.query('SELECT 1 FROM attachment_uploads WHERE id = $1', [id])).rowCount, 0);
    assert.equal((await S.db.query('SELECT 1 FROM attachments WHERE id = $1', [id])).rowCount, 1);
    assert.equal((await S.req('PUT', last, { user: 'b', body: Buffer.alloc(40), headers })).status, 200, 'finalize is idempotent');
    assert.equal((await S.db.query('SELECT COUNT(*) AS n FROM attachments WHERE id = $1', [id])).rows[0].n, 1);
  } finally { process.env.USER_QUOTA_MB = '0.002'; }
});

test('one-shot committed bytes block chunk reservation and concurrent mixed reservations stay within quota', async () => {
  const quota = await imp('apps/server/src/storage-quota.ts');
  process.env.USER_QUOTA_MB = '0.3';
  try {
    assert.equal((await attachment('a', 60_000)).status, 201);
    const reservedId = hex();
    await quota.reserveStorage('3', 1_000, reservedId);
    assert.equal((await S.req('PUT', `/api/chats/2/attachments/${reservedId}/chunks/0`, {
      user: 'c', body: Buffer.alloc(1_000),
      headers: { 'content-type': 'application/octet-stream', 'x-total-length': '1000' }
    })).status, 409, 'chunk upload cannot reuse an active one-shot id');
    await quota.releaseStorage(reservedId);
    const chunkId = hex();
    const headers = { 'content-type': 'application/octet-stream', 'x-total-length': '262200' };
    assert.equal((await S.req('PUT', `/api/chats/1/attachments/${chunkId}/chunks/0`, {
      user: 'a', body: Buffer.alloc(262_160), headers
    })).status, 413, 'committed one-shot bytes count against a chunk reservation');
    const id = hex();
    const concurrentChunkId = hex();
    const results = await Promise.allSettled([
      quota.reserveStorage('3', 200_000, id),
      quota.reserveChunkStorage(concurrentChunkId, '2', '3', 200_000, 1)
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const usage = (await S.db.query(`SELECT
      (SELECT COALESCE(SUM(byte_size), 0) FROM storage_reservations WHERE user_id = 3)
      + (SELECT COALESCE(SUM(total_bytes), 0) FROM attachment_uploads WHERE uploader_id = 3) AS bytes`)).rows[0];
    assert.equal(Number(usage.bytes), 200_000);
    await quota.releaseStorage(id);
    await S.db.query('DELETE FROM attachment_uploads WHERE id = $1', [concurrentChunkId]);
  } finally { process.env.USER_QUOTA_MB = '0.002'; }
});

test('cleanup commits a complete chunk file left by an interrupted finalization', async () => {
  const quota = await imp('apps/server/src/storage-quota.ts');
  const id = hex();
  process.env.USER_QUOTA_MB = '0.3';
  try {
    await quota.reserveChunkStorage(id, '2', '3', 1_000, 1);
    await writeFile(join(S.attachments.attachmentsDir(), `${id}.bin`), Buffer.alloc(1_000));
    await S.db.query(`UPDATE attachment_uploads SET finalizing = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours') WHERE id = $1`, [id]);
    await S.attachments.cleanupAttachments();
    assert.equal((await S.db.query('SELECT 1 FROM attachment_uploads WHERE id = $1', [id])).rowCount, 0);
    assert.equal((await S.db.query('SELECT byte_size FROM attachments WHERE id = $1', [id])).rows[0].byte_size, 1_000);
    await S.attachments.cleanupAttachments();
    assert.equal((await S.db.query('SELECT COUNT(*) AS n FROM attachments WHERE id = $1', [id])).rows[0].n, 1);
  } finally { process.env.USER_QUOTA_MB = '0.002'; }
});
