import { api } from '../api.js';
import { encryptContent } from '../e2ee.js';
import type { UiMessage } from '../chat/helpers.js';
import { reportTransfer } from '../datasaver.js';
import { CHUNK_SIZE, chunkCount, cipherSize, encryptChunk, encryptChunks, importAttachmentKey, newAttachmentSecrets, unb64u } from './crypto.js';
import { prepare } from './prepare.js';
import { localBlobs, setProgress } from './progress.js';
import { uploadChunks } from './transfer.js';
import { ATTACHMENT_LIMIT_COPY, MAX_ATTACHMENT_BYTES, type AttachmentDescriptor, type AttachmentInput, type AttachmentPayload } from './types.js';

/** What Conversation.tsx must provide (all of these already exist there). */
export type SenderDeps = {
  chatId: string;
  userId: string;
  replyToId: string | null;
  draft: (partial: Pick<UiMessage, 'kind' | 'text' | 'payload' | 'replyToId'>) => UiMessage;
  append: (message: UiMessage) => void;
  settle: (temporary: UiMessage, saved: UiMessage) => void;
  discard: (temporary: UiMessage) => void;
  showError: (copy: string) => void;
};

/** prepare -> encrypt + PUT chunks lazily (resumable, see transfer.ts) -> send the E2EE message that carries key + metadata. */
export const sendAttachment = async (deps: SenderDeps, input: AttachmentInput): Promise<void> => {
  const { chatId, userId, replyToId } = deps;
  if (input.blob.size < 1) return deps.showError('فایل خالی است.');
  if (input.blob.size > MAX_ATTACHMENT_BYTES) return deps.showError(ATTACHMENT_LIMIT_COPY);

  let temporary: UiMessage | undefined;
  let id = '';
  try {
    const prepared = await prepare(input);
    const secrets = newAttachmentSecrets();
    id = secrets.id;
    const caption = input.caption?.trim() || undefined;
    const attachment: AttachmentDescriptor = {
      version: 2, id, key: secrets.key, noncePrefix: secrets.noncePrefix, chunkSize: 262_144,
      size: prepared.blob.size, mime: 'application/octet-stream', ...prepared.extra,
    };
    const payload: AttachmentPayload = { attachment, caption };
    localBlobs.set(id, prepared.blob);
    temporary = deps.draft({ kind: input.kind, text: caption ?? null, payload, replyToId });
    deps.append(temporary);
    setProgress(id, 0);

    const c = { key: await importAttachmentKey(secrets.key, ['encrypt']), noncePrefix: unb64u(secrets.noncePrefix), chatId, id, size: attachment.size };
    const count = chunkCount(attachment.size);
    const outcome = await uploadChunks({
      chatId, id, total: cipherSize(attachment.size),
      encrypt: async (n) => encryptChunk(c, n, new Uint8Array(await prepared.blob.slice(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE).arrayBuffer()), n === count - 1),
      onProgress: (done) => setProgress(id, done),
      onSample: reportTransfer,
    });
    if (outcome === 'fallback') { // old server without the chunk route: one PUT of the whole ciphertext
      const parts: Uint8Array[] = [];
      for await (const chunk of encryptChunks(c, prepared.blob)) parts.push(chunk);
      await api.uploadAttachment(chatId, id, new Blob(parts as BlobPart[], { type: 'application/octet-stream' }), (done) => setProgress(id, done));
    }

    const encrypted = await encryptContent(chatId, userId, { kind: input.kind, text: caption ?? null, payload });
    const saved = await api.sendAttachment(chatId, input.kind, id, encrypted, replyToId);
    deps.settle(temporary, { ...saved, text: caption ?? null, payload });
  } catch (error) {
    if (temporary) deps.discard(temporary);
    if (id) localBlobs.delete(id);
    deps.showError(error instanceof Error && error.message && !/[A-Za-z]{4}/.test(error.message) ? error.message : 'ارسال فایل انجام نشد.');
  } finally {
    if (id) setProgress(id, undefined);
  }
};
