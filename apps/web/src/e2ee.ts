import { generateBackupablePair, toExtractable, type BackupPayload, type ServerBackupBlob } from './backup/crypto.js';
import { api, ApiError, type ChatCryptoState, type ChatMessageSummary, type Message, type OutboundEncryptedPayload } from './api.js';
import { groupsApi, type GroupDetail, type GroupKeyEntry } from './groups/groupsApi.js';
import { isStaleKeyError } from './keyErrors.js';
import { b64ToBytes, bytesToB64, fingerprintOf, openEnvelopes, senderKeyFor, unwrapChatKey, wrapChatKey, type OpenedKey } from './dmKeys.js';
import { acceptPin, currentPin, isLegacyPin, mergePins, normalizePins, pinsForBackup, readBackupPins, type PinList } from './pins.js';

type Content = Pick<ChatMessageSummary, 'kind' | 'text' | 'payload'>;
type StoredIdentity = { userId: string; privateKey: CryptoKey; publicKey: JsonWebKey; fingerprint: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Channel chats only: the server-held channel key. Direct chats use dmCache (all key versions), groups use groupCtxs.
const keyCache = new Map<string, Promise<CryptoKey>>();
// The identity private key is stored in IndexedDB as an EXTRACTABLE CryptoKey (see toExtractable): backup/recovery must be
// able to export it. It is not hidden from script in this origin or from someone with access to the browser profile.
let identity: StoredIdentity | undefined;
// Private JWK of a identity created in THIS session only (needed for key backup); never persisted.
let sessionPrivateJwk: JsonWebKey | undefined;
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const messageAadV1 = (chatId: string, senderId: string) =>
  encoder.encode(`tel:message:v1:${chatId}:${senderId}`);
const messageAadV2 = (chatId: string, senderId: string, cipherId: string, kind: Content['kind']) =>
  encoder.encode(`tel:message:v2:${chatId}:${senderId}:${cipherId}:${kind}`);

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open('tel-e2ee', 3);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('identities')) request.result.createObjectStore('identities', { keyPath: 'userId' });
    if (!request.result.objectStoreNames.contains('pins')) request.result.createObjectStore('pins');
    if (!request.result.objectStoreNames.contains('keyFloors')) request.result.createObjectStore('keyFloors'); // S9a: key version floors
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const dbGet = async (userId: string): Promise<StoredIdentity | undefined> => {
  const db = await openDb();
  return new Promise<StoredIdentity | undefined>((resolve, reject) => {
    const request = db.transaction('identities').objectStore('identities').get(userId);
    request.onsuccess = () => resolve(request.result as StoredIdentity | undefined);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
};
const dbPut = async (record: StoredIdentity): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('identities', 'readwrite');
    transaction.objectStore('identities').put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
};
const dbDelete = async (userId: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('identities', 'readwrite');
    transaction.objectStore('identities').delete(userId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
};
/** The contact's key differs from the one we pinned (trust on first use). Thrown instead of ever re-pinning silently. */
export class KeyChangedError extends Error {
  constructor(readonly memberId: string, readonly oldFingerprint: string, readonly newFingerprint: string) {
    super('Encryption identity changed; verify the contact before continuing');
    this.name = 'KeyChangedError';
  }
}
// Pins are stored per (own user, contact). The value is a LIST of accepted fingerprints, the last one is current
// (pins.ts). Values written by earlier versions are a single string: they are read as a one-entry list and rewritten as a list.
const pinKey = (memberId: string): string => `${identity!.userId}:${memberId}`;
const writePins = async (memberId: string, list: PinList): Promise<void> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('pins', 'readwrite');
      transaction.objectStore('pins').put(list, pinKey(memberId));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
};
const readPins = async (memberId: string): Promise<PinList> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const db = await openDb();
  let stored: unknown;
  try {
    stored = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('pins').objectStore('pins').get(pinKey(memberId));
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
  const list = normalizePins(stored);
  if (isLegacyPin(stored)) await writePins(memberId, list).catch(() => undefined); // migrate on load; reading still works if this fails
  return list;
};
const readPin = async (memberId: string): Promise<string | undefined> => currentPin(await readPins(memberId));
/** Every pin history of THIS user (keys `${userId}:${contactId}`), for the backup. Reads only; legacy single values are read as lists. */
const readAllPins = async (userId: string): Promise<Array<[string, PinList]>> => {
  const prefix = `${userId}:`;
  const db = await openDb();
  try {
    const { keys, values } = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
      const store = db.transaction('pins').objectStore('pins');
      const found = { keys: [] as IDBValidKey[], values: [] as unknown[] };
      const keyRequest = store.getAllKeys();
      const valueRequest = store.getAll();
      keyRequest.onsuccess = () => { found.keys = keyRequest.result; };
      valueRequest.onsuccess = () => { found.values = valueRequest.result as unknown[]; resolve(found); };
      keyRequest.onerror = () => reject(keyRequest.error);
      valueRequest.onerror = () => reject(valueRequest.error);
    });
    const result: Array<[string, PinList]> = [];
    keys.forEach((key, index) => {
      if (typeof key === 'string' && key.startsWith(prefix) && key.length > prefix.length) result.push([key.slice(prefix.length), normalizePins(values[index])]);
    });
    return result;
  } finally { db.close(); }
};
/** First contact pins the key. A different key for an already pinned contact is never pinned here: it is reported. */
const pinMember = async (memberId: string, value: string): Promise<void> => {
  const list = await readPins(memberId);
  const now = currentPin(list);
  if (now && now !== value) throw new KeyChangedError(memberId, now, value);
  if (!now) await writePins(memberId, acceptPin(list, value));
};
const fingerprint = fingerprintOf;

// ---- Key version floor (S9a) ----
// Per (own user, chat) this browser remembers the lowest key version it may still SEND with. A malicious server could otherwise
// report an older key version as the current one (for a direct chat: our own old envelope, which always opens), and a message
// would be sealed with a key that a stolen old identity can read. `used` is the highest version this browser sent with; `floor`
// follows it, and is raised further when the user accepts a contact's new identity (the next version must be a fresh one).
// Reading older messages never looks at the floor.
type KeyFloor = { floor: number; used: number };
const floorKey = (chatId: string): string => `${identity!.userId}:${chatId}`;
const wholeNumber = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0);
const readFloor = async (chatId: string): Promise<KeyFloor> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const db = await openDb();
  try {
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('keyFloors').objectStore('keyFloors').get(floorKey(chatId));
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () => reject(request.error);
    });
    const record = (stored ?? {}) as Partial<KeyFloor>;
    return { floor: wholeNumber(record.floor), used: wholeNumber(record.used) };
  } finally { db.close(); }
};
/** Raises (never lowers) the floor and/or the highest used version in one transaction. */
const raiseFloor = async (chatId: string, change: { floor?: number; used?: number }): Promise<void> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const key = floorKey(chatId);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('keyFloors', 'readwrite');
      const store = transaction.objectStore('keyFloors');
      const request = store.get(key);
      request.onsuccess = () => {
        const old = (request.result ?? {}) as Partial<KeyFloor>;
        const next: KeyFloor = {
          floor: Math.max(wholeNumber(old.floor), change.floor ?? 0, change.used ?? 0),
          used: Math.max(wholeNumber(old.used), change.used ?? 0)
        };
        if (next.floor !== wholeNumber(old.floor) || next.used !== wholeNumber(old.used)) store.put(next, key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
};

/** The chat is at a key version below the one this browser already moved past: sending is refused, reading older messages still works. */
export class ChatKeyRollbackError extends Error {
  constructor() { super('Encryption key is unavailable: the chat key went back to an older version. کلید گفت‌وگو به نسخهٔ قدیمی‌تری برگشته است؛ برای امنیت ارسال انجام نشد.'); this.name = 'ChatKeyRollbackError'; }
}

export type KeyChange = { memberId: string; oldFingerprint: string; newFingerprint: string };

/** Contacts of this chat whose server-side key no longer matches the pinned one. Never changes any pin. */
export const checkKeyChanges = async (chatId: string): Promise<KeyChange[]> => {
  if (!identity || channelOfChat.has(chatId)) return [];
  let keys: Array<{ memberId: string; publicKey: JsonWebKey | null }>;
  const groupId = groupOfChat.get(chatId);
  if (groupId) keys = (await groupsApi.get(groupId)).members.map((member) => ({ memberId: member.id, publicKey: member.publicKey }));
  else keys = (await api.chatCrypto(chatId)).members.map((member) => ({ memberId: member.userId, publicKey: member.publicKey }));
  const changes: KeyChange[] = [];
  for (const { memberId, publicKey } of keys) {
    if (memberId === identity.userId || !publicKey) continue;
    const pinned = await readPin(memberId);
    const actual = await fingerprint(publicKey);
    if (pinned && pinned !== actual) changes.push({ memberId, oldFingerprint: pinned, newFingerprint: actual });
  }
  return changes;
};

/** The user explicitly accepted the contact's new key: make it the current pin and drop everything derived from the old one. */
export const acceptKeyChange = async (chatId: string, change: KeyChange): Promise<void> => {
  const current = (await checkKeyChanges(chatId)).find((item) => item.memberId === change.memberId);
  if (!current || current.newFingerprint !== change.newFingerprint) throw new Error('The key changed again; review it first');
  // The new key becomes the current pin; the previous ones stay in the history so keys this contact wrapped earlier still open.
  await writePins(change.memberId, acceptPin(await readPins(change.memberId), current.newFingerprint));
  if (!groupOfChat.has(chatId)) {
    // Private chat (S9a): the contact's identity just changed, so a version made for the OLD identity must not be used to send
    // any more (the contact may have lost that key, or had it stolen). The lowest acceptable version becomes:
    //  - the one the server is still waiting for (`pending`) and never lower than the version after the last one this browser
    //    sent with; or, when nothing is pending,
    //  - the current version if the contact wrapped it with the key just accepted (it was made after the change), else the
    //    version after the last one this browser used.
    // A server that later goes back to a lower version, even one this browser never saw, is refused (dmSendKeys).
    const state = await api.chatCrypto(chatId);
    let floor = (await readFloor(chatId)).used + 1;
    if (state.pendingKeyVersion != null) floor = Math.max(floor, state.pendingKeyVersion);
    else {
      const envelope = state.envelopes.find((item) => item.version === state.keyVersion);
      if (envelope && envelope.senderId === change.memberId && envelope.senderPublicKey && await fingerprint(envelope.senderPublicKey) === current.newFingerprint) floor = Math.max(floor, state.keyVersion);
    }
    await raiseFloor(chatId, { floor });
  } else {
    // Group (S9a): same idea. A member's identity changed, so the version this browser has been sending with (made while that
    // member still had the old identity) must not be used any more; only a later one. A server that hides the pending rotation and
    // hands out the old version again is refused (sendGroupKey). The floor is the version after the last one USED here, and at
    // least the one the server is waiting for. A version this browser has merely seen is not counted: an admin may already have
    // made the next version after the change, and that one has to stay usable (it is the normal path).
    const groupId = groupOfChat.get(chatId)!;
    const pending = (await groupsApi.get(groupId).catch(() => undefined))?.pendingKeyVersion ?? 0;
    await raiseFloor(chatId, { floor: Math.max((await readFloor(chatId)).used + 1, pending) });
  }
  keyCache.clear();
  dmCache.clear();
  dmReadCache.clear();
  groupCtxs.clear();
};

export const hasLocalIdentity = async (userId: string): Promise<boolean> => Boolean(await dbGet(userId));

export type InitResult = { fingerprint: string; created: boolean; backupSaved: boolean };

/**
 * Loads (or, on first use, creates) this device's identity and registers its public half on the server.
 * With `wrap`, a freshly created key is sent together with its password-wrapped backup so the server stores
 * both in one transaction (no window in which the server knows the identity but holds no recoverable copy).
 */
export const initializeIdentity = async (userId: string, wrap?: (payload: BackupPayload) => Promise<ServerBackupBlob>, beforeWrite?: () => void, signal?: AbortSignal): Promise<InitResult> => {
  groupCtxs.clear();
  dmCache.clear();
  dmReadCache.clear();
  const stored = await dbGet(userId);
  beforeWrite?.();
  let created = false;
  if (stored) identity = stored;
  else {
    const pair = await generateBackupablePair();
    beforeWrite?.();
    const next = { userId, privateKey: await toExtractable(pair.privateJwk), publicKey: pair.publicJwk, fingerprint: await fingerprint(pair.publicJwk) };
    beforeWrite?.();
    sessionPrivateJwk = pair.privateJwk;
    // Stored extractable on purpose (backup needs to export it); see SECURITY.md "Key storage". Do not change without a new backup design.
    identity = next;
    await dbPut(next);
    beforeWrite?.();
    created = true;
  }
  let blob: ServerBackupBlob | undefined;
  if (created && wrap) {
    try {
      const payload = await payloadOf(identity, sessionPrivateJwk);
      if (payload) blob = await wrap(payload);
    } catch { /* registered without a backup; the caller queues the upload */ }
  }
  try {
    beforeWrite?.();
    const result = await api.registerCryptoIdentity(userId, identity.publicKey, blob, signal);
    return { fingerprint: identity.fingerprint, created, backupSaved: Boolean(result.backupSaved) };
  } catch (caught) {
    // The account is already bound to another identity (this browser lost its key): do not keep a useless new key here.
    if (!stored && caught instanceof ApiError && caught.status === 409) { await dbDelete(userId); identity = undefined; sessionPrivateJwk = undefined; }
    throw caught;
  }
};

export const initializeEncryption = async (userId: string): Promise<string> => (await initializeIdentity(userId)).fingerprint;

/** Current identity as a backup payload; null only for an old key that an earlier version stored non-extractable. */
export const getBackup = async (): Promise<BackupPayload | null> => {
  if (!identity) return null;
  return payloadOf(identity, sessionPrivateJwk);
};

const payloadOf = async (record: StoredIdentity, known?: JsonWebKey): Promise<BackupPayload | null> => {
  let jwk = known;
  if (jwk?.d === undefined) {
    if (!record.privateKey.extractable) return null;
    jwk = await crypto.subtle.exportKey('jwk', record.privateKey);
  }
  const payload: BackupPayload = { userId: record.userId, publicKey: record.publicKey, privateKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
  // The pin history goes along, so a restored browser can open envelopes a contact wrapped with an identity this user had accepted.
  // Failing to read it must not stop the identity from being backed up.
  const pins = pinsForBackup(await readAllPins(record.userId).catch(() => []));
  if (pins) payload.pins = pins;
  return payload;
};

/** Same as getBackup but straight from this browser's storage (works before initializeEncryption ran). */
export const exportLocalIdentity = async (userId: string): Promise<BackupPayload | null> => {
  const stored = await dbGet(userId);
  return stored ? payloadOf(stored) : null;
};

/** "Start fresh": the server forgets the old identity (password required), this browser makes a new one. */
export const resetIdentity = async (userId: string, password: string, secondFactor?: string): Promise<void> => {
  const state = await api.cryptoBackup().catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  const revision = state?.revision ?? 0;
  const { token } = await api.cryptoActionGrant('identity.reset', revision, password, secondFactor);
  await api.resetCryptoIdentity(revision, token);
  const pair = await generateBackupablePair();
  const next: StoredIdentity = { userId, privateKey: await toExtractable(pair.privateJwk), publicKey: pair.publicJwk, fingerprint: await fingerprint(pair.publicJwk) };
  await dbPut(next);
  identity = next;
  sessionPrivateJwk = pair.privateJwk;
  keyCache.clear();
  dmCache.clear();
  dmReadCache.clear();
  groupCtxs.clear();
  await api.registerCryptoIdentity(userId, next.publicKey);
};

/** Restore an identity from a backup (new device): store it extractable (so it can be backed up again) and re-register. */
export const importIdentity = async (payload: BackupPayload, beforeWrite?: () => void, signal?: AbortSignal): Promise<void> => {
  const next: StoredIdentity = {
    userId: payload.userId,
    privateKey: await toExtractable(payload.privateKey),
    publicKey: payload.publicKey,
    fingerprint: await fingerprint(payload.publicKey),
  };
  beforeWrite?.();
  await dbPut(next);
  beforeWrite?.();
  identity = next;
  sessionPrivateJwk = payload.privateKey;
  await restorePins(payload.pins);
  keyCache.clear();
  dmCache.clear();
  dmReadCache.clear();
  groupCtxs.clear();
  await api.registerCryptoIdentity(next.userId, next.publicKey, undefined, signal);
};

/**
 * Merge the pin history of a backup into this browser's pins (see pins.mergePins). Backups made before pins were included have
 * none, and that is fine. A pin that cannot be written is skipped: the identity itself is already restored.
 */
const restorePins = async (stored: BackupPayload['pins']): Promise<void> => {
  for (const [contactId, fromBackup] of readBackupPins(stored)) {
    try { await writePins(contactId, mergePins(await readPins(contactId), fromBackup)); } catch { /* keep going with the other contacts */ }
  }
};

// Groups: one wrapped string per member, original envelope format (no key version in the additional data).
const wrapKey = async (scope: string, recipientId: string, creatorId: string, publicJwk: JsonWebKey, rawKey: Uint8Array) => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const wrapped = await wrapChatKey({ scope, recipientId, creatorId, creatorPrivateKey: identity.privateKey, recipientPublicKey: publicJwk, raw: rawKey });
  return { recipientId, version: 1 as const, ...wrapped };
};

// ---- Direct chats and Saved Messages: numbered key versions (NS-07). ----
// Version v has one envelope per member. After someone starts fresh the server asks for version v+1; whoever opens the chat
// first creates it, wrapped for the members' CURRENT identities. Old versions stay readable for the contact: their envelopes
// carry the sender's public key from back then, accepted only if this browser pinned that fingerprint earlier (dmKeys.ts).
// `key` is the key for NEW messages; absent when the server reports a version below this browser's floor (S9a): the older keys
// in `keys` still open older messages.
type DmKeys = { version: number; key: CryptoKey | undefined; keys: Map<number, CryptoKey>; loadedAt: number };
const dmCache = new Map<string, Promise<DmKeys>>();
// (dmReadCache, below, is cleared next to it)

/** The key a message was built with is no longer the current one. */
export class StaleChatKeyError extends Error {
  constructor() { super('کلید گفت‌وگو عوض شده است؛ دوباره بفرستید.'); this.name = 'StaleChatKeyError'; }
}

const verifyMembers = async (state: ChatCryptoState): Promise<void> => {
  for (const member of state.members) {
    if (!member.publicKey) continue; // establishKey refuses a chat where a member has no key
    // The fingerprint is always computed here from the key itself. The server's copy may only be checked against it: a missing
    // one is no reason to skip the member (that would let a key without a pin pass), a different one is an error.
    const actual = await fingerprint(member.publicKey);
    if (member.fingerprint && actual !== member.fingerprint) throw new Error('Invalid encryption identity fingerprint');
    // Our own key is known locally, not trusted on first use: a pin left over from before "start fresh" must not block us.
    if (member.userId === identity?.userId) {
      if (actual !== identity.fingerprint) throw new Error('کلید رمزنگاری حساب شما با کلید سرور یکسان نیست.');
      continue;
    }
    await pinMember(member.userId, actual);
  }
};

const dmKeyReady = (state: ChatCryptoState): boolean =>
  state.pendingKeyVersion === null && state.keyVersion >= 1 && state.envelopes.some((envelope) => envelope.version === state.keyVersion);

/** Create the next key version (the first one, or the one a reset asked for) for every member and upload it. */
const establishKey = async (chatId: string, state: ChatCryptoState): Promise<ChatCryptoState> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  if (state.members.some((member) => !member.publicKey)) throw new Error('طرف مقابل هنوز رمزنگاری را راه‌اندازی نکرده است.');
  const version = state.pendingKeyVersion ?? Math.max(1, state.keyVersion);
  if (version < (await readFloor(chatId)).floor) throw new ChatKeyRollbackError();
  // Before any envelope is made: every other member's key, as fingerprinted HERE, must be the one pinned (a first contact is
  // pinned now). A key that does not match is reported (KeyChangedError), never wrapped for.
  for (const member of state.members) {
    if (member.userId !== identity.userId) await pinMember(member.userId, await fingerprint(member.publicKey!));
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const envelopes = await Promise.all(state.members.map(async (member) => {
    const recipientFingerprint = await fingerprint(member.publicKey!);
    if (member.userId === identity!.userId && recipientFingerprint !== identity!.fingerprint) throw new Error('کلید رمزنگاری حساب شما با کلید سرور یکسان نیست.');
    const wrapped = await wrapChatKey({ scope: chatId, version, recipientId: member.userId, creatorId: identity!.userId, creatorPrivateKey: identity!.privateKey, recipientPublicKey: member.publicKey!, raw });
    return { recipientId: member.userId, recipientFingerprint, nonce: wrapped.nonce, ciphertext: wrapped.ciphertext };
  }));
  try {
    await api.createCryptoEnvelopes(chatId, { version, senderFingerprint: identity.fingerprint, envelopes });
  } catch (caught) {
    // Another browser created the version first, or the server wants a different one: read the new state and carry on from it.
    if (!(caught instanceof ApiError && caught.status === 409 && caught.data && typeof caught.data.keyVersion === 'number')) throw caught;
  }
  return api.chatCrypto(chatId);
};

const importChatKey = (raw: ArrayBuffer): Promise<CryptoKey> => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

/** Opens every envelope of `state` that passes the pin rules (dmKeys.ts). Needs no current key version and creates nothing. */
const openDmEnvelopes = async (chatId: string, state: ChatCryptoState): Promise<Map<number, OpenedKey>> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const pins = new Map<string, PinList>();
  for (const member of state.members) pins.set(member.userId, await readPins(member.userId));
  return openEnvelopes({
    chatId, recipientId: identity.userId, recipientPrivateKey: identity.privateKey, envelopes: state.envelopes,
    context: {
      selfId: identity.userId, selfFingerprint: identity.fingerprint, selfPublicKey: identity.publicKey,
      pins: (userId) => pins.get(userId) ?? [],
      memberKey: (userId) => state.members.find((member) => member.userId === userId)?.publicKey ?? null
    }
  });
};

// ---- Reading (S9a): opening older messages never depends on the key for NEW messages. ----
// A separate cache from dmCache: it only fetches and opens envelopes. It never creates a key version, and it does not care which
// version is current or pending (a contact who started fresh and has not registered a new identity yet, a server that is
// missing the next version). A version outside the newest-32 list is fetched on its own (`?version=N`).
type DmReadKeys = { keys: Map<number, CryptoKey>; misses: Map<number, number>; inflight: Map<string, Promise<void>>; listed: boolean };
const dmReadCache = new Map<string, DmReadKeys>();
const readEntry = (chatId: string): DmReadKeys => {
  let entry = dmReadCache.get(chatId);
  if (!entry) { entry = { keys: new Map(), misses: new Map(), inflight: new Map(), listed: false }; dmReadCache.set(chatId, entry); }
  return entry;
};
const loadDmReadKeys = async (chatId: string, version: number | undefined): Promise<void> => {
  const state = await api.chatCrypto(chatId, version);
  await verifyMembers(state); // the key-change flow still applies: a changed contact key is reported, not trusted
  const entry = readEntry(chatId);
  for (const [opened, found] of await openDmEnvelopes(chatId, state)) entry.keys.set(opened, await importChatKey(found.raw));
  if (version === undefined) entry.listed = true;
};
const dedupe = (entry: DmReadKeys, name: string, run: () => Promise<void>): Promise<void> => {
  const running = entry.inflight.get(name);
  if (running) return running;
  const started = run().finally(() => entry.inflight.delete(name));
  entry.inflight.set(name, started);
  return started;
};

const loadDmKeys = async (chatId: string): Promise<DmKeys> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const { floor } = await readFloor(chatId);
  let state = await api.chatCrypto(chatId);
  await verifyMembers(state);
  for (let attempt = 0; !dmKeyReady(state) && attempt < 3; attempt += 1) {
    state = await establishKey(chatId, state);
    await verifyMembers(state);
  }
  if (!dmKeyReady(state)) throw new Error('Encryption key is unavailable');
  const keys = new Map<number, CryptoKey>();
  let currentKey: CryptoKey | undefined;
  for (const [version, entry] of await openDmEnvelopes(chatId, state)) {
    const key = await importChatKey(entry.raw);
    keys.set(version, key);
    // New messages only ever use the current version, and only if its envelope is from a key that is trusted today.
    if (version === state.keyVersion && entry.current && version >= floor) currentKey = key;
  }
  // A version below the floor: older messages stay readable, but there is no key for new ones (see dmSendKeys).
  if (!currentKey && state.keyVersion >= floor) throw new Error('Encryption key is unavailable');
  const reading = readEntry(chatId);
  for (const [version, key] of keys) reading.keys.set(version, key);
  return { version: state.keyVersion, key: currentKey, keys, loadedAt: Date.now() };
};

const dmKeysFor = (chatId: string): Promise<DmKeys> => {
  const cached = dmCache.get(chatId);
  if (cached) return cached;
  const pending = loadDmKeys(chatId);
  dmCache.set(chatId, pending);
  pending.catch(() => { if (dmCache.get(chatId) === pending) dmCache.delete(chatId); });
  return pending;
};

/**
 * The key for NEW messages of a direct chat. Refuses (ChatKeyRollbackError) when the chat is at a version below this browser's
 * floor, and records the version it hands out as used. Re-reads the chat once before refusing, so a server that has healed
 * (or a floor raised by another tab) is noticed.
 */
const dmSendKeys = async (chatId: string): Promise<{ key: CryptoKey; version: number }> => {
  const floor = async () => (await readFloor(chatId)).floor;
  let keys = await dmKeysFor(chatId);
  if (!keys.key || keys.version < await floor()) { dmCache.delete(chatId); keys = await dmKeysFor(chatId); }
  if (!keys.key || keys.version < await floor()) throw new ChatKeyRollbackError();
  await raiseFloor(chatId, { used: keys.version });
  return { key: keys.key, version: keys.version };
};

/**
 * The key that opens messages of one version (reading only). The newest versions come in one request; a version that is not among
 * them is requested alone, at most once per MISS_RETRY_MS.
 */
const dmKeyForVersion = async (chatId: string, version: number): Promise<CryptoKey> => {
  const entry = readEntry(chatId);
  const have = () => entry.keys.get(version);
  if (!have() && !entry.listed) await dedupe(entry, 'list', () => loadDmReadKeys(chatId, undefined)).catch((error: unknown) => { if (!entry.keys.size) throw error; });
  if (!have() && Date.now() - (entry.misses.get(version) ?? 0) >= MISS_RETRY_MS) {
    await dedupe(entry, `v${version}`, () => loadDmReadKeys(chatId, version)).catch((error: unknown) => { entry.misses.set(version, Date.now()); throw error; });
    if (!have()) entry.misses.set(version, Date.now());
  }
  const key = have();
  if (!key) throw new Error('No key for this chat key version');
  return key;
};

/** Forget the cached keys of a chat (a send was refused as stale, or the contact's key changed). */
export const invalidateChatKeys = (chatId: string): void => { dmCache.delete(chatId); dmReadCache.delete(chatId); keyCache.delete(chatId); };

/** Check every recipient before creating any envelope. Pin first contacts only after all existing pins match. */
const verifyRecipients = async (members: Array<{ userId: string; publicKey: JsonWebKey | null }>): Promise<Array<{ userId: string; publicKey: JsonWebKey; fingerprint: string }>> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const checked: Array<{ userId: string; publicKey: JsonWebKey; fingerprint: string }> = [];
  for (const member of members) {
    if (!member.publicKey) throw new Error('یکی از اعضا هنوز رمزنگاری را راه‌اندازی نکرده است.');
    const actual = await fingerprint(member.publicKey);
    if (member.userId === identity.userId && actual !== identity.fingerprint) throw new Error('کلید رمزنگاری حساب شما با کلید سرور یکسان نیست.');
    const own = member.userId === identity.userId; // our own key is known locally, never pinned (like verifyMembers)
    const pinned = own ? undefined : await readPin(member.userId);
    if (pinned && pinned !== actual) throw new KeyChangedError(member.userId, pinned, actual);
    checked.push({ ...member, publicKey: member.publicKey, fingerprint: actual });
  }
  for (const member of checked) if (member.userId !== identity.userId) await pinMember(member.userId, member.fingerprint);
  return checked;
};

// chat id -> channel id for chats of type "channel": their key is the server-held channel key, not a per-member envelope.
const channelOfChat = new Map<string, string>();
export const registerChannelChats = (chats: Array<{ id: string; type: string; channelId?: string }>): void => {
  for (const chat of chats) if (chat.type === 'channel' && chat.channelId) channelOfChat.set(chat.id, chat.channelId);
};
export const registerChannelChat = (chatId: string, channelId: string): void => { channelOfChat.set(chatId, channelId); };

// ---- Groups: one shared AES-GCM key per key version, wrapped per member with the same ECDH+HKDF envelope as direct chats. ----
const groupOfChat = new Map<string, string>();
type GroupCtx = {
  groupId: string; chatId: string;
  keys: Map<number, CryptoKey>; raws: Map<number, Uint8Array>; latest: number; checkedAt: number;
  members: Map<string, JsonWebKey | null>; detail?: GroupDetail; misses: Map<number, number>;
  /** Versions whose envelope is from a wrapper who is a member NOW and whose key is trusted today: only these may become `latest`. */
  sendable: Set<number>;
};
const groupCtxs = new Map<string, GroupCtx>();
const KEY_RECHECK_MS = 3_000;
const MISS_RETRY_MS = 5_000;

export const registerGroupChats = (chats: Array<{ id: string; type: string; groupId?: string }>): void => {
  for (const chat of chats) if (chat.type === 'group' && chat.groupId) groupOfChat.set(chat.id, chat.groupId);
};
export const registerGroupChat = (chatId: string, groupId: string): void => { groupOfChat.set(chatId, groupId); };
export const forgetGroup = (chatId: string): void => { const id = groupOfChat.get(chatId); groupOfChat.delete(chatId); if (id) groupCtxs.delete(id); };
export const isGroupChat = (chatId: string): boolean => groupOfChat.has(chatId);

const groupScope = (groupId: string, version: number) => `group:${groupId}:${version}`;
const groupCtx = (chatId: string, groupId?: string): GroupCtx => {
  const id = groupId ?? groupOfChat.get(chatId);
  if (!id) throw new Error('Not a group chat');
  let ctx = groupCtxs.get(id);
  if (!ctx) { ctx = { groupId: id, chatId, keys: new Map(), raws: new Map(), latest: 0, checkedAt: 0, members: new Map(), misses: new Map(), sendable: new Set() }; groupCtxs.set(id, ctx); }
  return ctx;
};
const loadGroupDetail = async (ctx: GroupCtx): Promise<GroupDetail> => {
  const detail = await groupsApi.get(ctx.groupId);
  ctx.detail = detail;
  ctx.members.clear();
  for (const member of detail.members) ctx.members.set(member.id, member.publicKey);
  return detail;
};
/**
 * Opens group key envelopes (NS-07b). Which key may open an envelope is decided by senderKeyFor (dmKeys.ts), the same rule as for
 * direct chats: the wrapper's key stored with the envelope must be a fingerprint this browser pinned for that wrapper before
 * (a never-pinned key is rejected, no trust on first use for history). A key that is not the wrapper's CURRENT pin opens the
 * old version for reading, but never becomes the key for new messages (`ctx.latest` only follows trusted-today envelopes).
 * Group envelopes use the original additional data (no version in it), so unwrapChatKey gets no `version`.
 */
const absorbGroupKeys = async (ctx: GroupCtx, entries: GroupKeyEntry[]): Promise<void> => {
  if (!identity) return;
  // Who is a member now decides which envelope may become the key for new messages (a wrapper who left cannot).
  if (!ctx.detail) await loadGroupDetail(ctx).catch(() => undefined);
  for (const entry of entries) {
    if ((ctx.keys.has(entry.version) && ctx.sendable.has(entry.version)) || entry.wrapped.length < 20) continue;
    try {
      const own = entry.wrappedBy === identity.userId;
      // Our own envelopes are checked against our local identity, never against a pin (a pin of ourselves left over from before
      // "start fresh" must not block us).
      if (!own) {
        let publicKey = ctx.members.get(entry.wrappedBy);
        if (publicKey === undefined) { await loadGroupDetail(ctx); publicKey = ctx.members.get(entry.wrappedBy); }
        // A wrapper who is still a member: pin on first contact; a changed key is never pinned here (KeyChangedError: skip until the user decides).
        if (publicKey) await pinMember(entry.wrappedBy, await fingerprint(publicKey));
      }
      const pins = own ? [] : await readPins(entry.wrappedBy);
      const nonce = entry.wrapped.slice(0, 16);
      const ciphertext = entry.wrapped.slice(16);
      const sender = await senderKeyFor(
        { senderId: entry.wrappedBy, version: entry.version, nonce, ciphertext, senderFingerprint: entry.wrapperFingerprint, senderPublicKey: entry.wrapperPublicKey },
        {
          selfId: identity.userId, selfFingerprint: identity.fingerprint, selfPublicKey: identity.publicKey,
          pins: () => pins, memberKey: (userId) => ctx.members.get(userId) ?? null
        }
      );
      if (!sender) continue;
      const raw = new Uint8Array(await unwrapChatKey({
        scope: groupScope(ctx.groupId, entry.version), recipientId: identity.userId, creatorId: entry.wrappedBy,
        recipientPrivateKey: identity.privateKey, creatorPublicKey: sender.publicKey, nonce, ciphertext
      }));
      ctx.raws.set(entry.version, raw);
      ctx.keys.set(entry.version, await crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']));
      if (sender.current && ctx.members.has(entry.wrappedBy)) { ctx.sendable.add(entry.version); ctx.latest = Math.max(ctx.latest, entry.version); }
    } catch { /* this envelope is unusable (changed identity or corrupt); skip it */ }
  }
};
const fetchGroupKeys = async (ctx: GroupCtx, version: number | 'latest'): Promise<void> => {
  await absorbGroupKeys(ctx, await groupsApi.keys(ctx.groupId, version));
  if (version === 'latest') ctx.checkedAt = Date.now();
};
const currentGroupKey = async (chatId: string): Promise<{ key: CryptoKey; version: number }> => {
  const ctx = groupCtx(chatId);
  if (!ctx.keys.size || Date.now() - ctx.checkedAt > KEY_RECHECK_MS) await fetchGroupKeys(ctx, 'latest').catch((error) => { if (!ctx.keys.size) throw error; });
  const key = ctx.keys.get(ctx.latest);
  if (!key) throw new Error('کلید گروه هنوز آماده نیست؛ کمی بعد دوباره تلاش کنید.');
  return { key, version: ctx.latest };
};
/**
 * The key for NEW group messages (S9a). Besides the key itself, the group's current state is checked: no rotation may be pending,
 * the key must be at least the group's current version, and not below this browser's floor. Whatever the server returned as
 * "latest" is not enough: an old envelope, or one by someone who already left, would otherwise be taken for the current key.
 */
const sendGroupKey = async (chatId: string): Promise<{ key: CryptoKey; version: number }> => {
  const ctx = groupCtx(chatId);
  if (!ctx.keys.size || !ctx.detail || Date.now() - ctx.checkedAt > KEY_RECHECK_MS) {
    try { await loadGroupDetail(ctx); await fetchGroupKeys(ctx, 'latest'); } catch (error) { if (!ctx.keys.size || !ctx.detail) throw error; }
  }
  const detail = ctx.detail;
  const key = ctx.sendable.has(ctx.latest) ? ctx.keys.get(ctx.latest) : undefined;
  if (!detail || !key || detail.pendingKeyVersion != null || ctx.latest < detail.keyVersion) throw new Error('کلید گروه هنوز آماده نیست؛ کمی بعد دوباره تلاش کنید.');
  if (ctx.latest < (await readFloor(chatId)).floor) throw new ChatKeyRollbackError();
  await raiseFloor(chatId, { used: ctx.latest });
  return { key, version: ctx.latest };
};
const groupKeyCandidates = async (chatId: string, version: number | undefined): Promise<CryptoKey[]> => {
  const ctx = groupCtx(chatId);
  if (version !== undefined) {
    let key = ctx.keys.get(version);
    if (!key && Date.now() - (ctx.misses.get(version) ?? 0) > MISS_RETRY_MS) {
      await fetchGroupKeys(ctx, version).catch(() => undefined);
      key = ctx.keys.get(version);
      if (!key) ctx.misses.set(version, Date.now());
    }
    return key ? [key] : [];
  }
  if (!ctx.keys.size) await fetchGroupKeys(ctx, 'latest').catch(() => undefined);
  return [...ctx.keys.entries()].sort((a, b) => b[0] - a[0]).map(([, key]) => key);
};

/** Wrap `raw` for every current member and upload it as `version`. */
const uploadGroupKey = async (ctx: GroupCtx, detail: GroupDetail, version: number, raw: Uint8Array): Promise<void> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const recipients = await verifyRecipients(detail.members.map((member) => ({ userId: member.id, publicKey: member.publicKey })));
  const envelopes = await Promise.all(recipients.map(async (member) => {
    const wrapped = await wrapKey(groupScope(ctx.groupId, version), member.userId, identity!.userId, member.publicKey, raw);
    return { userId: member.userId, wrapped: wrapped.nonce + wrapped.ciphertext };
  }));
  await groupsApi.putKeys(ctx.groupId, version, recipients.map((member) => ({ userId: member.userId, fingerprint: member.fingerprint })), envelopes);
  ctx.raws.set(version, raw);
  ctx.keys.set(version, await crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']));
  ctx.latest = Math.max(ctx.latest, version);
  ctx.sendable.add(version);
  ctx.detail = { ...detail, keyVersion: Math.max(detail.keyVersion, version), pendingKeyVersion: null }; // the server accepted this version
  ctx.checkedAt = Date.now();
};

/** Owner/admin: create the first key, or finish a rotation left pending by a removal/leave. Members: just load the key. */
export const ensureGroupKeyed = async (chatId: string, groupId?: string): Promise<{ keyed: boolean; rotated: boolean }> => {
  const ctx = groupCtx(chatId, groupId);
  const detail = await loadGroupDetail(ctx);
  await fetchGroupKeys(ctx, 'latest');
  const pending = detail.pendingKeyVersion;
  if (pending == null && ctx.latest >= detail.keyVersion && detail.keyVersion >= 1) return { keyed: true, rotated: false };
  if (detail.role !== 'owner' && detail.role !== 'admin') return { keyed: false, rotated: false };
  // The server is waiting for key version `pending` (new group, or after a removal/leave): create and upload it now.
  await uploadGroupKey(ctx, detail, pending ?? detail.keyVersion + 1, crypto.getRandomValues(new Uint8Array(32)));
  return { keyed: true, rotated: true };
};

/** Admin: always start a new key version (used after adding a member, so the newcomer cannot read older messages). */
export const rotateGroupKey = async (chatId: string, groupId?: string): Promise<void> => {
  const ctx = groupCtx(chatId, groupId);
  const detail = await loadGroupDetail(ctx);
  await uploadGroupKey(ctx, detail, detail.pendingKeyVersion ?? detail.keyVersion + 1, crypto.getRandomValues(new Uint8Array(32)));
};

/** Wrap the current group key for a person about to be added (the server needs it with the add request). */
export const wrapCurrentGroupKeyFor = async (chatId: string, userId: string, publicKey: JsonWebKey): Promise<string> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const ctx = groupCtx(chatId);
  if (!ctx.raws.has(ctx.latest)) await fetchGroupKeys(ctx, 'latest');
  const raw = ctx.raws.get(ctx.latest);
  if (!raw) throw new Error('کلید گروه در دسترس نیست.');
  const wrapped = await wrapKey(groupScope(ctx.groupId, ctx.latest), userId, identity.userId, publicKey, raw);
  return wrapped.nonce + wrapped.ciphertext;
};
export const currentGroupKeyVersion = (chatId: string): number => groupCtx(chatId).latest;

const chatKey = (chatId: string): Promise<CryptoKey> => {
  if (groupOfChat.has(chatId)) return currentGroupKey(chatId).then((current) => current.key);
  const cached = keyCache.get(chatId);
  if (cached) return cached;
  const channelId = channelOfChat.get(chatId);
  if (channelId) {
    const channelPending = api.channelKey(channelId).then((result) => crypto.subtle.importKey('raw', buffer(b64ToBytes(result.key)), 'AES-GCM', false, ['encrypt', 'decrypt']));
    keyCache.set(chatId, channelPending);
    channelPending.catch(() => keyCache.delete(chatId));
    return channelPending;
  }
  return dmSendKeys(chatId).then((keys) => keys.key);
};

/**
 * The key that sealed content of key version `version` (older media is sealed under the version of its message).
 * Direct chats: no version means 1 (messages from before key versions). Groups: no version means the current key.
 */
export const chatEncryptionKey = async (chatId: string, version?: number): Promise<CryptoKey> => {
  if (groupOfChat.has(chatId)) {
    if (version !== undefined) { const [key] = await groupKeyCandidates(chatId, version); if (key) return key; }
    return chatKey(chatId);
  }
  if (channelOfChat.has(chatId)) return chatKey(chatId);
  return dmKeyForVersion(chatId, version ?? 1);
};

/** The key new content must be sealed with, and its version (channels have none). Use the SAME version for everything in one message. */
export const currentChatKey = async (chatId: string): Promise<{ key: CryptoKey; version?: number }> => {
  if (groupOfChat.has(chatId)) return sendGroupKey(chatId);
  if (channelOfChat.has(chatId)) return { key: await chatKey(chatId) };
  return dmSendKeys(chatId);
};

/** `expectVersion`: the version media of this message was already sealed with; a different current version is a StaleChatKeyError. */
export const encryptContent = async (chatId: string, senderId: string, content: Content, expectVersion?: number): Promise<OutboundEncryptedPayload> => {
  let key: CryptoKey;
  let keyVersion: number | undefined;
  if (groupOfChat.has(chatId)) ({ key, version: keyVersion } = await sendGroupKey(chatId));
  else if (channelOfChat.has(chatId)) key = await chatKey(chatId);
  else ({ key, version: keyVersion } = await dmSendKeys(chatId));
  // Media was sealed with one key version; if the chat moved on in between (direct or group), nothing mismatched is sent.
  if (!channelOfChat.has(chatId) && expectVersion !== undefined && expectVersion !== keyVersion) throw new StaleChatKeyError();
  const cipherId = crypto.randomUUID();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(content));
  if (plaintext.byteLength > 16_368) throw new Error('Encrypted message content is too large');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(messageAadV2(chatId, senderId, cipherId, content.kind)) }, key, buffer(plaintext));
  return { version: 2, cipherId, nonce: bytesToB64(nonce), ciphertext: bytesToB64(new Uint8Array(ciphertext)), ...(keyVersion ? { keyVersion } : {}) };
};

export const decryptMessage = async <T extends ChatMessageSummary>(message: T): Promise<T> => {
  if (!message.encrypted || message.deletedAt) return message;
  try {
    const additionalData = message.encrypted.version === 2
      ? messageAadV2(message.chatId, message.senderId, message.encrypted.cipherId, message.kind)
      : messageAadV1(message.chatId, message.senderId);
    const decryptWith = (key: CryptoKey) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(b64ToBytes(message.encrypted!.nonce)), additionalData: buffer(additionalData) }, key, buffer(b64ToBytes(message.encrypted!.ciphertext)));
    let plaintext: ArrayBuffer | undefined;
    if (groupOfChat.has(message.chatId)) {
      const hinted = message.encrypted.version === 2 ? (message.encrypted as { keyVersion?: number }).keyVersion : undefined;
      for (const candidate of await groupKeyCandidates(message.chatId, hinted)) {
        try { plaintext = await decryptWith(candidate); break; } catch { /* try the next key version */ }
      }
      if (!plaintext) throw new Error('No group key opens this message');
    } else if (channelOfChat.has(message.chatId)) plaintext = await decryptWith(await chatKey(message.chatId));
    else {
      // Direct chats: the key version is on the message; messages from before key versions have none and are version 1.
      const version = message.encrypted.version === 2 ? (message.encrypted as { keyVersion?: number }).keyVersion ?? 1 : 1;
      plaintext = await decryptWith(await dmKeyForVersion(message.chatId, version));
    }
    const content = JSON.parse(decoder.decode(plaintext)) as Content;
    if (content.kind !== message.kind || (content.kind === 'text' && (typeof content.text !== 'string' || content.text.trim().length === 0 || content.text.length > 4_096))) throw new Error('Invalid plaintext');
    return { ...message, kind: content.kind, text: content.text, payload: content.payload };
  } catch {
    return { ...message, kind: 'text', text: '🔒 پیام قابل رمزگشایی نیست', payload: null };
  }
};

export const decryptMessages = <T extends Message>(messages: T[]): Promise<T[]> => Promise.all(messages.map(decryptMessage));


// ---- A send was refused because the chat key version was stale (NS-07) ----
const keyChangeListeners = new Set<(chatId: string) => void>();
/** Fires when a background re-encryption found that a contact's key changed (the open chat should show its key-change notice). */
export const onKeyChangeSuspected = (cb: (chatId: string) => void): (() => void) => { keyChangeListeners.add(cb); return () => { keyChangeListeners.delete(cb); }; };

/**
 * Run an encrypt-and-send step; if the server says the chat key version is stale, drop the cached keys and run it once more
 * (the plaintext is still in memory, so nothing is lost). Groups keep their own flow.
 */
export const withFreshChatKey = async <T>(chatId: string, run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (caught) {
    if (!isStaleKeyError(caught) || groupOfChat.has(chatId) || channelOfChat.has(chatId)) throw caught;
    invalidateChatKeys(chatId);
    try { return await run(); } catch (again) {
      if (again instanceof KeyChangedError) for (const cb of keyChangeListeners) { try { cb(chatId); } catch { /* listener bug */ } }
      throw again;
    }
  }
};

/** Outbox: encrypt a queued text again with the chat's current key version (its plaintext is still in memory). */
export const reencryptForStaleKey = async (chatId: string, senderId: string, content: Content): Promise<OutboundEncryptedPayload> => {
  invalidateChatKeys(chatId);
  try { return await encryptContent(chatId, senderId, content); } catch (caught) {
    if (caught instanceof KeyChangedError) for (const cb of keyChangeListeners) { try { cb(chatId); } catch { /* listener bug */ } }
    throw caught;
  }
};
