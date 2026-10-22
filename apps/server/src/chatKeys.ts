import type { FastifyReply } from 'fastify';
import { db } from './db.js';
import { groupGateCheck, type GateResult, type Queryable } from './groups.js';
import { postRefusal } from './channels.js';

// Direct-chat key versions (NS-07). A direct chat or Saved Messages chat has numbered chat-key versions in
// `direct_chat_keys` (+ per-version envelopes in `chat_key_envelopes`). After a member starts fresh with a new identity,
// `pending_version` is set and nobody may send until the next version exists. Like groups, the server enforces the
// CURRENT version on every post/edit, so a stale browser tab is refused and re-fetches its key.

export const MAX_ENVELOPE_VERSIONS = 32; // newest versions returned to a client; an older version is never deleted for this

type Action = 'post' | 'edit' | 'delete';

export const directKeyState = async (chatId: string, q: Queryable = db): Promise<{ keyVersion: number; pendingVersion: number | null } | null> => {
  const row = (await q.query<{ key_version: number; pending_version: number | null }>(
    'SELECT key_version, pending_version FROM direct_chat_keys WHERE chat_id = $1', [chatId])).rows[0];
  return row ? { keyVersion: row.key_version, pendingVersion: row.pending_version } : null;
};

/**
 * Key-version decision for every chat kind, as data (no reply). Groups keep their own rules (groupGateCheck). A direct or
 * Saved chat that has a key must carry the CURRENT key version and no reset may be pending. A chat without any key row
 * (channels, and chats nobody has opened yet) must not claim a version. Deleting needs no key.
 * Pass a transaction client to decide on the state the write will really see.
 */
export const messageKeyCheck = async (
  q: Queryable, chatId: string, userId: string, action: Action, keyVersion: unknown
): Promise<GateResult> => {
  const gate = await groupGateCheck(q, chatId, userId, action, keyVersion);
  if (!gate.ok || action === 'delete' || gate.keyVersion !== null) return gate;
  const state = await directKeyState(chatId, q);
  if (!state) {
    if (keyVersion === undefined || keyVersion === null) return gate;
    return { ok: false, status: 400, body: { error: 'This chat has no key version yet', keyVersion: null } };
  }
  if (state.pendingVersion !== null) {
    return { ok: false, status: 409, body: {
      error: 'Chat key reset pending; open the chat to create the new key',
      keyVersion: state.keyVersion, pendingKeyVersion: state.pendingVersion
    } };
  }
  if (keyVersion !== state.keyVersion) {
    return { ok: false, status: 400, body: { error: `keyVersion must be the current chat key version (${state.keyVersion})`, keyVersion: state.keyVersion, pendingKeyVersion: null } };
  }
  return { ok: true, keyVersion: state.keyVersion, staff: false };
};

/** Route hook form of messageKeyCheck: a reply has been sent when ok is false. */
export const messageKeyGate = async (
  chatId: string, userId: string, action: Action, keyVersion: unknown, reply: FastifyReply
): Promise<{ ok: true; keyVersion: number | null; staff: boolean } | { ok: false }> => {
  const gate = await messageKeyCheck(db, chatId, userId, action, keyVersion);
  if (gate.ok) return gate;
  await reply.code(gate.status).send(gate.body);
  return { ok: false };
};

/**
 * The whole write gate (membership, channel posting rights, key version) evaluated INSIDE the write transaction.
 * The route gates run before BEGIN; a reset, rotation or removal can commit in between, so the INSERT/UPDATE
 * decides again on what it will really write over. Same status codes and bodies as the route gates.
 */
export const txMessageGate = async (
  client: Queryable, chatId: string, userId: string, action: Action, keyVersion: unknown
): Promise<GateResult> => {
  const member = await client.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  if (member.rowCount !== 1) return { ok: false, status: 404, body: { error: 'Chat not found' } };
  const refusal = await postRefusal(chatId, userId, client);
  if (refusal) return { ok: false, ...refusal };
  return messageKeyCheck(client, chatId, userId, action, keyVersion);
};
