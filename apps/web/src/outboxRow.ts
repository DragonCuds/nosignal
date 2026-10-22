// Builds the row that Conversation.tsx hands to the outbox. Pure and dependency-free so a test can call the same producer the UI uses.
import type { EnqueueInput } from './outbox.js';

/** Pack ids are server-made ids; anything that is not a short plain token is never sent to the grant route. */
export const isValidPackId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

export type OutboxRowInput = {
  clientMsgId: string;
  chatId: string;
  kind: 'text' | 'sticker' | 'gif';
  encrypted: unknown;
  encryptedMediaId?: string;
  replyTo: string | null;
  /** The plaintext payload (kept in memory only, never copied into the row). Only the pack id of a sticker is read from it. */
  plain: { text: string | null; payload: unknown | null };
};

/**
 * The persisted row never carries the plaintext (`text` and `payload` stay null; the bubble text lives in memory only).
 * The one thing a sticker row must remember across retry/reload is WHICH PACK to share into the chat after the server
 * accepted the message, so that single id is stored as its own field `grantPackId`. Other kinds never get one.
 */
export const buildOutboxRow = (input: OutboxRowInput): EnqueueInput => {
  const row: EnqueueInput = {
    clientMsgId: input.clientMsgId, chatId: input.chatId, kind: input.kind, encrypted: input.encrypted,
    encryptedMediaId: input.encryptedMediaId, replyToId: input.replyTo, text: null, payload: null,
  };
  if (input.kind === 'sticker') {
    const packId = (input.plain.payload as { packId?: unknown } | null)?.packId;
    if (isValidPackId(packId)) row.grantPackId = packId;
  }
  return row;
};
