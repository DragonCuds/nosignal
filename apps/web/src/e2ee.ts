import { generateBackupablePair, toExtractable, type BackupPayload, type ServerBackupBlob } from './backup/crypto.js';
import { api, ApiError, type ChatMessageSummary, type Message, type OutboundEncryptedPayload } from './api.js';
import { groupsApi, type GroupDetail } from './groups/groupsApi.js';

type Content = Pick<ChatMessageSummary, 'kind' | 'text' | 'payload'>;
type StoredIdentity = { userId: string; privateKey: CryptoKey; publicKey: JsonWebKey; fingerprint: string };
type CryptoState = {
  members: Array<{ userId: string; publicKey: JsonWebKey | null; fingerprint: string | null }>;
  envelope: { senderId: string; version: 1; nonce: string; ciphertext: string } | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();
// The identity private key is stored in IndexedDB as an EXTRACTABLE CryptoKey (see toExtractable): backup/recovery must be
// able to export it. It is not hidden from script in this origin or from someone with access to the browser profile.
let identity: StoredIdentity | undefined;
// Private JWK of a identity created in THIS session only (needed for key backup); never persisted.
let sessionPrivateJwk: JsonWebKey | undefined;
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const bytesToB64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};
const b64ToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};
const keyAad = (chatId: string, recipientId: string, creatorId: string) =>
  encoder.encode(`tel:e2ee-key:v1:${chatId}:${recipientId}:${creatorId}`);
const messageAadV1 = (chatId: string, senderId: string) =>
  encoder.encode(`tel:message:v1:${chatId}:${senderId}`);
const messageAadV2 = (chatId: string, senderId: string, cipherId: string, kind: Content['kind']) =>
  encoder.encode(`tel:message:v2:${chatId}:${senderId}:${cipherId}:${kind}`);

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open('tel-e2ee', 2);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('identities')) request.result.createObjectStore('identities', { keyPath: 'userId' });
    if (!request.result.objectStoreNames.contains('pins')) request.result.createObjectStore('pins');
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
const readPin = async (memberId: string): Promise<string | undefined> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const db = await openDb();
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const request = db.transaction('pins').objectStore('pins').get(`${identity!.userId}:${memberId}`);
      request.onsuccess = () => resolve(request.result as string | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
};
const writePin = async (memberId: string, value: string): Promise<void> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('pins', 'readwrite');
      transaction.objectStore('pins').put(value, `${identity!.userId}:${memberId}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
};
const pinMember = async (memberId: string, value: string): Promise<void> => {
  const existing = await readPin(memberId);
  if (existing && existing !== value) throw new KeyChangedError(memberId, existing, value);
  if (!existing) await writePin(memberId, value);
};
const fingerprint = async (jwk: JsonWebKey): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`P-256:${jwk.x}:${jwk.y}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

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

/** The user explicitly accepted the contact's new key: re-pin it and drop everything derived from the old one. */
export const acceptKeyChange = async (chatId: string, change: KeyChange): Promise<void> => {
  const current = (await checkKeyChanges(chatId)).find((item) => item.memberId === change.memberId);
  if (!current || current.newFingerprint !== change.newFingerprint) throw new Error('The key changed again; review it first');
  await writePin(change.memberId, current.newFingerprint);
  keyCache.clear();
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
  return { userId: record.userId, publicKey: record.publicKey, privateKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
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
  keyCache.clear();
  groupCtxs.clear();
  await api.registerCryptoIdentity(next.userId, next.publicKey, undefined, signal);
};

const wrapKey = async (chatId: string, recipientId: string, creatorId: string, publicJwk: JsonWebKey, rawKey: Uint8Array) => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, identity.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`tel:${chatId}`), info: encoder.encode('tel chat key envelope v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(keyAad(chatId, recipientId, creatorId)) }, wrappingKey, buffer(rawKey));
  return { recipientId, version: 1 as const, nonce: bytesToB64(nonce), ciphertext: bytesToB64(new Uint8Array(ciphertext)) };
};

const unwrapRaw = async (chatId: string, state: CryptoState): Promise<ArrayBuffer> => {
  if (!identity || !state.envelope) throw new Error('Encryption key is unavailable');
  const sender = state.members.find((member) => member.userId === state.envelope!.senderId);
  if (!sender?.publicKey) throw new Error('Encryption sender identity is unavailable');
  const publicKey = await crypto.subtle.importKey('jwk', sender.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, identity.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`tel:${chatId}`), info: encoder.encode('tel chat key envelope v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(b64ToBytes(state.envelope.nonce)), additionalData: buffer(keyAad(chatId, identity.userId, state.envelope.senderId)) }, wrappingKey, buffer(b64ToBytes(state.envelope.ciphertext)));
};
const unwrapKey = async (chatId: string, state: CryptoState): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', await unwrapRaw(chatId, state), 'AES-GCM', false, ['encrypt', 'decrypt']);

const establishKey = async (chatId: string, state: CryptoState): Promise<CryptoKey> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  if (state.members.some((member) => !member.publicKey)) throw new Error('طرف مقابل هنوز رمزنگاری را راه‌اندازی نکرده است.');
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const envelopes = await Promise.all(state.members.map((member) => wrapKey(chatId, member.userId, identity!.userId, member.publicKey!, raw)));
  await api.createCryptoEnvelopes(chatId, envelopes);
  const refreshed = await api.chatCrypto(chatId);
  return unwrapKey(chatId, refreshed);
};

const verifyMembers = async (state: CryptoState): Promise<void> => {
  for (const member of state.members) {
    if (!member.publicKey || !member.fingerprint) continue;
    const actual = await fingerprint(member.publicKey);
    if (actual !== member.fingerprint) throw new Error('Invalid encryption identity fingerprint');
    await pinMember(member.userId, actual);
  }
};

/** Check every recipient before creating any envelope. Pin first contacts only after all existing pins match. */
const verifyRecipients = async (members: Array<{ userId: string; publicKey: JsonWebKey | null }>): Promise<Array<{ userId: string; publicKey: JsonWebKey; fingerprint: string }>> => {
  if (!identity) throw new Error('Encryption identity is not initialized');
  const checked: Array<{ userId: string; publicKey: JsonWebKey; fingerprint: string }> = [];
  for (const member of members) {
    if (!member.publicKey) throw new Error('یکی از اعضا هنوز رمزنگاری را راه‌اندازی نکرده است.');
    const actual = await fingerprint(member.publicKey);
    if (member.userId === identity.userId && actual !== identity.fingerprint) throw new Error('کلید رمزنگاری حساب شما با کلید سرور یکسان نیست.');
    const pinned = await readPin(member.userId);
    if (pinned && pinned !== actual) throw new KeyChangedError(member.userId, pinned, actual);
    checked.push({ ...member, publicKey: member.publicKey, fingerprint: actual });
  }
  for (const member of checked) await pinMember(member.userId, member.fingerprint);
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
  if (!ctx) { ctx = { groupId: id, chatId, keys: new Map(), raws: new Map(), latest: 0, checkedAt: 0, members: new Map(), misses: new Map() }; groupCtxs.set(id, ctx); }
  return ctx;
};
const loadGroupDetail = async (ctx: GroupCtx): Promise<GroupDetail> => {
  const detail = await groupsApi.get(ctx.groupId);
  ctx.detail = detail;
  ctx.members.clear();
  for (const member of detail.members) ctx.members.set(member.id, member.publicKey);
  return detail;
};
const absorbGroupKeys = async (ctx: GroupCtx, entries: Array<{ version: number; wrapped: string; wrappedBy: string }>): Promise<void> => {
  for (const entry of entries) {
    if (ctx.keys.has(entry.version) || entry.wrapped.length < 20) continue;
    try {
      let publicKey = ctx.members.get(entry.wrappedBy);
      if (publicKey === undefined) { await loadGroupDetail(ctx); publicKey = ctx.members.get(entry.wrappedBy); }
      if (!publicKey) continue;
      await pinMember(entry.wrappedBy, await fingerprint(publicKey)); // trust on first use, like direct chats
      const state: CryptoState = { members: [{ userId: entry.wrappedBy, publicKey, fingerprint: null }], envelope: { senderId: entry.wrappedBy, version: 1, nonce: entry.wrapped.slice(0, 16), ciphertext: entry.wrapped.slice(16) } };
      const raw = new Uint8Array(await unwrapRaw(groupScope(ctx.groupId, entry.version), state));
      ctx.raws.set(entry.version, raw);
      ctx.keys.set(entry.version, await crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']));
      ctx.latest = Math.max(ctx.latest, entry.version);
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
  const pending = api.chatCrypto(chatId).then(async (state) => {
    await verifyMembers(state);
    return state.envelope ? unwrapKey(chatId, state) : establishKey(chatId, state);
  });
  keyCache.set(chatId, pending);
  pending.catch(() => keyCache.delete(chatId));
  return pending;
};

/** `version` only matters in groups (older media is encrypted under the key version of its message). */
export const chatEncryptionKey = async (chatId: string, version?: number): Promise<CryptoKey> => {
  if (version !== undefined && groupOfChat.has(chatId)) { const [key] = await groupKeyCandidates(chatId, version); if (key) return key; }
  return chatKey(chatId);
};

export const encryptContent = async (chatId: string, senderId: string, content: Content): Promise<OutboundEncryptedPayload> => {
  let key: CryptoKey;
  let keyVersion: number | undefined;
  if (groupOfChat.has(chatId)) ({ key, version: keyVersion } = await currentGroupKey(chatId));
  else key = await chatKey(chatId);
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
    } else plaintext = await decryptWith(await chatKey(message.chatId));
    const content = JSON.parse(decoder.decode(plaintext)) as Content;
    if (content.kind !== message.kind || (content.kind === 'text' && (typeof content.text !== 'string' || content.text.trim().length === 0 || content.text.length > 4_096))) throw new Error('Invalid plaintext');
    return { ...message, kind: content.kind, text: content.text, payload: content.payload };
  } catch {
    return { ...message, kind: 'text', text: '🔒 پیام قابل رمزگشایی نیست', payload: null };
  }
};

export const decryptMessages = <T extends Message>(messages: T[]): Promise<T[]> => Promise.all(messages.map(decryptMessage));

