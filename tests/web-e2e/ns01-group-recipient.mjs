// Run directly: node tests/web-e2e/ns01-group-recipient.mjs
// Browser regression for NS-01. Network responses are mocked; no live service or database is touched.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = (await build({ entryPoints: [path.join(root, 'apps/web/src/e2ee.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'E2EE', write: false })).outputFiles[0].text;
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>NS-01 test</title>'); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    window.puts = [];
    window.detail = null;
    window.selfKey = null;
    window.fetch = async (input, options = {}) => {
      const url = String(input);
      if (url === '/api/crypto/identity') {
        window.selfKey = JSON.parse(options.body).publicKey;
        return new Response(JSON.stringify({ fingerprint: 'registered', backupSaved: false }), { status: 200 });
      }
      if (url === '/api/groups/55') return new Response(JSON.stringify(window.detail), { status: 200 });
      if (url.startsWith('/api/groups/55/keys?')) return new Response('[]', { status: 200 });
      if (url === '/api/groups/55/keys' && options.method === 'PUT') {
        window.puts.push(JSON.parse(options.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
  });
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(async () => {
    const makeKey = async () => crypto.subtle.exportKey('jwk', (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])).publicKey);
    const fp = async (key) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`P-256:${key.x}:${key.y}`)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const member = async (id, key) => ({ id, username: id, displayName: id, role: id === '1' ? 'owner' : 'member', publicKey: key, fingerprint: await fp(key) });
    await E2EE.initializeEncryption('1');
    const bob = await makeKey(); const carol = await makeKey(); const evil = await makeKey(); const dave = await makeKey();
    const original = [await member('1', window.selfKey), await member('2', bob), await member('3', carol)];
    window.detail = { id: '55', chatId: '77', title: 'test', avatarPath: null, role: 'owner', memberCount: 3, membershipRevision: 0, keyVersion: 0, pendingKeyVersion: 1, members: original };
    E2EE.registerGroupChat('77', '55');
    await E2EE.ensureGroupKeyed('77', '55');
    const first = window.puts.length === 1 && window.puts[0].envelopes.length === 3 && window.puts[0].membershipRevision === 0;
    window.detail = { ...window.detail, keyVersion: 1, pendingKeyVersion: 2, membershipRevision: 1, members: [original[0], original[1], await member('3', evil)] };
    const blocked = async (operation, memberId) => {
      try { await operation(); return false; } catch (error) { return error instanceof E2EE.KeyChangedError && error.memberId === memberId; }
    };
    const autoBlocked = await blocked(() => E2EE.ensureGroupKeyed('77', '55'), '3');
    const manualBlocked = await blocked(() => E2EE.rotateGroupKey('77', '55'), '3');
    const noPartialUpload = window.puts.length === 1;
    window.detail = { ...window.detail, memberCount: 4, membershipRevision: 2, members: [...original, await member('4', dave)] };
    await E2EE.ensureGroupKeyed('77', '55');
    const newMemberTofu = window.puts.length === 2 && window.puts[1].envelopes.length === 4;
    window.detail = { ...window.detail, keyVersion: 2, pendingKeyVersion: 3, membershipRevision: 3, members: [...original, await member('4', evil)] };
    const cachedChangeBlocked = await blocked(() => E2EE.ensureGroupKeyed('77', '55'), '4');
    return { first, autoBlocked, manualBlocked, noPartialUpload, newMemberTofu, cachedChangeBlocked, putCount: window.puts.length };
  });
  for (const [name, passed] of Object.entries(result)) if (name !== 'putCount') assert.equal(passed, true, `${name}: ${JSON.stringify(result)}`);
  assert.equal(result.putCount, 2);
  console.log('PASS NS-01 browser: TOFU, manual/background changed-key block, cached context, no partial upload');
} finally {
  await browser?.close();
  server.close();
}
