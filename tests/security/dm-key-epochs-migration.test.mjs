// NS-07: migration 019 on a database that already holds 001-018 data (real chat key envelopes, messages, groups).
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

test('019 rebuilds chat_key_envelopes: rows kept as version 1, sender key copied from the current identity, NULL when none, version rows created', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  up(db, '000', '019');
  for (const name of ['u1', 'u2', 'u3']) db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, 'x')").run(name, name);
  const ids = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  const [a, b, c] = ids;
  // a and b have identities; c (a sender whose identity row is gone) has none
  db.prepare('INSERT INTO user_crypto_identities (user_id, public_jwk, fingerprint) VALUES (?, json(?), ?)').run(a, jwk('a'), hex('a'));
  db.prepare('INSERT INTO user_crypto_identities (user_id, public_jwk, fingerprint) VALUES (?, json(?), ?)').run(b, jwk('b'), hex('b'));
  const chat = (...members) => {
    const id = db.prepare('INSERT INTO chats DEFAULT VALUES').run().lastInsertRowid;
    for (const m of members) db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(id, m);
    return Number(id);
  };
  const ab = chat(a, b); const bc = chat(b, c); const lone = chat(a); const empty = chat(a, c);
  const env = db.prepare("INSERT INTO chat_key_envelopes (chat_id, recipient_id, sender_id, version, nonce, ciphertext) VALUES (?, ?, ?, 1, ?, ?)");
  env.run(ab, a, a, 'n'.repeat(16), 'c'.repeat(60)); env.run(ab, b, a, 'm'.repeat(16), 'd'.repeat(60));
  env.run(bc, b, c, 'n'.repeat(16), 'c'.repeat(60)); env.run(bc, c, c, 'm'.repeat(16), 'd'.repeat(60));
  env.run(lone, a, a, 'n'.repeat(16), 'e'.repeat(60));
  // an existing message of a direct chat (no key_version) must survive untouched
  db.prepare("INSERT INTO messages (chat_id, sender_id, kind, encryption_version, cipher_id, nonce, ciphertext) VALUES (?, ?, 'text', 2, ?, ?, ?)")
    .run(ab, a, '123e4567-e89b-42d3-a456-426614174000', 'A'.repeat(16), 'A'.repeat(40));
  const before = db.prepare('SELECT * FROM messages').all();

  db.transaction(() => db.exec(readFileSync(path.join(migrations, '019_dm_key_epochs.sql'), 'utf8')))();

  const rows = db.prepare('SELECT chat_id, version, recipient_id, sender_id, sender_fingerprint, sender_public_jwk, nonce, ciphertext FROM chat_key_envelopes ORDER BY chat_id, recipient_id').all();
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.version === 1));
  const of = (chatId, recipient) => rows.find((r) => r.chat_id === chatId && r.recipient_id === recipient);
  assert.equal(of(ab, b).sender_fingerprint, hex('a'));
  assert.deepEqual(JSON.parse(of(ab, b).sender_public_jwk), JSON.parse(jwk('a')));
  assert.equal(of(ab, b).nonce, 'm'.repeat(16));
  assert.equal(of(ab, b).ciphertext, 'd'.repeat(60));
  assert.equal(of(bc, b).sender_fingerprint, null, 'sender without an identity row: NULL, the client falls back to the old behaviour');
  assert.equal(of(bc, b).sender_public_jwk, null);
  assert.equal(of(lone, a).sender_fingerprint, hex('a'));
  const versions = db.prepare('SELECT chat_id, key_version, pending_version FROM direct_chat_keys ORDER BY chat_id').all();
  assert.deepEqual(versions, [ab, bc, lone].map((id) => ({ chat_id: id, key_version: 1, pending_version: null })));
  assert.equal(db.prepare('SELECT 1 FROM direct_chat_keys WHERE chat_id = ?').get(empty), undefined, 'a chat without envelopes gets no row');
  assert.deepEqual(db.prepare('SELECT * FROM messages').all(), before, 'messages are not rewritten');
  assert.equal(db.prepare('SELECT key_version FROM messages').get().key_version, null);

  // the rebuilt table: several versions per recipient, but one row per (chat, version, recipient); sender columns come as a pair
  const add = db.prepare('INSERT INTO chat_key_envelopes (chat_id, version, recipient_id, sender_id, sender_fingerprint, sender_public_jwk, nonce, ciphertext) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run(ab, 2, b, b, hex('b'), jwk('b'), 'n'.repeat(16), 'c'.repeat(60));
  assert.throws(() => add.run(ab, 2, b, b, hex('b'), jwk('b'), 'n'.repeat(16), 'c'.repeat(60)), /UNIQUE/);
  assert.throws(() => add.run(ab, 3, b, b, hex('b'), null, 'n'.repeat(16), 'c'.repeat(60)), /CHECK/);
  assert.throws(() => add.run(ab, 0, b, b, null, null, 'n'.repeat(16), 'c'.repeat(60)), /CHECK/);
  assert.throws(() => add.run(ab, 3, b, b, 'XYZ', jwk('b'), 'n'.repeat(16), 'c'.repeat(60)), /CHECK/);
  assert.throws(() => db.prepare('INSERT INTO direct_chat_keys (chat_id, key_version, pending_version) VALUES (?, 2, 2)').run(empty), /CHECK/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('chat_key_envelopes_new')").get().n, 0, 'no leftover temp table');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
