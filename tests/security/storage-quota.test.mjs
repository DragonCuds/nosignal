import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
