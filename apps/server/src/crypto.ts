import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { parseBackupBlob } from './cryptoBackup.js';
import { directKeyState, MAX_ENVELOPE_VERSIONS } from './chatKeys.js';

const READ_LIMIT = { max: 120, timeWindow: '1 minute' } as const;
const WRITE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;
const id = (value: unknown): string | null => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const b64 = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

const validPublicJwk = (value: unknown): value is JsonWebKey => object(value)
  && value.kty === 'EC' && value.crv === 'P-256'
  && b64(value.x, 40, 48) && b64(value.y, 40, 48)
  && value.d === undefined && value.key_ops === undefined;

const fingerprint = (jwk: JsonWebKey): string =>
  createHash('sha256').update(`P-256:${jwk.x}:${jwk.y}`).digest('hex');

const parseJwk = (value: unknown): JsonWebKey | null => {
  if (typeof value !== 'string') return object(value) ? value as JsonWebKey : null;
  try { const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed as JsonWebKey : null; } catch { return null; }
};
const isFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_KEY_VERSION = 1_000_000;

const isMember = async (chatId: string, userId: string): Promise<boolean> =>
  (await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])).rowCount === 1;

export const registerCryptoRoutes = async (app: FastifyInstance): Promise<void> => {
  // `backup` (optional) is the password-wrapped copy of the new private key. It is stored in the SAME transaction
  // as a brand-new identity, so the server never knows an identity whose key has no recoverable copy (unless the
  // account chose manual mode). Ignored when the identity already exists.
  app.put<{ Body: { publicKey?: unknown; backup?: unknown; expectedUserId?: unknown } }>('/api/crypto/identity', { preHandler: app.requireUser, config: { rateLimit: WRITE_LIMIT }, bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (request.body?.expectedUserId !== request.user!.id) return reply.code(403).send({ error: 'Identity account does not match session' });
    if (!validPublicJwk(request.body?.publicKey)) return reply.code(400).send({ error: 'Invalid P-256 public key' });
    const key = { kty: 'EC', crv: 'P-256', x: request.body.publicKey.x, y: request.body.publicKey.y } satisfies JsonWebKey;
    const hash = fingerprint(key);
    const rawBackup = request.body.backup;
    const backup = rawBackup === undefined || rawBackup === null ? null : parseBackupBlob(object(rawBackup) ? rawBackup : null);
    if (rawBackup !== undefined && rawBackup !== null && !backup) return reply.code(400).send({ error: 'Invalid key backup' });
    const userId = request.user!.id;
    let backupSaved = false;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const existing = (await client.query<{ fingerprint: string }>('SELECT fingerprint FROM user_crypto_identities WHERE user_id = $1', [userId])).rows[0];
      if (existing) {
        await client.query('COMMIT');
        if (existing.fingerprint !== hash) return reply.code(409).send({ error: 'This account is already bound to another encryption identity' });
        return { fingerprint: hash, backupSaved: false };
      }
      await client.query(
        `INSERT INTO user_crypto_identities (user_id, public_jwk, fingerprint) VALUES ($1, json($2), $3)`,
        [userId, JSON.stringify(key), hash]
      );
      const mode = (await client.query<{ mode: string }>('SELECT mode FROM user_crypto_backups WHERE user_id = $1', [userId])).rows[0]?.mode;
      if (backup && (mode === undefined || mode === 'auto')) {
        backupSaved = true;
        await client.query(
          `INSERT INTO user_crypto_backups (user_id, mode, salt, iterations, wrapped, version, revision, updated_at)
           VALUES ($1, 'auto', $2, $3, $4, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT (user_id) DO UPDATE SET salt = excluded.salt, iterations = excluded.iterations, wrapped = excluded.wrapped,
             version = 1, revision = revision + 1, updated_at = excluded.updated_at WHERE user_crypto_backups.mode = 'auto'`,
          [userId, backup.salt, backup.iterations, backup.wrapped]
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return { fingerprint: hash, backupSaved };
  });

  // Members' CURRENT identities, the caller's envelopes (newest versions first) and the key version state.
  // Each envelope carries the sender's public key as it was when the envelope was wrapped: the browser opens an old
  // version with that key only if its fingerprint was pinned before (the server is not trusted for this).
  app.get<{ Params: { id: string } }>('/api/chats/:id/crypto', { preHandler: app.requireUser, config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
    const chatId = id(request.params.id);
    if (!chatId || !(await isMember(chatId, request.user!.id))) return reply.code(404).send({ error: 'Chat not found' });
    const members = await db.query<{ user_id: string; public_jwk: JsonWebKey | null; fingerprint: string | null }>(
      `SELECT cm.user_id, ci.public_jwk, ci.fingerprint FROM chat_members cm
       LEFT JOIN user_crypto_identities ci ON ci.user_id = cm.user_id
       WHERE cm.chat_id = $1 ORDER BY cm.user_id`, [chatId]);
    const state = await directKeyState(chatId);
    const rows = await db.query<{ sender_id: string; version: number; nonce: string; ciphertext: string; sender_fingerprint: string | null; sender_public_jwk: string | null }>(
      `SELECT sender_id, version, nonce, ciphertext, sender_fingerprint, sender_public_jwk FROM chat_key_envelopes
       WHERE chat_id = $1 AND recipient_id = $2 ORDER BY version DESC LIMIT ${MAX_ENVELOPE_VERSIONS}`, [chatId, request.user!.id]);
    const envelopes = rows.rows.map((row) => ({
      senderId: row.sender_id, version: row.version, nonce: row.nonce, ciphertext: row.ciphertext,
      senderFingerprint: row.sender_fingerprint, senderPublicKey: parseJwk(row.sender_public_jwk)
    }));
    const current = state ? envelopes.find((item) => item.version === state.keyVersion) : undefined;
    return {
      members: members.rows.map((row) => ({ userId: row.user_id, publicKey: row.public_jwk, fingerprint: row.fingerprint })),
      keyVersion: state?.keyVersion ?? 0,
      pendingKeyVersion: state?.pendingVersion ?? null,
      // Kept for older clients: the envelope of the current version.
      envelope: current ? { senderId: current.senderId, version: current.version, nonce: current.nonce, ciphertext: current.ciphertext } : null,
      envelopes
    };
  });

  type EnvelopeItem = { recipientId: string; recipientFingerprint: string; nonce: string; ciphertext: string };
  app.post<{ Params: { id: string }; Body: { version?: unknown; senderFingerprint?: unknown; envelopes?: unknown } }>('/api/chats/:id/crypto/envelopes', { preHandler: app.requireUser, config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
    const chatId = id(request.params.id);
    if (!chatId || !(await isMember(chatId, request.user!.id))) return reply.code(404).send({ error: 'Chat not found' });
    if ((await db.query('SELECT 1 FROM groups WHERE chat_id = $1', [chatId])).rowCount === 1) return reply.code(409).send({ error: 'Group chats use /api/groups/:id/keys' });
    const members = (await db.query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1 ORDER BY user_id', [chatId])).rows.map((row) => row.user_id);
    // Direct chat: one envelope per member (2). Saved Messages: a single member, one envelope to itself.
    const expected = (await db.query('SELECT 1 FROM saved_chats WHERE chat_id = $1', [chatId])).rowCount === 1 ? 1 : 2;
    const version = request.body?.version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > MAX_KEY_VERSION || !isFingerprint(request.body?.senderFingerprint)) {
      return reply.code(400).send({ error: 'A key version and the sender fingerprint are required' });
    }
    if (!Array.isArray(request.body?.envelopes) || request.body.envelopes.length !== expected) return reply.code(400).send({ error: 'An envelope is required for every chat member' });
    const parsed = request.body.envelopes.map((item) => object(item) && id(item.recipientId) && isFingerprint(item.recipientFingerprint) && (item.version === undefined || item.version === version) && b64(item.nonce, 16, 32) && b64(item.ciphertext, 40, 256) ? item as EnvelopeItem : null);
    if (parsed.some((item) => !item) || members.length !== expected || parsed.map((item) => item!.recipientId).sort().join(',') !== members.join(',')) return reply.code(400).send({ error: 'Invalid envelope set' });
    const userId = request.user!.id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Everything below is read and written in one transaction: two browsers creating the same version are serialized,
      // the second one finds the version already there and creates nothing.
      const identities = (await client.query<{ user_id: string; fingerprint: string; public_jwk: string }>(
        'SELECT user_id, fingerprint, public_jwk FROM user_crypto_identities WHERE user_id IN (SELECT value FROM json_each($1))',
        [JSON.stringify(members)])).rows;
      const byUser = new Map(identities.map((row) => [row.user_id, row]));
      if (byUser.size !== members.length) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Every member must initialize encryption first' }); }
      const sender = byUser.get(userId)!;
      if (sender.fingerprint !== request.body.senderFingerprint) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Your encryption identity changed; reload and retry' }); }
      for (const item of parsed as EnvelopeItem[]) {
        if (byUser.get(item.recipientId)!.fingerprint !== item.recipientFingerprint) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'A member encryption identity changed; reload and retry' }); }
      }
      let state = (await client.query<{ key_version: number; pending_version: number | null }>('SELECT key_version, pending_version FROM direct_chat_keys WHERE chat_id = $1', [chatId])).rows[0];
      if (!state) {
        // Envelopes without a version row (cannot happen after migration 019): adopt the newest version instead of failing on the primary key.
        const newest = (await client.query<{ v: number | null }>('SELECT max(version) AS v FROM chat_key_envelopes WHERE chat_id = $1', [chatId])).rows[0]?.v;
        if (newest != null) {
          await client.query('INSERT INTO direct_chat_keys (chat_id, key_version, pending_version) VALUES ($1, $2, NULL)', [chatId, newest]);
          state = { key_version: Number(newest), pending_version: null };
        }
      }
      if (state && version <= state.key_version) {
        // That version exists already. If everyone has an envelope for it this is a harmless repeat (the other browser won).
        const have = await client.query<{ recipient_id: string }>('SELECT recipient_id FROM chat_key_envelopes WHERE chat_id = $1 AND version = $2', [chatId, state.key_version]);
        const complete = members.every((member) => have.rows.some((row) => row.recipient_id === member));
        if (complete && version === state.key_version && state.pending_version === null) { await client.query('COMMIT'); return reply.code(200).send({ keyVersion: state.key_version }); }
        // A member lacks the envelope of the current version (should not happen: a reset always sets pending). Ask for a new version.
        const pending = state.pending_version ?? state.key_version + 1;
        if (!complete && state.pending_version === null) await client.query('UPDATE direct_chat_keys SET pending_version = $2 WHERE chat_id = $1', [chatId, pending]);
        await client.query('COMMIT');
        return reply.code(409).send({ error: 'Wrong key version', keyVersion: state.key_version, pendingKeyVersion: pending });
      }
      const wanted = state ? state.pending_version : 1;
      if (version !== wanted) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Wrong key version', keyVersion: state?.key_version ?? 0, pendingKeyVersion: state?.pending_version ?? null });
      }
      const senderKey = parseJwk(sender.public_jwk);
      const senderJwk = JSON.stringify({ kty: senderKey?.kty, crv: senderKey?.crv, x: senderKey?.x, y: senderKey?.y });
      for (const item of parsed as EnvelopeItem[]) await client.query(
        `INSERT INTO chat_key_envelopes (chat_id, version, recipient_id, sender_id, sender_fingerprint, sender_public_jwk, nonce, ciphertext)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [chatId, version, item.recipientId, userId, sender.fingerprint, senderJwk, item.nonce, item.ciphertext]);
      await client.query(
        `INSERT INTO direct_chat_keys (chat_id, key_version, pending_version) VALUES ($1, $2, NULL)
         ON CONFLICT (chat_id) DO UPDATE SET key_version = excluded.key_version, pending_version = NULL`, [chatId, version]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    return reply.code(201).send({ keyVersion: version });
  });
};
