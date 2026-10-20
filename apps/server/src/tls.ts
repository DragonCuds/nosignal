import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Own HTTPS without any outside certificate authority.
 *
 *  - mode 'auto'  : first start creates a local CA + server cert (EC P-256, SAN = `hosts`) under
 *                   `<dataDir>/tls/`. The server cert renews itself before it expires.
 *                   The CA is served at /ca.crt and a Persian install guide at /ca-help.
 *  - mode 'files' : use an existing certificate (`certFile` + `keyFile`); re-read daily so a
 *                   renewed certificate is picked up without a restart.
 *  - mode 'off'   : plain HTTP (the server sits behind the operator's own nginx / TLS terminator).
 *
 * Certificates are made with the `openssl` binary (no extra dependency, no network).
 */

export type TlsMode = 'auto' | 'files' | 'off';

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  mode?: TlsMode;
  /** Names/IPs that go into the certificate SAN (auto mode). Default: localhost, 127.0.0.1, ::1. */
  hosts?: string[];
  certFile?: string;
  keyFile?: string;
  /** Renew the server cert when fewer than this many days remain. Default 30. */
  renewBeforeDays?: number;
  /** How often to check for renewal. Default 12 h. */
  checkIntervalMs?: number;
  /** Server certificate lifetime in days (auto mode). Default 365. */
  serverCertDays?: number;
  log?: (message: string) => void;
};

export type RunningServer = {
  /** True when clients must use https:// (cookies may be `Secure`). */
  secure: boolean;
  mode: TlsMode;
  port: number;
  url: string;
  caCertPath: string | null;
  /** Re-check the certificate now; returns true when a new one was issued/loaded. */
  renewNow(force?: boolean): Promise<boolean>;
  close(): Promise<void>;
};

const DAY_MS = 86_400_000;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

const normalizeHosts = (hosts: string[] | undefined): string[] => {
  const list = hosts?.map((h) => h.trim().replace(/^\[|\]$/gu, '')).filter(Boolean);
  const result = [...new Set(list?.length ? list : ['localhost', '127.0.0.1', '::1'])];
  for (const host of result) {
    if (!isIP(host) && !HOST_RE.test(host)) throw new Error(`Invalid TLS host name: ${host}`);
  }
  return result;
};

const openssl = (args: string[]): void => {
  try {
    execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`openssl ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

const sanOf = (cert: X509Certificate): string[] =>
  (cert.subjectAltName ?? '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [kind, ...rest] = part.split(':');
    const value = rest.join(':').trim();
    if (kind === 'IP Address') return isIP(value) === 6 ? canonicalV6(value) : value;
    return value.toLowerCase();
  });

const canonicalV6 = (value: string): string => {
  // openssl prints IPv6 SANs expanded (0:0:0:0:0:0:0:1); compare via URL canonicalisation.
  try { return new URL(`http://[${value}]`).hostname.slice(1, -1); } catch { return value; }
};

const wantedSan = (hosts: string[]): string[] =>
  hosts.map((h) => (isIP(h) === 6 ? canonicalV6(h) : h.toLowerCase()));

/** Does this cert still cover `hosts` and have more than `minDays` left? */
const certIsFresh = (cert: X509Certificate, hosts: string[], minDays: number, now = Date.now()): boolean => {
  if (Date.parse(cert.validTo) - now < minDays * DAY_MS) return false;
  if (Date.parse(cert.validFrom) > now + DAY_MS) return false;
  const have = new Set(sanOf(cert));
  return wantedSan(hosts).every((h) => have.has(h));
};

const readCert = (file: string): X509Certificate | null => {
  try { return new X509Certificate(readFileSync(file)); } catch { return null; }
};

type TlsFiles = { dir: string; caKey: string; caCrt: string; key: string; crt: string };

const filesIn = (dataDir: string): TlsFiles => {
  const dir = join(resolve(dataDir), 'tls');
  return { dir, caKey: join(dir, 'ca.key'), caCrt: join(dir, 'ca.crt'), key: join(dir, 'server.key'), crt: join(dir, 'server.crt') };
};

const writeSecret = (file: string, content: string | Buffer): void => {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
};

const makeCa = (f: TlsFiles): void => {
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f.caKey]);
  chmodSync(f.caKey, 0o600);
  openssl([
    'req', '-x509', '-new', '-key', f.caKey, '-sha256', '-days', '3650',
    '-subj', '/CN=Tel Messenger Local CA/O=Tel Messenger',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'subjectKeyIdentifier=hash',
    '-out', f.caCrt
  ]);
};

const makeServerCert = (f: TlsFiles, hosts: string[], days: number): void => {
  const tmp = mkdtempSync(join(f.dir, '.issue-'));
  try {
    const key = join(tmp, 'server.key');
    const csr = join(tmp, 'server.csr');
    const ext = join(tmp, 'ext.cnf');
    const crt = join(tmp, 'server.crt');
    const san = hosts.map((h) => (isIP(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
    writeFileSync(ext, [
      `subjectAltName=${san}`,
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
      ''
    ].join('\n'));
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    openssl(['req', '-new', '-key', key, '-subj', `/CN=${hosts[0]}`, '-out', csr]);
    openssl([
      'x509', '-req', '-in', csr, '-CA', f.caCrt, '-CAkey', f.caKey, '-CAcreateserial',
      '-CAserial', join(tmp, 'ca.srl'), '-sha256', '-days', String(days), '-extfile', ext, '-out', crt
    ]);
    chmodSync(key, 0o600);
    // Swap in key first, then cert; a reader that sees a mismatched pair just fails once and retries.
    renameSync(key, f.key);
    renameSync(crt, f.crt);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/** Make sure a CA and a fresh server cert exist for `hosts`. Returns true when something was issued. */
export const ensureLocalCertificate = (
  dataDir: string,
  hosts: string[],
  options: { renewBeforeDays?: number; serverCertDays?: number; force?: boolean } = {}
): { files: TlsFiles; issued: boolean; newCa: boolean } => {
  const f = filesIn(dataDir);
  const renewBefore = options.renewBeforeDays ?? 30;
  const names = normalizeHosts(hosts);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  let issued = false;
  let newCa = false;

  const ca = existsSync(f.caKey) ? readCert(f.caCrt) : null;
  // A CA with < 60 days left is replaced (clients must then reinstall it; rare, 10-year CA).
  if (!ca || Date.parse(ca.validTo) - Date.now() < Math.max(60, renewBefore * 2) * DAY_MS) {
    makeCa(f);
    newCa = true;
  }
  const current = !newCa && existsSync(f.key) ? readCert(f.crt) : null;
  if (options.force || !current || !certIsFresh(current, names, renewBefore)) {
    makeServerCert(f, names, options.serverCertDays ?? 365);
    issued = true;
  }
  return { files: f, issued, newCa };
};

const helpPage = (caPath: string): string => `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>نصب گواهی امن</title>
<style>
body{font-family:Vazirmatn,Tahoma,sans-serif;margin:0;padding:24px 16px;background:#f4f6f8;color:#111;line-height:1.9}
main{max-width:640px;margin:auto}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2em}
a.btn{display:inline-block;background:#2a8cf0;color:#fff;padding:12px 22px;border-radius:12px;text-decoration:none}
ol{padding-inline-start:1.4em}
.note{background:#fff;border-radius:12px;padding:12px 16px}
</style>
</head>
<body>
<main>
<h1>نصب گواهی امن پیام‌رسان</h1>
<p>این سرور گواهی HTTPS خودش را می‌سازد. برای اینکه مرورگر هشدار «ناامن» نشان ندهد، یک‌بار گواهی را روی گوشی نصب کنید.</p>
<p><a class="btn" href="${caPath}" download="tel-messenger-ca.crt">دانلود گواهی</a></p>

<h2>اندروید</h2>
<ol>
<li>فایل بالا را دانلود کنید.</li>
<li>تنظیمات ← امنیت (یا «امنیت و حریم خصوصی») ← «رمزگذاری و اعتبارنامه‌ها».</li>
<li>«نصب گواهی» ← «گواهی CA» ← در هشدار «به هر حال نصب کن» را بزنید.</li>
<li>فایل <b>tel-messenger-ca.crt</b> را انتخاب کنید و در پایان مرورگر را کامل ببندید و دوباره باز کنید.</li>
</ol>

<h2>آیفون و آیپد</h2>
<ol>
<li>این صفحه را با <b>Safari</b> باز کنید و روی «دانلود گواهی» بزنید؛ «Allow» را انتخاب کنید.</li>
<li>تنظیمات ← بالای صفحه «Profile Downloaded» ← Install (رمز گوشی را وارد کنید).</li>
<li>تنظیمات ← General ← About ← Certificate Trust Settings.</li>
<li>سوئیچ گواهی «Tel Messenger Local CA» را روشن کنید.</li>
</ol>

<h2>کامپیوتر</h2>
<p>فایل را باز کنید و در «Trusted Root Certification Authorities» (ویندوز) یا Keychain (مک) اضافه کنید.</p>

<p class="note">این گواهی فقط برای همین سرور است. فایل را از هیچ منبع دیگری نصب نکنید.</p>
</main>
</body>
</html>
`;

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
  'referrer-policy': 'no-referrer'
};

const handleCaRoutes = (caCertPath: string) => (request: IncomingMessage, response: ServerResponse): boolean => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = (request.url ?? '').split('?')[0];
  if (path === '/ca.crt') {
    const body = readFileSync(caCertPath);
    response.writeHead(200, {
      ...SEC_HEADERS,
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="tel-messenger-ca.crt"',
      'content-length': body.length,
      'cache-control': 'no-cache'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  }
  if (path === '/ca-help') {
    const body = Buffer.from(helpPage('/ca.crt'));
    response.writeHead(200, {
      ...SEC_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'cache-control': 'no-cache'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  }
  return false;
};

/**
 * Starts listening. `app` must not be listening yet. In auto/files mode an https server is created
 * and Fastify is attached to it (requests via `app.routing`, WebSocket upgrades via `app.server`'s
 * 'upgrade' listeners), so `index.ts` only has to call this instead of `app.listen`.
 */
export const startServer = async (app: FastifyInstance, config: ServerConfig): Promise<RunningServer> => {
  const mode: TlsMode = config.mode ?? 'auto';
  const log = config.log ?? (() => undefined);

  if (mode === 'off') {
    await app.listen({ host: config.host, port: config.port });
    const address = app.server.address() as AddressInfo;
    const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return {
      secure: false, mode, port: address.port, url: `http://${hostPart}:${address.port}`, caCertPath: null,
      renewNow: async () => false,
      close: () => app.close()
    };
  }

  const hosts = normalizeHosts(config.hosts);
  const renewBeforeDays = config.renewBeforeDays ?? 30;
  let caCertPath: string | null = null;

  const loadCredentials = (force = false): { key: Buffer; cert: Buffer; changed: boolean } => {
    if (mode === 'files') {
      if (!config.certFile || !config.keyFile) throw new Error('TLS mode "files" needs certFile and keyFile');
      return { key: readFileSync(config.keyFile), cert: readFileSync(config.certFile), changed: true };
    }
    const result = ensureLocalCertificate(config.dataDir, hosts, {
      renewBeforeDays, serverCertDays: config.serverCertDays, force
    });
    caCertPath = result.files.caCrt;
    if (result.newCa) log('tls: created a new local CA (clients must install it again)');
    else if (result.issued) log('tls: issued a new server certificate');
    return { key: readFileSync(result.files.key), cert: readFileSync(result.files.crt), changed: result.issued };
  };

  const initial = loadCredentials();
  await app.ready();
  const serveCa = caCertPath ? handleCaRoutes(caCertPath) : null;

  const server = https.createServer({ key: initial.key, cert: initial.cert, minVersion: 'TLSv1.2' }, (request, response) => {
    if (serveCa?.(request, response)) return;
    app.routing(request, response);
  });
  server.on('upgrade', (request, socket, head) => {
    app.server.emit('upgrade', request, socket, head);
  });

  const renewNow = async (force = false): Promise<boolean> => {
    try {
      const next = loadCredentials(force);
      if (!next.changed) return false;
      server.setSecureContext({ key: next.key, cert: next.cert });
      return true;
    } catch (error) {
      log(`tls: renewal check failed: ${(error as Error).message}`);
      return false;
    }
  };
  const timer = setInterval(() => { void renewNow(); }, config.checkIntervalMs ?? 12 * 3_600_000);
  timer.unref();

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address;

  const close = async (): Promise<void> => {
    clearInterval(timer);
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    await app.close();
  };
  return {
    secure: true, mode, port: address.port, url: `https://${hostPart}:${address.port}`, caCertPath,
    renewNow, close
  };
};
