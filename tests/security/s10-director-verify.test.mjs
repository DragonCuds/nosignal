// Director's independent end-to-end check of the S10 round (second Astra review, R1-R4, R5 end to end), written apart from the
// task agents' own tests. Real apps/web/src/e2ee.ts (esbuild bundle, one fake IndexedDB per browser profile, WebCrypto) against the
// real server routes in-process. A "lie" rewrites what the server tells one browser (a malicious server); everything else is honest.
// Every scenario also checks that the honest path keeps working afterwards and that the other side can read what was sent.
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-s10-verify-'));
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
const outDir = await mkdtemp(path.join(os.tmpdir(), 'tel-s10-verify-bundle-'));
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

// A fake IndexedDB. Unlike the other harnesses, a transaction completes only after all its requests ran, and a failing request
// fails the whole transaction (onerror, no oncomplete), so a write fault can be injected: globalThis.__failFloorWrites.
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
          const tx = { failed: false, done: false };
          const finish = () => setTimeout(() => { if (tx.done) return; tx.done = true; if (tx.failed) { tx.error = new Error('write failed'); tx.onerror?.(); tx.onabort?.(); } else tx.oncomplete?.(); }, 0);
          const reply = (fn) => {
            const r = {};
            queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (error) { r.error = error; tx.failed = true; r.onerror?.(); } finish(); });
            return r;
          };
          const objectStore = {
            get: (key) => reply(() => structuredCloneSafe(store.get(key))),
            getAll: () => reply(() => [...store.values()].map(structuredCloneSafe)),
            getAllKeys: () => reply(() => [...store.keys()]),
            put: (value, key) => reply(() => {
              if (name === 'keyFloors' && globalThis.__failFloorWrites) throw new Error('injected keyFloors write fault');
              store.set(name === 'identities' ? value.userId : key, structuredCloneSafe(value));
            }),
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
  for (const name of ['ali', 'bea', 'cal', 'dee', 'eve', 'fox', 'gil', 'hut', 'ian', 'jay', 'kat', 'lee', 'max', 'ned', 'oli', 'pam', 'ray', 'sue']) ids[name] = await createUser(name, name, PASSWORD);
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
const sendGroupMessage = async (browser, user, group, value) => {
  const encrypted = await encrypt(browser, user, group.chatId, value);
  const response = await inject(user, 'POST', `/api/chats/${group.chatId}/messages`, { kind: 'text', encrypted, keyVersion: encrypted.keyVersion, clientMsgId: `cm-${randomUUID()}` });
  assert.equal(response.statusCode, 201, response.body);
};
const readGroup = async (browser, user, group) => {
  const list = (await inject(user, 'GET', `/api/chats/${group.chatId}/messages`)).json();
  return (await Promise.all(list.map(async (message) => (await as(browser, (m) => m.decryptMessage(message))).text))).filter((t) => !t.startsWith('🔒'));
};

const groupBrowser = async (name, user, group, profile = name) => { const b = await reload(name, user, profile); await join(b, group); return b; };
const groupLie = (name, group, { detail, keys }) => lie(name, (method, url, json) => {
  if (method !== 'GET') return undefined;
  if (detail && url === `/api/groups/${group.id}`) return { ...json, ...detail };
  if (keys && url.endsWith('version=latest')) return keys;
  return undefined;
});
const sendMessageOk = async (...args) => (await sendMessage(...args)).encrypted;

const pinOf = (profile, user, contact) => { const list = profileOf(profile).stores.pins.get(`${ids[user]}:${ids[contact]}`); return Array.isArray(list) ? list[list.length - 1] : list; };
const acceptAll = async (browser, chatId) => { const changes = await as(browser, (m) => m.checkKeyChanges(chatId)); for (const change of changes) await as(browser, (m) => m.acceptKeyChange(chatId, change)); return changes.length; };
const dmRollback = (method, url, json) => (method === 'GET' && /\/api\/chats\/\d+\/crypto$/.test(url)
  ? { ...json, keyVersion: 1, pendingKeyVersion: null, envelopes: json.envelopes.filter((e) => e.version === 1) } : undefined);
const isRollback = (e) => e.name === 'ChatKeyRollbackError';
const isKeyChanged = (e) => e.name === 'KeyChangedError';
const visible = (list) => list.filter((t) => !t.startsWith('🔒'));

test('V1 (R1): identity accepted in a GROUP, then the server rolls the DIRECT chat with the same contact back to v1: refused; honest paths continue', async () => {
  const ali = await open('ali', 'ali'); const bea = await open('bea', 'bea');
  await init(ali, 'ali'); await init(bea, 'bea');
  const dm = await makeChat('ali', 'bea');
  await sendMessageOk(ali, 'ali', dm, 'd1');
  assert.deepEqual(await readAll(bea, 'bea', dm), ['d1']);
  const g = await makeGroup('cal', ['ali', 'bea']);
  const cal = await groupBrowser('cal', 'cal', g); const aliG = await groupBrowser('ali', 'ali', g);
  assert.deepEqual(await keyed(cal, g), { keyed: true, rotated: true });
  assert.equal((await encrypt(aliG, 'ali', g.chatId, 'g1')).keyVersion, 1);
  await startFresh('bea2', 'bea', 'bea-new');
  // the admin is told first (verifyRecipients) and accepts, then rotates for the new identity
  await assert.rejects(keyed(cal, g), isKeyChanged);
  assert.equal(await acceptAll(cal, g.chatId), 1);
  assert.deepEqual(await keyed(cal, g), { keyed: true, rotated: true });
  // ali (warm page): sending in the group is blocked until the change is accepted (S10b), then accepted IN THE GROUP
  const aliWarm = await groupBrowser('ali', 'ali', g);
  await assert.rejects(encrypt(aliWarm, 'ali', g.chatId), isKeyChanged);
  assert.equal(await acceptAll(aliWarm, g.chatId), 1);
  // the malicious server now offers the direct chat at v1 with bea's (correct, now pinned) new key and no pending version
  for (const page of [await reload('ali', 'ali'), await reload('ali', 'ali')]) {
    lie('ali', dmRollback);
    await assert.rejects(encrypt(page, 'ali', dm), isRollback);
    assert.deepEqual(await readAll(page, 'ali', dm), ['d1'], 'reading the history is not affected');
    tamper.delete('ali');
  }
  // honest: the direct chat moves to v2 (ali makes it for bea's new key), bea's new browser reads it
  const honest = await reload('ali', 'ali');
  await sendMessageOk(honest, 'ali', dm, 'd2');
  assert.equal((await encrypt(honest, 'ali', dm)).keyVersion, 2);
  const bea2 = await reload('bea2', 'bea', 'bea-new'); await join(bea2, g);
  assert.ok((await readAll(bea2, 'bea', dm)).includes('d2'), 'the contact reads the new message');
  // honest group: v2, readable by bea's new identity
  const aliG2 = await groupBrowser('ali', 'ali', g);
  const sent = await encrypt(aliG2, 'ali', g.chatId, 'g2');
  assert.equal(sent.keyVersion, 2);
  await sendGroupMessage(aliG2, 'ali', g, 'g2-sent');
  assert.ok((await readGroup(bea2, 'bea', g)).includes('g2-sent'));
});

test('V1b (R1 reverse): identity accepted in the DIRECT chat, then the server hides the pending group rotation and offers v1: refused', async () => {
  const dee = await open('dee', 'dee'); const eve = await open('eve', 'eve');
  await init(dee, 'dee'); await init(eve, 'eve');
  const dm = await makeChat('dee', 'eve');
  await sendMessageOk(eve, 'eve', dm, 'e1');
  assert.deepEqual(await readAll(dee, 'dee', dm), ['e1']); // dee pins eve
  const g = await makeGroup('fox', ['dee', 'eve']);
  const fox = await groupBrowser('fox', 'fox', g);
  assert.deepEqual(await keyed(fox, g), { keyed: true, rotated: true });
  const deeG = await groupBrowser('dee', 'dee', g);
  assert.equal((await encrypt(deeG, 'dee', g.chatId)).keyVersion, 1);
  await startFresh('eve2', 'eve', 'eve-new');
  const deeDm = await reload('dee', 'dee');
  await assert.rejects(encrypt(deeDm, 'dee', dm), isKeyChanged);
  assert.equal(await acceptAll(deeDm, dm), 1);
  for (let i = 0; i < 2; i += 1) {
    const page = await groupBrowser('dee', 'dee', g);
    groupLie('dee', g, { detail: { pendingKeyVersion: null, keyVersion: 1 } });
    await assert.rejects(encrypt(page, 'dee', g.chatId), isRollback);
    tamper.delete('dee');
  }
  await assert.rejects(keyed(fox, g), isKeyChanged);
  await acceptAll(fox, g.chatId);
  assert.deepEqual(await keyed(fox, g), { keyed: true, rotated: true });
  assert.equal((await encrypt(await groupBrowser('dee', 'dee', g), 'dee', g.chatId)).keyVersion, 2, 'honest group: v2');
  assert.equal((await encrypt(await reload('dee', 'dee'), 'dee', dm)).keyVersion, 2, 'honest direct chat: v2');
});

test('V2 (R2): accepting fails half-way (the floor write fails after the pin was written): v1 is still refused, also after reload; then honest recovery', async () => {
  const gil = await open('gil', 'gil'); const hut = await open('hut', 'hut');
  await init(gil, 'gil'); await init(hut, 'hut');
  const dm = await makeChat('gil', 'hut');
  await sendMessageOk(gil, 'gil', dm, 'h1');
  assert.deepEqual(await readAll(hut, 'hut', dm), ['h1']);
  await startFresh('hut2', 'hut', 'hut-new');
  const page = await reload('gil', 'gil');
  const [change] = await as(page, (m) => m.checkKeyChanges(dm));
  globalThis.__failFloorWrites = true;
  try { await assert.rejects(as(page, (m) => m.acceptKeyChange(dm, change))); } finally { globalThis.__failFloorWrites = false; }
  assert.equal(pinOf('gil', 'gil', 'hut'), change.newFingerprint, 'the pin WAS written (the half-applied state)');
  assert.deepEqual(await as(page, (m) => m.checkKeyChanges(dm)), [], 'no warning any more');
  lie('gil', dmRollback);
  await assert.rejects(encrypt(page, 'gil', dm), isRollback, 'same page');
  await assert.rejects(encrypt(await reload('gil', 'gil'), 'gil', dm), isRollback, 'after reload');
  tamper.delete('gil');
  const honest = await reload('gil', 'gil');
  await sendMessageOk(honest, 'gil', dm, 'h2');
  assert.ok((await readAll(await reload('hut2', 'hut', 'hut-new'), 'hut', dm)).includes('h2'));
});

test('V3 (R3): warm cache, the wrapper of v1 left, the server hides the rotation: refused; honest rotation then works', async () => {
  const g = await makeGroup('ian', ['jay', 'kat']);
  await makeAdmin('ian', g.id, 'jay');
  const jay = await groupBrowser('jay', 'jay', g); const kat = await groupBrowser('kat', 'kat', g);
  assert.deepEqual(await keyed(jay, g), { keyed: true, rotated: true }); // jay wraps v1
  await sendGroupMessage(jay, 'jay', g, 'from jay');
  assert.deepEqual(await readGroup(kat, 'kat', g), ['from jay']);
  assert.equal((await encrypt(kat, 'kat', g.chatId)).keyVersion, 1, 'kat sends with v1 (warm cache)');
  assert.equal((await inject('jay', 'POST', `/api/groups/${g.id}/leave`)).statusCode, 204);
  groupLie('kat', g, { detail: { pendingKeyVersion: null, keyVersion: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 3_200)); // past KEY_RECHECK_MS: detail and keys are fetched again
  await assert.rejects(encrypt(kat, 'kat', g.chatId), /آماده نیست/);
  assert.deepEqual(await readGroup(kat, 'kat', g), ['from jay'], 'reading is not affected');
  tamper.delete('kat');
  const ian = await groupBrowser('ian', 'ian', g);
  assert.deepEqual(await keyed(ian, g), { keyed: true, rotated: true });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  assert.equal((await encrypt(kat, 'kat', g.chatId)).keyVersion, 2);
});

test('V4 (R4, honest server): a member\'s key changed and an admin already rotated; the warm page is stopped by the warning, accepting unlocks v2, no lockout', async () => {
  const max = await open('max', 'max'); const ned = await open('ned', 'ned');
  await init(max, 'max'); await init(ned, 'ned');
  const dm = await makeChat('max', 'ned');
  await sendMessageOk(ned, 'ned', dm, 'n1');
  assert.deepEqual(await readAll(max, 'max', dm), ['n1']); // max pins ned
  const g = await makeGroup('lee', ['max', 'ned']);
  const lee = await groupBrowser('lee', 'lee', g);
  assert.deepEqual(await keyed(lee, g), { keyed: true, rotated: true });
  const maxG = await groupBrowser('max', 'max', g);
  await sendGroupMessage(maxG, 'max', g, 'm1');
  await startFresh('ned2', 'ned', 'ned-new');
  await assert.rejects(keyed(lee, g), isKeyChanged);
  await acceptAll(lee, g.chatId);
  assert.deepEqual(await keyed(lee, g), { keyed: true, rotated: true }); // v2 made after the change, by lee
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  await assert.rejects(encrypt(maxG, 'max', g.chatId), isKeyChanged, 'the warm page does not send v2 behind the warning');
  assert.equal(await acceptAll(maxG, g.chatId), 1);
  for (const page of [await groupBrowser('max', 'max', g), await groupBrowser('max', 'max', g)]) {
    assert.equal((await encrypt(page, 'max', g.chatId)).keyVersion, 2, 'v2 is usable after accepting (no unreachable floor)');
  }
  const page = await groupBrowser('max', 'max', g);
  await sendGroupMessage(page, 'max', g, 'm2');
  const ned2 = await groupBrowser('ned2', 'ned', g, 'ned-new');
  assert.ok((await readGroup(ned2, 'ned', g)).includes('m2'), 'the member with the new identity reads it');
  // the direct chat with ned is also fine after the group accept: a fresh v2 is made, ned reads it
  const dmPage = await reload('max', 'max');
  await sendMessageOk(dmPage, 'max', dm, 'n2');
  assert.ok((await readAll(await reload('ned2', 'ned', 'ned-new'), 'ned', dm)).includes('n2'));
});

test('V5: no identity change: many sends across reloads in a direct chat and a group never hit a refusal; everything stays readable', async () => {
  const oli = await open('oli', 'oli'); const pam = await open('pam', 'pam');
  await init(oli, 'oli'); await init(pam, 'pam');
  const dm = await makeChat('oli', 'pam');
  const g = await makeGroup('pam', ['oli']);
  assert.deepEqual(await keyed(await groupBrowser('pam', 'pam', g), g), { keyed: true, rotated: true });
  for (let i = 0; i < 8; i += 1) {
    const [user, other] = i % 2 ? ['oli', 'pam'] : ['pam', 'oli'];
    const page = await groupBrowser(user, user, g);
    await sendMessageOk(page, user, dm, `dm-${i}`);
    await sendGroupMessage(page, user, g, `g-${i}`);
    assert.ok((await readAll(await reload(other, other), other, dm)).includes(`dm-${i}`));
  }
  const reader = await groupBrowser('oli', 'oli', g);
  assert.equal(visible(await readGroup(reader, 'oli', g)).length, 8);
  assert.equal((await readAll(reader, 'oli', dm)).length, 8);
});

test('V6 (R5 end to end): the manual backup file restores the pin history; the old and the new identity\'s messages both open; restoring into the same profile removes nothing', async () => {
  const ray = await open('ray', 'ray'); const sue = await open('sue', 'sue');
  await init(ray, 'ray'); await init(sue, 'sue');
  const dm = await makeChat('ray', 'sue');
  await sendMessageOk(sue, 'sue', dm, 'old');
  assert.deepEqual(await readAll(ray, 'ray', dm), ['old']);
  const sue2 = await startFresh('sue2', 'sue', 'sue-new');
  await init(sue2, 'sue');
  await sendMessageOk(await reload('sue2', 'sue', 'sue-new'), 'sue', dm, 'new'); // v2 wrapped by sue's new identity
  const rayPage = await reload('ray', 'ray');
  assert.equal(await acceptAll(rayPage, dm), 1);
  assert.deepEqual(await readAll(rayPage, 'ray', dm), ['old', 'new']);
  const before = profileOf('ray').stores.pins.get(`${ids.ray}:${ids.sue}`);
  const file = await as(rayPage, (m) => m.getBackup('file'));
  assert.deepEqual(file.pins[String(ids.sue)], before, 'the file carries the whole history');
  const fresh = await open('ray-restored', 'ray', 'ray-restored');
  await as(fresh, (m) => m.importIdentity(file));
  await init(fresh, 'ray');
  assert.deepEqual(await readAll(fresh, 'ray', dm), ['old', 'new'], 'a restored browser opens both identities\' envelopes');
  await sendMessageOk(fresh, 'ray', dm, 'after restore');
  assert.ok((await readAll(await reload('sue2', 'sue', 'sue-new'), 'sue', dm)).includes('after restore'));
  await as(rayPage, (m) => m.importIdentity(file)); // same profile again
  assert.deepEqual(profileOf('ray').stores.pins.get(`${ids.ray}:${ids.sue}`), before, 'nothing removed, current pin unchanged');
});
