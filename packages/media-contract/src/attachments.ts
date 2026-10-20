/** Attachment payload (envelope v2) carried inside the E2EE message. See docs/ATTACHMENTS.md. */
export const ATTACHMENT_CHUNK_SIZE = 262_144;
export const ATTACHMENT_TAG_BYTES = 16;

export type AttachmentKind = 'photo' | 'video' | 'voice' | 'file';

export type AttachmentDescriptor = {
  version: 2;
  /** Upload id, 32 lowercase hex, chosen by the client. */
  id: string;
  /** base64url, 32 bytes. */
  key: string;
  /** base64url, 8 bytes. */
  noncePrefix: string;
  chunkSize: number;
  /** Plaintext bytes. */
  size: number;
  mime: string;
  name?: string;
  w?: number;
  h?: number;
  durationMs?: number;
  /** base64url, 64 bytes (voice). */
  waveform?: string;
  /** base64url, <= 2 KB. */
  thumb?: string;
};

export type AttachmentMessagePayload = { attachment: AttachmentDescriptor; caption?: string };

export type AttachmentUploadResponse = { id: string; size: number };
export type AttachmentErrorResponse = { error: string };
