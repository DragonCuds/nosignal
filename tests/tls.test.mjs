import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';

// fastify and ws are installed in the server workspace, not at the repo root.
const serverRequire = createRequire(path.resolve(import.meta.dirname, '../apps/server/package.json'));
const Fastify = serverRequire('fastify');
const { WebSocketServer, WebSocket } = serverRequire('ws');

const { ensureLocalCertificate, regenerateLocalCa, startServer } = await import('../apps/server/dist/tls.js');

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

const signLeaf = (files, san) => {
  const dir = tmp();
  const key = path.join(dir, 'leaf.key');
  const csr = path.join(dir, 'leaf.csr');
  const ext = path.join(dir, 'leaf.cnf');
  const crt = path.join(dir, 'leaf.crt');
  writeFileSync(ext, `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  execFileSync('openssl', ['req', '-new', '-key', key, '-subj', '/CN=Test leaf', '-out', csr]);
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', files.caCrt, '-CAkey', files.caKey,
    '-CAcreateserial', '-CAserial', path.join(dir, 'serial'), '-days', '5', '-extfile', ext, '-out', crt], { stdio: 'ignore' });
  return crt;
};

const verifyLeaf = (files, crt) => execFileSync('openssl',
  ['verify', '-purpose', 'sslserver', '-CAfile', files.caCrt, crt], { stdio: 'pipe' }).toString();

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

test('renew and regenerate keep certificates at 0644 and keys at 0600 under a permissive umask', () => {
  const previous = process.umask(0o002);
  try {
    const dataDir = tmp();
    ensureLocalCertificate(dataDir, ['example.test']);
    const renewed = ensureLocalCertificate(dataDir, ['example.test'], { force: true });
    assert.equal(renewed.issued, true);
    assert.equal(renewed.newCa, false);
    assert.equal(statSync(renewed.files.crt).mode & 0o777, 0o644);
    assert.equal(statSync(renewed.files.caCrt).mode & 0o777, 0o644);
    assert.equal(statSync(renewed.files.key).mode & 0o777, 0o600);
    assert.equal(statSync(renewed.files.caKey).mode & 0o777, 0o600);

    const regenerated = regenerateLocalCa(dataDir, ['example.test']);
    assert.equal(statSync(regenerated.files.crt).mode & 0o777, 0o644);
    assert.equal(statSync(regenerated.files.caCrt).mode & 0o777, 0o644);
    assert.equal(statSync(regenerated.files.key).mode & 0o777, 0o600);
    assert.equal(statSync(regenerated.files.caKey).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
  }
});

test('second call keeps the cert; changed hosts require planned CA replacement; leaf renewal keeps CA', () => {
  const dataDir = tmp();
  const first = ensureLocalCertificate(dataDir, ['localhost']);
  const serial = new X509Certificate(readFileSync(first.files.crt)).serialNumber;
  const caBefore = readFileSync(first.files.caCrt, 'utf8');

  const again = ensureLocalCertificate(dataDir, ['localhost']);
  assert.equal(again.issued, false);
  assert.equal(new X509Certificate(readFileSync(first.files.crt)).serialNumber, serial);

  assert.throws(() => ensureLocalCertificate(dataDir, ['localhost', '10.1.2.3']), /planned replacement/);
  assert.equal(readFileSync(first.files.caCrt, 'utf8'), caBefore);
  regenerateLocalCa(dataDir, ['localhost', '10.1.2.3']);
  assert.match(new X509Certificate(readFileSync(first.files.crt)).subjectAltName, /10\.1\.2\.3/);
  const caBefore2 = readFileSync(first.files.caCrt, 'utf8');

  // 10-day cert with the 30-day renewal window: must renew immediately.
  const short = ensureLocalCertificate(dataDir, ['localhost', '10.1.2.3'], { serverCertDays: 10, force: true });
  assert.ok(short.issued);
  const renewed = ensureLocalCertificate(dataDir, ['localhost', '10.1.2.3'], { renewBeforeDays: 30 });
  assert.ok(renewed.issued, 'cert with <30 days left is renewed');
  assert.notEqual(caBefore2, caBefore);
  assert.equal(readFileSync(first.files.caCrt, 'utf8'), caBefore2);
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

test('new CA is name-constrained (critical): leaf validates for its hosts, a leaf for another domain does not', async () => {
  const dataDir = tmp();
  const { files } = ensureLocalCertificate(dataDir, ['example.test', '192.0.2.7', '::1']);
  const caText = execFileSync('openssl', ['x509', '-in', files.caCrt, '-noout', '-text']).toString();
  assert.match(caText, /X509v3 Name Constraints: critical/);
  assert.match(caText, /DNS:example\.test/);
  assert.match(caText, /IP:192\.0\.2\.7\/255\.255\.255\.255/);
  assert.match(execFileSync('openssl', ['verify', '-CAfile', files.caCrt, files.crt]).toString(), /OK/);
  for (const [purpose, name] of [['-verify_hostname', 'example.test'], ['-verify_ip', '192.0.2.7'], ['-verify_ip', '::1']]) {
    assert.match(execFileSync('openssl', ['verify', '-CAfile', files.caCrt, '-purpose', 'sslserver', purpose, name, files.crt]).toString(), /OK/, `${purpose} ${name}`);
  }
  // Someone with the CA key mints a cert for google.com and for a foreign IP: both must fail.
  const tmpDir = tmp();
  for (const san of ['DNS:google.com', 'IP:8.8.8.8']) {
    const key = path.join(tmpDir, 'k.pem'); const csr = path.join(tmpDir, 'c.csr'); const ext = path.join(tmpDir, 'e.cnf'); const crt = path.join(tmpDir, 'x.crt');
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    execFileSync('openssl', ['req', '-new', '-key', key, '-subj', '/CN=evil', '-out', csr]);
    execFileSync('sh', ['-c', `printf 'subjectAltName=${san}\\nextendedKeyUsage=serverAuth\\n' > ${ext}`]);
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', files.caCrt, '-CAkey', files.caKey, '-CAcreateserial', '-CAserial', path.join(tmpDir, 's.srl'), '-days', '5', '-extfile', ext, '-out', crt], { stdio: 'ignore' });
    assert.throws(() => execFileSync('openssl', ['verify', '-CAfile', files.caCrt, crt], { stdio: 'pipe' }), /permitted subtree violation|verification failed/i, san);
  }
});

test('CA constraints reject absent name types, DNS children and mixed SANs', () => {
  for (const [hosts, accepted, rejected] of [
    [['192.0.2.7'], ['IP:192.0.2.7'], ['DNS:other.test', 'IP:8.8.8.8', 'IP:192.0.2.7,DNS:other.test']],
    [['example.test'], ['DNS:example.test'], ['DNS:child.example.test', 'IP:8.8.8.8', 'IP:::1', 'DNS:example.test,IP:8.8.8.8']],
    [['example.test', '192.0.2.7'], ['DNS:example.test', 'IP:192.0.2.7'], ['DNS:child.example.test', 'DNS:other.test', 'IP:8.8.8.8', 'IP:::1', 'DNS:example.test,IP:8.8.8.8']]
  ]) {
    const { files } = ensureLocalCertificate(tmp(), hosts);
    for (const san of accepted) assert.match(verifyLeaf(files, signLeaf(files, san)), /OK/, `${hosts}: ${san}`);
    for (const san of rejected) {
      assert.throws(() => verifyLeaf(files, signLeaf(files, san)),
        /excluded subtree violation|permitted subtree violation|verification failed/i, `${hosts}: ${san}`);
    }
  }
});

test('overlapping DNS names fail before replacing a CA', () => {
  const dataDir = tmp();
  const first = ensureLocalCertificate(dataDir, ['example.test']);
  const oldCa = readFileSync(first.files.caCrt);
  const oldKey = readFileSync(first.files.caKey);
  assert.throws(() => regenerateLocalCa(dataDir, ['example.test', 'child.example.test']), /cannot contain both/);
  assert.deepEqual(readFileSync(first.files.caCrt), oldCa);
  assert.deepEqual(readFileSync(first.files.caKey), oldKey);
});

test('an offline CA key is unnecessary for serving a fresh leaf and fails closed on renewal', () => {
  const dataDir = tmp();
  const first = ensureLocalCertificate(dataDir, ['192.0.2.7']);
  const oldCa = readFileSync(first.files.caCrt);
  const oldLeaf = readFileSync(first.files.crt);
  const owner = statSync(first.files.key);
  const offlineKey = path.join(tmp(), 'ca.key');
  renameSync(first.files.caKey, offlineKey);
  assert.equal(ensureLocalCertificate(dataDir, ['192.0.2.7']).newCa, false);
  assert.throws(() => ensureLocalCertificate(dataDir, ['192.0.2.7'], { force: true }), /CA key is offline/);
  assert.deepEqual(readFileSync(first.files.caCrt), oldCa);
  assert.deepEqual(readFileSync(first.files.crt), oldLeaf);
  renameSync(offlineKey, first.files.caKey);
  assert.match(execFileSync(process.execPath, ['scripts/renew-local-cert.mjs', '--data-dir', dataDir,
    '--hosts', '192.0.2.7']).toString(), /Server certificate renewed/);
  assert.notDeepEqual(readFileSync(first.files.crt), oldLeaf);
  assert.deepEqual(readFileSync(first.files.caCrt), oldCa);
  assert.equal(statSync(first.files.key).uid, owner.uid);
  assert.equal(statSync(first.files.key).gid, owner.gid);
});

test('Node https validates the constrained CA for DNS and IP hosts, serves no CA key', async () => {
  const dataDir = tmp();
  const port = nextPort++;
  const server = await startServer(makeApp(), { host: '127.0.0.1', port, dataDir, mode: 'auto', hosts: ['localhost', '127.0.0.1', '::1'] });
  try {
    const ca = readFileSync(path.join(dataDir, 'tls/ca.crt'));
    assert.equal((await get(`https://127.0.0.1:${port}/api/health`, ca)).status, 200);
    assert.equal((await get(`https://localhost:${port}/api/health`, ca)).status, 200);
    for (const p of ['/ca.key', '/tls/ca.key', '/data/tls/ca.key', '/../tls/ca.key', '/ca.crt/../ca.key']) {
      const res = await get(`https://127.0.0.1:${port}${p}`, ca);
      assert.ok(!res.body.toString().includes('PRIVATE KEY'), p);
      assert.notEqual(res.status, 200, p);
    }
    assert.equal(statSync(path.join(dataDir, 'tls/ca.key')).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(dataDir, 'tls')).mode & 0o777, 0o700);
  } finally {
    await server.close();
  }
});

test('legacy CA without constraints is never replaced automatically; regenerateLocalCa is the opt-in', () => {
  const dataDir = tmp();
  const dir = path.join(dataDir, 'tls');
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'ca.key'); const crt = path.join(dir, 'ca.crt');
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  execFileSync('openssl', ['req', '-x509', '-new', '-key', key, '-sha256', '-days', '3650', '-subj', '/CN=Legacy', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', crt]);
  const legacy = readFileSync(crt, 'utf8');
  const first = ensureLocalCertificate(dataDir, ['example.test']);
  assert.equal(first.newCa, false);
  const more = ensureLocalCertificate(dataDir, ['example.test', '10.9.9.9']);
  assert.equal(more.newCa, false);
  assert.equal(readFileSync(crt, 'utf8'), legacy);
  assert.match(execFileSync('openssl', ['verify', '-CAfile', crt, first.files.crt]).toString(), /OK/);

  const out = regenerateLocalCa(dataDir, ['example.test', '10.9.9.9']);
  assert.ok(out.backupDir && existsSync(path.join(out.backupDir, 'ca.key')));
  assert.equal(readFileSync(path.join(out.backupDir, 'ca.crt'), 'utf8'), legacy);
  assert.match(execFileSync('openssl', ['x509', '-in', crt, '-noout', '-text']).toString(), /Name Constraints: critical/);
  assert.match(execFileSync('openssl', ['verify', '-CAfile', crt, out.files.crt]).toString(), /OK/);
  assert.equal(statSync(key).mode & 0o777, 0o600);
});

// ---------------------------------------------------------------------------
// NS-11 isolated trust matrix. The only trust anchor is the project's own ca.crt, passed
// explicitly (`openssl verify -CAfile`, node `tls` `ca`). Nothing is installed in any trust store.
// ---------------------------------------------------------------------------

const strictVerify = (caCrt, crt, extra = []) => {
  try {
    const out = execFileSync('openssl', ['verify', '-x509_strict', '-purpose', 'sslserver', '-no-CApath', '-no-CAstore',
      '-CAfile', caCrt, ...extra, crt], { stdio: 'pipe' }).toString();
    return { ok: /: OK/.test(out), out };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

const mintLeaf = (files, san) => signLeaf(files, san);

/** Handshake with only `ca` as trust anchor (verification stays ON); name match is done separately by the caller. */
const handshake = (crt, key, ca) => new Promise((resolve) => {
  const server = tls.createServer({ cert: readFileSync(crt), key: readFileSync(key) }, (s) => s.end());
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1', () => {
    const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, ca,
      servername: 'ns11.invalid', checkServerIdentity: () => undefined }, () => {
      socket.destroy(); server.close(); resolve({ authorized: socket.authorized, error: socket.authorizationError });
    });
    socket.on('error', (e) => { socket.destroy(); server.close(); resolve({ authorized: false, error: e.code || e.message }); });
  });
});

const leafWithKey = (files, san) => {
  const dir = tmp();
  const key = path.join(dir, 'leaf.key');
  const csr = path.join(dir, 'leaf.csr');
  const ext = path.join(dir, 'leaf.cnf');
  const crt = path.join(dir, 'leaf.crt');
  writeFileSync(ext, `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  execFileSync('openssl', ['req', '-new', '-key', key, '-subj', '/CN=Test leaf', '-out', csr]);
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', files.caCrt, '-CAkey', files.caKey,
    '-CAcreateserial', '-CAserial', path.join(dir, 'serial'), '-days', '5', '-extfile', ext, '-out', crt], { stdio: 'ignore' });
  return { crt, key };
};

// [CA hosts, accepted SAN values, rejected SAN values]
const MATRIX = [
  ['IP-only CA', ['192.0.2.7'],
    ['IP:192.0.2.7'],
    ['IP:8.8.8.8', 'IP:192.0.2.8', 'IP:::1', 'DNS:other.test', 'DNS:google.com', 'DNS:192.0.2.7.example.test',
      'IP:192.0.2.7,DNS:other.test', 'DNS:other.test,IP:192.0.2.7']],
  ['IPv6-only CA', ['::1'],
    ['IP:::1'],
    ['IP:::2', 'IP:127.0.0.1', 'DNS:localhost', 'IP:::1,DNS:other.test']],
  ['DNS-only CA', ['example.test'],
    ['DNS:example.test'],
    ['DNS:other.test', 'DNS:google.com', 'DNS:child.example.test', 'DNS:example.test.evil.test', 'IP:8.8.8.8', 'IP:::1',
      'DNS:example.test,IP:8.8.8.8', 'IP:8.8.8.8,DNS:example.test']],
  ['DNS+IP CA', ['example.test', '192.0.2.7'],
    ['DNS:example.test', 'IP:192.0.2.7', 'DNS:example.test,IP:192.0.2.7'],
    ['DNS:other.test', 'DNS:child.example.test', 'IP:8.8.8.8', 'IP:::1',
      'DNS:example.test,IP:8.8.8.8', 'IP:192.0.2.7,DNS:other.test']]
];

for (const [label, hosts, accepted, rejected] of MATRIX) {
  test(`NS-11 matrix (${label}): -x509_strict and node tls with explicit ca only`, async () => {
    const { files } = ensureLocalCertificate(tmp(), hosts);
    const ca = readFileSync(files.caCrt);
    // The CA's own leaf covers exactly the configured hosts.
    assert.equal(strictVerify(files.caCrt, files.crt).ok, true, strictVerify(files.caCrt, files.crt).out);
    for (const san of accepted) {
      const leaf = leafWithKey(files, san);
      const v = strictVerify(files.caCrt, leaf.crt);
      assert.equal(v.ok, true, `${label} openssl should accept ${san}: ${v.out}`);
      const h = await handshake(leaf.crt, leaf.key, ca);
      assert.equal(h.authorized, true, `${label} node should accept ${san}: ${h.error}`);
    }
    for (const san of rejected) {
      const leaf = leafWithKey(files, san);
      const v = strictVerify(files.caCrt, leaf.crt);
      assert.equal(v.ok, false, `${label} openssl must reject ${san}`);
      assert.match(v.out, /subtree violation|verification failed/i, `${label} ${san}: ${v.out}`);
      const h = await handshake(leaf.crt, leaf.key, ca);
      assert.equal(h.authorized, false, `${label} node must reject ${san}`);
      assert.ok(h.error, `${label} ${san}: node must report an authorization error`);
    }
  });

  test(`NS-11 matrix (${label}): leaf renewed by scripts/renew-local-cert.mjs keeps the same limits`, async () => {
    const dataDir = tmp();
    const first = ensureLocalCertificate(dataDir, hosts);
    const oldCa = readFileSync(first.files.caCrt);
    const oldLeaf = readFileSync(first.files.crt);
    const out = execFileSync(process.execPath, ['scripts/renew-local-cert.mjs', '--data-dir', dataDir, '--hosts', hosts.join(',')]).toString();
    assert.match(out, /Server certificate renewed/);
    assert.notDeepEqual(readFileSync(first.files.crt), oldLeaf);
    assert.deepEqual(readFileSync(first.files.caCrt), oldCa, 'CA must not change on renewal');

    // Renewed leaf: valid under the isolated anchor and exactly the configured SANs.
    assert.equal(strictVerify(first.files.caCrt, first.files.crt).ok, true);
    const renewed = new X509Certificate(readFileSync(first.files.crt));
    const sans = renewed.subjectAltName.split(',').map((s) => s.trim()).sort();
    const expected = hosts.map((h) => (h.includes(':') ? `IP Address:${h === '::1' ? '0:0:0:0:0:0:0:1' : h}` : /^\d/.test(h) ? `IP Address:${h}` : `DNS:${h}`)).sort();
    assert.deepEqual(sans, expected);
    assert.equal((await handshake(first.files.crt, first.files.key, oldCa)).authorized, true);

    // The same limits still apply to anything signed after renewal.
    for (const san of rejected) {
      const leaf = leafWithKey(first.files, san);
      assert.equal(strictVerify(first.files.caCrt, leaf.crt).ok, false, `after renewal: ${san}`);
      assert.equal((await handshake(leaf.crt, leaf.key, oldCa)).authorized, false, `after renewal (node): ${san}`);
    }

    // Renewal for a host the CA does not permit fails closed and leaves files untouched.
    const leafBefore = readFileSync(first.files.crt);
    const extra = hosts.some((h) => !h.includes(':') && !/^\d/.test(h)) ? 'other.test' : 'dns-added.test';
    assert.throws(() => execFileSync(process.execPath, ['scripts/renew-local-cert.mjs', '--data-dir', dataDir,
      '--hosts', [...hosts, extra].join(',')], { stdio: 'pipe' }), /planned replacement/);
    assert.deepEqual(readFileSync(first.files.crt), leafBefore);
    assert.deepEqual(readFileSync(first.files.caCrt), oldCa);
  });
}
