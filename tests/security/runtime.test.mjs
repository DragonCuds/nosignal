import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const host = '127.0.0.1';
let port;
let child;
let dataDir;

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch(`http://${host}:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become ready within 15 seconds');
}

async function websocketStatus(origin) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port,
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...(origin ? { Origin: origin } : {})
      }
    });
    request.once('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('upgrade', () => reject(new Error('untrusted WebSocket unexpectedly upgraded')));
    request.once('error', reject);
    request.end();
  });
}

before(async () => {
  port = await unusedPort();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-security-test-'));
  child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      TRUSTED_ORIGINS: 'https://messenger.example',
      DATA_DIR: dataDir,
      SESSION_SECRET: 'security-test-only-secret-with-at-least-32-bytes'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', () => {
    if (child.exitCode && stderr) process.stderr.write(stderr);
  });
  await waitUntilReady();
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('production responses enforce browser security policy', async () => {
  const response = await fetch(`http://${host}:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /unsafe-eval/);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('state-changing API requests require an exact trusted Origin', async () => {
  for (const origin of [undefined, 'https://attacker.example', 'https://messenger.example.attacker.test']) {
    const response = await fetch(`http://${host}:${port}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {})
      },
      body: '{}'
    });
    assert.equal(response.status, 403);
  }

  const trusted = await fetch(`http://${host}:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://messenger.example' },
    body: '{}'
  });
  assert.equal(trusted.status, 400);
});

test('WebSocket upgrades reject missing and untrusted origins', async () => {
  assert.equal(await websocketStatus(), 403);
  assert.equal(await websocketStatus('https://attacker.example'), 403);
});

test('production JavaScript contains no dynamic-code evaluation', async () => {
  const assets = path.join(root, 'apps/web/dist/assets');
  for (const entry of (await readdir(assets)).filter((name) => name.endsWith('.js'))) {
    const source = await readFile(path.join(assets, entry), 'utf8');
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(/, `${entry} uses dynamic code evaluation`);
  }
});
