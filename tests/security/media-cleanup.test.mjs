// Orphan cleanup of encrypted chat media: old files with no live reference go.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(root, 'apps/server/dist');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-mcleanup-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.TRUSTED_ORIGINS = 'http://localhost:3050';
process.env.SESSION_SECRET = 'cleanup-test-secret-with-at-least-32-bytes';
const load = (name) => import(path.join(dist, name));
const { runMigrations } = await load('migrate.js');
const { db } = await load('db.js');
const { createUser } = await load('users.js');
const { cleanupEncryptedMedia } = await load('media/cleanup.js');
const { mediaDir, ensureStorage } = await load('media/storage.js');

let chat, user;
const old = new Date(Date.now() - 100 * 3_600_000).toISOString();
const fresh = new Date(Date.now() - 3_600_000).toISOString();
const file = (id) => path.join(mediaDir, 'encrypted', `${id}.bin`);
const addMedia = async (createdAt, { message = false, deleted = false } = {}) => {
  const id = randomUUID();
  await writeFile(file(id), Buffer.alloc(40, 1));
  await db.query('INSERT INTO encrypted_chat_media (id, chat_id, uploader_id, file_path, byte_size, created_at) VALUES ($1, $2, $3, $4, 40, $5)', [id, chat, user, `encrypted/${id}.bin`, createdAt]);
  if (message) {
    await db.query(
      `INSERT INTO messages (chat_id, sender_id, kind, text, payload, encryption_version, cipher_id, nonce, ciphertext, encrypted_media_id, deleted_at)
       VALUES ($1, $2, 'photo', NULL, '{}', 2, $3, 'AAAAAAAAAAAAAAAA', $4, $5, $6)`,
      [chat, user, randomUUID(), 'A'.repeat(40), id, deleted ? old : null]
    ).catch(async (error) => { throw new Error(`message insert failed: ${error.message}`); });
  }
  return id;
};

before(async () => {
  await runMigrations();
  await ensureStorage();
  user = await createUser('mc_user', 'mc', 'a-long-password-9');
  chat = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chat, user]);
});
after(async () => { await db.end(); await rm(dataDir, { recursive: true, force: true }); });

test('removes old unreferenced and deleted-message media; keeps fresh and live media', async () => {
  const orphanOld = await addMedia(old);
  const orphanFresh = await addMedia(fresh);
  const used = await addMedia(old, { message: true });
  const usedDeleted = await addMedia(old, { message: true, deleted: true });
  const result = await cleanupEncryptedMedia();
  assert.equal(result.rows, 2);
  assert.equal(existsSync(file(orphanOld)), false);
  assert.equal((await db.query('SELECT 1 FROM encrypted_chat_media WHERE id = $1', [orphanOld])).rowCount, 0);
  assert.equal(existsSync(file(usedDeleted)), false);
  assert.equal((await db.query('SELECT encrypted_media_id FROM messages WHERE encrypted_media_id = $1', [usedDeleted])).rowCount, 0);
  for (const id of [orphanFresh, used]) {
    assert.equal(existsSync(file(id)), true, id);
    assert.equal((await db.query('SELECT 1 FROM encrypted_chat_media WHERE id = $1', [id])).rowCount, 1);
  }
});

test('stray files without a row go only when old; non-media names and other folders are never touched', async () => {
  const strayOld = randomUUID(); const strayFresh = randomUUID();
  await writeFile(file(strayOld), 'x'); await writeFile(file(strayFresh), 'x');
  const past = new Date(Date.now() - 100 * 3_600_000);
  await utimes(file(strayOld), past, past);
  const notMedia = path.join(mediaDir, 'encrypted', 'keep-me.txt');
  await writeFile(notMedia, 'x'); await utimes(notMedia, past, past);
  await mkdir(path.join(mediaDir, 'stickers'), { recursive: true });
  const sticker = path.join(mediaDir, 'stickers', `${randomUUID()}.webp`);
  await writeFile(sticker, 'x'); await utimes(sticker, past, past);
  const result = await cleanupEncryptedMedia();
  assert.equal(result.strays, 1);
  assert.equal(existsSync(file(strayOld)), false);
  assert.equal(existsSync(file(strayFresh)), true);
  assert.equal(existsSync(notMedia), true);
  assert.equal(existsSync(sticker), true);
});

test('files left behind by a deleted chat are collected once old', async () => {
  const c = (await db.query('INSERT INTO chats DEFAULT VALUES RETURNING id')).rows[0].id;
  const id = randomUUID();
  await writeFile(file(id), 'x');
  await db.query('INSERT INTO encrypted_chat_media (id, chat_id, uploader_id, file_path, byte_size) VALUES ($1, $2, $3, $4, 40)', [id, c, user, `encrypted/${id}.bin`]);
  await db.query('DELETE FROM chats WHERE id = $1', [c]); // cascades the row, not the file
  assert.equal(existsSync(file(id)), true);
  assert.equal((await cleanupEncryptedMedia()).strays, 0, 'fresh file is kept');
  const past = new Date(Date.now() - 100 * 3_600_000);
  await utimes(file(id), past, past);
  assert.equal((await cleanupEncryptedMedia()).strays, 1);
  assert.equal(existsSync(file(id)), false);
});
