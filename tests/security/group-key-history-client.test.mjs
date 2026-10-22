// NS-07b client side: the real apps/web/src/e2ee.ts (bundled with esbuild, a fake IndexedDB per "browser", WebCrypto) talking to the
// real server code in-process, for GROUPS: a member who wrapped older group key versions starts fresh, the others keep the whole history,
// a lying server cannot plant a never-pinned wrapper key, and a key that is only trusted for history never becomes the key for new messages.
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-group-client-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'group-client-test-secret-with-at-least-32-bytes';
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
const outDir = await mkdtemp(path.join(os.tmpdir(), 'tel-group-client-bundle-'));
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
const ip = () => `10.12.${nextIp >> 8}.${nextIp++ & 255}`;
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
const init = (browser, user) => as(browser, (m) => m.initializeEncryption(String(ids[user])));
const LOCKED = '🔒 پیام قابل رمزگشایی نیست';

before(async () => {
  await runMigrations();
  for (const name of ['uma', 'pat', 'quin', 'rex', 'sam']) ids[name] = await createUser(name, name, PASSWORD);
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


// ---- helpers for groups -------------------------------------------------------------------------------------------------------------------
const fpOf = async (user) => (await db.query('SELECT fingerprint FROM user_crypto_identities WHERE user_id = $1', [ids[user]])).rows[0]?.fingerprint;
const makeGroup = async (owner, members) => {
  const response = await inject(owner, 'POST', '/api/groups', { title: 'گروه', memberIds: members.map((m) => ids[m]) });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
};
const makeAdmin = async (owner, groupId, user) => assert.equal((await inject(owner, 'POST', `/api/groups/${groupId}/admins/${ids[user]}`)).statusCode, 204);
const join = (browser, group) => as(browser, (m) => m.registerGroupChat(group.chatId, group.id));
const keyed = (browser, group) => as(browser, (m) => m.ensureGroupKeyed(group.chatId, group.id));
const changes = (browser, group) => as(browser, (m) => m.checkKeyChanges(group.chatId));
const accept = async (browser, group) => { for (const change of await changes(browser, group)) await as(browser, (m) => m.acceptKeyChange(group.chatId, change)); };
const pinsOf = (profile, me, other) => profileOf(profile).stores.pins.get(`${ids[me]}:${ids[other]}`);
const groupRow = async (group) => (await db.query('SELECT key_version, pending_version FROM groups WHERE id = $1', [group.id])).rows[0];
const sorted = (list) => [...list].sort();
/** A fresh page load of that user on the same profile (new module instance, nothing cached). */
const reload = async (name, user, profile, group) => { const browser = await open(name, user, profile); await init(browser, user); await join(browser, group); return browser; };

// ---- scenario 1: uma (owner) wrapped version 1, starts fresh; pat (admin) rotates; pat and quin keep the whole history ---------------------
const S = {};
test('a group is keyed by uma (version 1); every member reads; the server stored uma\'s key with each envelope', async () => {
  S.uma = await open('uma', 'uma'); S.pat = await open('pat', 'pat'); S.quin = await open('quin', 'quin');
  for (const [b, u] of [[S.uma, 'uma'], [S.pat, 'pat'], [S.quin, 'quin']]) await init(b, u);
  S.g = await makeGroup('uma', ['pat', 'quin']);
  await makeAdmin('uma', S.g.id, 'pat');
  for (const b of [S.uma, S.pat, S.quin]) await join(b, S.g);
  assert.deepEqual(await keyed(S.uma, S.g), { keyed: true, rotated: true });
  S.umaOld = await fpOf('uma');
  await sendMessage(S.uma, 'uma', S.g.chatId, 'v1 از اوما');
  await sendMessage(S.pat, 'pat', S.g.chatId, 'v1 از پات');
  for (const [b, u] of [[S.uma, 'uma'], [S.pat, 'pat'], [S.quin, 'quin']]) assert.deepEqual(sorted(await readAll(b, u, S.g.chatId)), sorted(['v1 از اوما', 'v1 از پات']));
  const rows = (await db.query('SELECT wrapper_fingerprint FROM group_key_envelopes WHERE group_id = $1 AND version = 1', [S.g.id])).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.wrapper_fingerprint === S.umaOld));
  assert.equal(pinsOf('pat', 'pat', 'uma').length, 1);
});

test('uma starts fresh in a new browser: only her own envelope goes; the group asks for a new version', async () => {
  S.umaNew = await open('umaNew', 'uma', 'uma-new');
  await as(S.umaNew, async (m) => { try { await m.initializeEncryption(String(ids.uma)); } catch { /* bound to another identity */ } });
  await as(S.umaNew, (m) => m.resetIdentity(String(ids.uma), PASSWORD));
  S.umaNewFp = await fpOf('uma');
  assert.notEqual(S.umaNewFp, S.umaOld);
  assert.deepEqual(sorted((await db.query('SELECT user_id FROM group_key_envelopes WHERE group_id = $1', [S.g.id])).rows.map((r) => String(r.user_id))), sorted([ids.pat, ids.quin].map(String)));
  assert.deepEqual(await groupRow(S.g), { key_version: 1, pending_version: 2 });
});

test('the key-change flow is unchanged: pat sees the warning, nothing opens and no rotation happens until he accepts', async () => {
  S.pat = await reload('pat', 'pat', 'pat', S.g);
  assert.equal((await changes(S.pat, S.g)).length, 1);
  assert.ok((await readAll(S.pat, 'pat', S.g.chatId)).every((t) => t === LOCKED), 'blocked until the user decides');
  await assert.rejects(keyed(S.pat, S.g), (e) => e.name === 'KeyChangedError');
  assert.deepEqual(await groupRow(S.g), { key_version: 1, pending_version: 2 });
});

test('pat accepts uma\'s new key (the old fingerprint stays in his history), rotates, and still reads version 1 and version 2', async () => {
  await accept(S.pat, S.g);
  const pins = pinsOf('pat', 'pat', 'uma');
  assert.equal(pins.length, 2);
  assert.equal(pins[0], S.umaOld);
  assert.equal(pins[1], S.umaNewFp);
  assert.deepEqual(await keyed(S.pat, S.g), { keyed: true, rotated: true });
  assert.deepEqual(await groupRow(S.g), { key_version: 2, pending_version: null });
  await sendMessage(S.pat, 'pat', S.g.chatId, 'v2 از پات');
  assert.deepEqual(sorted(await readAll(S.pat, 'pat', S.g.chatId)), sorted(['v1 از اوما', 'v1 از پات', 'v2 از پات']));
  // a page reload on the same profile: still the whole history
  S.pat = await reload('pat', 'pat', 'pat', S.g);
  assert.deepEqual(sorted(await readAll(S.pat, 'pat', S.g.chatId)), sorted(['v1 از اوما', 'v1 از پات', 'v2 از پات']));
  assert.equal((await changes(S.pat, S.g)).length, 0);
});

test('quin (a plain member, a fresh page load) accepts the change and reads everything; new messages use version 2', async () => {
  S.quin = await reload('quin', 'quin', 'quin', S.g);
  assert.equal((await changes(S.quin, S.g)).length, 1);
  await accept(S.quin, S.g);
  const sent = await sendMessage(S.quin, 'quin', S.g.chatId, 'v2 از کوین');
  assert.equal(sent.encrypted.keyVersion, 2);
  assert.deepEqual(sorted(await readAll(S.quin, 'quin', S.g.chatId)), sorted(['v1 از اوما', 'v1 از پات', 'v2 از پات', 'v2 از کوین']));
});

test('uma (new identity) reads only what was sent after the rotation, and can write', async () => {
  S.umaNew = await reload('umaNew', 'uma', 'uma-new', S.g);
  assert.deepEqual(await keyed(S.umaNew, S.g), { keyed: true, rotated: false });
  const texts = await readAll(S.umaNew, 'uma', S.g.chatId);
  assert.equal(texts.filter((t) => t === LOCKED).length, 2, 'the two version-1 messages stay locked for the member who started fresh');
  assert.deepEqual(sorted(texts.filter((t) => t !== LOCKED)), sorted(['v2 از پات', 'v2 از کوین']));
  await sendMessage(S.umaNew, 'uma', S.g.chatId, 'v2 از اوما');
  assert.ok((await readAll(S.pat, 'pat', S.g.chatId)).includes('v2 از اوما'));
});

test('a lying server returns a wrapper key for version 1 that was never pinned: rejected (no trust on first use for history)', async () => {
  const evil = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const evilPub = await crypto.subtle.exportKey('jwk', evil.publicKey);
  const evilFp = await S.pat.fingerprintOf(evilPub);
  const evilGroupKey = crypto.getRandomValues(new Uint8Array(32));
  const patPub = (await db.query('SELECT public_jwk FROM user_crypto_identities WHERE user_id = $1', [ids.pat])).rows[0].public_jwk;
  // the group wrap format: scope group:<id>:<version>, original additional data (no version), nonce + ciphertext as one string
  const forgedWrap = await S.pat.wrapChatKey({ scope: `group:${S.g.id}:1`, recipientId: String(ids.pat), creatorId: String(ids.uma), creatorPrivateKey: evil.privateKey, recipientPublicKey: patPub, raw: evilGroupKey });
  const evilAes = await crypto.subtle.importKey('raw', evilGroupKey, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipherId = randomUUID();
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(`tel:message:v2:${S.g.chatId}:${ids.uma}:${cipherId}:text`) }, evilAes,
    new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'from the attacker', payload: null })));
  const evilMessage = { id: '9999', chatId: S.g.chatId, senderId: String(ids.uma), kind: 'text', deletedAt: null, encrypted: { version: 2, cipherId, nonce: S.pat.bytesToB64(nonce), ciphertext: S.pat.bytesToB64(new Uint8Array(sealed)), keyVersion: 1 } };
  const plant = { wrapped: forgedWrap.nonce + forgedWrap.ciphertext, wrappedBy: String(ids.uma) };
  for (const [label, rewrite] of [
    ['unpinned key with its own fingerprint', (e) => ({ ...e, ...plant, wrapperPublicKey: evilPub, wrapperFingerprint: evilFp })],
    ['unpinned key claiming a pinned fingerprint', (e) => ({ ...e, ...plant, wrapperPublicKey: evilPub, wrapperFingerprint: S.umaOld })],
    ['no stored key: falls back to uma\'s current key, which did not wrap version 1', (e) => ({ ...e, wrapperPublicKey: null, wrapperFingerprint: null })],
  ]) {
    S.pat = await open('pat', 'pat', 'pat'); // a fresh page load, so nothing is cached
    tamper.set('pat', (method, url, json) => (method === 'GET' && /\/keys\?version=/.test(url) ? json.map((e) => (e.version === 1 ? rewrite(e) : e)) : undefined));
    await init(S.pat, 'pat'); await join(S.pat, S.g);
    const opened = await as(S.pat, (m) => m.decryptMessage(evilMessage));
    assert.equal(opened.text, LOCKED, label);
    const real = (await readAll(S.pat, 'pat', S.g.chatId)).filter((t) => t !== LOCKED);
    assert.ok(!real.includes('from the attacker'), label);
    assert.ok(real.includes('v2 از پات') && !real.includes('v1 از اوما'), `${label}: version 2 still works, the planted/unusable version 1 does not`);
    tamper.delete('pat');
  }
  // pure check of the rule itself
  const context = { selfId: 'x', selfFingerprint: 'f', selfPublicKey: {}, memberKey: () => null, pins: () => [S.umaOld] };
  assert.equal(await S.pat.senderKeyFor({ senderId: 'u', version: 1, nonce: '', ciphertext: '', senderPublicKey: evilPub, senderFingerprint: evilFp }, context), null);
  S.pat = await reload('pat', 'pat', 'pat', S.g);
  assert.ok((await readAll(S.pat, 'pat', S.g.chatId)).includes('v1 از اوما'), 'untampered, the real history opens again');
});

test('a key that is only trusted for history never becomes the key for NEW messages (a lying server claims version 1 is the latest)', async () => {
  const v1 = (await inject('pat', 'GET', `/api/groups/${S.g.id}/keys?version=1`)).json();
  assert.equal(v1.length, 1);
  S.pat = await open('pat', 'pat', 'pat');
  tamper.set('pat', (method, url) => (method === 'GET' && url.endsWith('version=latest') ? v1 : undefined));
  await init(S.pat, 'pat'); await join(S.pat, S.g);
  await assert.rejects(as(S.pat, (m) => m.encryptContent(S.g.chatId, String(ids.pat), { kind: 'text', text: 'must not use the old key', payload: null })), /آماده نیست/);
  // reading the old version through that envelope is fine
  const old = (await inject('pat', 'GET', `/api/chats/${S.g.chatId}/messages`)).json().filter((m) => m.encrypted.keyVersion === 1);
  assert.ok(old.length >= 2);
  tamper.delete('pat');
  S.pat = await reload('pat', 'pat', 'pat', S.g);
});

// ---- scenario 2: a wrapper who LEFT the group: the members who had pinned him keep reading what he wrapped ---------------------------------
test('a wrapper who left: a member who pinned him earlier still reads version 1; one who never did does not (no trust on first use)', async () => {
  const pat = await open('pat2', 'pat', 'pat'); const rex = await open('rex', 'rex'); const quin = await open('quin2', 'quin', 'quin'); const sam = await open('sam', 'sam');
  for (const [b, u] of [[pat, 'pat'], [rex, 'rex'], [quin, 'quin'], [sam, 'sam']]) await init(b, u);
  const g = await makeGroup('pat', ['rex', 'quin', 'sam']);
  await makeAdmin('pat', g.id, 'rex');
  for (const b of [pat, rex, quin, sam]) await join(b, g);
  assert.deepEqual(await keyed(rex, g), { keyed: true, rotated: true });             // rex (not the owner) wraps version 1
  await sendMessage(rex, 'rex', g.chatId, 'از رکس');
  assert.deepEqual(await readAll(quin, 'quin', g.chatId), ['از رکس']);               // quin opens it now and pins rex
  assert.equal((await inject('rex', 'POST', `/api/groups/${g.id}/leave`)).statusCode, 204);
  assert.deepEqual(await groupRow(g), { key_version: 1, pending_version: 2 });
  assert.deepEqual(await keyed(pat, g), { keyed: true, rotated: true });             // pat (owner) rotates
  await sendMessage(pat, 'pat', g.chatId, 'بعد از رفتن رکس');
  const quin2 = await reload('quin3', 'quin', 'quin', g);
  assert.deepEqual(sorted(await readAll(quin2, 'quin', g.chatId)), sorted(['از رکس', 'بعد از رفتن رکس']), 'rex is no longer a member, his stored key was pinned before');
  assert.equal((await db.query('SELECT 1 FROM group_key_envelopes WHERE group_id = $1 AND user_id = $2', [g.id, ids.rex])).rowCount, 0);
  const sam2 = await reload('sam2', 'sam', 'sam', g);
  const samTexts = await readAll(sam2, 'sam', g.chatId);
  assert.deepEqual(sorted(samTexts), sorted([LOCKED, 'بعد از رفتن رکس']), 'sam never pinned rex: the old version stays closed');
});

// ---- scenario 3: the only staff member starts fresh on the SAME browser profile and rotates for herself --------------------------------------
test('an owner who starts fresh on the same profile can rotate for herself (no stale pin of herself blocks her); members keep the history; her own new envelope opens after a reload', async () => {
  const sam = await open('sam3', 'sam', 'sam'); const quin = await open('quin4', 'quin', 'quin');
  await init(sam, 'sam'); await init(quin, 'quin');
  const g = await makeGroup('sam', ['quin']);
  await join(sam, g); await join(quin, g);
  assert.deepEqual(await keyed(sam, g), { keyed: true, rotated: true });
  await sendMessage(sam, 'sam', g.chatId, 'قبل از شروع تازه');
  assert.deepEqual(await readAll(quin, 'quin', g.chatId), ['قبل از شروع تازه']);
  const old = await fpOf('sam');
  await as(sam, (m) => m.resetIdentity(String(ids.sam), PASSWORD));                  // same profile: the new identity replaces the old one
  assert.notEqual(await fpOf('sam'), old);
  assert.deepEqual(await groupRow(g), { key_version: 1, pending_version: 2 });
  await join(sam, g);
  assert.deepEqual(await keyed(sam, g), { keyed: true, rotated: true });
  assert.deepEqual(await groupRow(g), { key_version: 2, pending_version: null });
  const quin2 = await reload('quin5', 'quin', 'quin', g);
  assert.equal((await changes(quin2, g)).length, 1);
  await accept(quin2, g);
  await sendMessage(sam, 'sam', g.chatId, 'بعد از شروع تازه');
  assert.deepEqual(sorted(await readAll(quin2, 'quin', g.chatId)), sorted(['قبل از شروع تازه', 'بعد از شروع تازه']));
  const sam2 = await reload('sam4', 'sam', 'sam', g);                                 // reload: her own envelope (wrapped by herself) opens
  assert.deepEqual(sorted(await readAll(sam2, 'sam', g.chatId)), sorted([LOCKED, 'بعد از شروع تازه']));
  const encrypted = await as(sam2, (m) => m.encryptContent(g.chatId, String(ids.sam), { kind: 'text', text: 'x', payload: null }));
  assert.equal(encrypted.keyVersion, 2);
});
