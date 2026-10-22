// S9b: the pin history travels inside the key backup. The real apps/web/src/e2ee.ts (bundled with esbuild, a fake IndexedDB per "browser",
// WebCrypto) talks to the real server code in-process. A restored browser must open envelopes that a contact wrapped with an identity this
// user had accepted, an old backup without pins must still restore, and nothing read from a backup may corrupt the pins.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { pinsForBackup, readBackupPins, mergePins, isFingerprint, MAX_PINS_PER_CONTACT, BACKUP_PINS_BUDGET } from '../../apps/web/src/pins.ts';
import { encryptBackup, decryptBackup, wrapForServer, unwrapFromServer } from '../../apps/web/src/backup/crypto.ts';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.SERVER_DIST ? path.resolve(process.env.SERVER_DIST) : path.join(root, 'apps/server/dist');
const origin = 'http://localhost:3050';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-backup-pins-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'backup-pins-test-secret-with-at-least-32-bytes';
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
const { parseBackupBlob } = await load('cryptoBackup.js');
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
      chatCrypto: (id) => call('GET', '/api/chats/' + id + '/crypto'),
      createCryptoEnvelopes: (id, body) => call('POST', '/api/chats/' + id + '/crypto/envelopes', body),
      registerCryptoIdentity: (userId, publicKey, backup) => call('PUT', '/api/crypto/identity', { expectedUserId: userId, publicKey, backup }),
      cryptoBackup: () => call('GET', '/api/crypto/backup'),
      cryptoActionGrant: (action, expectedRevision, password, secondFactor) => call('POST', '/api/crypto/action-grant', { action, expectedRevision, password, secondFactor }),
      resetCryptoIdentity: (expectedRevision, actionToken) => call('POST', '/api/crypto/identity/reset', { expectedRevision, actionToken }),
    };`,
  groups: 'export const groupsApi = {};',
};
const outDir = await mkdtemp(path.join(os.tmpdir(), 'tel-backup-pins-bundle-'));
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
  const stores = { identities: new Map(), pins: new Map() };
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
            getAllKeys: () => reply(() => [...store.keys()]),
            getAll: () => reply(() => [...store.values()].map(structuredCloneSafe)),
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
const ip = () => `10.9.${nextIp >> 8}.${nextIp++ & 255}`;
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
const inject = (user, method, url, payload) => app.inject({ method, url, payload, remoteAddress: ip(), headers: { origin, cookie: cookies[user] } });

// instance name -> { user, idb }. A "tamper" hook can rewrite what the server tells one browser (a lying/compromised server).
const instances = new Map();
const tamper = new Map();
globalThis.__bridge = {
  async call(who, method, url, body) {
    const instance = instances.get(who);
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
const makeChat = async (a, b) => (await inject(a, 'POST', '/api/chats', { userId: ids[b] })).json().id;
const init = (browser, user) => as(browser, (m) => m.initializeEncryption(String(ids[user])));
const LOCKED = '🔒 پیام قابل رمزگشایی نیست';

before(async () => {
  await runMigrations();
  for (const name of ['alice', 'bob', 'carol']) ids[name] = await createUser(name, name, PASSWORD);
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

// ---- the history: bob created version 1, bob starts fresh, alice accepts bob's new key -------------------------------------------------
const S = {};
const FP = (n) => String(n).padStart(64, '0').replaceAll(/[^0-9a-f]/gu, 'a');
const pinsOf = (browser, user, contact) => profileOf(browser)?.stores.pins.get(`${ids[user]}:${ids[contact]}`);
const fresh = (name, user, profile = name) => open(name, user, profile);
const restoreInto = async (name, user, profile, payload) => {
  const browser = await fresh(name, user, profile);
  await as(browser, (m) => m.importIdentity(payload));
  await init(browser, user);
  return browser;
};

test('setup: alice holds bob\'s pin history [old, new] and still reads everything', async () => {
  S.alice = await open('alice', 'alice'); S.bob = await open('bob', 'bob');
  await init(S.alice, 'alice'); await init(S.bob, 'bob');
  S.chat = await makeChat('alice', 'bob');
  await sendMessage(S.bob, 'bob', S.chat, 'پیام نسخهٔ یک');
  assert.deepEqual(await readAll(S.alice, 'alice', S.chat), ['پیام نسخهٔ یک']); // alice pins bob's first key here
  await as(S.bob, (m) => m.resetIdentity(String(ids.bob), PASSWORD));
  await sendMessage(S.bob, 'bob', S.chat, 'پیام نسخهٔ دو');
  S.alice = await open('alice', 'alice'); await init(S.alice, 'alice');
  const [change] = await as(S.alice, (m) => m.checkKeyChanges(S.chat));
  assert.ok(change, 'alice sees bob\'s new key');
  await as(S.alice, (m) => m.acceptKeyChange(S.chat, change));
  S.history = pinsOf('alice', 'alice', 'bob');
  assert.equal(S.history.length, 2);
  assert.deepEqual((await readAll(S.alice, 'alice', S.chat)).sort(), ['پیام نسخهٔ دو', 'پیام نسخهٔ یک'].sort());
});

test('the backup carries the pin history of this user only', async () => {
  // a pin of ANOTHER local account in the same browser profile, and a corrupt value under alice's prefix
  const pins = profileOf('alice').stores.pins;
  pins.set(`${ids.bob}:${ids.alice}`, [FP(7)]);
  pins.set(`${ids.alice}:junk`, 12345);
  const backup = await as(S.alice, (m) => m.getBackup());
  assert.deepEqual(backup.pins, { [String(ids.bob)]: S.history });
  S.payload = backup;
  pins.delete(`${ids.alice}:junk`);
  const local = await as(S.alice, (m) => m.exportLocalIdentity(String(ids.alice)));
  assert.deepEqual(local.pins, backup.pins, 'the automatic server backup uses the same payload');
});

test('the pin history survives both backup formats (file and server blob)', async () => {
  const file = await encryptBackup(S.payload, 'a long passphrase here', 100_000);
  assert.deepEqual((await decryptBackup(file, 'a long passphrase here')).pins, S.payload.pins);
  const blob = await wrapForServer(S.payload, PASSWORD);
  assert.deepEqual((await unwrapFromServer(blob, PASSWORD, S.payload.userId)).pins, S.payload.pins);
  assert.ok(parseBackupBlob({ ...blob }), 'the server accepts the blob');
});

test('restore into an EMPTY browser: the envelope bob wrapped with his earlier identity opens (version 1 history)', async () => {
  S.alice2 = await restoreInto('alice2', 'alice', 'alice-restored', S.payload);
  assert.deepEqual(pinsOf('alice2', 'alice', 'bob'), S.history, 'history restored in order, the newest is current');
  assert.deepEqual(await as(S.alice2, (m) => m.checkKeyChanges(S.chat)), [], 'no key-change warning: the restored pin is bob\'s current key');
  assert.deepEqual((await readAll(S.alice2, 'alice', S.chat)).sort(), ['پیام نسخهٔ دو', 'پیام نسخهٔ یک'].sort(), 'both versions open');
  const sent = await sendMessage(S.alice2, 'alice', S.chat, 'از مرورگر بازیابی‌شده');
  assert.equal(sent.encrypted.keyVersion, 2);
});

test('an OLD backup without pins still restores; only the old envelope stays locked', async () => {
  const { pins, ...oldBackup } = S.payload;
  assert.ok(pins);
  const old = await encryptBackup(oldBackup, 'a long passphrase here', 100_000);
  const restored = await decryptBackup(old, 'a long passphrase here');
  assert.equal('pins' in restored, false);
  const browser = await restoreInto('alice3', 'alice', 'alice-old-backup', restored);
  assert.equal(pinsOf('alice3', 'alice', 'bob'), undefined, 'nothing is invented');
  const texts = await readAll(browser, 'alice', S.chat);
  assert.ok(texts.includes('پیام نسخهٔ دو') && texts.includes('از مرورگر بازیابی‌شده'), 'the current identity works as before');
  assert.equal(texts.filter((t) => t === LOCKED).length, 1, 'without the history, version 1 is locked');
  assert.deepEqual(pinsOf('alice3', 'alice', 'bob')?.length, 1, 'first contact pins the current key as it always did');
});

test('merge on restore: this browser\'s own current pin stays last; without a local pin the backup order is kept', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map((letter) => letter.repeat(64));
  const profile = 'alice-merge';
  await fresh('alice4', 'alice', profile);
  profileOf('alice4').stores.pins.set(`${ids.alice}:900`, [a]);       // local pin, unknown to the backup
  profileOf('alice4').stores.pins.set(`${ids.alice}:901`, c);          // legacy single value, also in the backup
  const payload = { ...S.payload, pins: { 900: [b, c], 901: [a, b, c], 902: [c, b] } };
  const browser = await fresh('alice4b', 'alice', profile);
  await as(browser, (m) => m.importIdentity(payload));
  const stored = (contact) => profileOf('alice4b').stores.pins.get(`${ids.alice}:${contact}`);
  assert.deepEqual(stored(900), [b, c, a], 'local current pin (a) is still the last one');
  assert.deepEqual(stored(901), [a, b, c], 'a legacy single value is read as a list; its fingerprint stays current');
  assert.deepEqual(stored(902), [c, b], 'no local pin: backup order kept, the last is current');
});

test('what a backup says is checked: bad lists are skipped as a whole, the restore itself still works', async () => {
  const good = 'd'.repeat(64);
  const payload = {
    ...S.payload,
    pins: {
      10: [good],
      11: ['not-a-fingerprint'],
      12: ['D'.repeat(64)],                                   // upper case is not what fingerprintOf produces
      13: Array.from({ length: MAX_PINS_PER_CONTACT + 1 }, (_, i) => i.toString(16).padStart(64, '0')),
      14: 'e'.repeat(64),                                     // not a list
      15: [],
      16: [good, 7],
      '': [good],
      'a b': [good],
      '../x': [good],
      constructor: { evil: true },
    }
  };
  Object.defineProperty(payload.pins, '__proto__', { value: [good], enumerable: true, configurable: true, writable: true });
  const browser = await restoreInto('alice5', 'alice', 'alice-validate', payload);
  const stored = [...profileOf('alice5').stores.pins.keys()].filter((key) => key.startsWith(`${ids.alice}:`)).map((key) => key.split(':')[1]);
  assert.deepEqual(stored, ['10'], 'only the one well-formed list is kept');
  for (const bad of ['11', '12', '13', '14', '15', '16', '', 'a b', '../x', '__proto__', 'constructor']) assert.ok(!stored.includes(bad), `skipped: ${JSON.stringify(bad)}`);
  assert.ok(await as(browser, (m) => m.hasLocalIdentity(String(ids.alice))), 'identity restored regardless');
  assert.equal(Object.getPrototypeOf(profileOf('alice5').stores.pins.get(`${ids.alice}:10`)), Array.prototype);
});

test('pure rules: readBackupPins, mergePins, pinsForBackup', () => {
  assert.deepEqual(readBackupPins(undefined), []);
  assert.deepEqual(readBackupPins([FP(1)]), []);
  assert.deepEqual(readBackupPins('x'), []);
  assert.equal(isFingerprint('a'.repeat(64)), true);
  assert.equal(isFingerprint('a'.repeat(63)), false);
  const a = 'a'.repeat(64); const b = 'b'.repeat(64);
  assert.deepEqual(readBackupPins({ 1: [a, b, a] }), [['1', [b, a]]], 'duplicates keep their last position');
  assert.deepEqual(mergePins([], [a, b]), [a, b]);
  assert.deepEqual(mergePins([b], [a, b]), [a, b]);
  assert.deepEqual(mergePins([a], [b]), [b, a]);
  const many = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(64, '0'));
  assert.deepEqual(mergePins([many[39]], many.slice(0, 32)).at(-1), many[39], 'cap keeps the newest, local current last');
  assert.equal(mergePins([many[39]], many.slice(0, 32)).length, MAX_PINS_PER_CONTACT);

  assert.equal(pinsForBackup([]), undefined);
  assert.equal(pinsForBackup([['1', ['nope']]]), undefined);
  const capped = pinsForBackup([['1', many]]);
  assert.equal(capped['1'].length, MAX_PINS_PER_CONTACT);
  assert.equal(capped['1'].at(-1), many[39], 'the newest 32, current last');

  // lots of contacts: within the budget, the ones with a history come first
  const entries = Array.from({ length: 1_000 }, (_, i) => [String(100_000 + i), [i.toString(16).padStart(64, '1')]]);
  entries.push(['999999', [a, b]]);
  const packed = pinsForBackup(entries);
  assert.ok(JSON.stringify(packed).length <= BACKUP_PINS_BUDGET, 'within the budget');
  assert.deepEqual(packed['999999'], [a, b], 'a contact with a history is kept even though it came last');
  assert.ok(Object.keys(packed).length < 1_001, 'the budget cut something');
});

test('the biggest backup the client will build is accepted by the server\'s blob limit', async () => {
  const entries = Array.from({ length: 2_000 }, (_, i) => [`${i}`.padStart(8, '9'), [`${i}`.padStart(64, 'c'), `${i}`.padStart(64, 'e')]]);
  const payload = { ...S.payload, pins: pinsForBackup(entries) };
  const blob = await wrapForServer(payload, PASSWORD);
  assert.ok(parseBackupBlob(blob), `wrapped length ${blob.wrapped.length}`);
  assert.ok(blob.wrapped.length < 32 * 1024);
  assert.ok(JSON.stringify({ ...blob, expectedUserId: '1', password: PASSWORD, expectedRevision: 1, actionToken: 'x'.repeat(100) }).length < 48 * 1024, 'fits the request body limit');
});
