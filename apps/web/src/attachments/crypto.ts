// Chunked AES-256-GCM for attachments (docs/ATTACHMENTS.md). Pure WebCrypto, no imports.
export const CHUNK_SIZE = 262_144;
export const TAG_BYTES = 16;
const FULL_CHUNK = CHUNK_SIZE + TAG_BYTES;

export type AttachmentCrypto = {
  key: CryptoKey;
  noncePrefix: Uint8Array; // 8 bytes
  chatId: string;
  id: string;
  size: number; // plaintext bytes
};

const enc = new TextEncoder();
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export const b64u = (bytes: Uint8Array): string => {
  let s = '';
  for (let o = 0; o < bytes.length; o += 0x8000) s += String.fromCharCode(...bytes.subarray(o, o + 0x8000));
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};
export const unb64u = (v: string): Uint8Array => {
  const p = v.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (v.length % 4)) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};

export const chunkCount = (size: number): number => Math.max(1, Math.ceil(size / CHUNK_SIZE));
export const cipherSize = (size: number): number => size + chunkCount(size) * TAG_BYTES;

export const newAttachmentSecrets = () => ({
  id: [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join(''),
  key: b64u(crypto.getRandomValues(new Uint8Array(32))),
  noncePrefix: b64u(crypto.getRandomValues(new Uint8Array(8)))
});

export const importAttachmentKey = (keyB64u: string, usages: KeyUsage[] = ['encrypt', 'decrypt']): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', buf(unb64u(keyB64u)), 'AES-GCM', false, usages);

const params = (c: AttachmentCrypto, i: number, last: boolean): AesGcmParams => {
  const iv = new Uint8Array(12);
  iv.set(c.noncePrefix, 0);
  new DataView(iv.buffer).setUint32(8, i, false);
  const head = enc.encode(`tel:att:v2|${c.chatId}|${c.id}|`);
  const aad = new Uint8Array(head.length + 5);
  aad.set(head, 0);
  new DataView(aad.buffer).setUint32(head.length, i, false);
  aad[head.length + 4] = last ? 1 : 0;
  return { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad), tagLength: 128 };
};

export const encryptChunk = async (c: AttachmentCrypto, i: number, plain: Uint8Array, last: boolean): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.encrypt(params(c, i, last), c.key, buf(plain)));

export const decryptChunk = async (c: AttachmentCrypto, i: number, cipher: Uint8Array, last: boolean): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.decrypt(params(c, i, last), c.key, buf(cipher)));

/** Encrypt a Blob chunk by chunk; memory stays at ~one chunk. */
export async function* encryptChunks(c: AttachmentCrypto, source: Blob): AsyncGenerator<Uint8Array> {
  if (source.size !== c.size) throw new Error('size mismatch');
  const n = chunkCount(c.size);
  for (let i = 0; i < n; i++) {
    const plain = new Uint8Array(await source.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer());
    yield await encryptChunk(c, i, plain, i === n - 1);
  }
}

/** Ciphertext as a ReadableStream (for fetch duplex upload) with known total length cipherSize(c.size). */
export const encryptToStream = (c: AttachmentCrypto, source: Blob): ReadableStream<Uint8Array> => {
  const it = encryptChunks(c, source);
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const r = await it.next();
      if (r.done) ctrl.close(); else ctrl.enqueue(r.value);
    }
  });
};

export type RangePlan = {
  firstChunk: number;
  lastChunk: number;
  cipherStart: number; // inclusive
  cipherEnd: number; // inclusive
  skip: number; // plaintext bytes to drop from the first decrypted chunk
  length: number; // plaintext bytes in the answer
};

/** Plaintext byte range [start, end] inclusive -> ciphertext chunk span. */
export const planRange = (size: number, start: number, end: number): RangePlan => {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= size) throw new RangeError('bad range');
  const firstChunk = Math.floor(start / CHUNK_SIZE);
  const lastChunk = Math.floor(end / CHUNK_SIZE);
  const total = cipherSize(size);
  return {
    firstChunk, lastChunk,
    cipherStart: firstChunk * FULL_CHUNK,
    cipherEnd: Math.min(total, (lastChunk + 1) * FULL_CHUNK) - 1,
    skip: start - firstChunk * CHUNK_SIZE,
    length: end - start + 1
  };
};

/** Decrypt plaintext [start,end] using fetchCipher(a,b) that returns ciphertext bytes a..b inclusive (HTTP Range). */
export const decryptRange = async (
  c: AttachmentCrypto, start: number, end: number,
  fetchCipher: (from: number, to: number) => Promise<Uint8Array>
): Promise<Uint8Array> => {
  const p = planRange(c.size, start, end);
  const data = await fetchCipher(p.cipherStart, p.cipherEnd);
  if (data.length !== p.cipherEnd - p.cipherStart + 1) throw new Error('short ciphertext');
  const n = chunkCount(c.size);
  const out = new Uint8Array(p.length);
  let written = 0;
  for (let i = p.firstChunk; i <= p.lastChunk; i++) {
    const off = (i - p.firstChunk) * FULL_CHUNK;
    const plain = await decryptChunk(c, i, data.subarray(off, Math.min(data.length, off + FULL_CHUNK)), i === n - 1);
    const piece = plain.subarray(i === p.firstChunk ? p.skip : 0);
    const take = Math.min(piece.length, p.length - written);
    out.set(piece.subarray(0, take), written);
    written += take;
  }
  if (written !== p.length) throw new Error('truncated');
  return out;
};

export const decryptAll = async (c: AttachmentCrypto, fetchCipher: (from: number, to: number) => Promise<Uint8Array>): Promise<Uint8Array> => {
  if (c.size > 0) return decryptRange(c, 0, c.size - 1, fetchCipher);
  const data = await fetchCipher(0, TAG_BYTES - 1); // empty file = one empty chunk (just the tag)
  if (data.length !== TAG_BYTES) throw new Error('short ciphertext');
  return decryptChunk(c, 0, data, true);
};
