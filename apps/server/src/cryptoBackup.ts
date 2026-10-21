import type { FastifyInstance } from 'fastify';
import { allowLoginAttempt, verifyPassword } from './auth.js';
import { db } from './db.js';

// Server side of the E2EE key backup. The blob is produced and opened in the browser only
// (key = PBKDF2 of the login password); the server never sees the identity key itself.
const READ_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
const WRITE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
const RESET_LIMIT = { max: 5, timeWindow: '15 minutes' } as const;

export const BACKUP_MIN_ITERATIONS = 600_000;
export const BACKUP_MAX_ITERATIONS = 5_000_000;
export const BACKUP_MAX_WRAPPED = 4_096; // a P-256 private JWK payload wraps to well under 1 KiB; groups of keys may grow it

const b64 = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

/** Validates a wrapped-key blob ({salt, iterations, wrapped, version}); null when malformed. */
export const parseBackupBlob = (body: { salt?: unknown; iterations?: unknown; wrapped?: unknown; version?: unknown } | null | undefined): { salt: string; iterations: number; wrapped: string } | null => {
  const { salt, iterations, wrapped, version } = body ?? {};
  if (!b64(salt, 16, 64) || !b64(wrapped, 40, BACKUP_MAX_WRAPPED) || version !== 1
    || !Number.isInteger(iterations) || (iterations as number) < BACKUP_MIN_ITERATIONS || (iterations as number) > BACKUP_MAX_ITERATIONS) return null;
  return { salt, iterations: iterations as number, wrapped };
};

type Row = { mode: 'auto' | 'manual'; salt: string | null; iterations: number | null; wrapped: string | null; version: number | null; updated_at: string };

const view = (row: Row) => ({
  mode: row.mode,
  backup: row.wrapped === null ? null : { salt: row.salt, iterations: row.iterations, wrapped: row.wrapped, version: row.version },
  updatedAt: row.updated_at
});

export const registerCryptoBackupRoutes = async (app: FastifyInstance): Promise<void> => {
  // 404 = this account has never stored anything (no copy, no mode choice yet).
  app.get('/api/crypto/backup', { preHandler: app.requireUser, config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const row = (await db.query<Row>('SELECT mode, salt, iterations, wrapped, version, updated_at FROM user_crypto_backups WHERE user_id = $1', [request.user!.id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'No key backup' });
    return view(row);
  });

  // Stores/replaces the one copy of the caller and switches the account to mode "auto".
  app.put<{ Body: { salt?: unknown; iterations?: unknown; wrapped?: unknown; version?: unknown } }>('/api/crypto/backup', {
    config: { rateLimit: WRITE_LIMIT }, preHandler: app.requireUser, bodyLimit: 16 * 1024
  }, async (request, reply) => {
    const blob = parseBackupBlob(request.body);
    if (!blob) return reply.code(400).send({ error: 'Invalid key backup' });
    const { salt, iterations, wrapped } = blob;
    await db.query(
      `INSERT INTO user_crypto_backups (user_id, mode, salt, iterations, wrapped, version, updated_at)
       VALUES ($1, 'auto', $2, $3, $4, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (user_id) DO UPDATE SET mode = 'auto', salt = excluded.salt, iterations = excluded.iterations,
         wrapped = excluded.wrapped, version = 1, updated_at = excluded.updated_at`,
      [request.user!.id, salt, iterations, wrapped]
    );
    return reply.code(204).send();
  });

  // Removes the server copy and records the choice "manual" so clients do not upload again.
  app.delete('/api/crypto/backup', { preHandler: app.requireUser, config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
    await db.query(
      `INSERT INTO user_crypto_backups (user_id, mode, updated_at) VALUES ($1, 'manual', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (user_id) DO UPDATE SET mode = 'manual', salt = NULL, iterations = NULL, wrapped = NULL, version = NULL, updated_at = excluded.updated_at`,
      [request.user!.id]
    );
    return reply.code(204).send();
  });

  // Lets the client confirm the login password before it wraps the key with it (switching back to "auto").
  app.post<{ Body: { password?: unknown } }>('/api/crypto/password-check', {
    preHandler: app.requireUser, config: { rateLimit: RESET_LIMIT }
  }, async (request, reply) => {
    const password = request.body?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 1_024) return reply.code(400).send({ error: 'Password is required' });
    if (!allowLoginAttempt(request.user!.username)) return reply.code(429).send({ error: 'Too many attempts. Try again later.' });
    const account = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [request.user!.id])).rows[0];
    if (!account || !(await verifyPassword(account.password_hash, password))) return reply.code(403).send({ error: 'Wrong password' });
    return reply.code(204).send();
  });

  // "Start fresh": the account may take a NEW encryption identity. Needs the login password (a stolen
  // session alone must not be able to swap the identity). Old encrypted chats lose their key envelopes.
  app.post<{ Body: { password?: unknown } }>('/api/crypto/identity/reset', {
    preHandler: app.requireUser, config: { rateLimit: RESET_LIMIT }
  }, async (request, reply) => {
    const password = request.body?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 1_024) return reply.code(400).send({ error: 'Password is required' });
    if (!allowLoginAttempt(request.user!.username)) return reply.code(429).send({ error: 'Too many attempts. Try again later.' });
    const account = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [request.user!.id])).rows[0];
    if (!account || !(await verifyPassword(account.password_hash, password))) return reply.code(403).send({ error: 'Wrong password' });
    const userId = request.user!.id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Every chat key envelope of every chat this user is in (both sides: the old key is unusable for the new identity).
      await client.query('DELETE FROM chat_key_envelopes WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)', [userId]);
      await client.query('DELETE FROM user_crypto_identities WHERE user_id = $1', [userId]);
      // The old wrapped key no longer matches the account; the chosen mode (auto/manual) is kept.
      await client.query(`UPDATE user_crypto_backups SET salt = NULL, iterations = NULL, wrapped = NULL, version = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = $1`, [userId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return reply.code(204).send();
  });
};
