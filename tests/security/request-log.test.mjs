import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { Writable } from 'node:stream';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const requireServer = createRequire(path.join(root, 'apps/server/package.json'));
const Fastify = requireServer('fastify');
const { safeRequestPath, safeLoggerOptions } = await import(path.join(dist, 'requestLog.js'));

test('request logger omits invite tokens and query values but keeps routes and status', async () => {
  const lines = [];
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
  const app = Fastify({ logger: { ...safeLoggerOptions, stream } });
  app.get('/join/*', async () => ({ ok: true }));
  app.get('/c/*', async () => ({ ok: true }));
  app.get('/api/invites/:token', async () => ({ ok: true }));
  app.post('/api/invites/:token/accept', async () => ({ ok: true }));
  app.get('/api/channels/join/:token', async () => ({ ok: true }));
  app.post('/api/channels/join/:token', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/invites/:token/error', async (request) => {
    throw new Error(`failed at ${request.url}`);
  });

  const token = 'NS08_UNIQUE_INVITE_MARKER_0123456789';
  try {
    for (const [method, url] of [
      ['GET', `/join/${token}?source=${token}`],
      ['GET', `/join/${token}/${token}?source=${token}`],
      ['GET', `/c/${token}?source=${token}`],
      ['GET', `/api/invites/${token}?source=${token}`],
      ['POST', `/api/invites/${token}/accept?source=${token}`],
      ['GET', `/api/channels/join/${token}?source=${token}`],
      ['POST', `/api/channels/join/${token}?source=${token}`],
      ['GET', `/api/health?source=${token}`]
    ]) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 200);
    }
    assert.equal((await app.inject({ method: 'GET', url: `/api/invites/${token}/error` })).statusCode, 500);
  } finally {
    await app.close();
  }

  const log = lines.join('');
  assert.doesNotMatch(log, /NS08_UNIQUE_INVITE_MARKER_0123456789/);
  assert.match(log, /"url":"\/api\/invites\/\[redacted\]\/accept"/);
  assert.match(log, /"url":"\/api\/channels\/join\/\[redacted\]"/);
  assert.match(log, /"url":"\/api\/health"/);
  assert.match(log, /"statusCode":200/);
});

test('malformed URL is not logged verbatim', () => {
  assert.equal(safeRequestPath('http://[invalid/NS08_UNIQUE_INVITE_MARKER'), '[invalid-url]');
  assert.equal(safeRequestPath('/api/invites/secret/accept/secret'), '/api/invites/[redacted]/accept');
});
