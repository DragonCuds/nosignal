import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { allowLoginAttempt, clearSessionCookie, createSession, deleteSession, getSessionToken, requireTrustedOrigin, requireUser, setCookieSecure, verifyLoginPassword } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { registerChatRoutes } from './chats.js';
import { registerRealtime } from './realtime.js';
import { registerMediaRoutes } from './media/routes.js';
import { registerCryptoRoutes } from './crypto.js';
import { registerCryptoBackupRoutes } from './cryptoBackup.js';
import { hasTotp, registerSecurityRoutes, verifySecondFactor } from './security.js';
import { runMigrations } from './migrate.js';
import { registerInvites } from './invites.js';
import { registerRegistration } from './registration.js';
import { registerAttachments } from './attachments/index.js';
import { startServer } from './tls.js';
import { migrateMfaSecrets } from './totp.js';

// npm may place Fastify itself inside this workspace while hoisting plugins to the
// monorepo root. Keep their runtime decorations visible to the workspace compiler.
declare module 'fastify' {
  interface FastifyInstance {
    parseCookie(cookieHeader: string): Record<string, string>;
  }
  interface FastifyRequest {
    cookies: Record<string, string | undefined>;
    file(options?: unknown): Promise<import('@fastify/multipart').MultipartFile | undefined>;
  }
  interface FastifyReply {
    setCookie(name: string, value: string, options?: Record<string, unknown>): this;
    clearCookie(name: string, options?: Record<string, unknown>): this;
    sendFile(filename: string): this;
  }
}

await runMigrations();
await migrateMfaSecrets();
const app = Fastify({
  logger: true,
  trustProxy: config.isProduction ? '127.0.0.1' : false
});

await app.register(fastifyCookie);
await app.register(fastifyHelmet, {
  global: true,
  hsts: config.isProduction ? undefined : false,
  // Decrypted media (photos, GIFs, stickers, voice) is shown from blob: URLs made in the browser after the client
  // decrypts it; without these, incoming media renders as an empty box. blob: is same-origin and script-created only.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'blob:']
    }
  }
});
// Text-like types only: ciphertext, event streams and video never compress.
await app.register(fastifyCompress, {
  global: true,
  encodings: ['br', 'gzip'],
  threshold: 1_024,
  customTypes: /^(text\/(html|css|plain|javascript|xml)|application\/(javascript|json|manifest\+json|xml)|image\/svg\+xml)\b/i
});
await app.register(fastifyRateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute'
});
app.addHook('onRequest', requireTrustedOrigin);
await registerInvites(app);
await registerRegistration(app);

app.get('/api/health', async () => ({ ok: true }));

app.post<{ Body: { username?: string; password?: string; secondFactor?: string } }>('/api/auth/login', {
  config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
}, async (request, reply) => {
  const { username, password, secondFactor } = request.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 1_024) {
    return reply.code(400).send({ error: 'username and password are required' });
  }
  if (!allowLoginAttempt(username)) {
    return reply.code(429).send({ error: 'Too many login attempts. Try again later.' });
  }
  const result = await db.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE username = $1',
    [username.trim().toLowerCase()]
  );
  const account = result.rows[0];
  if (!account || !(await verifyLoginPassword(account?.password_hash, password))) {
    return reply.code(401).send({ error: 'Invalid username or password' });
  }
  if (await hasTotp(account.id)) {
    if (!secondFactor) return reply.code(428).send({ error: 'Second factor required', mfaRequired: true });
    if (!(await verifySecondFactor(account.id, secondFactor))) return reply.code(401).send({ error: 'Invalid verification code' });
  }
  await createSession(account.id, reply, request, getSessionToken(request));
  return reply.code(204).send();
});

app.post('/api/auth/logout', async (request, reply) => {
  await deleteSession(getSessionToken(request));
  clearSessionCookie(reply);
  return reply.code(204).send();
});

app.get('/api/me', { preHandler: requireUser }, async (request) => request.user);

app.decorate('requireUser', requireUser);
await registerRealtime(app);
await registerCryptoRoutes(app);
await registerCryptoBackupRoutes(app);
await registerChatRoutes(app);
await registerAttachments(app);
await registerMediaRoutes(app);
await registerSecurityRoutes(app);

app.addHook('onClose', async () => db.end());

const webDist = resolve(import.meta.dirname, '../../web/dist');

const staticCacheControl = (file: string): string => {
  const rel = relative(webDist, file).split(sep).join('/');
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  if (rel.startsWith('emoji/') || rel.startsWith('fonts/')) return 'public, max-age=2592000, immutable';
  if (rel.startsWith('icons/')) return 'public, max-age=86400';
  return 'no-cache'; // index.html, service-worker.js, register-sw.js, manifest, offline.html
};

if (process.env.NODE_ENV === 'production' && existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    cacheControl: false,
    setHeaders: (reply: { header(name: string, value: string): unknown }, file: string) => reply.header('Cache-Control', staticCacheControl(file))
  });

  // Invite links are SPA routes: /join/<token> must always return the app shell.
  app.get('/join/*', (_request, reply) => reply.sendFile('index.html'));
  // Channel invite links are SPA routes too.
  app.get('/c/*', (_request, reply) => reply.sendFile('index.html'));

  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({ error: 'Not found' });
  });
}

const start = async (): Promise<void> => {
  try {
    const running = await startServer(app, {
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
      mode: config.tlsMode,
      hosts: config.tlsHosts,
      certFile: config.tlsCertFile,
      keyFile: config.tlsKeyFile,
      log: (message) => app.log.info(message)
    });
    setCookieSecure(config.isProduction || running.secure);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
