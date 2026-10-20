import assert from 'node:assert/strict';
import { test } from 'node:test';

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
