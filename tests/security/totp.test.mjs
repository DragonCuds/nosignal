import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'test-secret-with-at-least-thirty-two-bytes';
process.env.TRUSTED_ORIGINS = 'http://localhost:3050';

const {
  generateRecoveryCodes,
  generateTotpSecret,
  recoveryCodeHash,
  totpForStep,
  verifyTotp
} = await import('../../apps/server/dist/totp.js');

test('TOTP accepts only the current drift window and rejects malformed codes', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(verifyTotp(secret, totpForStep(secret, step), now), step);
  assert.equal(verifyTotp(secret, totpForStep(secret, step - 1), now), step - 1);
  assert.equal(verifyTotp(secret, totpForStep(secret, step - 2), now), null);
  assert.equal(verifyTotp(secret, 'abcdef', now), null);
});

test('recovery codes are unique, formatted, and never stored as plaintext hashes', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.match(code, /^[A-F0-9]{5}(?:-[A-F0-9]{5}){3}$/);
    assert.notEqual(recoveryCodeHash(code), code);
    assert.equal(recoveryCodeHash(code), recoveryCodeHash(code.replaceAll('-', '')));
  }
});
