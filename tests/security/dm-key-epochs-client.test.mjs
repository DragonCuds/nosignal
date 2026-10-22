// NS-07 client side: the real apps/web/src/e2ee.ts (bundled with esbuild, a fake IndexedDB per "browser", WebCrypto) talking to the
// real server code in-process. Covers key versions, pin history, the "start fresh" flow, a lying server and stale browsers.
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-dm-client-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'dm-client-test-secret-with-at-least-32-bytes';
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
      chatCrypto: (id) => call('GET', '/api/chats/' + id + '/crypto'),
      createCryptoEnvelopes: (id, body) => call('POST', '/api/chats/' + id + '/crypto/envelopes', body),
      registerCryptoIdentity: (userId, publicKey, backup) => call('PUT', '/api/crypto/identity', { expectedUserId: userId, publicKey, backup }),
      cryptoBackup: () => call('GET', '/api/crypto/backup'),
      cryptoActionGrant: (action, expectedRevision, password, secondFactor) => call('POST', '/api/crypto/action-grant', { action, expectedRevision, password, secondFactor }),
      resetCryptoIdentity: (expectedRevision, actionToken) => call('POST', '/api/crypto/identity/reset', { expectedRevision, actionToken }),
    };`,
  groups: 'export const groupsApi = {};',
};
const outDir = await mkdtemp(path.join(os.tmpdir(), 'tel-dm-client-bundle-'));
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
const ip = () => `10.7.${nextIp >> 8}.${nextIp++ & 255}`;
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
  for (const name of ['alice', 'bob', 'carol', 'dave', 'eve', 'frank']) ids[name] = await createUser(name, name, PASSWORD);
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

// ---- scenario 1: bob created version 1, bob starts fresh, alice accepts, alice creates version 2 ---------------------------------------
const S = {};
test('a chat key is created, both read each other (version 1)', async () => {
  S.alice = await open('alice', 'alice');
  S.bob = await open('bob', 'bob');
  await init(S.alice, 'alice'); await init(S.bob, 'bob');
  S.chat = await makeChat('alice', 'bob');
  const first = await sendMessage(S.bob, 'bob', S.chat, 'سلام از بابک');          // bob creates version 1 (his envelopes carry his current key)
  assert.equal(first.encrypted.keyVersion, 1);
  assert.deepEqual(await readAll(S.alice, 'alice', S.chat), ['سلام از بابک']);
  await sendMessage(S.alice, 'alice', S.chat, 'جواب از الهه');
  assert.deepEqual((await readAll(S.bob, 'bob', S.chat)).sort(), ['جواب از الهه', 'سلام از بابک'].sort());
  const rows = (await db.query('SELECT recipient_id, sender_id, version FROM chat_key_envelopes WHERE chat_id = $1 ORDER BY recipient_id', [S.chat])).rows;
  assert.deepEqual(rows.map((r) => [String(r.sender_id), r.version]), [[String(ids.bob), 1], [String(ids.bob), 1]], 'bob created both envelopes');
});

test('pins are stored as a list; an old single-value pin is migrated when it is loaded (director test c)', async () => {
  const pins = profileOf('alice').stores.pins;
  const key = `${ids.alice}:${ids.bob}`;
  const stored = pins.get(key);
  assert.ok(Array.isArray(stored) && stored.length === 1, 'new code stores a list');
  pins.set(key, stored[0]); // what an earlier version wrote: one string
  assert.equal(typeof pins.get(key), 'string');
  S.alice = await open('alice', 'alice'); // reload the page: new module instance, same profile
  await init(S.alice, 'alice');
  assert.deepEqual(await as(S.alice, (m) => m.checkKeyChanges(S.chat)), [], 'nothing changed, nothing reported');
  assert.deepEqual(pins.get(key), stored, 'rewritten as a one-entry list on load');
  assert.deepEqual(await readAll(S.alice, 'alice', S.chat).then((texts) => texts.sort()), ['جواب از الهه', 'سلام از بابک'].sort(), 'history still opens after the migration');
  assert.deepEqual(S.pinsBefore = [...stored], stored);
});

test('bob starts fresh: his own envelope goes, alice keeps hers; bob (new key) creates version 2 and cannot read version 1', async () => {
  await as(S.bob, (m) => m.resetIdentity(String(ids.bob), PASSWORD));
  const row = (await db.query('SELECT key_version, pending_version FROM direct_chat_keys WHERE chat_id = $1', [S.chat])).rows[0];
  assert.deepEqual(row, { key_version: 1, pending_version: 2 });
  assert.deepEqual((await db.query('SELECT recipient_id FROM chat_key_envelopes WHERE chat_id = $1', [S.chat])).rows.map((r) => String(r.recipient_id)), [String(ids.alice)]);
  await sendMessage(S.bob, 'bob', S.chat, 'پیام تازه بعد از شروع تازه');    // bob pins alice (same key as before), creates version 2
  const fresh = await readAll(S.bob, 'bob', S.chat);
  assert.ok(fresh.includes('پیام تازه بعد از شروع تازه'));
  assert.equal(fresh.filter((t) => t === LOCKED).length, 2, 'bob cannot read what was sent before his reset');
  const v2 = (await db.query('SELECT sender_id, sender_fingerprint FROM chat_key_envelopes WHERE chat_id = $1 AND version = 2', [S.chat])).rows;
  assert.equal(v2.length, 2);
});

test('director test a: alice (a browser that reloads) accepts bob\'s new key and still reads the version-1 history bob created', async () => {
  S.alice = await open('alice', 'alice');
  await init(S.alice, 'alice');
  // before accepting: the key-change warning flow is exactly as before, nothing opens
  const changes = await as(S.alice, (m) => m.checkKeyChanges(S.chat));
  assert.equal(changes.length, 1);
  const texts = await readAll(S.alice, 'alice', S.chat);
  assert.ok(texts.every((t) => t === LOCKED), 'blocked until the user decides');
  await assert.rejects(as(S.alice, (m) => m.encryptContent(S.chat, String(ids.alice), { kind: 'text', text: 'x', payload: null })), (e) => e.name === 'KeyChangedError');
  await as(S.alice, (m) => m.acceptKeyChange(S.chat, changes[0]));
  const pins = profileOf('alice').stores.pins.get(`${ids.alice}:${ids.bob}`);
  assert.equal(pins.length, 2, 'the old fingerprint stays in the history');
  assert.equal(pins[0], S.pinsBefore[0]);
  assert.equal(pins[1], changes[0].newFingerprint);
  const after = (await readAll(S.alice, 'alice', S.chat)).sort();
  assert.deepEqual(after, ['جواب از الهه', 'پیام تازه بعد از شروع تازه', 'سلام از بابک'].sort(), 'old version-1 messages and the new version-2 message');
  const next = await sendMessage(S.alice, 'alice', S.chat, 'بعد از تأیید');
  assert.equal(next.encrypted.keyVersion, 2, 'new messages use the current version');
  assert.ok((await readAll(S.bob, 'bob', S.chat)).includes('بعد از تأیید'));
});

test('director test b: the server returns an old-version sender key that was never pinned: rejected (no trust on first use for history)', async () => {
  const evil = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const evilPub = await crypto.subtle.exportKey('jwk', evil.publicKey);
  const evilFp = await S.alice.fingerprintOf(evilPub);
  const evilChatKey = crypto.getRandomValues(new Uint8Array(32));
  const alicePub = (await db.query('SELECT public_jwk FROM user_crypto_identities WHERE user_id = $1', [ids.alice])).rows[0].public_jwk;
  const forged = await S.alice.wrapChatKey({ scope: S.chat, version: 1, recipientId: String(ids.alice), creatorId: String(ids.bob), creatorPrivateKey: evil.privateKey, recipientPublicKey: alicePub, raw: evilChatKey });
  // a message the attacker sealed under the key it planted
  const evilAes = await crypto.subtle.importKey('raw', evilChatKey, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipherId = randomUUID();
  const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'from the attacker', payload: null }));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(`tel:message:v2:${S.chat}:${ids.bob}:${cipherId}:text`) }, evilAes, plaintext);
  const evilMessage = { id: '9999', chatId: S.chat, senderId: String(ids.bob), kind: 'text', deletedAt: null, encrypted: { version: 2, cipherId, nonce: S.alice.bytesToB64(nonce), ciphertext: S.alice.bytesToB64(new Uint8Array(sealed)), keyVersion: 1 } };

  for (const [label, rewrite] of [
    ['unpinned key with its own fingerprint', (e) => ({ ...e, senderPublicKey: evilPub, senderFingerprint: evilFp, nonce: forged.nonce, ciphertext: forged.ciphertext })],
    ['unpinned key claiming a pinned fingerprint', (e) => ({ ...e, senderPublicKey: evilPub, senderFingerprint: S.pinsBefore[0], nonce: forged.nonce, ciphertext: forged.ciphertext })],
  ]) {
    S.alice = await open('alice', 'alice'); // a fresh page load, so nothing is cached
    tamper.set('alice', (method, url, json) => (method === 'GET' && url.endsWith('/crypto') ? { ...json, envelopes: json.envelopes.map((e) => (e.version === 1 ? rewrite(e) : e)) } : undefined));
    await init(S.alice, 'alice');
    const opened = await as(S.alice, (m) => m.decryptMessage(evilMessage));
    assert.equal(opened.text, LOCKED, label);
    const real = (await readAll(S.alice, 'alice', S.chat)).filter((t) => t !== LOCKED);
    assert.ok(real.includes('بعد از تأیید') && !real.includes('from the attacker'), `${label}: version 2 still works, the planted version 1 does not`);
    tamper.delete('alice');
  }
  // pure check of the rule itself
  const context = { selfId: 'a', selfFingerprint: 'f', selfPublicKey: {}, memberKey: () => null, pins: () => [S.pinsBefore[0]] };
  assert.equal(await S.alice.senderKeyFor({ senderId: 'b', version: 1, nonce: '', ciphertext: '', senderPublicKey: evilPub, senderFingerprint: evilFp }, context), null);
});

test('a lying server cannot make an old trusted key the key for NEW messages', async () => {
  // The server claims version 1 is current again. Version 1 was wrapped with bob's previous key: pinned (history) but not current.
  S.alice = await open('alice', 'alice');
  tamper.set('alice', (method, url, json) => (method === 'GET' && url.endsWith('/crypto') ? { ...json, keyVersion: 1, pendingKeyVersion: null, envelopes: json.envelopes.filter((e) => e.version === 1) } : undefined));
  await init(S.alice, 'alice');
  await assert.rejects(as(S.alice, (m) => m.encryptContent(S.chat, String(ids.alice), { kind: 'text', text: 'must not use the old key', payload: null })), /unavailable/);
  tamper.delete('alice');
});

test('chat media: a key of an older version still opens older media for the contact who kept it; the new browser of the resetter cannot', async () => {
  const key1 = await as(S.alice, (m) => m.chatEncryptionKey(S.chat, 1));
  const key2 = await as(S.alice, (m) => m.chatEncryptionKey(S.chat, 2));
  assert.notEqual(key1, key2);
  const current = await as(S.alice, (m) => m.currentChatKey(S.chat));
  assert.equal(current.version, 2);
  // bob's new browser has the new key only
  S.bobNew = await open('bobNew', 'bob', 'bob'); // same profile (he keeps the new key)
  await init(S.bobNew, 'bob');
  await as(S.bobNew, (m) => m.chatEncryptionKey(S.chat, 2));
  await assert.rejects(as(S.bobNew, (m) => m.chatEncryptionKey(S.chat, 1)), /No key for this chat key version/);
  // media from before key versions (no keyVersion on the message) is version 1
  await as(S.alice, (m) => m.chatEncryptionKey(S.chat));
});

// ---- scenario 2: carol created version 1, resets in a NEW browser; alice-style open tab of dave is stale ---------------------------------
test('stale open tab: the old browser keeps encrypting with version 1, the server refuses, re-encrypting needs the key-change decision, then it works', async () => {
  S.dave = await open('dave', 'dave');
  S.carol = await open('carol', 'carol');
  await init(S.dave, 'dave'); await init(S.carol, 'carol');
  S.chat2 = await makeChat('dave', 'carol');
  await sendMessage(S.carol, 'carol', S.chat2, 'carol v1');
  await sendMessage(S.dave, 'dave', S.chat2, 'dave v1');                 // dave's tab now caches version 1
  // carol loses her key and starts fresh in a new browser (new profile); the dave tab stays open and is NOT reloaded
  S.carol2 = await open('carol2', 'carol', 'carol-new-profile');
  await as(S.carol2, async (m) => { try { await m.initializeEncryption(String(ids.carol)); } catch { /* bound to another identity */ } });
  await as(S.carol2, (m) => m.resetIdentity(String(ids.carol), PASSWORD));
  // the open dave tab: this is the old cached version
  const stale = await as(S.dave, (m) => m.encryptContent(S.chat2, String(ids.dave), { kind: 'text', text: 'from the stale tab', payload: null }));
  assert.equal(stale.keyVersion, 1, 'the open tab still believes version 1 is current');
  const refused = await inject('dave', 'POST', `/api/chats/${S.chat2}/messages`, { kind: 'text', encrypted: stale, keyVersion: 1, clientMsgId: `cm-${randomUUID()}` });
  assert.equal(refused.statusCode, 409, refused.body);
  const refusal = new S.dave.ApiError(refused.json().error, refused.statusCode, refused.json());
  assert.equal(S.dave.isStaleKeyError(refusal), true);
  assert.equal(S.dave.isStaleKeyError(new S.dave.ApiError('x', 400, { error: 'group', keyVersion: 2 })), false, 'group answers are not this error');
  assert.equal(S.dave.isStaleKeyError(new S.dave.ApiError('x', 500, { keyVersion: 1, pendingKeyVersion: 2 })), false);
  // re-encrypting needs dave to accept carol's new key first (the warning flow is unchanged)
  await assert.rejects(as(S.dave, (m) => m.reencryptForStaleKey(S.chat2, String(ids.dave), { kind: 'text', text: 'from the stale tab', payload: null })), (e) => e.name === 'KeyChangedError');
  const changes = await as(S.dave, (m) => m.checkKeyChanges(S.chat2));
  assert.equal(changes.length, 1);
  await as(S.dave, (m) => m.acceptKeyChange(S.chat2, changes[0]));
  const again = await as(S.dave, (m) => m.reencryptForStaleKey(S.chat2, String(ids.dave), { kind: 'text', text: 'from the stale tab', payload: null }));
  assert.equal(again.keyVersion, 2, 'sealed again with the new version');
  const sent = await inject('dave', 'POST', `/api/chats/${S.chat2}/messages`, { kind: 'text', encrypted: again, keyVersion: 2, clientMsgId: `cm-${randomUUID()}` });
  assert.equal(sent.statusCode, 201, sent.body);
  // dave created version 2 (carol2 had not opened the chat yet); carol2 reads it, and old history only on dave's side
  const carolSees = await readAll(S.carol2, 'carol', S.chat2);
  assert.ok(carolSees.includes('from the stale tab'));
  assert.equal(carolSees.filter((t) => t === LOCKED).length, 2);
  const daveSees = await readAll(S.dave, 'dave', S.chat2);
  assert.deepEqual(daveSees.sort(), ['carol v1', 'dave v1', 'from the stale tab'].sort());
});

test('withFreshChatKey: one retry after a stale refusal, none for other errors', async () => {
  const stale = () => new S.dave.ApiError('stale', 400, { error: 'stale', keyVersion: 2, pendingKeyVersion: null });
  let runs = 0;
  const result = await as(S.dave, (m) => m.withFreshChatKey(S.chat2, async () => { runs += 1; if (runs === 1) throw stale(); return 'ok'; }));
  assert.deepEqual([result, runs], ['ok', 2]);
  runs = 0;
  await assert.rejects(as(S.dave, (m) => m.withFreshChatKey(S.chat2, async () => { runs += 1; throw new S.dave.ApiError('nope', 400, { error: 'nope' }); })));
  assert.equal(runs, 1);
});

test('pin helpers: a pin history keeps the accepted fingerprints, the last one is current', async () => {
  const { acceptPin, currentPin, normalizePins, wasPinned, isLegacyPin } = S.alice;
  assert.deepEqual(normalizePins('abc'), ['abc']);
  assert.deepEqual(normalizePins(undefined), []);
  assert.deepEqual(normalizePins(['a', 'a', 'b', 7]), ['a', 'b']);
  assert.equal(isLegacyPin('abc'), true);
  assert.equal(isLegacyPin(['abc']), false);
  const list = acceptPin(acceptPin([], 'a'), 'b');
  assert.deepEqual(list, ['a', 'b']);
  assert.equal(currentPin(list), 'b');
  assert.deepEqual(acceptPin(list, 'a'), ['b', 'a'], 'accepting an older key again makes it current again');
  assert.equal(wasPinned(list, 'a'), true);
  assert.equal(wasPinned(list, 'c'), false);
});

// ---- scenario 3: both start fresh ------------------------------------------------------------------------------------------------------
test('both contacts start fresh: new messages work, the old ones stay unreadable for both (nobody holds a key of the old identities)', async () => {
  const eve = await open('eve', 'eve'); const frank = await open('frank', 'frank');
  await init(eve, 'eve'); await init(frank, 'frank');
  const chat = await makeChat('eve', 'frank');
  await sendMessage(eve, 'eve', chat, 'قدیمی ۱'); await sendMessage(frank, 'frank', chat, 'قدیمی ۲');
  const eve2 = await open('eve2', 'eve', 'eve-new'); const frank2 = await open('frank2', 'frank', 'frank-new');
  await as(eve2, (m) => m.resetIdentity(String(ids.eve), PASSWORD));
  await as(frank2, (m) => m.resetIdentity(String(ids.frank), PASSWORD));
  assert.equal((await db.query('SELECT 1 FROM chat_key_envelopes WHERE chat_id = $1', [chat])).rowCount, 0, 'no envelope is left: both recipients were removed');
  assert.deepEqual((await db.query('SELECT key_version, pending_version FROM direct_chat_keys WHERE chat_id = $1', [chat])).rows[0], { key_version: 1, pending_version: 2 });
  await sendMessage(eve2, 'eve', chat, 'تازه ۱');
  await sendMessage(frank2, 'frank', chat, 'تازه ۲');
  const forEve = await readAll(eve2, 'eve', chat);
  const forFrank = await readAll(frank2, 'frank', chat);
  for (const texts of [forEve, forFrank]) {
    assert.ok(texts.includes('تازه ۱') && texts.includes('تازه ۲'));
    assert.equal(texts.filter((t) => t === LOCKED).length, 2, 'the two old messages stay locked');
  }
});

test('Saved Messages after start fresh: the old notes stay locked, new notes work', async () => {
  const frank3 = await open('frank3', 'frank', 'frank-new'); // the profile that holds frank\'s new key
  await init(frank3, 'frank');
  const saved = (await inject('frank', 'POST', '/api/chats/saved')).json().id;
  const note = await sendMessage(frank3, 'frank', saved, 'یادداشت');
  assert.equal(note.encrypted.keyVersion, 1);
  const frank4 = await open('frank4', 'frank', 'frank-newer');
  await as(frank4, async (m) => { try { await m.initializeEncryption(String(ids.frank)); } catch { /* bound to another identity */ } });
  await as(frank4, (m) => m.resetIdentity(String(ids.frank), PASSWORD));
  const after = await sendMessage(frank4, 'frank', saved, 'یادداشت جدید');
  assert.equal(after.encrypted.keyVersion, 2);
  const texts = await readAll(frank4, 'frank', saved);
  assert.deepEqual(texts.sort(), [LOCKED, 'یادداشت جدید'].sort());
});
