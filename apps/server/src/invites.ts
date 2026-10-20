import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { createSession, getSessionToken, hashPassword, requireUser } from './auth.js';
import { db } from './db.js';
import { normalizeUsername, validateNewUser } from './users.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const validTokenShape = (token: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(token);

type InviteRow = { id: string; created_at: string; expires_at: string; max_uses: number; uses: number; expired: number };

type InviteSummary = {
  id: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  status: 'active' | 'used' | 'expired';
};

const summarize = (row: InviteRow): InviteSummary => ({
  id: row.id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  maxUses: Number(row.max_uses),
  uses: Number(row.uses),
  status: Number(row.uses) >= Number(row.max_uses) ? 'used' : Number(row.expired) ? 'expired' : 'active'
});

const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await requireUser(request, reply);
  if (reply.sent || !request.user) return;
  const result = await db.query<{ is_admin: number }>('SELECT is_admin FROM users WHERE id = $1', [request.user.id]);
  if (Number(result.rows[0]?.is_admin) !== 1) await reply.code(403).send({ error: 'Admin only' });
};

export const registerInvites = async (app: FastifyInstance): Promise<void> => {
  app.post<{ Body: { maxUses?: number } }>('/api/invites', {
    preHandler: requireAdmin,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const raw = request.body?.maxUses ?? 1;
    if (!Number.isInteger(raw) || raw < 1 || raw > 100) return reply.code(400).send({ error: 'maxUses must be an integer 1–100' });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    const result = await db.query<{ id: string }>(
      'INSERT INTO invites (token_hash, created_by, expires_at, max_uses) VALUES ($1, $2, $3, $4) RETURNING id',
      [hashToken(token), request.user!.id, expiresAt, raw]
    );
    return reply.code(201).send({ id: result.rows[0].id, token, path: `/join/${token}`, expiresAt, maxUses: raw });
  });

  app.get('/api/invites', { preHandler: requireAdmin }, async () => {
    const result = await db.query<InviteRow>(
      `SELECT id, created_at, expires_at, max_uses, uses, (expires_at <= ${NOW_SQL}) AS expired
       FROM invites ORDER BY id DESC LIMIT 200`
    );
    return result.rows.map(summarize);
  });

  app.delete<{ Params: { id: string } }>('/api/invites/:id', { preHandler: requireAdmin }, async (request, reply) => {
    if (!/^\d{1,15}$/.test(request.params.id)) return reply.code(404).send({ error: 'Not found' });
    const result = await db.query('DELETE FROM invites WHERE id = $1', [request.params.id]);
    return result.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'Not found' });
  });

  app.get<{ Params: { token: string } }>('/api/invites/:token', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => {
    const { token } = request.params;
    if (!validTokenShape(token)) return { valid: false };
    const result = await db.query(
      `SELECT 1 FROM invites WHERE token_hash = $1 AND uses < max_uses AND expires_at > ${NOW_SQL}`,
      [hashToken(token)]
    );
    return { valid: result.rowCount > 0 };
  });

  app.post<{ Params: { token: string }; Body: { username?: unknown; displayName?: unknown; password?: unknown } }>('/api/invites/:token/accept', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const { token } = request.params;
    const { username, displayName, password } = request.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 1_024
      || (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 100))) {
      return reply.code(400).send({ error: 'username and password are required' });
    }
    const name = normalizeUsername(username);
    const shown = (typeof displayName === 'string' && displayName.trim()) || name;
    try { validateNewUser(name, shown, password); } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid input' });
    }
    if (!validTokenShape(token)) return reply.code(404).send({ error: 'Invite is not valid' });
    const hash = hashToken(token);

    const passwordHash = await hashPassword(password);
    const client = await db.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      const burned = await client.query(
        `UPDATE invites SET uses = uses + 1 WHERE token_hash = $1 AND uses < max_uses AND expires_at > ${NOW_SQL}`,
        [hash]
      );
      if (!burned.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Invite is not valid' });
      }
      const taken = await client.query('SELECT 1 FROM users WHERE username = $1', [name]);
      if (taken.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Username is taken' });
      }
      const created = await client.query<{ id: string }>(
        'INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [name, shown.trim(), passwordHash]
      );
      userId = created.rows[0].id;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await createSession(userId, reply, request, getSessionToken(request));
    return reply.code(204).send();
  });
};
