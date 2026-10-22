import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';

export type User = {
  id: string;
  username: string;
  displayName: string;
  avatarPath: string | null;
};

export type ChatMessageSummary = {
  id: string;
  chatId: string;
  senderId: string;
  kind: 'text' | 'sticker' | 'gif' | 'photo' | 'video' | 'voice' | 'file';
  text: string | null;
  payload: unknown | null;
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt?: string | null;
  encrypted: EncryptedPayload | null;
  /** Idempotency key chosen by the sender (weak-net). */
  clientMsgId?: string | null;
};

export type EncryptedPayload =
  | { version: 1; nonce: string; ciphertext: string }
  | { version: 2; cipherId: string; nonce: string; ciphertext: string; /** Which chat/group key version sealed it (direct chats: absent = version 1, from before key versions). */ keyVersion?: number };

export type OutboundEncryptedPayload = Extract<EncryptedPayload, { version: 2 }>;

export type Message = ChatMessageSummary & {
  deletedAt: string | null;
  sender: User;
};

export type StickerFormat = 'tgs' | 'webm' | 'webp';

export type Sticker = {
  id: string;
  packId: string;
  fileUrl: string;
  format: StickerFormat;
  emoji: string;
  w: number;
  h: number;
  sort: number;
};

export type StickerPack = {
  id: string;
  slug: string;
  title: string;
  thumbUrl: string | null;
};

export type StickerPackDetail = StickerPack & { stickers: Sticker[] };

/** A pack opened from a chat: no slug, and whether the viewer already holds it / is its owner. */
export type SharedStickerPack = Omit<StickerPack, 'slug'> & { stickers: Sticker[]; inLibrary: boolean; owned: boolean };

export type StickerMessagePayload = Pick<Sticker, 'packId' | 'format' | 'w' | 'h' | 'emoji'> & {
  stickerId: string;
  fileUrl?: string;
};

export type Gif = {
  id: string;
  mp4Url: string;
  posterUrl: string;
  w: number;
  h: number;
  durationMs: number;
  tags: string[];
};

export type GifMessagePayload = Pick<Gif, 'mp4Url' | 'w' | 'h' | 'durationMs'> & { gifId: string };

export type RealtimeEvent =
  | { type: 'message.new' | 'message.edited' | 'message.deleted'; chatId: string; message: Message; seq?: number }
  | { type: 'read'; chatId: string; userId: string; messageId: string }
  | { type: 'typing'; chatId: string; userId: string; isTyping: boolean }
  | { type: 'presence'; userId: string; online: boolean; lastSeen: string | null };

/** One entry of the server event log (GET /api/sync). */
export type SyncEvent = { seq: number; type: 'message.new' | 'message.edited' | 'message.deleted'; chatId: string; message: Message };
/** reset=true: too much was missed, the client must refetch lists instead of applying events. */
export type SyncResponse = { events: SyncEvent[]; latest: number; reset: boolean };

export type Chat = {
  id: string;
  type: 'direct' | 'saved' | 'channel' | 'group';
  createdAt: string;
  /** null for the personal "Saved Messages" chat (type 'saved'). */
  peer: User | null;
  /** Channels only (type 'channel'). */
  title?: string;
  avatarPath?: string | null;
  channelId?: string;
  /** Groups only (type 'group'); `id` stays the chat id. */
  groupId?: string;
  role?: 'owner' | 'admin' | 'member';
  memberCount?: number;
  unreadCount: number;
  lastMessage: ChatMessageSummary | null;
};

export type SecurityStatus = {
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  passkeys: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }>;
};

export type DeviceSession = {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** The JSON body of the error answer, when there was one (e.g. the current key version of a chat). */
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ChatCryptoState = {
  members: Array<{ userId: string; publicKey: JsonWebKey | null; fingerprint: string | null }>;
  /** Current key version (0 = none yet) and, after a member started fresh, the version that must be created next. */
  keyVersion: number;
  pendingKeyVersion: number | null;
  /** Envelopes for the caller, newest version first; each carries the sender's public key as it was when wrapped. */
  envelopes: Array<{ senderId: string; version: number; nonce: string; ciphertext: string; senderFingerprint: string | null; senderPublicKey: JsonWebKey | null }>;
};

let unauthorizedHandler: (() => void) | undefined;

export const onUnauthorized = (handler: () => void): (() => void) => {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = undefined;
  };
};

/** Realtime saw its session revoked (close code 4401): same effect as a 401 on any request. */
export const notifyUnauthorized = (): void => unauthorizedHandler?.();

const TIMEOUT_MESSAGE = 'ارتباط با سرور برقرار نشد. اینترنت را بررسی کنید.';
const JSON_TIMEOUT_MS = 15_000;
/** Big multipart bodies (sticker pack, GIF, encrypted media) need longer than a JSON call. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** Timeout and network failure both become ApiError(…, 0) so callers can tell "no answer" from a server refusal. */
const request = async <T>(path: string, init?: RequestInit, timeoutMs = JSON_TIMEOUT_MS): Promise<T> => {
  const isFormData = init?.body instanceof FormData;
  const controller = new AbortController();
  const outer = init?.signal;
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onOuterAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        ...(init?.body && !isFormData ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 401 && !outer?.aborted) unauthorizedHandler?.();
      const body = await response.json().catch(() => null) as ({ error?: string } & Record<string, unknown>) | null;
      throw new ApiError(body?.error ?? 'در ارتباط با سرور مشکلی پیش آمد.', response.status, body && typeof body === 'object' && !Array.isArray(body) ? body : undefined);
    }

    if (response.status === 204) return undefined as T;
    const raw = await response.text();
    return (raw ? JSON.parse(raw) : undefined) as T; // some 201 replies have an empty body
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (outer?.aborted && !timedOut) throw error; // caller cancelled: let the AbortError through
    throw new ApiError(timedOut ? TIMEOUT_MESSAGE : 'اتصال به سرور قطع شد.', 0);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
};

export const api = {
  me: () => request<User>('/api/me'),
  login: (username: string, password: string, secondFactor?: string) =>
    request<void>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, secondFactor }),
    }),
  passkeyLoginOptions: () => request<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkeys/login/options', { method: 'POST' }),
  verifyPasskeyLogin: (response: AuthenticationResponseJSON) => request<void>('/api/auth/passkeys/login/verify', { method: 'POST', body: JSON.stringify({ response }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  chats: () => request<Chat[]>('/api/chats'),
  users: () => request<User[]>('/api/users'),
  createChat: (userId: string) =>
    request<{ id: string; created: boolean }>('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  createSavedChat: () => request<{ id: string; created: boolean }>('/api/chats/saved', { method: 'POST' }),
  searchUsers: (q: string, signal?: AbortSignal) => request<Array<User>>(`/api/users/search?${new URLSearchParams({ q })}`, { signal }),
  usernameAvailable: (u: string, signal?: AbortSignal) => request<{ available: boolean; valid: boolean }>(`/api/username-available?${new URLSearchParams({ u })}`, { signal }),
  register: (username: string, password: string, displayName?: string) =>
    request<void>('/api/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) }),
  registerCryptoIdentity: (userId: string, publicKey: JsonWebKey, backup?: { salt: string; iterations: number; wrapped: string; version: 1 }, signal?: AbortSignal) => request<{ fingerprint: string; backupSaved?: boolean }>('/api/crypto/identity', { method: 'PUT', body: JSON.stringify({ expectedUserId: userId, publicKey, backup }), signal }),
  cryptoBackup: (signal?: AbortSignal) => request<{ mode: 'auto' | 'manual'; backup: { salt: string; iterations: number; wrapped: string; version: 1 } | null; revision: number; updatedAt: string }>('/api/crypto/backup', { signal }),
  cryptoActionGrant: (action: 'backup.replace' | 'backup.delete' | 'identity.reset', expectedRevision: number, password: string, secondFactor?: string) =>
    request<{ token: string }>('/api/crypto/action-grant', { method: 'POST', body: JSON.stringify({ action, expectedRevision, password, secondFactor }) }),
  cryptoSecurityEvents: () => request<Array<{ action: string; createdAt: string }>>('/api/crypto/security-events'),
  putCryptoBackup: (userId: string, blob: { salt: string; iterations: number; wrapped: string; version: 1 }, password: string, expectedRevision: number, actionToken?: string, signal?: AbortSignal) => request<void>('/api/crypto/backup', { method: 'PUT', body: JSON.stringify({ ...blob, expectedUserId: userId, password, expectedRevision, actionToken }), signal }),
  deleteCryptoBackup: (expectedRevision: number, actionToken: string) => request<void>('/api/crypto/backup', { method: 'DELETE', body: JSON.stringify({ expectedRevision, actionToken }) }),
  resetCryptoIdentity: (expectedRevision: number, actionToken: string) => request<void>('/api/crypto/identity/reset', { method: 'POST', body: JSON.stringify({ expectedRevision, actionToken }) }),
  checkPassword: (password: string) => request<void>('/api/crypto/password-check', { method: 'POST', body: JSON.stringify({ password }) }),
  channelKey: (channelId: string) => request<{ version: number; key: string }>(`/api/channels/${encodeURIComponent(channelId)}/key`),
  /** With `version`: only the caller's envelope of that one key version (reaches versions older than the newest-32 cap). */
  chatCrypto: (chatId: string, version?: number) => request<ChatCryptoState>(`/api/chats/${encodeURIComponent(chatId)}/crypto${version === undefined ? '' : `?version=${version}`}`),
  createCryptoEnvelopes: (chatId: string, body: { version: number; senderFingerprint: string; envelopes: Array<{ recipientId: string; recipientFingerprint: string; nonce: string; ciphertext: string }> }) =>
    request<{ keyVersion: number }>(`/api/chats/${encodeURIComponent(chatId)}/crypto/envelopes`, { method: 'POST', body: JSON.stringify(body) }),
  /** How many chats (direct + Saved Messages) a "start fresh" touches. */
  cryptoResetImpact: () => request<{ chats: number }>('/api/crypto/identity/reset-impact'),
  sync: (since?: number) => request<SyncResponse>(`/api/sync${since === undefined ? '' : `?since=${since}`}`),
  messages: (chatId: string, before?: string, limit = 50) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    return request<Message[]>(`/api/chats/${encodeURIComponent(chatId)}/messages?${query}`);
  },
  sendMessage: (chatId: string, encrypted: OutboundEncryptedPayload, replyToId: string | null = null, clientMsgId?: string) =>
    request<Message>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'text', encrypted, keyVersion: encrypted.keyVersion, replyToId, clientMsgId }),
    }),
  sendSticker: (chatId: string, payload: StickerMessagePayload, encrypted: OutboundEncryptedPayload, encryptedMediaId: string, replyToId: string | null = null, clientMsgId?: string) =>
    request<Message>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'sticker', encryptedMediaId, encrypted, keyVersion: encrypted.keyVersion, replyToId, clientMsgId }),
    }),
  sendGif: (chatId: string, payload: GifMessagePayload, encrypted: OutboundEncryptedPayload, encryptedMediaId: string, replyToId: string | null = null, clientMsgId?: string) =>
    request<Message>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'gif', encryptedMediaId, encrypted, keyVersion: encrypted.keyVersion, replyToId, clientMsgId }),
    }),
  sendAttachment: (chatId: string, kind: 'photo' | 'video' | 'voice' | 'file', attachmentId: string, encrypted: OutboundEncryptedPayload, replyToId: string | null = null, clientMsgId?: string) =>
    request<Message>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ kind, attachmentId, encrypted, keyVersion: encrypted.keyVersion, replyToId, clientMsgId }),
    }),
  /** PUT raw ciphertext (Content-Length = cipherSize); XHR so the upload has progress. */
  uploadAttachment: (chatId: string, id: string, ciphertext: Blob, onProgress?: (done: number) => void) =>
    new Promise<{ id: string; size: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(id)}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      // No whole-upload cap (size varies); give up only when nothing moves for 30 s.
      let stall: ReturnType<typeof setTimeout> | undefined;
      const arm = () => { clearTimeout(stall); stall = setTimeout(() => xhr.abort(), 30_000); };
      arm();
      xhr.upload.onprogress = (event) => { arm(); if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
      xhr.onerror = () => { clearTimeout(stall); reject(new ApiError('ارسال فایل ناموفق بود.', 0)); };
      xhr.onabort = () => { clearTimeout(stall); reject(new ApiError(TIMEOUT_MESSAGE, 0)); };
      xhr.onload = () => {
        clearTimeout(stall);
        if (xhr.status === 401) unauthorizedHandler?.();
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText) as { id: string; size: number }); } catch { reject(new ApiError('پاسخ نامعتبر از سرور.', xhr.status)); }
          return;
        }
        let message = 'ارسال فایل ناموفق بود.';
        try { message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message; } catch { /* keep default */ }
        reject(new ApiError(message, xhr.status));
      };
      xhr.send(ciphertext);
    }),
  /** Ciphertext bytes from..to inclusive (HTTP Range), streamed so the caller can show progress. */
  downloadAttachment: async (id: string, from: number, to: number, onProgress?: (done: number) => void): Promise<Uint8Array> => {
    // Stall guard: abort when no byte arrives for 30 s (headers included), so a dead link can't hang forever.
    const controller = new AbortController();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), 30_000); };
    arm();
    try {
      const response = await fetch(`/api/attachments/${encodeURIComponent(id)}`, { credentials: 'include', headers: { range: `bytes=${from}-${to}` }, signal: controller.signal });
      if (!response.ok || !response.body) throw new ApiError('فایل دریافت نشد.', response.status);
      const length = to - from + 1;
      const out = new Uint8Array(length);
      const skip = response.status === 206 ? 0 : from; // server ignored Range: drop the leading bytes ourselves
      let seen = 0;
      let written = 0;
      const reader = response.body.getReader();
      for (;;) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = value;
        if (seen < skip) { const drop = Math.min(skip - seen, chunk.length); seen += drop; chunk = chunk.subarray(drop); }
        const take = Math.min(chunk.length, length - written);
        if (take > 0) { out.set(chunk.subarray(0, take), written); written += take; onProgress?.(written / length); }
        if (written >= length) { void reader.cancel().catch(() => undefined); break; }
      }
      if (written !== length) throw new ApiError('فایل ناقص دریافت شد.', 0);
      return out;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(TIMEOUT_MESSAGE, 0);
    } finally {
      clearTimeout(stall);
    }
  },
  uploadEncryptedMedia: (chatId: string, ciphertext: Blob) => {
    const body = new FormData();
    body.append('file', ciphertext, 'ciphertext.bin');
    return request<{ id: string }>(`/api/chats/${encodeURIComponent(chatId)}/encrypted-media`, { method: 'POST', body }, UPLOAD_TIMEOUT_MS);
  },
  encryptedMedia: async (id: string): Promise<ArrayBuffer> => {
    const signal = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/encrypted-media/${encodeURIComponent(id)}`, { credentials: 'include', signal });
      if (!response.ok) throw new ApiError('رسانهٔ رمزگذاری‌شده دریافت نشد.', response.status);
      return await response.arrayBuffer();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(TIMEOUT_MESSAGE, 0);
    }
  },
  stickerPacks: () => request<StickerPack[]>('/api/media/packs'),
  stickerPack: (packId: string) => request<StickerPackDetail>(`/api/media/packs/${encodeURIComponent(packId)}`),
  /** Tell the server this chat may open this pack (it holds nothing more than "pack P was shared into chat C"). */
  grantStickerPack: (chatId: string, packId: string) => request<void>(`/api/chats/${encodeURIComponent(chatId)}/sticker-packs/${encodeURIComponent(packId)}/grant`, { method: 'POST' }),
  sharedStickerPack: (chatId: string, packId: string) => request<SharedStickerPack>(`/api/chats/${encodeURIComponent(chatId)}/sticker-packs/${encodeURIComponent(packId)}`),
  addSharedStickerPack: (chatId: string, packId: string) => request<void>(`/api/chats/${encodeURIComponent(chatId)}/sticker-packs/${encodeURIComponent(packId)}/library`, { method: 'PUT' }),
  removeStickerPackFromLibrary: (packId: string) => request<void>(`/api/media/packs/${encodeURIComponent(packId)}/library`, { method: 'DELETE' }),
  recentStickers: () => request<Sticker[]>('/api/media/stickers/recent'),
  rememberSticker: (stickerId: string) => request<void>(`/api/media/stickers/${encodeURIComponent(stickerId)}/recent`, { method: 'POST' }),
  importStickerPack: (file: File, title?: string) => {
    const body = new FormData();
    body.append('file', file);
    if (title?.trim()) body.append('title', title.trim());
    return request<{ id: string; slug: string; title: string; count: number }>('/api/media/packs/import', { method: 'POST', body }, UPLOAD_TIMEOUT_MS);
  },
  gifs: (tag?: string) => request<Gif[]>(`/api/media/gifs${tag?.trim() ? `?${new URLSearchParams({ tag: tag.trim() })}` : ''}`),
  savedGifs: () => request<Gif[]>('/api/media/gifs/saved'),
  saveGif: (gifId: string) => request<void>(`/api/media/gifs/${encodeURIComponent(gifId)}/save`, { method: 'PUT' }),
  unsaveGif: (gifId: string) => request<void>(`/api/media/gifs/${encodeURIComponent(gifId)}/save`, { method: 'DELETE' }),
  uploadGif: (file: File, tags?: string) => {
    const body = new FormData();
    body.append('file', file);
    if (tags?.trim()) body.append('tags', tags.trim());
    return request<Gif>('/api/media/gifs/upload', { method: 'POST', body }, UPLOAD_TIMEOUT_MS);
  },
  editMessage: (chatId: string, messageId: string, encrypted: OutboundEncryptedPayload) =>
    request<Message>(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ encrypted, keyVersion: encrypted.keyVersion }),
    }),
  deleteMessage: (chatId: string, messageId: string) =>
    request<Message>(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    }),
  markRead: (chatId: string, messageId: string) =>
    request<void>(`/api/chats/${encodeURIComponent(chatId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),
  securityStatus: () => request<SecurityStatus>('/api/security/status'),
  setupTotp: (password: string, secondFactor?: string) => request<{ secret: string; otpauthUri: string }>('/api/security/totp/setup', { method: 'POST', body: JSON.stringify({ password, secondFactor }) }),
  enableTotp: (code: string) => request<{ recoveryCodes: string[] }>('/api/security/totp/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  disableTotp: (password: string, secondFactor: string) => request<void>('/api/security/totp/disable', { method: 'POST', body: JSON.stringify({ password, secondFactor }) }),
  regenerateRecoveryCodes: (password: string, secondFactor: string) => request<{ recoveryCodes: string[] }>('/api/security/recovery-codes/regenerate', { method: 'POST', body: JSON.stringify({ password, secondFactor }) }),
  sessions: () => request<DeviceSession[]>('/api/security/sessions'),
  revokeSession: (id: string) => request<void>(`/api/security/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeOtherSessions: () => request<void>('/api/security/sessions/revoke-others', { method: 'POST' }),
  passkeyRegistrationOptions: (password: string, secondFactor?: string) => request<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkeys/register/options', { method: 'POST', body: JSON.stringify({ password, secondFactor }) }),
  verifyPasskeyRegistration: (response: RegistrationResponseJSON, name?: string) => request<void>('/api/auth/passkeys/register/verify', { method: 'POST', body: JSON.stringify({ response, name }) }),
  deletePasskey: (id: string, password: string, secondFactor?: string) => request<void>(`/api/security/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ password, secondFactor }) }),
  changePassword: (userId: string, currentPassword: string, newPassword: string, expectedBackupRevision: number, backup?: { salt: string; iterations: number; wrapped: string; version: 1 }, secondFactor?: string, signal?: AbortSignal) => request<void>('/api/security/password', { method: 'POST', body: JSON.stringify({ expectedUserId: userId, currentPassword, newPassword, expectedBackupRevision, backup, secondFactor }), signal }),
};
