import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { generateBackupablePair, encryptBackup, decryptBackup, toExtractable } from '../../apps/web/src/backup/crypto.ts';

const { parseEncryptedMessageV2 } = await import('../../apps/server/dist/encrypted-message.js');

const valid = {
  version: 2,
  cipherId: '123e4567-e89b-42d3-a456-426614174000',
  nonce: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAA'
};

test('version 2 message envelopes require a bound UUID and 96-bit nonce', () => {
  assert.deepEqual(parseEncryptedMessageV2(valid), valid);
  assert.equal(parseEncryptedMessageV2({ ...valid, version: 1 }), null);
  assert.equal(parseEncryptedMessageV2({ ...valid, cipherId: '123e4567-e89b-12d3-a456-426614174000' }), null);
  assert.equal(parseEncryptedMessageV2({ ...valid, nonce: 'AAAAAAAAAAAAAAA' }), null);
  assert.equal(parseEncryptedMessageV2({ ...valid, nonce: 'AAAAAAAAAAAAAAAA=' }), null);
});

test('version 2 message envelopes reject empty-tag, malformed and oversized ciphertext', () => {
  assert.equal(parseEncryptedMessageV2({ ...valid, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA' }), null);
  assert.equal(parseEncryptedMessageV2({ ...valid, ciphertext: 'not+base64url' }), null);
  assert.equal(parseEncryptedMessageV2({ ...valid, ciphertext: 'A'.repeat(21_847) }), null);
});

const KEY_NOTE = 'The identity private key is stored extractable on purpose (backup must export it). '
  + 'If you change this, you must also update SECURITY.md ("Key storage"), docs/fa/security.md and the backup path '
  + '(automatic server backup, recovery key, .telkey file, restore).';

test('identity private key is extractable when freshly created and when restored from a backup', async () => {
  // e2ee.ts runs in a browser (IndexedDB, fetch) and cannot be imported in Node, so this exercises the same
  // crypto.ts functions it calls (generateBackupablePair -> toExtractable) and the source test below pins the wiring.
  const pair = await generateBackupablePair();
  const fresh = await toExtractable(pair.privateJwk);
  assert.equal(fresh.extractable, true, KEY_NOTE);
  assert.deepEqual((await crypto.subtle.exportKey('jwk', fresh)).d, pair.privateJwk.d, KEY_NOTE);

  const payload = { userId: '7', publicKey: pair.publicJwk, privateKey: pair.privateJwk, groupKeys: {} };
  const restoredPayload = await decryptBackup(await encryptBackup(payload, 'correct horse battery', 100_000), 'correct horse battery');
  const restored = await toExtractable(restoredPayload.privateKey);
  assert.equal(restored.extractable, true, KEY_NOTE);
  assert.equal((await crypto.subtle.exportKey('jwk', restored)).d, pair.privateJwk.d, KEY_NOTE);
});

test('e2ee.ts stores new and restored identity keys through toExtractable only', () => {
  const source = readFileSync(new URL('../../apps/web/src/e2ee.ts', import.meta.url), 'utf8');
  assert.ok(!/toNonExtractable/u.test(source), KEY_NOTE);
  // create (initializeIdentity), start fresh (resetIdentity) and restore (importIdentity)
  assert.equal(source.match(/privateKey: await toExtractable\(/gu)?.length, 3, KEY_NOTE);
});
