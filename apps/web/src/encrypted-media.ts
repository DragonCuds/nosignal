import { getCachedMedia, putCachedMedia } from './mediaCache.js';
import { api, type Message, type OutboundEncryptedPayload } from './api.js';
import { chatEncryptionKey, currentChatKey, decryptMessage, encryptContent } from './e2ee.js';

const MAX_PLAINTEXT_BYTES = 25 * 1024 * 1024;
const encoder = new TextEncoder();
const objectUrlCache = new Map<string, Promise<string>>();

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
const mediaAad = (chatId: string): ArrayBuffer => buffer(encoder.encode(`tel:attachment:v1:${chatId}`));

type MediaEnvelope = { version: 1; id: string; nonce: string; mimeType: string; size: number };
type MediaPayload = Record<string, unknown> & { encryptedMedia?: MediaEnvelope };

const sourceBytes = async (source: string | Blob): Promise<{ bytes: ArrayBuffer; mimeType: string }> => {
  const blob = typeof source === 'string'
    ? await fetch(source, { credentials: 'include' }).then((response) => {
      if (!response.ok) throw new Error('Media source could not be read');
      return response.blob();
    })
    : source;
  if (blob.size < 1 || blob.size > MAX_PLAINTEXT_BYTES) throw new Error('Media must be between 1 byte and 25 MB');
  return { bytes: await blob.arrayBuffer(), mimeType: blob.type || 'application/octet-stream' };
};

export const encryptMediaMessage = async (
  chatId: string,
  senderId: string,
  kind: 'sticker' | 'gif' | 'photo',
  payload: Record<string, unknown>,
  source: string | Blob
): Promise<{ encrypted: OutboundEncryptedPayload; encryptedMediaId: string }> => {
  const { bytes, mimeType } = await sourceBytes(source);
  // The media is sealed with the chat key of ONE version; the message that carries its key must use the same version
  // (encryptContent throws StaleChatKeyError if the chat moved to a new key version in between, so nothing mismatched is sent).
  const { key, version } = await currentChatKey(chatId);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce), additionalData: mediaAad(chatId) }, key, bytes);
  const { id } = await api.uploadEncryptedMedia(chatId, new Blob([ciphertext], { type: 'application/octet-stream' }));
  const safePayload: MediaPayload = { ...payload };
  delete safePayload.fileUrl;
  delete safePayload.mp4Url;
  delete safePayload.posterUrl;
  safePayload.encryptedMedia = { version: 1, id, nonce: bytesToB64(nonce), mimeType, size: bytes.byteLength };
  const encrypted = await encryptContent(chatId, senderId, { kind, text: null, payload: safePayload }, version);
  return { encrypted, encryptedMediaId: id };
};

const isEnvelope = (value: unknown): value is MediaEnvelope => {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<MediaEnvelope>;
  return envelope.version === 1
    && typeof envelope.id === 'string' && /^[a-f0-9-]{36}$/i.test(envelope.id)
    && typeof envelope.nonce === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(envelope.nonce)
    && typeof envelope.mimeType === 'string' && envelope.mimeType.length <= 128
    && typeof envelope.size === 'number' && Number.isSafeInteger(envelope.size)
    && envelope.size >= 1 && envelope.size <= MAX_PLAINTEXT_BYTES;
};

export const hydrateEncryptedMedia = async (chatId: string, kind: string, payload: unknown, keyVersion?: number): Promise<unknown> => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const mediaPayload = payload as MediaPayload;
  if (!isEnvelope(mediaPayload.encryptedMedia)) return payload;
  const envelope = mediaPayload.encryptedMedia;
  const cacheKey = `${chatId}:${envelope.id}:${envelope.nonce}`;
  let pending = objectUrlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const fetchCipher = async (): Promise<ArrayBuffer> => {
        const hit = await getCachedMedia(envelope.id);
        if (hit) return hit;
        const fresh = await api.encryptedMedia(envelope.id);
        void putCachedMedia(envelope.id, [new Uint8Array(fresh)]);
        return fresh;
      };
      const [key, ciphertext] = await Promise.all([chatEncryptionKey(chatId, keyVersion), fetchCipher()]);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buffer(b64ToBytes(envelope.nonce)), additionalData: mediaAad(chatId) }, key, ciphertext
      );
      if (plaintext.byteLength !== envelope.size) throw new Error('Encrypted media length mismatch');
      return URL.createObjectURL(new Blob([plaintext], { type: envelope.mimeType }));
    })();
    objectUrlCache.set(cacheKey, pending);
    pending.catch(() => objectUrlCache.delete(cacheKey));
  }
  const url = await pending;
  const hydrated = { ...mediaPayload };
  if (kind === 'sticker') hydrated.fileUrl = url;
  else hydrated.mp4Url = url;
  return hydrated;
};

export const decryptMessageMedia = async <T extends Message>(message: T): Promise<T> => {
  const decrypted = await decryptMessage(message);
  if (!decrypted.encrypted || decrypted.deletedAt || !['sticker', 'gif', 'photo'].includes(decrypted.kind)) return decrypted;
  try {
    return { ...decrypted, payload: await hydrateEncryptedMedia(decrypted.chatId, decrypted.kind, decrypted.payload, (decrypted.encrypted as { keyVersion?: number } | null)?.keyVersion) };
  } catch {
    return { ...decrypted, kind: 'text', text: '🔒 رسانه قابل رمزگشایی نیست', payload: null };
  }
};

export const decryptMessagesMedia = <T extends Message>(messages: T[]): Promise<T[]> => Promise.all(messages.map(decryptMessageMedia));
