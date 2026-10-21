import type { FastifyReply } from 'fastify';
import { db } from './db.js';
import { groupMessageGate } from './groups.js';

// Direct-chat key versions (NS-07). A direct chat or Saved Messages chat has numbered chat-key versions in
// `direct_chat_keys` (+ per-version envelopes in `chat_key_envelopes`). After a member starts fresh with a new identity,
// `pending_version` is set and nobody may send until the next version exists. Like groups, the server enforces the
// CURRENT version on every post/edit, so a stale browser tab is refused and re-fetches its key.

export const MAX_ENVELOPE_VERSIONS = 32; // newest versions returned to a client; an older version is never deleted for this

type Action = 'post' | 'edit' | 'delete';
type Gate = { ok: true; keyVersion: number | null; staff: boolean } | { ok: false };

export const directKeyState = async (chatId: string): Promise<{ keyVersion: number; pendingVersion: number | null } | null> => {
  const row = (await db.query<{ key_version: number; pending_version: number | null }>(
    'SELECT key_version, pending_version FROM direct_chat_keys WHERE chat_id = $1', [chatId])).rows[0];
  return row ? { keyVersion: row.key_version, pendingVersion: row.pending_version } : null;
};

/**
 * Message-route gate for every chat kind. Groups keep their own rules (groupMessageGate). A direct or Saved chat
 * that has a key must carry the CURRENT key version and no reset may be pending. A chat without any key row (channels,
 * and chats nobody has opened yet) must not claim a version. Deleting needs no key.
 */
export const messageKeyGate = async (
  chatId: string, userId: string, action: Action, keyVersion: unknown, reply: FastifyReply
): Promise<Gate> => {
  const gate = await groupMessageGate(chatId, userId, action, keyVersion, reply);
  if (!gate.ok || action === 'delete' || gate.keyVersion !== null) return gate;
  const state = await directKeyState(chatId);
  if (!state) {
    if (keyVersion === undefined || keyVersion === null) return gate;
    await reply.code(400).send({ error: 'This chat has no key version yet', keyVersion: null });
    return { ok: false };
  }
  if (state.pendingVersion !== null) {
    await reply.code(409).send({
      error: 'Chat key reset pending; open the chat to create the new key',
      keyVersion: state.keyVersion, pendingKeyVersion: state.pendingVersion
    });
    return { ok: false };
  }
  if (keyVersion !== state.keyVersion) {
    await reply.code(400).send({ error: `keyVersion must be the current chat key version (${state.keyVersion})`, keyVersion: state.keyVersion, pendingKeyVersion: null });
    return { ok: false };
  }
  return { ok: true, keyVersion: state.keyVersion, staff: false };
};
