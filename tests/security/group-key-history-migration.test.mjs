// NS-07b: migration 021 on a database that already holds 001-020 data (groups with real key envelopes).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const migrations = path.join(root, 'apps/server/migrations');
const Database = createRequire(path.join(root, 'apps/server/package.json'))('better-sqlite3');
const files = readdirSync(migrations).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
const up = (db, from, to) => { for (const f of files.filter((n) => n >= from && n < to)) db.exec(readFileSync(path.join(migrations, f), 'utf8')); };
const hex = (c) => c.repeat(64);
const jwk = (c) => JSON.stringify({ kty: 'EC', crv: 'P-256', x: c.repeat(43), y: c.repeat(43) });

test('021 rebuilds group_key_envelopes: rows kept, wrapper key copied from the current identity, NULL when none, nothing else touched', () => {
  assert.ok(files.includes('021_group_key_history.sql'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  up(db, '000', '021');
  for (const name of ['u1', 'u2', 'u3']) db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, 'x')").run(name, name);
  const [a, b, c] = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  // a and b have identities; c (a wrapper whose identity row is gone) has none
  db.prepare('INSERT INTO user_crypto_identities (user_id, public_jwk, fingerprint) VALUES (?, json(?), ?)').run(a, jwk('a'), hex('a'));
  db.prepare('INSERT INTO user_crypto_identities (user_id, public_jwk, fingerprint) VALUES (?, json(?), ?)').run(b, jwk('b'), hex('b'));
  const chats = [1, 2].map(() => Number(db.prepare('INSERT INTO chats DEFAULT VALUES').run().lastInsertRowid));
  const groupIds = chats.map((chatId, i) => Number(db.prepare('INSERT INTO groups (chat_id, title, created_by, key_version) VALUES (?, ?, ?, 2)').run(chatId, `g${i}`, a).lastInsertRowid));
  const env = db.prepare('INSERT INTO group_key_envelopes (group_id, version, user_id, wrapped, wrapped_by) VALUES (?, ?, ?, ?, ?)');
  env.run(groupIds[0], 1, a, 'w'.repeat(60), a); env.run(groupIds[0], 1, b, 'x'.repeat(60), a);
  env.run(groupIds[0], 2, a, 'y'.repeat(60), b); env.run(groupIds[0], 2, b, 'z'.repeat(60), b);
  env.run(groupIds[1], 1, b, 'v'.repeat(60), c);          // wrapped by a member that has no identity row now
  db.prepare("INSERT INTO messages (chat_id, sender_id, kind, encryption_version, cipher_id, nonce, ciphertext, key_version) VALUES (?, ?, 'text', 2, ?, ?, ?, 2)")
    .run(chats[0], a, '123e4567-e89b-42d3-a456-426614174000', 'A'.repeat(16), 'A'.repeat(40));
  const messagesBefore = db.prepare('SELECT * FROM messages').all();
  const groupsBefore = db.prepare('SELECT * FROM groups').all();

  db.transaction(() => db.exec(readFileSync(path.join(migrations, '021_group_key_history.sql'), 'utf8')))();

  const rows = db.prepare('SELECT group_id, version, user_id, wrapped, wrapped_by, wrapper_fingerprint, wrapper_public_jwk FROM group_key_envelopes ORDER BY group_id, version, user_id').all();
  assert.equal(rows.length, 5);
  const of = (g, v, u) => rows.find((r) => r.group_id === groupIds[g] && r.version === v && r.user_id === u);
  assert.equal(of(0, 1, b).wrapper_fingerprint, hex('a'));
  assert.deepEqual(JSON.parse(of(0, 1, b).wrapper_public_jwk), JSON.parse(jwk('a')));
  assert.equal(of(0, 1, b).wrapped, 'x'.repeat(60), 'the envelope itself is untouched');
  assert.equal(of(0, 2, a).wrapper_fingerprint, hex('b'));
  assert.equal(of(0, 2, a).wrapped_by, b);
  assert.equal(of(1, 1, b).wrapper_fingerprint, null, 'wrapper without an identity row: NULL, the client falls back to the old behaviour');
  assert.equal(of(1, 1, b).wrapper_public_jwk, null);
  assert.deepEqual(db.prepare('SELECT * FROM messages').all(), messagesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM groups').all(), groupsBefore);

  // the rebuilt table keeps its key and cascade, and the new columns are constrained as a pair
  const add = db.prepare('INSERT INTO group_key_envelopes (group_id, version, user_id, wrapped, wrapped_by, wrapper_fingerprint, wrapper_public_jwk) VALUES (?, ?, ?, ?, ?, ?, ?)');
  assert.throws(() => add.run(groupIds[0], 2, a, 'w'.repeat(60), b, hex('b'), jwk('b')), /UNIQUE/);
  assert.throws(() => add.run(groupIds[0], 3, a, 'w'.repeat(60), b, hex('b'), null), /CHECK/);
  assert.throws(() => add.run(groupIds[0], 3, a, 'w'.repeat(60), b, null, jwk('b')), /CHECK/);
  assert.throws(() => add.run(groupIds[0], 3, a, 'w'.repeat(60), b, 'XYZ', jwk('b')), /CHECK/);
  assert.throws(() => add.run(groupIds[0], 3, a, 'w'.repeat(60), b, hex('B'), jwk('b')), /CHECK/);
  add.run(groupIds[0], 3, a, 'w'.repeat(60), b, hex('b'), jwk('b'));
  add.run(groupIds[0], 4, a, 'w'.repeat(60), b, null, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'group_key_envelopes_new'").get().n, 0, 'no leftover temp table');
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'group_key_envelopes_user_idx'").get().n, 1, 'index recreated');
  db.prepare('DELETE FROM groups WHERE id = ?').run(groupIds[1]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM group_key_envelopes WHERE group_id = ?').get(groupIds[1]).n, 0, 'cascade from groups still works');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
