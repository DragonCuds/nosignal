export type EncryptedMessageV2 = {
  version: 2;
  cipherId: string;
  nonce: string;
  ciphertext: string;
};

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const decodedLength = (value: string): number =>
  Math.floor(value.length * 3 / 4);

const canonicalBase64Url = (value: unknown, exactBytes?: number): value is string => {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) return false;
  const bytes = decodedLength(value);
  return Number.isFinite(bytes) && (exactBytes === undefined || bytes === exactBytes);
};

export const parseEncryptedMessageV2 = (value: unknown): EncryptedMessageV2 | null => {
  if (!object(value) || value.version !== 2 || typeof value.cipherId !== 'string' || !UUID_V4.test(value.cipherId)) return null;
  if (!canonicalBase64Url(value.nonce, 12) || !canonicalBase64Url(value.ciphertext)) return null;
  const ciphertextBytes = decodedLength(value.ciphertext);
  if (ciphertextBytes <= 16 || ciphertextBytes > MAX_CIPHERTEXT_BYTES) return null;
  return {
    version: 2,
    cipherId: value.cipherId.toLowerCase(),
    nonce: value.nonce,
    ciphertext: value.ciphertext
  };
};
