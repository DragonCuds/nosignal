import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { db } from './db.js';

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

const isMember = async (chatId: string, userId: string): Promise<boolean> =>
  (await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])).rowCount === 1;

export const registerCryptoRoutes = async (app: FastifyInstance): Promise<void> => {
  app.put<{ Body: { publicKey?: unknown } }>('/api/crypto/identity', { preHandler: app.requireUser, config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
    if (!validPublicJwk(request.body?.publicKey)) return reply.code(400).send({ error: 'Invalid P-256 public key' });
    const key = { kty: 'EC', crv: 'P-256', x: request.body.publicKey.x, y: request.body.publicKey.y } satisfies JsonWebKey;
    const hash = fingerprint(key);
    const result = await db.query<{ fingerprint: string }>(
      `INSERT INTO user_crypto_identities (user_id, public_jwk, fingerprint)
       VALUES ($1, json($2), $3)
       ON CONFLICT (user_id) DO UPDATE SET public_jwk = user_crypto_identities.public_jwk
       RETURNING fingerprint`,
      [request.user!.id, JSON.stringify(key), hash]
    );
    if (result.rows[0].fingerprint !== hash) return reply.code(409).send({ error: 'This account is already bound to another encryption identity' });
    return { fingerprint: hash };
  });

  app.get<{ Params: { id: string } }>('/api/chats/:id/crypto', { preHandler: app.requireUser, config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
    const chatId = id(request.params.id);
    if (!chatId || !(await isMember(chatId, request.user!.id))) return reply.code(404).send({ error: 'Chat not found' });
    const members = await db.query<{ user_id: string; public_jwk: JsonWebKey | null; fingerprint: string | null }>(
      `SELECT cm.user_id, ci.public_jwk, ci.fingerprint FROM chat_members cm
       LEFT JOIN user_crypto_identities ci ON ci.user_id = cm.user_id
       WHERE cm.chat_id = $1 ORDER BY cm.user_id`, [chatId]);
    const envelope = await db.query<{ sender_id: string; version: number; nonce: string; ciphertext: string }>(
      `SELECT sender_id, version, nonce, ciphertext FROM chat_key_envelopes
       WHERE chat_id = $1 AND recipient_id = $2`, [chatId, request.user!.id]);
    return {
      members: members.rows.map((row) => ({ userId: row.user_id, publicKey: row.public_jwk, fingerprint: row.fingerprint })),
      envelope: envelope.rows[0] ? { senderId: envelope.rows[0].sender_id, version: envelope.rows[0].version, nonce: envelope.rows[0].nonce, ciphertext: envelope.rows[0].ciphertext } : null
    };
  });

  app.post<{ Params: { id: string }; Body: { envelopes?: unknown } }>('/api/chats/:id/crypto/envelopes', { preHandler: app.requireUser, config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
    const chatId = id(request.params.id);
    if (!chatId || !(await isMember(chatId, request.user!.id))) return reply.code(404).send({ error: 'Chat not found' });
    if ((await db.query('SELECT 1 FROM groups WHERE chat_id = $1', [chatId])).rowCount === 1) return reply.code(409).send({ error: 'Group chats use /api/groups/:id/keys' });
    const members = (await db.query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1 ORDER BY user_id', [chatId])).rows.map((row) => row.user_id);
    // Direct chat: one envelope per member (2). Saved Messages: a single member, one envelope to itself.
    const expected = (await db.query('SELECT 1 FROM saved_chats WHERE chat_id = $1', [chatId])).rowCount === 1 ? 1 : 2;
    if (!Array.isArray(request.body?.envelopes) || request.body.envelopes.length !== expected) return reply.code(400).send({ error: 'An envelope is required for every chat member' });
    const parsed = request.body.envelopes.map((item) => object(item) && id(item.recipientId) && item.version === 1 && b64(item.nonce, 16, 32) && b64(item.ciphertext, 40, 256) ? item as { recipientId: string; version: 1; nonce: string; ciphertext: string } : null);
    if (parsed.some((item) => !item) || members.length !== expected || parsed.map((item) => item!.recipientId).sort().join(',') !== members.join(',')) return reply.code(400).send({ error: 'Invalid envelope set' });
    const identities = await db.query(
      'SELECT user_id FROM user_crypto_identities WHERE user_id IN (SELECT value FROM json_each($1))',
      [JSON.stringify(members)]
    );
    if (identities.rowCount !== members.length) return reply.code(409).send({ error: 'Every member must initialize encryption first' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT 1 FROM chat_key_envelopes WHERE chat_id = $1', [chatId]);
      if (existing.rowCount === 0) {
        for (const item of parsed) await client.query(
          `INSERT INTO chat_key_envelopes (chat_id, recipient_id, sender_id, version, nonce, ciphertext)
           VALUES ($1, $2, $3, 1, $4, $5)`,
          [chatId, item!.recipientId, request.user!.id, item!.nonce, item!.ciphertext]);
      } else if (existing.rowCount !== members.length) {
        throw new Error('Incomplete chat key envelope set');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return reply.code(201).send();
  });
};

