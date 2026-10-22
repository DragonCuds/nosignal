// Bundle the real attachment sender with a refused encryption step and a successful chunk upload.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const src = path.join(root, 'apps/web/src');
const { build } = createRequire(path.join(root, 'apps/server/package.json'))('esbuild');
const dir = await mkdtemp(path.join(tmpdir(), 'attachment-send-test-'));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = path.join(dir, 'bundle.mjs');
const mocks = {
  '../api.js': `export const api = { sendAttachment: () => { throw new Error('Unexpected send'); } };`,
  '../e2ee.js': `import { KeyChangedError } from ${JSON.stringify(path.join(src, 'e2ee.ts'))};
    export const refusal = new KeyChangedError('contact', 'old-fingerprint', 'new-fingerprint');
    export const encryptContent = async () => { throw refusal; };
    export const withFreshChatKey = async (_chatId, send) => send();`,
  '../datasaver.js': `export const reportTransfer = () => {};`,
  './progress.js': `export const localBlobs = new Map(); export const setProgress = () => {};`,
  './transfer.js': `export const uploadChunks = async () => 'done';`,
};
await build({
  stdin: {
    contents: `export { sendAttachment } from './send.ts'; export { refusal } from '../e2ee.js';`,
    resolveDir: path.join(src, 'attachments'), sourcefile: 'entry.ts', loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  plugins: [{ name: 'sender-mocks', setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => path.dirname(args.importer) === path.join(src, 'attachments') && args.path in mocks
      ? { path: args.path, namespace: 'mock' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
      contents: mocks[args.path], loader: 'js', resolveDir: src,
    }));
  } }],
});
const { sendAttachment, refusal } = await import(pathToFileURL(outfile).href);

test('sendAttachment passes the original KeyChangedError and failed draft to discard', async () => {
  const temporary = { id: 'temporary' };
  const appended = [];
  const discarded = [];
  const errors = [];
  await sendAttachment({
    chatId: 'chat', userId: 'sender', replyToId: null,
    draft: () => temporary,
    append: (message) => appended.push(message),
    settle: () => assert.fail('A refused attachment must not settle'),
    discard: (...args) => discarded.push(args),
    showError: (copy) => errors.push(copy),
  }, { kind: 'file', blob: new Blob(['attachment']), name: 'file.txt' });

  assert.equal(refusal.name, 'KeyChangedError');
  assert.deepEqual(appended, [temporary]);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0][0], temporary);
  assert.equal(discarded[0][1], refusal);
  assert.deepEqual(errors, ['ارسال فایل انجام نشد.']);
});
