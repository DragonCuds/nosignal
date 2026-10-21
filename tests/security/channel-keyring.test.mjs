import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'apps/server/package.json'));
const Database = require('better-sqlite3');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tel-channel-keys-'));
const dbPath = path.join(dataDir, 'tel.db');
const backupPath = path.join(dataDir, 'before-rotation.db');
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const oldSession = 'old-session-secret-only-for-channel-migration-test';
const newSession = 'new-session-secret-only-for-channel-migration-test';
const ring1 = `key1:${k1.toString('base64url')}`;
const ring2 = `${ring1},key2:${k2.toString('base64url')}`;
const plain1 = randomBytes(32);
const plain2 = randomBytes(32);

const runMigration = (session, ring, active) => spawnSync(process.execPath, ['apps/server/dist/migrate.js'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir, SESSION_SECRET: session,
    CHANNEL_KEYRING: ring, CHANNEL_ACTIVE_KEY_ID: active, TRUSTED_ORIGINS: 'http://localhost:3050' }
});
const rows = () => {
  const db = new Database(dbPath);
  try { return db.prepare('SELECT id, key_id, key_wrapped FROM channels ORDER BY id').all(); }
  finally { db.close(); }
};
const wrap = (key, plain) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
};
const unwrap = (key, wrapped) => {
  const raw = Buffer.from(wrapped, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
};
const legacyKey = createHash('sha256').update(`tel:channel-key:v1\0${oldSession}`).digest();

test('channel keys survive initial migration, interruption, rotation, session change and backup restore', () => {
  try {
    const initial = runMigration(oldSession, ring1, 'key1');
    assert.equal(initial.status, 0, initial.stderr);
    const db = new Database(dbPath);
    try {
      db.exec(`INSERT INTO users (username, display_name, password_hash) VALUES ('owner', 'Owner', 'unused');
        INSERT INTO chats DEFAULT VALUES;
        INSERT INTO chats DEFAULT VALUES;`);
      const insert = db.prepare("INSERT INTO channels (chat_id, owner_id, title, key_wrapped) VALUES (?, 1, 'Archive', ?)");
      insert.run(1, wrap(legacyKey, plain1));
      insert.run(2, 'corrupt-legacy-key');
    } finally { db.close(); }

    const interrupted = runMigration(oldSession, ring1, 'key1');
    assert.notEqual(interrupted.status, 0, 'corrupt row must stop migration');
    assert.deepEqual(rows().map((r) => r.key_id), ['key1', 'legacy-session-v1']);
    const repair = new Database(dbPath);
    try { repair.prepare('UPDATE channels SET key_wrapped = ? WHERE id = 2').run(wrap(legacyKey, plain2)); }
    finally { repair.close(); }
    assert.equal(runMigration(oldSession, ring1, 'key1').status, 0);
    let migrated = rows();
    assert.deepEqual(migrated.map((r) => r.key_id), ['key1', 'key1']);
    assert.deepEqual(unwrap(k1, migrated[0].key_wrapped), plain1);
    assert.deepEqual(unwrap(k1, migrated[1].key_wrapped), plain2);
    copyFileSync(dbPath, backupPath);

    assert.notEqual(runMigration(newSession, `key2:${k2.toString('base64url')}`, 'key2').status, 0,
      'old key must remain until its rows have moved');
    assert.equal(runMigration(newSession, ring2, 'key2').status, 0);
    migrated = rows();
    assert.deepEqual(migrated.map((r) => r.key_id), ['key2', 'key2']);
    assert.deepEqual(unwrap(k2, migrated[0].key_wrapped), plain1);
    assert.deepEqual(unwrap(k2, migrated[1].key_wrapped), plain2);
    assert.equal(runMigration(newSession, `key2:${k2.toString('base64url')}`, 'key2').status, 0);
    assert.deepEqual(rows(), migrated, 're-running migration must not rewrite current rows');

    copyFileSync(backupPath, dbPath);
    assert.equal(runMigration(newSession, ring1, 'key1').status, 0, 'backup opens with its matching keyring');
    assert.deepEqual(rows().map((r) => r.key_id), ['key1', 'key1']);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
