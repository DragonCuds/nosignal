// S10b (R3, R4): checks right before a group key is handed out for NEW messages. The real apps/web/src/e2ee.ts (bundled with esbuild, a fake
// IndexedDB per "browser", WebCrypto) talks to the real server code in-process, sometimes through a lying server (the `tamper` hooks).
//  R3: a warm cache must not keep a group version "sendable" after the member who wrapped it left (or changed identity).
//  R4: a pinned member whose current key no longer matches the pin stops sending (KeyChangedError) instead of a message that locks the group later.
// To prove a scenario fails on the old code: S10B_OLD_E2EE=/path/to/old/e2ee.ts node --test tests/security/group-send-checks.test.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-s10b-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 's10b-test-secret-with-at-least-32-bytes';
process.env.TRUSTED_ORIGINS = origin;

const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const { build } = serverRequire.resolve('esbuild') ? serverRequire('esbuild') : {};
const Fastify = serverRequire('fastify');
const fastifyCookie = serverRequire('@fastify/cookie');
const fastifyRateLimit = serverRequire('@fastify/rate-limit');
const load = (name) => import(path.join(dist, name));
const { runMigrations } = await load('migrate.js');
const { db } = await load('db.js');
const { createUser } = await load('users.js');
const auth = await load('auth.js');
const { registerChatRoutes } = await load('chats.js');
const { registerCryptoRoutes } = await load('crypto.js');
const { registerCryptoBackupRoutes } = await load('cryptoBackup.js');

const PASSWORD = 'a-long-password-9';
const src = path.join(root, 'apps/web/src');

// ---- the browser side: e2ee.ts bundled with a mocked API client (-> in-process server) -----------------------------------------------
const mocks = {
  api: `export class ApiError extends Error { constructor(m, status, data) { super(m); this.status = status; this.data = data; } }
    const who = new URL(import.meta.url).searchParams.get('u');
    const call = async (method, url, body) => {
      const r = await globalThis.__bridge.call(who, method, url, body);
      if (r.status >= 400) throw new ApiError(r.json?.error ?? 'error', r.status, r.json ?? undefined);
      return r.status === 204 || !r.body ? undefined : r.json;
    };
    export const api = {
      chatCrypto: (id, version) => call('GET', '/api/chats/' + id + '/crypto' + (version === undefined ? '' : '?version=' + version)),
      createCryptoEnvelopes: (id, body) => call('POST', '/api/chats/' + id + '/crypto/envelopes', body),
      registerCryptoIdentity: (userId, publicKey, backup) => call('PUT', '/api/crypto/identity', { expectedUserId: userId, publicKey, backup }),
      cryptoBackup: () => call('GET', '/api/crypto/backup'),
      cryptoActionGrant: (action, expectedRevision, password, secondFactor) => call('POST', '/api/crypto/action-grant', { action, expectedRevision, password, secondFactor }),
      resetCryptoIdentity: (expectedRevision, actionToken) => call('POST', '/api/crypto/identity/reset', { expectedRevision, actionToken }),
    };`,
  groups: `import { ApiError } from './api.js';
    const who = new URL(import.meta.url).searchParams.get('u');
    const call = async (method, url, body) => {
      const r = await globalThis.__bridge.call(who, method, url, body);
      if (r.status >= 400) throw new ApiError(r.json?.error ?? 'error', r.status, r.json ?? undefined);
      return r.status === 204 || !r.body ? undefined : r.json;
    };
    export const groupsApi = {
      get: (id) => call('GET', '/api/groups/' + id),
      keys: (id, version) => call('GET', '/api/groups/' + id + '/keys?version=' + version),
      putKeys: (id, version, expectedMembers, envelopes) => call('PUT', '/api/groups/' + id + '/keys', { version, expectedMembers, envelopes }),
    };`,
};
const outDir = await mkdtemp(path.join(os.tmpdir(), 'tel-s10b-bundle-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './e2ee.ts'; export * from './dmKeys.ts'; export * from './pins.ts'; export * from './keyErrors.ts'; export { ApiError } from './api.js';`,
    resolveDir: src, sourcefile: 'entry.ts', loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  plugins: [{ name: 'mocks', setup(b) {
    if (process.env.S10B_OLD_E2EE) {
      b.onResolve({ filter: /^\.\/e2ee\.ts$/ }, () => ({ path: 'old-e2ee', namespace: 'old' }));
      b.onLoad({ filter: /.*/, namespace: 'old' }, async () => ({ contents: await readFile(process.env.S10B_OLD_E2EE, 'utf8'), resolveDir: src, loader: 'ts' }));
    }
    b.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: 'api', namespace: 'mock' }));
    b.onResolve({ filter: /^\.\/groups\/groupsApi\.js$/ }, () => ({ path: 'groups', namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: mocks[a.path], loader: 'js' }));
  } }]
});

// A fake IndexedDB: enough of the API surface e2ee.ts uses (open, transaction, objectStore get/put/delete). One per "browser profile".
const makeIdb = () => {
  const stores = { identities: new Map(), pins: new Map(), keyFloors: new Map() };
  const open = () => {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: (name) => name in stores },
        close() {},
        transaction(name) {
          const store = stores[name];
          const tx = {};
          const reply = (fn) => {
            const r = {};
            queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (error) { r.error = error; r.onerror?.(); } queueMicrotask(() => tx.oncomplete?.()); });
            return r;
          };
          const objectStore = {
            get: (key) => reply(() => structuredCloneSafe(store.get(key))),
            put: (value, key) => reply(() => { store.set(name === 'identities' ? value.userId : key, structuredCloneSafe(value)); }),
            delete: (key) => reply(() => { store.delete(key); }),
          };
          tx.objectStore = () => objectStore;
          return tx;
        }
      };
      request.onsuccess?.();
    });
    return request;
  };
  return { open, stores };
};
const structuredCloneSafe = (value) => (Array.isArray(value) ? [...value] : value); // CryptoKeys stay by reference

// ---- the server side ------------------------------------------------------------------------------------------------------------------
let app;
const ids = {};
const cookies = {};
const events = [];
let nextIp = 1;
const ip = () => `10.31.${nextIp >> 8}.${nextIp++ & 255}`;
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
const inject = (user, method, url, payload) => app.inject({ method, url, payload, remoteAddress: ip(), headers: { origin, cookie: cookies[user] } });

// instance name -> { user, idb }. A "tamper" hook can rewrite what the server tells one browser (a lying/compromised server).
const instances = new Map();
const tamper = new Map();
const requests = []; // every call a browser made to the server
globalThis.__bridge = {
  async call(who, method, url, body) {
    const instance = instances.get(who);
    requests.push({ who, method, url, body });
    const response = await inject(instance.user, method, url, body);
    let json = null;
    try { json = response.json(); } catch { /* no body */ }
    const hook = tamper.get(who);
    if (hook && response.statusCode < 400) json = hook(method, url, json) ?? json;
    return { status: response.statusCode, body: response.body, json };
  }
};

/** Opens a browser: a fresh module instance of e2ee.ts on the given profile (the profile keeps keys + pins across reloads). */
let moduleCounter = 0;
const profiles = new Map();
const open = async (name, user, profile = name) => {
  if (!profiles.has(profile)) profiles.set(profile, makeIdb());
  const mod = await import(`${pathToFileURL(outfile).href}?u=${name}&n=${++moduleCounter}`);
  instances.set(name, { user, idb: profiles.get(profile) });
  return Object.assign(Object.create(null), mod, { name });
};
/** Run `fn` as that browser (the fake IndexedDB is a global, so only one browser acts at a time). */
const as = async (browser, fn) => {
  globalThis.indexedDB = instances.get(browser.name).idb;
  return fn(browser);
};
const profileOf = (name) => instances.get(name).idb;

const b64 = (n) => randomBytes(n).toString('base64url');
const sendMessage = async (browser, user, chatId, text) => {
  const encrypted = await as(browser, (m) => m.encryptContent(chatId, String(ids[user]), { kind: 'text', text, payload: null }));
  const response = await inject(user, 'POST', `/api/chats/${chatId}/messages`, { kind: 'text', encrypted, keyVersion: encrypted.keyVersion, clientMsgId: `cm-${randomUUID()}` });
  assert.equal(response.statusCode, 201, response.body);
  return { message: response.json(), encrypted };
};
const readAll = async (browser, user, chatId) => {
  const list = (await inject(user, 'GET', `/api/chats/${chatId}/messages`)).json();
  return Promise.all(list.map(async (message) => (await as(browser, (m) => m.decryptMessage(message))).text));
};
const init = (browser, user) => as(browser, (m) => m.initializeEncryption(String(ids[user])));
const LOCKED = '🔒 پیام قابل رمزگشایی نیست';

before(async () => {
  await runMigrations();
  for (const name of ['r3o', 'r3c', 'r3m', 'r4c', 'r4a', 'r4b', 'h1o', 'h1m', 'h3o', 'h3a', 'h3d', 'h4o', 'h4a', 'h4b', 'r3x', 'r3y', 'r3z']) ids[name] = await createUser(name, name, PASSWORD);
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 10_000, timeWindow: '1 minute' });
  app.addHook('onRequest', auth.requireTrustedOrigin);
  app.decorate('requireUser', auth.requireUser);
  app.decorate('realtime', { broadcastToChat: (chatId, event) => events.push({ chatId, event }) });
  app.get('/test/login/:id', async (request, reply) => { await auth.createSession(request.params.id, reply, request); return { ok: true }; });
  await registerCryptoRoutes(app);
  await registerCryptoBackupRoutes(app);
  await registerChatRoutes(app);
  await app.ready();
  for (const name of Object.keys(ids)) cookies[name] = cookieOf(await app.inject({ method: 'GET', url: `/test/login/${ids[name]}`, headers: { origin } }));
});
after(async () => { await app.close(); await db.end(); await rm(dataDir, { recursive: true, force: true }); await rm(outDir, { recursive: true, force: true }); });



// ---- helpers ------------------------------------------------------------------------------------------------------------------------------
const makeChat = async (a, b) => (await inject(a, 'POST', '/api/chats', { userId: ids[b] })).json().id;
const text = (value) => ({ kind: 'text', text: value, payload: null });
const encrypt = (browser, user, chatId, value = 'x', expectVersion) => as(browser, (m) => m.encryptContent(chatId, String(ids[user]), text(value), expectVersion));
/** A new browser profile for the user that starts fresh (the old identity is gone from the server, a new one is registered). */
const startFresh = async (name, user, profile) => {
  const browser = await open(name, user, profile);
  await as(browser, async (m) => { try { await m.initializeEncryption(String(ids[user])); } catch { /* bound to another identity */ } });
  await as(browser, (m) => m.resetIdentity(String(ids[user]), PASSWORD));
  return browser;
};
const reload = async (name, user, profile = name) => { const browser = await open(name, user, profile); await init(browser, user); return browser; };
const lie = (name, rewrite) => tamper.set(name, rewrite);
const makeGroup = async (owner, members) => {
  for (const user of [owner, ...members]) await init(await open(`pre-${user}`, user, user), user); // every member needs a registered identity
  const response = await inject(owner, 'POST', '/api/groups', { title: 'گروه', memberIds: members.map((m) => ids[m]) });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
};
const makeAdmin = async (owner, groupId, user) => assert.equal((await inject(owner, 'POST', `/api/groups/${groupId}/admins/${ids[user]}`)).statusCode, 204);
const join = (browser, group) => as(browser, (m) => m.registerGroupChat(group.chatId, group.id));
const keyed = (browser, group) => as(browser, (m) => m.ensureGroupKeyed(group.chatId, group.id));
const groupBrowser = async (name, user, group, profile = name) => { const b = await reload(name, user, profile); await join(b, group); return b; };
const groupLie = (name, group, { detail, keys }) => lie(name, (method, url, json) => {
  if (method !== 'GET') return undefined;
  if (detail && url === `/api/groups/${group.id}`) return typeof detail === 'function' ? detail(json) : { ...json, ...detail };
  if (keys && url.endsWith('version=latest')) return keys;
  return undefined;
});
const NOT_READY = /آماده نیست/;
const sendGroupMessage = async (browser, user, group, value) => {
  const encrypted = await encrypt(browser, user, group.chatId, value);
  const response = await inject(user, 'POST', `/api/chats/${group.chatId}/messages`, { kind: 'text', encrypted, keyVersion: encrypted.keyVersion, clientMsgId: `cm-${randomUUID()}` });
  assert.equal(response.statusCode, 201, response.body);
  return encrypted;
};
const readGroup = async (browser, user, group) => {
  const list = (await inject(user, 'GET', `/api/chats/${group.chatId}/messages`)).json();
  return (await Promise.all(list.map(async (message) => (await as(browser, (m) => m.decryptMessage(message))).text))).filter((t) => !t.startsWith('🔒'));
};
/** The browser re-checks the group after KEY_RECHECK_MS (3 s): every call moves the clock another 10 s ahead (it never goes back). */
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = async (fn) => { skew += 10_000; return fn(); };
const pinsOf = (profile) => profileOf(profile).stores.pins;
const fingerprintOfIdentity = (profile, user) => profileOf(profile).stores.identities.get(String(ids[user])).fingerprint;
const acceptAll = async (browser, chatId) => {
  const changes = await as(browser, (m) => m.checkKeyChanges(chatId));
  for (const change of changes) await as(browser, (m) => m.acceptKeyChange(chatId, change));
  return changes;
};

// ---- R3: a warm cache is not a permanent permission to send -------------------------------------------------------------------------------------
test('R3: version 1 was wrapped by C and used; C leaves; a lying server hides the rotation: sending with the cached version 1 is refused', async () => {
  const g = await makeGroup('r3o', ['r3c', 'r3m']);
  await makeAdmin('r3o', g.id, 'r3c');
  const owner = await groupBrowser('r3o', 'r3o', g); const c = await groupBrowser('r3c', 'r3c', g); const m = await groupBrowser('r3m', 'r3m', g);
  assert.deepEqual(await keyed(c, g), { keyed: true, rotated: true });        // C wraps version 1
  assert.equal((await sendGroupMessage(m, 'r3m', g, 'v1')).keyVersion, 1);    // m opens it, pins C, and the cache is warm
  const old = (await inject('r3m', 'GET', `/api/groups/${g.id}/keys?version=1`)).json();
  assert.equal(old.length, 1);
  assert.equal((await inject('r3c', 'POST', `/api/groups/${g.id}/leave`)).statusCode, 204);
  // the malicious API: the member list is true (C is gone), but the rotation is hidden and "latest" is C's version 1 again
  groupLie('r3m', g, { detail: { keyVersion: 1, pendingKeyVersion: null }, keys: old });
  await later(async () => {
    await assert.rejects(encrypt(m, 'r3m', g.chatId, 'v1 again'), NOT_READY);
    await assert.rejects(encrypt(m, 'r3m', g.chatId, 'v1 again, second try'), NOT_READY, 'still refused on the next try');
  });
  assert.deepEqual(await readGroup(m, 'r3m', g), ['v1'], 'reading version 1 through the same browser still works');
  tamper.delete('r3m');
  // honest server: the rotation is pending; once the owner made version 2 sending works with it
  await later(() => assert.rejects(encrypt(m, 'r3m', g.chatId), NOT_READY));
  assert.deepEqual(await keyed(owner, g), { keyed: true, rotated: true });
  assert.equal((await later(() => encrypt(m, 'r3m', g.chatId, 'v2'))).keyVersion, 2);
});

// ---- R4: Astra's scenario ------------------------------------------------------------------------------------------------------------------------
test('R4: a member\'s key changed and an admin already made the next version: sending is refused with KeyChangedError until the user accepts; then it works', async () => {
  const g = await makeGroup('r4c', ['r4a', 'r4b']);
  const c = await groupBrowser('r4c', 'r4c', g); const a = await groupBrowser('r4a', 'r4a', g); const b = await groupBrowser('r4b', 'r4b', g);
  assert.deepEqual(await keyed(c, g), { keyed: true, rotated: true });          // admin C (the owner) makes version 1
  // Alice pins Bob's current key (B1) the normal way: she writes to him in a direct chat.
  const dm = await makeChat('r4a', 'r4b');
  const dmEncrypted = await as(a, (x) => x.encryptContent(dm, String(ids.r4a), text('hi bob')));
  assert.ok(dmEncrypted.keyVersion >= 1);
  const b1 = fingerprintOfIdentity('r4b', 'r4b');
  assert.equal(pinsOf('r4a').get(`${ids.r4a}:${ids.r4b}`)?.at(-1), b1, 'Alice pinned B1');
  assert.equal((await sendGroupMessage(a, 'r4a', g, 'v1 از آلیس')).keyVersion, 1);
  // Bob starts fresh (B2); C accepts it and makes version 2 (nothing pending any more)
  await startFresh('r4b2', 'r4b', 'r4b-new');
  const owner = await groupBrowser('r4c', 'r4c', g);
  assert.equal((await acceptAll(owner, g.chatId)).length, 1);
  assert.deepEqual(await keyed(owner, g), { keyed: true, rotated: true });
  const detail = (await inject('r4a', 'GET', `/api/groups/${g.id}`)).json();
  assert.equal(detail.keyVersion, 2); assert.equal(detail.pendingKeyVersion, null);
  // Alice's send with version 2: refused, no message is made
  const page = await groupBrowser('r4a', 'r4a', g);
  const b2 = fingerprintOfIdentity('r4b2', 'r4b');
  await assert.rejects(encrypt(page, 'r4a', g.chatId, 'v2 before accepting'), (e) => e.name === 'KeyChangedError' && e.memberId === String(ids.r4b) && e.oldFingerprint === b1 && e.newFingerprint === b2);
  assert.equal(profileOf('r4a').stores.keyFloors.get(`${ids.r4a}:${g.chatId}`).used, 1, 'version 2 was not used');
  // she accepts B2 and sends with version 2 (on this branch the accept raises the floor to used+1 = 2; after merging S10a it is only the pending version: both allow 2)
  assert.equal((await acceptAll(page, g.chatId)).length, 1);
  const sent = await sendGroupMessage(page, 'r4a', g, 'v2 after accepting');
  assert.equal(sent.keyVersion, 2);
  // the admin who accepted and rotated sends too, and Alice reads it
  assert.equal((await sendGroupMessage(owner, 'r4c', g, 'v2 از مدیر')).keyVersion, 2);
  assert.deepEqual((await readGroup(page, 'r4a', g)).sort(), ['v1 از آلیس', 'v2 after accepting', 'v2 از مدیر'].sort());
});

// ---- honest paths --------------------------------------------------------------------------------------------------------------------------------
test('honest: a group without any identity change sends again and again (also after the re-check interval)', async () => {
  const g = await makeGroup('h1o', ['h1m']);
  const owner = await groupBrowser('h1o', 'h1o', g); const m = await groupBrowser('h1m', 'h1m', g);
  assert.deepEqual(await keyed(owner, g), { keyed: true, rotated: true });
  for (let i = 0; i < 3; i += 1) assert.equal((await sendGroupMessage(m, 'h1m', g, `m${i}`)).keyVersion, 1);
  for (let i = 0; i < 3; i += 1) assert.equal((await later(() => sendGroupMessage(owner, 'h1o', g, `o${i}`))).keyVersion, 1);
  await later(async () => { assert.equal((await sendGroupMessage(m, 'h1m', g, 'again')).keyVersion, 1); });
  assert.equal((await readGroup(m, 'h1m', g)).length, 7);
  const reopened = await groupBrowser('h1m', 'h1m', g);
  assert.equal((await sendGroupMessage(reopened, 'h1m', g, 'after reload')).keyVersion, 1);
});

test('honest: a member Alice has no pin for is not pinned by sending (trust on first use is unchanged) and does not block it', async () => {
  const g = await makeGroup('h3o', ['h3a', 'h3d']);
  const owner = await groupBrowser('h3o', 'h3o', g); const alice = await groupBrowser('h3a', 'h3a', g);
  assert.deepEqual(await keyed(owner, g), { keyed: true, rotated: true });
  assert.equal((await sendGroupMessage(alice, 'h3a', g, 'hello')).keyVersion, 1);
  const pins = pinsOf('h3a');
  assert.ok(pins.has(`${ids.h3a}:${ids.h3o}`), 'the wrapper was pinned, as before');
  assert.ok(!pins.has(`${ids.h3a}:${ids.h3d}`), 'the member who wrote nothing is still unpinned');
});

test('honest: a member with no public key (reset, not registered again yet): sending behaves as before', async () => {
  const g = await makeGroup('h4o', ['h4a', 'h4b']);
  const owner = await groupBrowser('h4o', 'h4o', g); const alice = await groupBrowser('h4a', 'h4a', g);
  assert.deepEqual(await keyed(owner, g), { keyed: true, rotated: true });
  await sendGroupMessage(alice, 'h4a', g, 'one');
  // a member whose key is null and a pin exists for him (Alice wrote to him in a direct chat before)
  const dm = await makeChat('h4a', 'h4b');
  await as(alice, (x) => x.encryptContent(dm, String(ids.h4a), text('hi')));
  assert.ok(pinsOf('h4a').has(`${ids.h4a}:${ids.h4b}`));
  groupLie('h4a', g, { detail: (json) => ({ ...json, members: json.members.map((member) => (String(member.id) === String(ids.h4b) ? { ...member, publicKey: null } : member)) }) });
  await later(async () => {
    assert.equal((await sendGroupMessage(alice, 'h4a', g, 'two')).keyVersion, 1, 'a member without a key does not block the send (as before; the server holds the rotation)');
  });
  tamper.delete('h4a');
});

// ---- UI: the send-error handling in Conversation.tsx (source check; the component itself needs a browser, see tests/web-e2e) ---------------------
test('UI: KeyChangedError while sending (text, sticker/gif, edit, attachments) refreshes the key-change banner and shows the accurate message', async () => {
  const source = await readFile(path.join(src, 'Conversation.tsx'), 'utf8');
  const body = (name) => { const start = source.indexOf(`const ${name} = async`); assert.ok(start > 0, name); return source.slice(start, source.indexOf('\n  };\n', start)); };
  assert.match(source, /const keyChangedWhileSending = \(\) => \{ setKeyDismissed\(false\); void refreshKeyChanges\(\); \};/);
  for (const name of ['sendText', 'sendMedia', 'submit']) assert.match(body(name), /instanceof KeyChangedError\)[^\n]*keyChangedWhileSending\(\)|instanceof KeyChangedError\) keyChangedWhileSending\(\)/, name);
  assert.match(body('sendText'), /KEY_CHANGED_COPY[^\n]*متن شما نگه داشته شد/);
  assert.match(source, /discard: \(temporary, caught\) => \{\n\s+failedId = temporary\.id;\n\s+if \(caught instanceof KeyChangedError\) \{ keyChangedWhileSending\(\); failedCopy = KEY_CHANGED_COPY; \}/);
  const attachment = source.slice(source.indexOf('const attachWith'), source.indexOf('const attach ='));
  assert.match(attachment, /markFailed\(temporary\.id, failedCopy \?\?/);
  assert.match(attachment, /error: failedCopy \?\? copy/);
  assert.doesNotMatch(source.slice(source.indexOf('const KEY_CHANGED_COPY'), source.indexOf('const KEY_CHANGED_COPY') + 200), /باید یک‌بار وارد شود/);
});
