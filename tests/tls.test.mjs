import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';

// fastify and ws are installed in the server workspace, not at the repo root.
const serverRequire = createRequire(path.resolve(import.meta.dirname, '../apps/server/package.json'));
const Fastify = serverRequire('fastify');
const { WebSocketServer, WebSocket } = serverRequire('ws');

const { ensureLocalCertificate, startServer } = await import('../apps/server/dist/tls.js');

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tel-tls-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const get = (url, ca) => new Promise((resolve, reject) => {
  https.get(url, { ca }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

const makeApp = () => {
  const app = Fastify();
  app.get('/api/health', async () => ({ ok: true }));
  const wss = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.send('hello')));
  return app;
};

let nextPort = 4110;

test('ensureLocalCertificate: EC P-256 CA + server cert with SAN, verifies, keys are 0600', () => {
  const dataDir = tmp();
  const { files, issued, newCa } = ensureLocalCertificate(dataDir, ['example.test', '192.0.2.7', '::1']);
  assert.ok(issued && newCa);
  const out = execFileSync('openssl', ['verify', '-CAfile', files.caCrt, files.crt]).toString();
  assert.match(out, /OK/);
  const cert = new X509Certificate(readFileSync(files.crt));
  assert.equal(cert.publicKey.asymmetricKeyType, 'ec');
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.match(cert.subjectAltName, /DNS:example\.test/);
  assert.match(cert.subjectAltName, /IP Address:192\.0\.2\.7/);
  assert.equal(cert.ca, false);
  assert.ok(new X509Certificate(readFileSync(files.caCrt)).ca);
  assert.equal(statSync(files.key).mode & 0o777, 0o600);
  assert.equal(statSync(files.caKey).mode & 0o777, 0o600);
});

test('second call keeps the cert; changed hosts or near-expiry reissue it (CA stays)', () => {
  const dataDir = tmp();
  const first = ensureLocalCertificate(dataDir, ['localhost']);
  const serial = new X509Certificate(readFileSync(first.files.crt)).serialNumber;
  const caBefore = readFileSync(first.files.caCrt, 'utf8');

  const again = ensureLocalCertificate(dataDir, ['localhost']);
  assert.equal(again.issued, false);
  assert.equal(new X509Certificate(readFileSync(first.files.crt)).serialNumber, serial);

  const moreHosts = ensureLocalCertificate(dataDir, ['localhost', '10.1.2.3']);
  assert.ok(moreHosts.issued && !moreHosts.newCa);
  assert.match(new X509Certificate(readFileSync(first.files.crt)).subjectAltName, /10\.1\.2\.3/);

  // 10-day cert with the 30-day renewal window: must renew immediately.
  const short = ensureLocalCertificate(dataDir, ['localhost', '10.1.2.3'], { serverCertDays: 10, force: true });
  assert.ok(short.issued);
  const renewed = ensureLocalCertificate(dataDir, ['localhost', '10.1.2.3'], { renewBeforeDays: 30 });
  assert.ok(renewed.issued, 'cert with <30 days left is renewed');
  assert.equal(readFileSync(first.files.caCrt, 'utf8'), caBefore);
  const left = (Date.parse(new X509Certificate(readFileSync(first.files.crt)).validTo) - Date.now()) / 86_400_000;
  assert.ok(left > 300);
});

test('rejects hostile host names (no option/config injection)', () => {
  assert.throws(() => ensureLocalCertificate(tmp(), ['a.test,IP:1.1.1.1\nbasicConstraints=CA:TRUE']), /Invalid TLS host/);
});

test('auto mode serves HTTPS, /ca.crt, /ca-help, websocket; trusts only its own CA', async () => {
  const dataDir = tmp();
  const port = nextPort++;
  const app = makeApp();
  const server = await startServer(app, { host: '127.0.0.1', port, dataDir, mode: 'auto', hosts: ['localhost', '127.0.0.1'] });
  try {
    assert.equal(server.secure, true);
    assert.equal(server.url, `https://127.0.0.1:${port}`);
    const ca = readFileSync(server.caCertPath);

    const health = await get(`${server.url}/api/health`, ca);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    await assert.rejects(get(`${server.url}/api/health`), /self-signed|unable to verify|certificate/i);

    const caRes = await get(`${server.url}/ca.crt`, ca);
    assert.equal(caRes.status, 200);
    assert.match(caRes.headers['content-type'], /x-x509-ca-cert/);
    assert.deepEqual(caRes.body, ca);
    assert.doesNotMatch(caRes.body.toString(), /PRIVATE KEY/);

    const help = await get(`${server.url}/ca-help`, ca);
    assert.equal(help.status, 200);
    assert.match(help.body.toString(), /dir="rtl"/);
    assert.match(help.body.toString(), /اندروید/);
    assert.match(help.body.toString(), /آیفون/);
    assert.doesNotMatch(help.body.toString(), /https?:\/\/(?!127)/);

    const message = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ca });
      ws.once('message', (m) => { ws.close(); resolve(m.toString()); });
      ws.once('error', reject);
    });
    assert.equal(message, 'hello');

    // Renewal swaps the cert on the live server without a restart.
    const serialBefore = new X509Certificate(readFileSync(path.join(dataDir, 'tls/server.crt'))).serialNumber;
    assert.equal(await server.renewNow(), false);
    assert.equal(await server.renewNow(true), true);
    const serialAfter = new X509Certificate(readFileSync(path.join(dataDir, 'tls/server.crt'))).serialNumber;
    assert.notEqual(serialBefore, serialAfter);
    assert.equal((await get(`${server.url}/api/health`, ca)).status, 200);
  } finally {
    await server.close();
  }
});

test('files mode uses the given cert; off mode is plain HTTP without /ca.crt', async () => {
  const dataDir = tmp();
  const { files } = ensureLocalCertificate(dataDir, ['localhost', '127.0.0.1']);
  const port = nextPort++;
  const filesServer = await startServer(makeApp(), {
    host: '127.0.0.1', port, dataDir: tmp(), mode: 'files', certFile: files.crt, keyFile: files.key
  });
  try {
    const res = await get(`${filesServer.url}/api/health`, readFileSync(files.caCrt));
    assert.equal(res.status, 200);
    assert.equal(filesServer.caCertPath, null);
    assert.equal((await get(`${filesServer.url}/ca.crt`, readFileSync(files.caCrt))).status, 404);
  } finally {
    await filesServer.close();
  }

  const offPort = nextPort++;
  const off = await startServer(makeApp(), { host: '127.0.0.1', port: offPort, dataDir: tmp(), mode: 'off' });
  try {
    assert.equal(off.secure, false);
    assert.equal(off.url, `http://127.0.0.1:${offPort}`);
    assert.equal((await fetch(`${off.url}/api/health`)).status, 200);
    assert.equal((await fetch(`${off.url}/ca.crt`)).status, 404);
  } finally {
    await off.close();
  }
});
