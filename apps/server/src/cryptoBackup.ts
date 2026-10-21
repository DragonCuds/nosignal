import type { FastifyInstance } from 'fastify';
import { createHmac, randomBytes } from 'node:crypto';
import { allowLoginAttempt, getSessionId, verifyPassword } from './auth.js';
import { config } from './config.js';
import { db, type DbClient } from './db.js';
import { hasTotp, verifySecondFactor } from './security.js';

// Server side of the E2EE key backup. The blob is produced and opened in the browser only
// (key = PBKDF2 of the login password); the server never sees the identity key itself.
const READ_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
const WRITE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
const RESET_LIMIT = { max: 5, timeWindow: '15 minutes' } as const;
type Action = 'backup.replace' | 'backup.delete' | 'identity.reset';
const actionHash = (token: string): string => createHmac('sha256', config.sessionSecret).update(`crypto-action\0${token}`).digest('hex');

const consumeAction = async (client: DbClient, token: unknown, userId: string, sessionId: string, action: Action, revision: number): Promise<boolean> => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  const result = await client.query(
    `DELETE FROM crypto_action_grants WHERE token_hash = $1 AND user_id = $2 AND session_id = $3
      AND action = $4 AND backup_revision = $5 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND password_hash = (SELECT password_hash FROM users WHERE id = $2)
      AND mfa_enabled = (SELECT CASE WHEN EXISTS (SELECT 1 FROM user_security WHERE user_id = $2 AND totp_enabled_at IS NOT NULL) THEN 1 ELSE 0 END)
     RETURNING token_hash`,
    [actionHash(token), userId, sessionId, action, revision]
  );
  return result.rowCount === 1;
};

const recordEvent = (client: DbClient, userId: string, action: 'backup.created' | 'backup.replaced' | 'backup.deleted' | 'identity.reset'): Promise<unknown> =>
  client.query('INSERT INTO crypto_security_events (user_id, action) VALUES ($1, $2)', [userId, action]);

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

type Row = { mode: 'auto' | 'manual'; salt: string | null; iterations: number | null; wrapped: string | null; version: number | null; revision: number; updated_at: string };

const view = (row: Row) => ({
  mode: row.mode,
  revision: row.revision,
  backup: row.wrapped === null ? null : { salt: row.salt, iterations: row.iterations, wrapped: row.wrapped, version: row.version },
  updatedAt: row.updated_at
});

export const registerCryptoBackupRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post<{ Body: { action?: unknown; expectedRevision?: unknown; password?: unknown; secondFactor?: unknown } }>('/api/crypto/action-grant', {
    preHandler: app.requireUser, config: { rateLimit: RESET_LIMIT }
  }, async (request, reply) => {
    const { action, expectedRevision, password, secondFactor } = request.body ?? {};
    if (action !== 'backup.replace' && action !== 'backup.delete' && action !== 'identity.reset') return reply.code(400).send({ error: 'Invalid action' });
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) return reply.code(400).send({ error: 'Expected backup revision is required' });
    if (typeof password !== 'string' || !password || password.length > 1_024) return reply.code(403).send({ error: 'Reauthentication failed' });
    if (!allowLoginAttempt(request.user!.username)) return reply.code(429).send({ error: 'Too many attempts. Try again later.' });
    const sessionId = await getSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: 'Unauthorized' });
    const account = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [request.user!.id])).rows[0];
    if (!account || !(await verifyPassword(account.password_hash, password))) return reply.code(403).send({ error: 'Reauthentication failed' });
    const mfaEnabled = await hasTotp(request.user!.id);
    if (mfaEnabled && !(await verifySecondFactor(request.user!.id, secondFactor))) return reply.code(403).send({ error: 'Reauthentication failed' });
    const current = (await db.query<{ revision: number }>('SELECT revision FROM user_crypto_backups WHERE user_id = $1', [request.user!.id])).rows[0];
    if ((current?.revision ?? 0) !== expectedRevision) return reply.code(409).send({ error: 'Key backup changed; reload and retry' });
    const token = randomBytes(32).toString('base64url');
    await db.query("DELETE FROM crypto_action_grants WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    await db.query(`INSERT INTO crypto_action_grants (token_hash, user_id, session_id, action, backup_revision, password_hash, mfa_enabled, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes'))`,
    [actionHash(token), request.user!.id, sessionId, action, expectedRevision, account.password_hash, mfaEnabled ? 1 : 0]);
    reply.header('cache-control', 'no-store');
    return { token };
  });

  app.get('/api/crypto/security-events', { preHandler: app.requireUser, config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const events = await db.query<{ action: string; created_at: string }>(
      'SELECT action, created_at FROM crypto_security_events WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [request.user!.id]
    );
    return events.rows.map((event) => ({ action: event.action, createdAt: event.created_at }));
  });

  // 404 = this account has never stored anything (no copy, no mode choice yet).
  app.get('/api/crypto/backup', { preHandler: app.requireUser, config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const row = (await db.query<Row>('SELECT mode, salt, iterations, wrapped, version, revision, updated_at FROM user_crypto_backups WHERE user_id = $1', [request.user!.id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'No key backup' });
    return view(row);
  });

  // Stores/replaces the one copy of the caller and switches the account to mode "auto".
  app.put<{ Body: { salt?: unknown; iterations?: unknown; wrapped?: unknown; version?: unknown; expectedUserId?: unknown; expectedRevision?: unknown; password?: unknown; actionToken?: unknown } }>('/api/crypto/backup', {
    config: { rateLimit: WRITE_LIMIT }, preHandler: app.requireUser, bodyLimit: 16 * 1024
  }, async (request, reply) => {
    if (request.body?.expectedUserId !== request.user!.id) return reply.code(403).send({ error: 'Backup account does not match session' });
    const blob = parseBackupBlob(request.body);
    if (!blob) return reply.code(400).send({ error: 'Invalid key backup' });
    const expected = request.body?.expectedRevision;
    if (!Number.isSafeInteger(expected) || (expected as number) < 0) return reply.code(400).send({ error: 'Expected backup revision is required' });
    const password = request.body?.password;
    if (typeof password !== 'string' || password.length > 1_024) return reply.code(403).send({ error: 'Reauthentication failed' });
    const sessionId = await getSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: 'Unauthorized' });
    const { salt, iterations, wrapped } = blob;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const account = (await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [request.user!.id])).rows[0];
      if (!account || !(await verifyPassword(account.password_hash, password))) {
        await client.query('ROLLBACK'); return reply.code(403).send({ error: 'Reauthentication failed' });
      }
      const current = (await client.query<{ revision: number; mode: string; wrapped: string | null }>('SELECT revision, mode, wrapped FROM user_crypto_backups WHERE user_id = $1', [request.user!.id])).rows[0];
      if ((current?.revision ?? 0) !== expected) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Key backup changed; reload and retry' }); }
      if ((current?.wrapped || current?.mode === 'manual') && !(await consumeAction(client, request.body?.actionToken, request.user!.id, sessionId, 'backup.replace', expected as number))) {
        await client.query('ROLLBACK'); return reply.code(403).send({ error: 'Action authorization required' });
      }
      if (current) {
        await client.query(`UPDATE user_crypto_backups SET mode = 'auto', salt = $2, iterations = $3, wrapped = $4,
          version = 1, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = $1`,
        [request.user!.id, salt, iterations, wrapped]);
      } else {
        await client.query(`INSERT INTO user_crypto_backups (user_id, mode, salt, iterations, wrapped, version, revision)
          VALUES ($1, 'auto', $2, $3, $4, 1, 1)`, [request.user!.id, salt, iterations, wrapped]);
      }
      await recordEvent(client, request.user!.id, current?.wrapped ? 'backup.replaced' : 'backup.created');
      await client.query('DELETE FROM crypto_action_grants WHERE user_id = $1', [request.user!.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return reply.code(204).send();
  });

  // Removes the server copy and records the choice "manual" so clients do not upload again.
  app.delete<{ Body: { actionToken?: unknown; expectedRevision?: unknown } }>('/api/crypto/backup', { preHandler: app.requireUser, config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
    const expected = request.body?.expectedRevision;
    if (!Number.isSafeInteger(expected) || (expected as number) < 0) return reply.code(400).send({ error: 'Expected backup revision is required' });
    const sessionId = await getSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: 'Unauthorized' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query<{ revision: number }>('SELECT revision FROM user_crypto_backups WHERE user_id = $1', [request.user!.id])).rows[0];
      if ((current?.revision ?? 0) !== expected) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Key backup changed; reload and retry' }); }
      if (!(await consumeAction(client, request.body?.actionToken, request.user!.id, sessionId, 'backup.delete', expected as number))) {
        await client.query('ROLLBACK'); return reply.code(403).send({ error: 'Action authorization required' });
      }
      await client.query(
        `INSERT INTO user_crypto_backups (user_id, mode, revision, updated_at) VALUES ($1, 'manual', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (user_id) DO UPDATE SET mode = 'manual', salt = NULL, iterations = NULL, wrapped = NULL, version = NULL,
           revision = revision + 1, updated_at = excluded.updated_at`,
        [request.user!.id]
      );
      await recordEvent(client, request.user!.id, 'backup.deleted');
      await client.query('DELETE FROM crypto_action_grants WHERE user_id = $1', [request.user!.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
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

  // How many chats a "start fresh" touches (shown before the user confirms). Counts only; nothing else is revealed.
  app.get('/api/crypto/identity/reset-impact', { preHandler: app.requireUser, config: { rateLimit: READ_LIMIT } }, async (request) => {
    const row = (await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM direct_chat_keys k WHERE k.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)`, [request.user!.id])).rows[0];
    return { chats: Number(row?.n ?? 0) };
  });

  // "Start fresh": the account may take a NEW encryption identity. Needs the login password (a stolen
  // session alone must not be able to swap the identity). The user's own chat key envelopes are removed; contacts keep theirs.
  app.post<{ Body: { actionToken?: unknown; expectedRevision?: unknown } }>('/api/crypto/identity/reset', {
    preHandler: app.requireUser, config: { rateLimit: RESET_LIMIT }
  }, async (request, reply) => {
    const expected = request.body?.expectedRevision;
    if (!Number.isSafeInteger(expected) || (expected as number) < 0) return reply.code(400).send({ error: 'Expected backup revision is required' });
    const sessionId = await getSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: 'Unauthorized' });
    const userId = request.user!.id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query<{ revision: number }>('SELECT revision FROM user_crypto_backups WHERE user_id = $1', [userId])).rows[0];
      if ((current?.revision ?? 0) !== expected) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Key backup changed; reload and retry' }); }
      if (!(await consumeAction(client, request.body?.actionToken, userId, sessionId, 'identity.reset', expected as number))) {
        await client.query('ROLLBACK'); return reply.code(403).send({ error: 'Action authorization required' });
      }
      // Direct and Saved chats (NS-07): only THIS user's envelopes go (they were wrapped for the old identity and are useless
      // to the new one). The contact's envelopes stay, together with the sender key stored in each one, so the contact
      // keeps the whole history. Every such chat needs a new key version, which the next member to open it creates.
      await client.query(
        `INSERT INTO direct_chat_keys (chat_id, key_version, pending_version)
         SELECT chat_id, max(version), NULL FROM chat_key_envelopes WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $1) GROUP BY chat_id
         ON CONFLICT (chat_id) DO NOTHING`, [userId]);
      await client.query(
        'UPDATE direct_chat_keys SET pending_version = COALESCE(pending_version, key_version + 1) WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)', [userId]);
      await client.query('DELETE FROM chat_key_envelopes WHERE recipient_id = $1', [userId]);
      await client.query('DELETE FROM user_crypto_identities WHERE user_id = $1', [userId]);
      // Groups: this member's envelopes are for the old identity. Ask an admin to rotate the key (new envelope for the new identity).
      await client.query('UPDATE groups SET pending_version = COALESCE(pending_version, key_version + 1) WHERE key_version > 0 AND chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)', [userId]);
      // The old wrapped key no longer matches the account; the chosen mode (auto/manual) is kept.
      await client.query(`UPDATE user_crypto_backups SET salt = NULL, iterations = NULL, wrapped = NULL, version = NULL,
        revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = $1`, [userId]);
      await recordEvent(client, userId, 'identity.reset');
      await client.query('DELETE FROM crypto_action_grants WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return reply.code(204).send();
  });
};
