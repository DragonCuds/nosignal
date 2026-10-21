// Direct-chat key envelopes with key versions (NS-07). Standalone (no app imports) so it can be tested under node.
//
// One AES-GCM chat key K_v exists per key version v. Every member gets K_v wrapped with ECDH(creator private, member public).
// The server stores, next to each envelope, the creator's public key as it was when the envelope was wrapped. That is
// untrusted input: a browser opens an envelope with that stored key only if its fingerprint is in the creator's pin history
// (pins.ts). A fingerprint that was never pinned is rejected, so a malicious server cannot slip in a key of its own.
import { currentPin, wasPinned, type PinList } from './pins.js';

const encoder = new TextEncoder();
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
export const bytesToB64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};
export const b64ToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

export const fingerprintOf = async (jwk: JsonWebKey): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`P-256:${jwk.x}:${jwk.y}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Additional authenticated data of an envelope. Version 1 (and every group envelope, which passes no version) keeps the
 * original format, so everything created before key versions still opens. Version 2 and later also bind the version number,
 * so the server cannot hand over an envelope of one version as another.
 */
const keyAad = (scope: string, recipientId: string, creatorId: string, version?: number): Uint8Array =>
  version !== undefined && version >= 2
    ? encoder.encode(`tel:e2ee-key:v2:${scope}:${version}:${recipientId}:${creatorId}`)
    : encoder.encode(`tel:e2ee-key:v1:${scope}:${recipientId}:${creatorId}`);

const wrappingKey = async (scope: string, privateKey: CryptoKey, peerPublic: JsonWebKey, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> => {
  const publicKey = await crypto.subtle.importKey('jwk', peerPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`tel:${scope}`), info: encoder.encode('tel chat key envelope v1') }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
};

export type WrapInput = { scope: string; version?: number; recipientId: string; creatorId: string; creatorPrivateKey: CryptoKey; recipientPublicKey: JsonWebKey; raw: Uint8Array };
export const wrapChatKey = async (input: WrapInput): Promise<{ nonce: string; ciphertext: string }> => {
  const key = await wrappingKey(input.scope, input.creatorPrivateKey, input.recipientPublicKey, 'encrypt');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(keyAad(input.scope, input.recipientId, input.creatorId, input.version)) }, key, buffer(input.raw));
  return { nonce: bytesToB64(nonce), ciphertext: bytesToB64(new Uint8Array(ciphertext)) };
};

export type UnwrapInput = { scope: string; version?: number; recipientId: string; creatorId: string; recipientPrivateKey: CryptoKey; creatorPublicKey: JsonWebKey; nonce: string; ciphertext: string };
export const unwrapChatKey = async (input: UnwrapInput): Promise<ArrayBuffer> => {
  const key = await wrappingKey(input.scope, input.recipientPrivateKey, input.creatorPublicKey, 'decrypt');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(b64ToBytes(input.nonce)), additionalData: buffer(keyAad(input.scope, input.recipientId, input.creatorId, input.version)) }, key, buffer(b64ToBytes(input.ciphertext)));
};

export type ServerEnvelope = {
  senderId: string; version: number; nonce: string; ciphertext: string;
  senderFingerprint?: string | null; senderPublicKey?: JsonWebKey | null;
};
export type SenderContext = {
  selfId: string; selfFingerprint: string; selfPublicKey: JsonWebKey;
  /** This browser's pin history for a contact (empty if none). */
  pins: (userId: string) => PinList;
  /** The contact's key as the server reports it NOW (already checked against the current pin by the caller). */
  memberKey: (userId: string) => JsonWebKey | null;
};

/**
 * Which public key may open `envelope`, or null if none is acceptable.
 * - Our own envelopes: only our CURRENT identity (a reset deletes the old ones on the server; none is ever trusted).
 * - A contact's envelope with a stored sender key: its fingerprint must be in that contact's pin history. `current` tells
 *   whether it is the contact's current pin (only then may the key it carries be used to ENCRYPT new messages).
 * - A legacy envelope without a stored sender key: the contact's current server key, which must equal the current pin.
 */
export const senderKeyFor = async (envelope: ServerEnvelope, context: SenderContext): Promise<{ publicKey: JsonWebKey; current: boolean } | null> => {
  if (envelope.senderId === context.selfId) {
    const key = envelope.senderPublicKey ?? context.selfPublicKey;
    return await fingerprintOf(key) === context.selfFingerprint ? { publicKey: key, current: true } : null;
  }
  const pins = context.pins(envelope.senderId);
  const now = currentPin(pins);
  if (!envelope.senderPublicKey) {
    const key = context.memberKey(envelope.senderId);
    return key && now && await fingerprintOf(key) === now ? { publicKey: key, current: true } : null;
  }
  const fingerprint = await fingerprintOf(envelope.senderPublicKey);
  if (envelope.senderFingerprint && envelope.senderFingerprint !== fingerprint) return null; // the server contradicts itself
  if (!wasPinned(pins, fingerprint)) return null; // never accepted: no trust on first use for stored historical keys
  return { publicKey: envelope.senderPublicKey, current: fingerprint === now };
};

export type OpenedKey = { raw: ArrayBuffer; /** Wrapped by a key that is trusted today, so new messages may use it. */ current: boolean };
/** Opens every envelope that passes `senderKeyFor`. An envelope that fails any check is left out (never throws). */
export const openEnvelopes = async (input: {
  chatId: string; recipientId: string; recipientPrivateKey: CryptoKey; envelopes: readonly ServerEnvelope[]; context: SenderContext;
}): Promise<Map<number, OpenedKey>> => {
  const opened = new Map<number, OpenedKey>();
  for (const envelope of input.envelopes) {
    if (opened.has(envelope.version)) continue;
    try {
      const sender = await senderKeyFor(envelope, input.context);
      if (!sender) continue;
      const raw = await unwrapChatKey({
        scope: input.chatId, version: envelope.version, recipientId: input.recipientId, creatorId: envelope.senderId,
        recipientPrivateKey: input.recipientPrivateKey, creatorPublicKey: sender.publicKey, nonce: envelope.nonce, ciphertext: envelope.ciphertext
      });
      opened.set(envelope.version, { raw, current: sender.current });
    } catch { /* unusable envelope: leave it out */ }
  }
  return opened;
};
