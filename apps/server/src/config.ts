import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(import.meta.dirname, '../../../.env');

// systemd supplies production values through EnvironmentFile.  The local .env is only a
// developer fallback; an unprivileged service must never need permission to read it.
if (existsSync(envFile) && process.env.SESSION_SECRET === undefined) {
  try {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    }
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EACCES') throw error;
  }
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) {
  throw new Error('NODE_ENV must be development, test, or production');
}

const isProduction = nodeEnv === 'production';
const port = Number(process.env.PORT ?? '3050');
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const dataDir = resolve(process.env.DATA_DIR?.trim() || resolve(import.meta.dirname, '../../../data'));

const sessionSecret = required('SESSION_SECRET');
const unsafeSessionSecrets = new Set([
  'change-me',
  'replace-me',
  'replace-with-a-long-random-value'
]);
if (isProduction && (Buffer.byteLength(sessionSecret) < 32 || unsafeSessionSecrets.has(sessionSecret.toLowerCase()))) {
  throw new Error('SESSION_SECRET must be at least 32 bytes and non-default in production');
}

const parseOrigin = (value: string): string => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error(`Invalid trusted origin: ${value}`);
  }
};

const configuredOrigins = process.env.TRUSTED_ORIGINS
  ?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (isProduction && !configuredOrigins?.length) {
  throw new Error('TRUSTED_ORIGINS is required in production');
}

const trustedOrigins = new Set(
  (configuredOrigins?.length
    ? configuredOrigins
    : [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173'
      ]).map(parseOrigin)
);

const firstTrustedOrigin = [...trustedOrigins][0];
const webauthnRpId = process.env.WEBAUTHN_RP_ID?.trim() || new URL(firstTrustedOrigin).hostname;
if (!/^(?=.{1,253}$)(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/iu.test(webauthnRpId)) {
  throw new Error('WEBAUTHN_RP_ID must be a valid domain name');
}
for (const origin of trustedOrigins) {
  const url = new URL(origin);
  if (isProduction && url.protocol !== 'https:') throw new Error('All production TRUSTED_ORIGINS must use HTTPS');
  if (url.hostname !== webauthnRpId && !url.hostname.endsWith(`.${webauthnRpId}`)) {
    throw new Error(`WEBAUTHN_RP_ID is not a registrable suffix of trusted origin: ${origin}`);
  }
}

const tlsMode = (process.env.TLS_MODE?.trim().toLowerCase() || 'off');
if (!['auto', 'files', 'off'].includes(tlsMode)) throw new Error('TLS_MODE must be auto, files, or off');
const tlsCertFile = process.env.TLS_CERT_FILE?.trim() || undefined;
const tlsKeyFile = process.env.TLS_KEY_FILE?.trim() || undefined;
if (tlsMode === 'files' && (!tlsCertFile || !tlsKeyFile)) throw new Error('TLS_CERT_FILE and TLS_KEY_FILE are required when TLS_MODE=files');
const tlsHosts = process.env.TLS_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
// Behind nginx (TLS_MODE=off) the app stays on loopback. Serving TLS itself usually means
// listening on a LAN/public address, so BIND_HOST can override the default.
const host = process.env.BIND_HOST?.trim() || '127.0.0.1';

const openRegistration = ['1', 'true'].includes(process.env.OPEN_REGISTRATION?.trim().toLowerCase() ?? '');

export const config = {
  openRegistration,
  host,
  tlsMode: tlsMode as 'auto' | 'files' | 'off',
  tlsHosts,
  tlsCertFile,
  tlsKeyFile,
  dataDir,
  sessionSecret,
  port,
  isProduction,
  trustedOrigins,
  webauthnRpId,
  webauthnRpName: process.env.WEBAUTHN_RP_NAME?.trim() || 'NoSignal'
};
