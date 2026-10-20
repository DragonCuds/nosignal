// Phone/browser capability test page over self-signed HTTPS.
//   PORT=4106 HOST=127.0.0.1 node scripts/device-test/server.mjs
// Binds to loopback unless HOST is set. Stops itself after TTL_MIN minutes (default 30).
// The director decides when HOST is opened to the network and opens/closes the firewall port.
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const here = import.meta.dirname;
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4106);
const ttl = Number(process.env.TTL_MIN ?? 30);
const certHost = process.env.CERT_HOST ?? host;
const dir = mkdtempSync(join(tmpdir(), 'device-test-'));
const log = process.env.REPORT_FILE ?? join(dir, 'reports.log');

const san = /^\d+\.\d+\.\d+\.\d+$/.test(certHost) ? `IP:${certHost}` : `DNS:${certHost}`;
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
  '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', `/CN=${certHost}`, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });

const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', (chunk) => { if (body.length < 8192) body += chunk; });
    req.on('end', () => { appendFileSync(log, `${new Date().toISOString()} ${body}\n`); res.end('ok'); });
    return;
  }
  const file = req.url === '/sw.js' ? 'sw.js' : 'index.html';
  res.setHeader('content-type', file === 'sw.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  res.end(readFileSync(join(here, file)));
  appendFileSync(log, `${new Date().toISOString()} HIT ${req.url}\n`);
});
new WebSocketServer({ server, path: '/ws' }).on('connection', (socket) => socket.send('connected'));
server.listen(port, host, () => console.log(`device test on https://${host}:${port}  reports: ${log}  stops in ${ttl} min`));
setTimeout(() => process.exit(0), ttl * 60_000).unref?.();
