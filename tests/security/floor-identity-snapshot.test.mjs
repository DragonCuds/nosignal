// S10a (R1, R2): the key floor remembers WHO the members were when a version was last used.
// (Harness copied from key-freshness-client.test.mjs.) Original header: key freshness on the client. The real apps/web/src/e2ee.ts (bundled with esbuild, a fake IndexedDB per "browser", WebCrypto)
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-floor-identity-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'floor-identity-test-secret-with-at-least-32-bytes';
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
const outDir = await mkdtemp(path.join(os.tmpdir(), 'tel-floor-identity-bundle-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './${process.env.E2EE_FILE ?? 'e2ee.ts'}'; export * from './dmKeys.ts'; export * from './pins.ts'; export * from './keyErrors.ts'; export { ApiError } from './api.js';`,
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
  const fault = { floorWrites: false }; // when set, a write transaction on keyFloors throws (a crash/quota error part-way through acceptKeyChange)
  const open = () => {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: (name) => name in stores },
        close() {},
        transaction(name, mode) {
          if (fault.floorWrites && name === 'keyFloors' && mode === 'readwrite') throw new Error('injected: keyFloors write failed');
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
  return { open, stores, fault };
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

const USERS = Array.from({ length: 10 }, (_, i) => ['a', 'b', 'c'].map((p) => `u${p}${i + 1}`)).flat(); // a=Alice, b=Bob, c=Carl, one trio per test
before(async () => {
  await runMigrations();
  for (const name of USERS) ids[name] = await createUser(name, name, PASSWORD);
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


// ---- group helpers (as in key-freshness-client.test.mjs) ----------------------------------------------------------------------------------
const makeGroup = async (owner, members) => {
  for (const user of [owner, ...members]) await init(await open(`pre-${user}`, user, user), user); // every member needs a registered identity
  const response = await inject(owner, 'POST', '/api/groups', { title: 'گروه', memberIds: members.map((m) => ids[m]) });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
};
const join = (browser, group) => as(browser, (m) => m.registerGroupChat(group.chatId, group.id));
const keyed = (browser, group) => as(browser, (m) => m.ensureGroupKeyed(group.chatId, group.id));
const groupBrowser = async (name, user, group, profile = name) => { const b = await reload(name, user, profile); await join(b, group); return b; };
const groupLie = (name, group, { detail, keys }) => lie(name, (method, url, json) => {
  if (method !== 'GET') return undefined;
  if (detail && url === `/api/groups/${group.id}`) return { ...json, ...detail };
  if (keys && url.endsWith('version=latest')) return keys;
  return undefined;
});
const post = async (user, chatId, encrypted) => {
  const response = await inject(user, 'POST', `/api/chats/${chatId}/messages`, { kind: 'text', encrypted, keyVersion: encrypted.keyVersion, clientMsgId: `cm-${randomUUID()}` });
  assert.equal(response.statusCode, 201, response.body);
};
const sendGroupMessage = async (browser, user, group, value) => { const encrypted = await encrypt(browser, user, group.chatId, value); await post(user, group.chatId, encrypted); return encrypted; };
/** A DM between two users whose browsers have registered their identities. */
const dmPair = async (a, b) => { await init(await open(a, a), a); await init(await open(b, b), b); return makeChat(a, b); };
const isRollback = (e) => e.name === 'ChatKeyRollbackError';

// ---- what is stored / what the lying server says ------------------------------------------------------------------------------------------
const floorRecord = (user, chatId) => profileOf(user).stores.keyFloors.get(`${ids[user]}:${chatId}`);
const pinsOf = (user, contact) => profileOf(user).stores.pins.get(`${ids[user]}:${ids[contact]}`);
/** Our own envelope of version 1 of a direct chat, as the server has it before the contact starts fresh. */
const ownV1 = async (user, chatId) => (await inject(user, 'GET', `/api/chats/${chatId}/crypto`)).json().envelopes.filter((e) => e.version === 1 && String(e.senderId) === String(ids[user]));
/** The malicious API of finding R1/R2: the members are right (the new identity), but the chat is at version 1 with our own old envelope, nothing pending. */
const dmBackToV1 = (name, envelopes) => lie(name, (method, url, json) => (method === 'GET' && url.endsWith('/crypto')
  ? { ...json, keyVersion: 1, pendingKeyVersion: null, envelopes } : undefined));
const getsOfCrypto = () => requests.filter((r) => r.method === 'GET' && /\/crypto(\?|$)/u.test(r.url));
const acceptAll = async (browser, chatId) => {
  const changes = await as(browser, (m) => m.checkKeyChanges(chatId));
  assert.equal(changes.length, 1, 'exactly one identity change to accept');
  await as(browser, (m) => m.acceptKeyChange(chatId, changes[0]));
};

// ====================================================================================================================================================
// R1: a pin belongs to a contact, a floor to a chat. Accepting the contact's new identity in one chat must close the other chat too.
// ====================================================================================================================================================
test('S10a-R1a: Alice used v1 in the DM, accepts Bob\'s new identity in the GROUP: a malicious DM API that hands back v1 is refused, also after a reload', async () => {
  const [A, B, C] = ['ua1', 'ub1', 'uc1'];
  const g = await makeGroup(C, [A, B]);
  const chat = await dmPair(A, B);
  const alice = await reload(A, A);
  await sendMessage(alice, A, chat, 'v1');
  const b1 = pinsOf(A, B)[0];
  assert.equal(floorRecord(A, chat).used, 1);
  const envelopes = await ownV1(A, chat);
  assert.equal(envelopes.length, 1);
  await startFresh(`${B}2`, B, `${B}-new`);                                   // Bob: B1 -> B2
  const inGroup = await groupBrowser(A, A, g);
  await acceptAll(inGroup, g.chatId);                                          // accepted in the group
  assert.equal(pinsOf(A, B).at(-1) !== b1, true, 'the shared pin of Bob moved to B2');
  assert.equal(floorRecord(A, chat).floor, 1, 'the DM floor itself was not touched (this is the R1 gap)');
  dmBackToV1(A, envelopes);
  await assert.rejects(encrypt(inGroup, A, chat), isRollback, 'same page');
  await assert.rejects(encrypt(await reload(A, A), A, chat), isRollback, 'after a reload');
  tamper.delete(A);
  assert.deepEqual(floorRecord(A, chat), { floor: 1, used: 1, pins: { [ids[B]]: b1 } }, 'the record holds the pin of Bob as it was when v1 was used');
  const honest = await reload(A, A);                                           // the honest server: Bob has not made v2 yet, Alice makes it
  assert.equal((await encrypt(honest, A, chat)).keyVersion, 2);
});

test('S10a-R1b: Alice used v1 in the GROUP, accepts Bob\'s new identity in the DM: a malicious group API that hands back v1 is refused, also after a reload', async () => {
  const [A, B, C] = ['ua2', 'ub2', 'uc2'];
  const g = await makeGroup(C, [A, B]);
  const chat = await dmPair(A, B);
  await sendMessage(await reload(A, A), A, chat, 'dm');                        // Alice pins Bob in the DM
  const carl = await groupBrowser(C, C, g);
  assert.deepEqual(await keyed(carl, g), { keyed: true, rotated: true });      // v1, wrapped by Carl (a member who stays)
  const alice = await groupBrowser(A, A, g);
  assert.equal((await sendGroupMessage(alice, A, g, 'g1')).keyVersion, 1);
  const old = (await inject(A, 'GET', `/api/groups/${g.id}/keys?version=1`)).json();
  await startFresh(`${B}2`, B, `${B}-new`);
  const inDm = await reload(A, A);
  await acceptAll(inDm, chat);                                                 // accepted in the DM
  assert.equal(floorRecord(A, g.chatId).floor, 1, 'the group floor itself was not touched');
  for (const label of ['first load', 'after a reload']) {
    const page = await groupBrowser(A, A, g);
    groupLie(A, g, { detail: { keyVersion: 1, pendingKeyVersion: null }, keys: old });
    await assert.rejects(encrypt(page, A, g.chatId), isRollback, label);
    tamper.delete(A);
  }
  assert.deepEqual(Object.keys(floorRecord(A, g.chatId).pins).sort(), [ids[B], ids[C]].map(String).sort(), 'snapshot: the other two members');
});

// ====================================================================================================================================================
// R2: a failure in acceptKeyChange must not leave a new pin together with an unchanged floor.
// ====================================================================================================================================================
test('S10a-R2a: the network call after the pin is accepted throws: v1 is refused afterwards (same page and after a reload), caches were cleared', async () => {
  const [A, B] = ['ua3', 'ub3'];
  const chat = await dmPair(A, B);
  const alice = await reload(A, A);
  await sendMessage(alice, A, chat, 'v1');                                    // the key cache of this page is now warm
  const envelopes = await ownV1(A, chat);
  await startFresh(`${B}2`, B, `${B}-new`);
  const changes = await as(alice, (m) => m.checkKeyChanges(chat));
  assert.equal(changes.length, 1);
  let calls = 0;
  lie(A, (method, url) => { if (method === 'GET' && /\/crypto$/u.test(url) && ++calls >= 2) throw new Error('network down'); return undefined; });
  await as(alice, (m) => m.acceptKeyChange(chat, changes[0])).catch(() => undefined); // the old code fails here, after writing the pin
  dmBackToV1(A, envelopes);
  requests.length = 0;
  await assert.rejects(encrypt(alice, A, chat), isRollback, 'same page');
  assert.ok(getsOfCrypto().length > 0, 'the key caches were cleared: the page asked the server again');
  await assert.rejects(encrypt(await reload(A, A), A, chat), isRollback, 'after a reload');
  tamper.delete(A);
});

test('S10a-R2b: the floor cannot be written after the pin was: the pin snapshot alone keeps v1 unusable (DM)', async () => {
  const [A, B] = ['ua4', 'ub4'];
  const chat = await dmPair(A, B);
  const alice = await reload(A, A);
  await sendMessage(alice, A, chat, 'v1');
  const envelopes = await ownV1(A, chat);
  const b1 = pinsOf(A, B)[0];
  await startFresh(`${B}2`, B, `${B}-new`);
  const changes = await as(alice, (m) => m.checkKeyChanges(chat));
  profileOf(A).fault.floorWrites = true;                                      // writePins goes through, the floor write fails
  await assert.rejects(as(alice, (m) => m.acceptKeyChange(chat, changes[0])), /injected/u);
  profileOf(A).fault.floorWrites = false;
  assert.equal(pinsOf(A, B).length, 2, 'the new pin WAS written');
  assert.equal(floorRecord(A, chat).floor, 1, 'the floor was NOT raised: only the snapshot is left');
  dmBackToV1(A, envelopes);
  requests.length = 0;
  await assert.rejects(encrypt(alice, A, chat), isRollback, 'same page');
  assert.ok(getsOfCrypto().length > 0, 'caches are cleared in a finally, also when the accept failed');
  await assert.rejects(encrypt(await reload(A, A), A, chat), isRollback, 'after a reload');
  tamper.delete(A);
  assert.deepEqual(floorRecord(A, chat), { floor: 1, used: 1, pins: { [ids[B]]: b1 } }, 'what refused it is the snapshot of Bob\'s old pin');
});

test('S10a-R2c: same for a group: the floor write fails after the pin write, the snapshot alone refuses the old version', async () => {
  const [A, B, C] = ['ua5', 'ub5', 'uc5'];
  const g = await makeGroup(C, [A, B]);
  const chat = await dmPair(A, B);
  await sendMessage(await reload(A, A), A, chat, 'dm');
  assert.deepEqual(await keyed(await groupBrowser(C, C, g), g), { keyed: true, rotated: true });
  const alice = await groupBrowser(A, A, g);
  assert.equal((await sendGroupMessage(alice, A, g, 'g1')).keyVersion, 1);
  const old = (await inject(A, 'GET', `/api/groups/${g.id}/keys?version=1`)).json();
  await startFresh(`${B}2`, B, `${B}-new`);
  const changes = await as(alice, (m) => m.checkKeyChanges(g.chatId));
  profileOf(A).fault.floorWrites = true;
  await assert.rejects(as(alice, (m) => m.acceptKeyChange(g.chatId, changes[0])), /injected/u);
  profileOf(A).fault.floorWrites = false;
  assert.equal(pinsOf(A, B).length, 2);
  assert.equal(floorRecord(A, g.chatId).floor, 1);
  for (const label of ['same page', 'after a reload']) {
    const page = label === 'same page' ? alice : await groupBrowser(A, A, g);
    groupLie(A, g, { detail: { keyVersion: 1, pendingKeyVersion: null }, keys: old });
    await assert.rejects(encrypt(page, A, g.chatId), isRollback, label);
    tamper.delete(A);
  }
});

// ====================================================================================================================================================
// Honest paths must keep working.
// ====================================================================================================================================================
test('S10a-honest-dm: Bob starts fresh, the server asks for v2, Alice accepts, v2 is made and works; also after reloads', async () => {
  const [A, B] = ['ua6', 'ub6'];
  const chat = await dmPair(A, B);
  await sendMessage(await reload(A, A), A, chat, 'v1');
  await startFresh(`${B}2`, B, `${B}-new`);
  assert.equal((await inject(A, 'GET', `/api/chats/${chat}/crypto`)).json().pendingKeyVersion, 2);
  await acceptAll(await reload(A, A), chat);
  const sent = await sendMessage(await reload(A, A), A, chat, 'v2');
  assert.equal(sent.encrypted.keyVersion, 2);
  const bob = await reload(`${B}2`, B, `${B}-new`);
  assert.deepEqual((await readAll(bob, B, chat)).includes('v2'), true, 'Bob opens it');
  assert.equal((await sendMessage(await reload(A, A), A, chat, 'again')).encrypted.keyVersion, 2);
  assert.equal(floorRecord(A, chat).used, 2);
  assert.equal(floorRecord(A, chat).pins[ids[B]], pinsOf(A, B).at(-1), 'the snapshot follows the new pin');
});

test('S10a-honest-group: Bob starts fresh, an admin rotates to v2 (wrapped by the admin), Alice accepts and sends with v2: no rollback error, also after reloads', async () => {
  const [A, B, C] = ['ua7', 'ub7', 'uc7'];
  const g = await makeGroup(C, [A, B]);
  const chat = await dmPair(A, B);
  await sendMessage(await reload(A, A), A, chat, 'dm');                       // Alice pins Bob
  assert.deepEqual(await keyed(await groupBrowser(C, C, g), g), { keyed: true, rotated: true });
  assert.equal((await sendGroupMessage(await groupBrowser(A, A, g), A, g, 'g1')).keyVersion, 1);
  await startFresh(`${B}2`, B, `${B}-new`);
  assert.equal((await inject(C, 'GET', `/api/groups/${g.id}`)).json().pendingKeyVersion, 2);
  const carl = await groupBrowser(C, C, g);
  await acceptAll(carl, g.chatId);
  assert.deepEqual(await keyed(carl, g), { keyed: true, rotated: true });     // v2, wrapped by Carl
  const alice = await groupBrowser(A, A, g);
  await acceptAll(alice, g.chatId);
  assert.equal(floorRecord(A, g.chatId).floor, 1, 'nothing is pending any more: accepting does not raise the floor (no used+1 lock)');
  assert.equal((await sendGroupMessage(alice, A, g, 'g2')).keyVersion, 2);
  for (let i = 0; i < 3; i += 1) assert.equal((await sendGroupMessage(await groupBrowser(A, A, g), A, g, `g3-${i}`)).keyVersion, 2, `reload ${i}`);
  assert.equal(floorRecord(A, g.chatId).used, 2);
});

test('S10a-honest-nochange: nobody changes identity: a DM and a group keep working over many sends and reloads; the first send in a chat has no record yet', async () => {
  const [A, B, C] = ['ua8', 'ub8', 'uc8'];
  const g = await makeGroup(C, [A, B]);
  const chat = await dmPair(A, B);
  assert.equal(floorRecord(A, chat), undefined, 'no record before the first send');
  for (let i = 0; i < 4; i += 1) assert.equal((await sendMessage(await reload(A, A), A, chat, `dm-${i}`)).encrypted.keyVersion, 1, `dm reload ${i}`);
  assert.deepEqual(await readAll(await reload(B, B), B, chat), ['dm-0', 'dm-1', 'dm-2', 'dm-3']);
  assert.deepEqual(await keyed(await groupBrowser(C, C, g), g), { keyed: true, rotated: true });
  assert.equal(floorRecord(A, g.chatId), undefined);
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await sendGroupMessage(await groupBrowser(A, A, g), A, g, `a-${i}`)).keyVersion, 1, `group alice ${i}`);
    assert.equal((await sendGroupMessage(await groupBrowser(B, B, g), B, g, `b-${i}`)).keyVersion, 1, `group bob ${i}`);
  }
  const page = await groupBrowser(A, A, g);                                    // several sends from one page, too
  for (let i = 0; i < 3; i += 1) assert.equal((await sendGroupMessage(page, A, g, `p-${i}`)).keyVersion, 1);
  assert.equal(floorRecord(A, chat).used, 1);
});

test('S10a-honest-oldrecord: a floor record written before S10a (no pins) still works and gets a snapshot with the next send', async () => {
  const [A, B] = ['ua9', 'ub9'];
  const chat = await dmPair(A, B);
  await sendMessage(await reload(A, A), A, chat, 'one');
  profileOf(A).stores.keyFloors.set(`${ids[A]}:${chat}`, { floor: 1, used: 1 });   // the shape S9a wrote
  assert.equal((await sendMessage(await reload(A, A), A, chat, 'two')).encrypted.keyVersion, 1);
  assert.deepEqual(floorRecord(A, chat), { floor: 1, used: 1, pins: { [ids[B]]: pinsOf(A, B)[0] } });
  profileOf(A).stores.keyFloors.set(`${ids[A]}:${chat}`, { floor: 1, used: 1, pins: 'garbage' });
  assert.equal((await sendMessage(await reload(A, A), A, chat, 'three')).encrypted.keyVersion, 1, 'an unusable snapshot counts as empty');
});
