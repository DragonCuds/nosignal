// S9a (NS-07c): key freshness on the client. The real apps/web/src/e2ee.ts (bundled with esbuild, a fake IndexedDB per "browser", WebCrypto)
// talks to the real server code in-process, sometimes through a lying server (the `tamper` hooks):
//  1. a missing/empty fingerprint is no reason to skip the pin check, 2. an older key version is not accepted as the current one
//  (local version floor; a group wrapper who left is not current), 3. media key version mismatch in groups,
//  5. reading old messages does not depend on a usable current key, 6. a version outside the newest 32 can be fetched.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-freshness-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'freshness-test-secret-with-at-least-32-bytes';
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
const outDir = await mkdtemp(path.join(os.tmpdir(), 'tel-freshness-bundle-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './e2ee.ts'; export * from './dmKeys.ts'; export * from './pins.ts'; export * from './keyErrors.ts'; export { ApiError } from './api.js';`,
    resolveDir: src, sourcefile: 'entry.ts', loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  plugins: [{ name: 'mocks', setup(b) {
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
const ip = () => `10.19.${nextIp >> 8}.${nextIp++ & 255}`;
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
  for (const name of ['ana', 'ben', 'cyd', 'dan', 'kim', 'lou', 'eli', 'fay', 'gus', 'hel', 'gia', 'hal', 'ivy', 'jon']) ids[name] = await createUser(name, name, PASSWORD);
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
const sorted = (list) => [...list].sort();
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
const envelopePosts = () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/crypto/envelopes'));
const newKey = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return crypto.subtle.exportKey('jwk', pair.publicKey);
};

// ---- finding 1: a missing fingerprint must not let a key without a pin through ---------------------------------------------------------------
test('S9a-1: the server sends the new key of a pinned contact with an empty, null or missing fingerprint: no envelope is made for it', async () => {
  const ana = await open('ana', 'ana'); const ben = await open('ben', 'ben');
  await init(ana, 'ana'); await init(ben, 'ben');
  const chat = await makeChat('ana', 'ben');
  await sendMessageOk(ben, 'ben', chat, 'v1 از بن');
  assert.deepEqual(await readAll(ana, 'ana', chat), ['v1 از بن']); // ana pins ben
  await startFresh('ben2', 'ben', 'ben-new');                      // pending version 2: ana is asked to create the next key
  const evilKey = await newKey();
  const swap = (fingerprint) => (method, url, json) => (method === 'GET' && url.endsWith('/crypto')
    ? { ...json, members: json.members.map((m) => (String(m.userId) === String(ids.ben)
      ? { userId: m.userId, publicKey: evilKey, ...(fingerprint === undefined ? {} : { fingerprint }) } : m)) }
    : undefined);
  for (const [label, fingerprint] of [['empty', ''], ['null', null], ['missing', undefined]]) {
    const page = await reload('ana', 'ana');
    lie('ana', swap(fingerprint));
    requests.length = 0;
    await assert.rejects(encrypt(page, 'ana', chat), (e) => e.name === 'KeyChangedError', label);
    assert.equal(envelopePosts().length, 0, `${label}: nothing was wrapped for the unpinned key`);
    tamper.delete('ana');
  }
  const page = await reload('ana', 'ana');
  lie('ana', swap('0'.repeat(64)));
  await assert.rejects(encrypt(page, 'ana', chat), /Invalid encryption identity fingerprint/, 'a fingerprint that does not match the key is an error');
  tamper.delete('ana');
});
const sendMessageOk = async (...args) => (await sendMessage(...args)).encrypted;

// ---- finding 2 (direct chats): the version floor ---------------------------------------------------------------------------------------------
const floorOf = (profile, user, chatId) => profileOf(profile).stores.keyFloors.get(`${ids[user]}:${chatId}`);
test('S9a-2: after accepting the contact\'s new key, going back to the old version is refused, even though the new version was never seen here', async () => {
  const dan = await open('dan', 'dan'); const cy = await open('cyd', 'cyd');
  await init(dan, 'dan'); await init(cy, 'cyd');
  const chat = await makeChat('dan', 'cyd');
  await sendMessageOk(dan, 'dan', chat, 'v1 از دن');                       // dan creates version 1: his own envelope opens with his key
  assert.deepEqual(await readAll(cy, 'cyd', chat), ['v1 از دن']);
  await startFresh('cyd2', 'cyd', 'cyd-new');                                   // cy starts fresh; nobody has made version 2 yet
  const page = await reload('dan', 'dan');
  const changes = await as(page, (m) => m.checkKeyChanges(chat));
  assert.equal(changes.length, 1);
  await as(page, (m) => m.acceptKeyChange(chat, changes[0]));
  const rollback = (method, url, json) => (method === 'GET' && url.endsWith('/crypto')
    ? { ...json, keyVersion: 1, pendingKeyVersion: null, envelopes: json.envelopes.filter((e) => e.version === 1) } : undefined);
  const lying = await reload('dan', 'dan');
  lie('dan', rollback);
  await assert.rejects(encrypt(lying, 'dan', chat), (e) => e.name === 'ChatKeyRollbackError');
  assert.deepEqual(await readAll(lying, 'dan', chat), ['v1 از دن'], 'reading the old messages is not affected');
  tamper.delete('dan');
  assert.deepEqual(floorOf('dan', 'dan', chat), { floor: 2, used: 1 });
});
test('S9a-2b: using a version raises the floor by itself; after a page reload (empty cache) the old version is still refused', async () => {
  const kim = await open('kim', 'kim'); const lou = await open('lou', 'lou');
  await init(kim, 'kim'); await init(lou, 'lou');
  const chat = await makeChat('kim', 'lou');
  await sendMessageOk(kim, 'kim', chat, 'v1 از کیم');
  await readAll(lou, 'lou', chat);
  await startFresh('lou2', 'lou', 'lou-new');
  await sendMessageOk(await reload('lou2', 'lou', 'lou-new'), 'lou', chat, 'v2 از لو'); // lou creates version 2
  const kimPage = await reload('kim', 'kim');
  for (const change of await as(kimPage, (m) => m.checkKeyChanges(chat))) await as(kimPage, (m) => m.acceptKeyChange(chat, change));
  assert.equal(floorOf('kim', 'kim', chat).floor, 2, 'version 2 was made after the change by the accepted key: it is allowed, version 1 is not');
  profileOf('kim').stores.keyFloors.clear();                                 // forget what accepting wrote: only use is left
  assert.equal((await encrypt(await reload('kim', 'kim'), 'kim', chat)).keyVersion, 2);
  assert.deepEqual(floorOf('kim', 'kim', chat), { floor: 2, used: 2 });
  const lying = await reload('kim', 'kim');
  lie('kim', (method, url, json) => (method === 'GET' && url.endsWith('/crypto')
    ? { ...json, keyVersion: 1, pendingKeyVersion: null, envelopes: json.envelopes.filter((e) => e.version === 1) } : undefined));
  await assert.rejects(encrypt(lying, 'kim', chat), (e) => e.name === 'ChatKeyRollbackError');
  tamper.delete('kim');
  assert.equal((await encrypt(await reload('kim', 'kim'), 'kim', chat)).keyVersion, 2, 'the honest server still works');
});

// ---- finding 2 (groups) ----------------------------------------------------------------------------------------------------------------------
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
  if (detail && url === `/api/groups/${group.id}`) return { ...json, ...detail };
  if (keys && url.endsWith('version=latest')) return keys;
  return undefined;
});
const NOT_READY = /آماده نیست/;

test('S9a-2c: a rotation is pending (a member left): sending in the group is refused even though a current member wrapped the key', async () => {
  const g = await makeGroup('gia', ['hal', 'ivy']);
  const gia = await open('gia', 'gia'); const hal = await open('hal', 'hal'); const ivy = await open('ivy', 'ivy');
  for (const [b, u] of [[gia, 'gia'], [hal, 'hal'], [ivy, 'ivy']]) { await init(b, u); await join(b, g); }
  assert.deepEqual(await keyed(gia, g), { keyed: true, rotated: true });
  assert.equal((await encrypt(ivy, 'ivy', g.chatId)).keyVersion, 1, 'sanity: sending works while nothing is pending');
  assert.equal((await inject('hal', 'POST', `/api/groups/${g.id}/leave`)).statusCode, 204);
  const page = await groupBrowser('ivy', 'ivy', g);
  await assert.rejects(encrypt(page, 'ivy', g.chatId), NOT_READY);
});

test('S9a-2d: the envelope of a member who left, handed out as "latest": not chosen for sending', async () => {
  const g = await makeGroup('gia', ['hal', 'ivy', 'jon']);
  await makeAdmin('gia', g.id, 'hal');
  const gia = await reload('gia', 'gia'); const hal = await reload('hal', 'hal'); const ivy = await reload('ivy', 'ivy'); await reload('jon', 'jon');
  for (const b of [gia, hal, ivy]) await join(b, g);
  assert.deepEqual(await keyed(hal, g), { keyed: true, rotated: true });     // hal (admin) wraps version 1
  await sendGroupMessage(hal, 'hal', g, 'از هال');
  assert.deepEqual(await readGroup(ivy, 'ivy', g), ['از هال']);              // ivy pins hal
  const old = (await inject('ivy', 'GET', `/api/groups/${g.id}/keys?version=1`)).json();
  assert.equal(old.length, 1);
  assert.equal((await inject('hal', 'POST', `/api/groups/${g.id}/leave`)).statusCode, 204);
  assert.deepEqual(await keyed(gia, g), { keyed: true, rotated: true });     // gia (owner) makes version 2
  // the server lies: hal is not in the member list (that part is true), but version 1 is "latest" and nothing is pending
  const page = await groupBrowser('ivy', 'ivy', g);
  groupLie('ivy', g, { detail: { keyVersion: 1, pendingKeyVersion: null }, keys: old });
  await assert.rejects(encrypt(page, 'ivy', g.chatId), NOT_READY);
  assert.deepEqual(await readGroup(page, 'ivy', g), ['از هال'], 'reading version 1 through it still works');
  tamper.delete('ivy');
  assert.equal((await encrypt(await groupBrowser('ivy', 'ivy', g), 'ivy', g.chatId)).keyVersion, 2, 'the honest server: version 2');
});
const sendGroupMessage = async (browser, user, group, value) => {
  const encrypted = await encrypt(browser, user, group.chatId, value);
  const response = await inject(user, 'POST', `/api/chats/${group.chatId}/messages`, { kind: 'text', encrypted, keyVersion: encrypted.keyVersion, clientMsgId: `cm-${randomUUID()}` });
  assert.equal(response.statusCode, 201, response.body);
};
const readGroup = async (browser, user, group) => {
  const list = (await inject(user, 'GET', `/api/chats/${group.chatId}/messages`)).json();
  return (await Promise.all(list.map(async (message) => (await as(browser, (m) => m.decryptMessage(message))).text))).filter((t) => !t.startsWith('🔒'));
};

test('S9a-2e: an old group version handed out as "latest" while the group is at a newer one, or below this browser\'s floor: refused', async () => {
  const g = await makeGroup('gia', ['ivy']);
  const gia = await groupBrowser('gia', 'gia', g); const ivy = await groupBrowser('ivy', 'ivy', g);
  assert.deepEqual(await keyed(gia, g), { keyed: true, rotated: true });
  await sendGroupMessage(ivy, 'ivy', g, 'v1');
  await as(gia, (m) => m.rotateGroupKey(g.chatId, g.id));                   // version 2, wrapped by gia (a member)
  assert.deepEqual((await inject('gia', 'GET', `/api/groups/${g.id}`)).json().keyVersion, 2);
  const old = (await inject('ivy', 'GET', `/api/groups/${g.id}/keys?version=1`)).json();
  const page = await groupBrowser('ivy', 'ivy', g);
  groupLie('ivy', g, { keys: old });                                         // the group is honestly at 2; "latest" is version 1 by a member
  await assert.rejects(encrypt(page, 'ivy', g.chatId), NOT_READY, 'older than the group\'s current version');
  tamper.delete('ivy');
  const honest = await groupBrowser('ivy', 'ivy', g);
  assert.equal((await encrypt(honest, 'ivy', g.chatId)).keyVersion, 2);
  assert.deepEqual(profileOf('ivy').stores.keyFloors.get(`${ids.ivy}:${g.chatId}`), { floor: 2, used: 2 });
  const consistent = await groupBrowser('ivy', 'ivy', g);
  groupLie('ivy', g, { detail: { keyVersion: 1, pendingKeyVersion: null }, keys: old });   // the whole group state rolled back
  await assert.rejects(encrypt(consistent, 'ivy', g.chatId), (e) => e.name === 'ChatKeyRollbackError');
  tamper.delete('ivy');
});

// ---- finding 3: media key version in groups ---------------------------------------------------------------------------------------------------
test('S9a-3: the group key rotates while media is being uploaded: the message is not sealed with a different version than the media', async () => {
  const g = await makeGroup('gia', ['jon']);
  const gia = await groupBrowser('gia', 'gia', g); const jon = await groupBrowser('jon', 'jon', g);
  assert.deepEqual(await keyed(gia, g), { keyed: true, rotated: true });
  const media = await as(jon, (m) => m.currentChatKey(g.chatId));            // the media is sealed with this key
  assert.equal(media.version, 1);
  await as(gia, (m) => m.rotateGroupKey(g.chatId, g.id));                    // ...and the key rotates during the upload
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;                                       // the upload took a while (the browser re-checks the group)
  try {
    await assert.rejects(encrypt(jon, 'jon', g.chatId, 'x', media.version), (e) => e.name === 'StaleChatKeyError');
    assert.equal((await encrypt(jon, 'jon', g.chatId, 'x', 2)).keyVersion, 2, 'sealing again with the new version is fine');
  } finally { Date.now = realNow; }
});

// ---- finding 5: reading does not depend on the key for new messages ------------------------------------------------------------------------------
test('S9a-5: the contact started fresh and has no identity yet (the next version is pending): old messages still open', async () => {
  const eli = await open('eli', 'eli'); const fay = await open('fay', 'fay');
  await init(eli, 'eli'); await init(fay, 'fay');
  const chat = await makeChat('eli', 'fay');
  await sendMessageOk(fay, 'fay', chat, 'از فی');
  await sendMessageOk(eli, 'eli', chat, 'از الی');
  assert.deepEqual(sorted(await readAll(eli, 'eli', chat)), sorted(['از فی', 'از الی'])); // eli pins fay
  // what "start fresh" leaves on the server when the browser drops before it registers the new identity
  await db.query('DELETE FROM chat_key_envelopes WHERE chat_id = $1 AND recipient_id = $2', [chat, ids.fay]);
  await db.query('DELETE FROM user_crypto_identities WHERE user_id = $1', [ids.fay]);
  await db.query('UPDATE direct_chat_keys SET pending_version = 2 WHERE chat_id = $1', [chat]);
  const page = await reload('eli', 'eli');
  requests.length = 0;
  assert.deepEqual(sorted(await readAll(page, 'eli', chat)), sorted(['از فی', 'از الی']));
  assert.equal(envelopePosts().length, 0, 'reading created no key');
  await assert.rejects(encrypt(page, 'eli', chat), 'sending is not possible yet (the contact has no key)');
});

// ---- finding 6: a version older than the newest 32 ------------------------------------------------------------------------------------------------
test('S9a-6: a chat with more than 32 key versions: a message of version 1 still opens (the version is fetched on its own)', async () => {
  // Users 9 and 10: text order and numeric order of their ids differ (they used to make the first key upload fail with "Invalid envelope set").
  assert.notEqual([ids.gus, ids.hel].map(String).sort().join(), [ids.gus, ids.hel].map(Number).sort((a, b) => a - b).join(), 'test setup: ids must cross a digit boundary');
  const gus = await open('gus', 'gus'); const hel = await open('hel', 'hel');
  await init(gus, 'gus'); await init(hel, 'hel');
  const chat = await makeChat('gus', 'hel');
  await sendMessageOk(gus, 'gus', chat, 'از گاس');
  assert.deepEqual(await readAll(hel, 'hel', chat), ['از گاس']);              // hel pins gus
  const versions = Array.from({ length: 39 }, (_, i) => i + 2);
  await db.query(
    `INSERT INTO chat_key_envelopes (chat_id, version, recipient_id, sender_id, sender_fingerprint, sender_public_jwk, nonce, ciphertext)
     SELECT e.chat_id, v.value, e.recipient_id, e.sender_id, e.sender_fingerprint, e.sender_public_jwk, e.nonce, e.ciphertext
     FROM chat_key_envelopes e, json_each($2) v WHERE e.chat_id = $1 AND e.recipient_id = $3 AND e.version = 1`,
    [chat, JSON.stringify(versions), ids.hel]);
  await db.query('UPDATE direct_chat_keys SET key_version = 40 WHERE chat_id = $1', [chat]);
  const list = (await inject('hel', 'GET', `/api/chats/${chat}/crypto`)).json();
  assert.equal(list.envelopes.length, 32);
  assert.ok(!list.envelopes.some((e) => e.version === 1), 'version 1 is outside the newest 32');
  const one = (await inject('hel', 'GET', `/api/chats/${chat}/crypto?version=1`)).json();
  assert.deepEqual(one.envelopes.map((e) => e.version), [1], 'one version on request');
  assert.equal(one.keyVersion, 40);
  assert.equal((await inject('hel', 'GET', `/api/chats/${chat}/crypto?version=77`)).json().envelopes.length, 0);
  for (const bad of ['0', 'abc', '-1', '1.5', '99999999']) assert.equal((await inject('hel', 'GET', `/api/chats/${chat}/crypto?version=${bad}`)).statusCode, 400, bad);
  assert.equal((await inject('cyd', 'GET', `/api/chats/${chat}/crypto?version=1`)).statusCode, 404, 'not a member');
  const page = await reload('hel', 'hel');
  assert.deepEqual(await readAll(page, 'hel', chat), ['از گاس']);
});
