import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup, generateBackupablePair, toNonExtractable } from '../../apps/web/src/backup/crypto.ts';

const mk = async () => {
  const { privateJwk, publicJwk } = await generateBackupablePair();
  return { userId: '7', publicKey: publicJwk, privateKey: privateJwk, groupKeys: { c1: 'abc' } };
};
test('roundtrip', async () => {
  const p = await mk();
  const file = await encryptBackup(p, 'correct horse battery', 100_000);
  assert.ok(!file.includes(p.privateKey.d));
  assert.deepEqual(await decryptBackup(file, 'correct horse battery'), p);
});
test('wrong passphrase / tamper / garbage', async () => {
  const p = await mk();
  const file = await encryptBackup(p, 'correct horse battery', 100_000);
  await assert.rejects(decryptBackup(file, 'wrong passphrase!!'), /bad-passphrase/);
  const f = JSON.parse(file); f.iter = 100_001;
  await assert.rejects(decryptBackup(JSON.stringify(f), 'correct horse battery'), /bad-passphrase/);
  await assert.rejects(decryptBackup('nope', 'x'), /bad-file/);
  await assert.rejects(encryptBackup(p, 'short'), /حداقل/);
});
test('imported key is non-extractable and matches public key', async () => {
  const p = await mk();
  const k = await toNonExtractable(p.privateKey);
  assert.equal(k.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', k));
  const pub = await crypto.subtle.importKey('jwk', p.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const other = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const a = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, other.privateKey, 256);
  const otherPub = await crypto.subtle.importKey('jwk', await crypto.subtle.exportKey('jwk', other.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const b = await crypto.subtle.deriveBits({ name: 'ECDH', public: otherPub }, k, 256);
  assert.deepEqual(new Uint8Array(a), new Uint8Array(b));
});
