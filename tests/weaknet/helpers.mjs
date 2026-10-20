// Shared helpers for the weak-network tests (not a test file itself).
// Everything runs on 127.0.0.1 with a temp DATA_DIR and a port >= 4100, never the live service.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const root = path.resolve(import.meta.dirname, '../..');
export const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tryListen = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
// random free port in 4100..4999 (checked by binding it briefly)
export const freePort = async () => {
  for (let i = 0; i < 200; i++) {
    const p = 4100 + Math.floor(Math.random() * 900);
    if (await tryListen(p)) return p;
  }
  throw new Error('no free port');
};

export const tmpDir = (prefix) => mkdtemp(path.join(os.tmpdir(), `${prefix}-`));

// In-process Fastify app with the real routes, temp sqlite DATA_DIR, users a/b/c (ids 1/2/3),
// chat 1 = a+b, chat 2 = b+c. Env must be set before the server modules are imported, so call this once per test file.
export const bootApp = async ({ routes = ['chats'], env = {}, prefix = 'weaknet' } = {}) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secret = 'weaknet-test-only-secret-with-at-least-32-bytes';
  const dataDir = await tmpDir(prefix);
  Object.assign(process.env, {
    NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, SESSION_SECRET: secret,
    TRUSTED_ORIGINS: origin, WEBAUTHN_RP_ID: '127.0.0.1', ...env
  });
  const { register } = await imp('apps/server/node_modules/tsx/dist/esm/api/index.mjs');
  register();
  const { default: Fastify } = await imp('apps/server/node_modules/fastify/fastify.js');
  const { default: cookie } = await imp('node_modules/@fastify/cookie/index.js');
  const { db } = await imp('apps/server/src/db.ts');
  const { runMigrations } = await imp('apps/server/src/migrate.ts');
  const auth = await imp('apps/server/src/auth.ts');
  await runMigrations();
  const cookies = {};
  for (const [i, u] of ['a', 'b', 'c'].entries()) {
    await db.query('INSERT INTO users (username, display_name, password_hash) VALUES ($1, $1, $2)', [u, 'x']);
    cookies[u] = `token-${u}`;
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))`,
      [`00000000-0000-4000-8000-00000000000${i}`, i + 1, createHmac('sha256', secret).update(cookies[u]).digest('hex')]);
  }
  await db.query('INSERT INTO chats DEFAULT VALUES'); await db.query('INSERT INTO chats DEFAULT VALUES');
  for (const u of [1, 2]) await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES (1, $1)', [u]);
  for (const u of [2, 3]) await db.query('INSERT INTO chat_members (chat_id, user_id) VALUES (2, $1)', [u]);
  const app = Fastify();
  app.decorate('requireUser', auth.requireUser);
  await app.register(cookie);
  app.addHook('onRequest', auth.requireTrustedOrigin);
  const hits = []; // every request that reaches the server (method + url)
  app.addHook('onRequest', async (req) => { hits.push(`${req.method} ${req.url}`); });
  const out = { app, db, port, origin, cookies, dataDir, hits, broadcasts: [] };
  if (routes.includes('realtime')) {
    const { registerRealtime } = await imp('apps/server/src/realtime.ts');
    await registerRealtime(app);
    const orig = app.realtime.broadcastToChat;
    app.realtime.broadcastToChat = (c, e) => { out.broadcasts.push(e); orig(c, e); };
  }
  if (routes.includes('chats')) {
    out.chats = await imp('apps/server/src/chats.ts');
    out.sync = await imp('apps/server/src/sync.ts');
    await out.chats.registerChatRoutes(app);
  }
  if (routes.includes('attachments')) {
    out.attachments = await imp('apps/server/src/attachments/index.ts');
    await out.attachments.registerAttachments(app);
  }
  await app.listen({ host: '127.0.0.1', port });
  // request against `base` (default: the server directly; pass a proxy origin to go through netsim)
  out.req = (method, url, { user = 'a', body, headers = {}, base = origin, signal } = {}) => fetch(`${base}${url}`, {
    method, body, signal, headers: { Origin: origin, Cookie: `tel_session=${cookies[user]}`, ...headers }
  });
  out.json = (method, url, { user = 'a', body, base, signal } = {}) => out.req(method, url, {
    user, base, signal, body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' }
  });
  out.close = async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); };
  return out;
};

export const enc = () => ({ version: 2, cipherId: randomUUID(), nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(40).toString('base64url') });

// Starts tools/netsim/proxy.mjs in front of `targetPort`. Returns { port, origin, lines, waitFor(re), stop() }.
export const startProxy = async (targetPort, profile, extra = [], seed = 1) => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'tools/netsim/proxy.mjs'), '--listen', String(port), '--target', `127.0.0.1:${targetPort}`, '--profile', profile, '--seed', String(seed), ...extra.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l);
      for (const w of [...waiters]) if (w.re.test(l)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(l); }
    }
  });
  const waitFor = (re, ms = 15000) => {
    const hit = lines.find((l) => re.test(l));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { re, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`proxy: no line matching ${re}`)); } }, ms);
    });
  };
  await waitFor(/netsim/);
  return {
    port, origin: `http://127.0.0.1:${port}`, lines, waitFor,
    count: (re) => lines.filter((l) => re.test(l)).length,
    stop: async () => { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 1000); }); }
  };
};
