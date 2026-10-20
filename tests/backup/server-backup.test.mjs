import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBackupablePair, wrapForServer, unwrapFromServer, toRecoveryKey, fromRecoveryKey, toExtractable } from '../../apps/web/src/backup/crypto.ts';

const mk = async (userId = '7') => {
  const { privateJwk, publicJwk } = await generateBackupablePair();
  return { userId, publicKey: publicJwk, privateKey: privateJwk };
};

test('server wrap roundtrip, nothing readable in the blob, meets the server size/shape limits', async () => {
  const p = await mk();
  const blob = await wrapForServer(p, 'login-password', 100_000);
  assert.ok(!JSON.stringify(blob).includes(p.privateKey.d));
  assert.match(blob.wrapped, /^[A-Za-z0-9_-]{40,4096}$/);
  assert.match(blob.salt, /^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(await unwrapFromServer(blob, 'login-password', '7'), p);
});

test('wrong password and wrong user are rejected', async () => {
  const p = await mk();
  const blob = await wrapForServer(p, 'login-password', 100_000);
  await assert.rejects(unwrapFromServer(blob, 'other-password', '7'), /bad-passphrase/);
  await assert.rejects(unwrapFromServer(blob, 'login-password', '8'), /bad-passphrase/);
  await assert.rejects(unwrapFromServer({ ...blob, iterations: 10 }, 'login-password', '7'), /bad-file/);
});

test('default cost is at least 600k iterations (server minimum)', async () => {
  const blob = await wrapForServer(await mk(), 'login-password');
  assert.ok(blob.iterations >= 600_000);
});

test('recovery key roundtrip, tolerant of whitespace; garbage rejected', async () => {
  const p = await mk();
  const key = toRecoveryKey(p);
  assert.ok(key.startsWith('TELKEY1-'));
  const back = fromRecoveryKey(`  ${key.replace(/ /g, '\n ')}  `, '7');
  assert.equal(back.privateKey.d, p.privateKey.d);
  assert.equal(back.publicKey.x, p.publicKey.x);
  assert.throws(() => fromRecoveryKey('nonsense', '7'), /bad-file/);
  assert.throws(() => fromRecoveryKey('TELKEY1-@@@@', '7'), /bad-file/);
});

test('toExtractable keeps the key exportable', async () => {
  const p = await mk();
  const key = await toExtractable(p.privateKey);
  assert.equal(key.extractable, true);
  assert.equal((await crypto.subtle.exportKey('jwk', key)).d, p.privateKey.d);
});
