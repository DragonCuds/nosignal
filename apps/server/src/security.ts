import argon2 from 'argon2';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clearSessionCookie, createSession, currentTokenHash, getSessionId, getSessionToken, notifySessionsRevoked, verifyPassword } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { parseBackupBlob } from './cryptoBackup.js';
import { decryptMfaSecret, encryptMfaSecret, generateRecoveryCodes, generateTotpSecret, recoveryCodeHash, verifyTotp } from './totp.js';

const FLOW_COOKIE = 'tel_webauthn_flow';
const flowHash = (token: string): string => createHmac('sha256', config.sessionSecret).update(`webauthn\0${token}`).digest('hex');

const setFlowCookie = (reply: FastifyReply, token: string): void => {
  reply.setCookie(FLOW_COOKIE, token, {
    path: '/api/auth/passkeys', httpOnly: true, secure: config.isProduction,
    sameSite: 'strict', maxAge: 5 * 60, priority: 'high'
  });
};

const clearFlowCookie = (reply: FastifyReply): void => {
  reply.clearCookie(FLOW_COOKIE, {
    path: '/api/auth/passkeys', httpOnly: true, secure: config.isProduction, sameSite: 'strict'
  });
};

export const hasTotp = async (userId: string): Promise<boolean> => {
  const result = await db.query('SELECT 1 FROM user_security WHERE user_id = $1 AND totp_enabled_at IS NOT NULL', [userId]);
  return result.rowCount === 1;
};

export const verifySecondFactor = async (userId: string, candidate: unknown): Promise<boolean> => {
  if (typeof candidate !== 'string' || candidate.length > 64) return false;
  const normalized = candidate.replace(/[\s-]/gu, '').toUpperCase();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const security = await client.query<{ totp_secret_enc: Buffer; last_totp_step: string | null }>(
      'SELECT totp_secret_enc, last_totp_step FROM user_security WHERE user_id = $1 AND totp_enabled_at IS NOT NULL',
      [userId]
    );
    const row = security.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return false;
    }

    if (/^\d{6}$/u.test(normalized)) {
      const step = verifyTotp(decryptMfaSecret(row.totp_secret_enc), normalized);
      if (step !== null && (row.last_totp_step === null || BigInt(row.last_totp_step) < BigInt(step))) {
        await client.query('UPDATE user_security SET last_totp_step = $2 WHERE user_id = $1', [userId, step]);
        await client.query('COMMIT');
        return true;
      }
    } else if (/^[A-F0-9]{20}$/u.test(normalized)) {
      const used = await client.query(
        'DELETE FROM recovery_codes WHERE user_id = $1 AND code_hash = $2 RETURNING code_hash',
        [userId, recoveryCodeHash(normalized)]
      );
      if (used.rowCount === 1) {
        await client.query('COMMIT');
        return true;
      }
    }
    await client.query('ROLLBACK');
    return false;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const verifyReauthentication = async (userId: string, password: unknown, secondFactor: unknown): Promise<boolean> => {
  if (typeof password !== 'string' || password.length > 1_024) return false;
  const result = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const account = result.rows[0];
  if (!account || !(await verifyPassword(account.password_hash, password))) return false;
  return !(await hasTotp(userId)) || verifySecondFactor(userId, secondFactor);
};

const replaceRecoveryCodes = async (userId: string): Promise<string[]> => {
  const codes = generateRecoveryCodes();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const code of codes) {
      await client.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, recoveryCodeHash(code)]);
    }
    await client.query('COMMIT');
    return codes;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const createChallenge = async (reply: FastifyReply, kind: 'register' | 'authenticate', challenge: string, userId: string | null): Promise<void> => {
  const flow = randomBytes(32).toString('base64url');
  await db.query("DELETE FROM webauthn_challenges WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  await db.query(
    `INSERT INTO webauthn_challenges (flow_hash, user_id, kind, challenge, expires_at)
     VALUES ($1, $2, $3, $4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes'))`,
    [flowHash(flow), userId, kind, challenge]
  );
  setFlowCookie(reply, flow);
};

const consumeChallenge = async (request: FastifyRequest, kind: 'register' | 'authenticate', userId: string | null): Promise<string | null> => {
  const flow = request.cookies[FLOW_COOKIE];
  if (!flow) return null;
  const result = await db.query<{ challenge: string }>(
    `DELETE FROM webauthn_challenges
     WHERE flow_hash = $1 AND kind = $2 AND user_id IS $3
       AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING challenge`,
    [flowHash(flow), kind, userId]
  );
  return result.rows[0]?.challenge ?? null;
};

const expectedOrigins = [...config.trustedOrigins];

export const registerSecurityRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/api/security/status', { preHandler: app.requireUser }, async (request) => {
    const [security, credentials, recovery] = await Promise.all([
      db.query<{ enabled: boolean }>('SELECT (totp_enabled_at IS NOT NULL) AS enabled FROM user_security WHERE user_id = $1', [request.user!.id]),
      db.query<{ id: string; name: string; created_at: Date; last_used_at: Date | null }>(
        'SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC', [request.user!.id]
      ),
      db.query<{ count: string }>('SELECT CAST(count(*) AS TEXT) AS count FROM recovery_codes WHERE user_id = $1', [request.user!.id])
    ]);
    return {
      totpEnabled: security.rows[0]?.enabled ?? false,
      recoveryCodesRemaining: Number(recovery.rows[0]?.count ?? 0),
      passkeys: credentials.rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at }))
    };
  });

  app.post<{ Body: { password?: string; secondFactor?: string } }>('/api/security/totp/setup', {
    preHandler: app.requireUser, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    if (!(await verifyReauthentication(request.user!.id, request.body?.password, request.body?.secondFactor))) {
      return reply.code(401).send({ error: 'Reauthentication failed' });
    }
    const sessionId = await getSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: 'Unauthorized' });
    const secret = generateTotpSecret();
    await db.query(
      `INSERT INTO mfa_enrollments (session_id, secret_enc, expires_at)
       VALUES ($1, $2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes'))
       ON CONFLICT (session_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, expires_at = EXCLUDED.expires_at`,
      [sessionId, encryptMfaSecret(secret)]
    );
    const label = encodeURIComponent(`${config.webauthnRpName}:${request.user!.username}`);
    const issuer = encodeURIComponent(config.webauthnRpName);
    return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` };
  });

  app.post<{ Body: { code?: string } }>('/api/security/totp/enable', {
    preHandler: app.requireUser, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const sessionId = await getSessionId(request);
    if (!sessionId || typeof request.body?.code !== 'string') return reply.code(400).send({ error: 'Invalid enrollment' });
    const enrollment = await db.query<{ secret_enc: Buffer }>(
      "DELETE FROM mfa_enrollments WHERE session_id = $1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') RETURNING secret_enc", [sessionId]
    );
    const encrypted = enrollment.rows[0]?.secret_enc;
    if (!encrypted) return reply.code(400).send({ error: 'Enrollment expired' });
    const step = verifyTotp(decryptMfaSecret(encrypted), request.body.code);
    if (step === null) return reply.code(400).send({ error: 'Invalid verification code' });
    await db.query(
      `INSERT INTO user_security (user_id, totp_secret_enc, totp_enabled_at, last_totp_step)
       VALUES ($1, $2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), $3)
       ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc,
       totp_enabled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_totp_step = EXCLUDED.last_totp_step`,
      [request.user!.id, encrypted, step]
    );
    return { recoveryCodes: await replaceRecoveryCodes(request.user!.id) };
  });

  app.post<{ Body: { password?: string; secondFactor?: string } }>('/api/security/totp/disable', {
    preHandler: app.requireUser, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    if (!(await verifyReauthentication(request.user!.id, request.body?.password, request.body?.secondFactor))) {
      return reply.code(401).send({ error: 'Reauthentication failed' });
    }
    const token = currentTokenHash(request);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_security WHERE user_id = $1', [request.user!.id]);
      await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [request.user!.id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [request.user!.id, token]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
    notifySessionsRevoked({ userId: request.user!.id, exceptTokenHash: token });
    return reply.code(204).send();
  });

  app.post<{ Body: { password?: string; secondFactor?: string } }>('/api/security/recovery-codes/regenerate', {
    preHandler: app.requireUser, config: { rateLimit: { max: 3, timeWindow: '1 hour' } }
  }, async (request, reply) => {
    if (!(await hasTotp(request.user!.id))) return reply.code(409).send({ error: 'MFA is not enabled' });
    if (!(await verifyReauthentication(request.user!.id, request.body?.password, request.body?.secondFactor))) {
      return reply.code(401).send({ error: 'Reauthentication failed' });
    }
    return { recoveryCodes: await replaceRecoveryCodes(request.user!.id) };
  });

  app.get('/api/security/sessions', { preHandler: app.requireUser }, async (request) => {
    const token = currentTokenHash(request);
    const result = await db.query<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date; current: boolean }>(
      `SELECT id, user_agent, created_at, last_seen_at, expires_at, (token_hash = $2) AS current
       FROM sessions WHERE user_id = $1
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY current DESC, last_seen_at DESC`,
      [request.user!.id, token]
    );
    return result.rows.map((row) => ({ id: row.id, userAgent: row.user_agent, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, current: row.current }));
  });

  app.delete<{ Params: { id: string } }>('/api/security/sessions/:id', { preHandler: app.requireUser }, async (request, reply) => {
    const result = await db.query<{ current: boolean; token_hash: string }>(
      'DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash = $3 AS current, token_hash',
      [request.params.id, request.user!.id, currentTokenHash(request)]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'Session not found' });
    notifySessionsRevoked({ tokenHash: result.rows[0].token_hash });
    if (result.rows[0].current) clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post('/api/security/sessions/revoke-others', { preHandler: app.requireUser }, async (request, reply) => {
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [request.user!.id, currentTokenHash(request)]);
    notifySessionsRevoked({ userId: request.user!.id, exceptTokenHash: currentTokenHash(request) });
    return reply.code(204).send();
  });

  app.post<{ Body: { password?: string; secondFactor?: string } }>('/api/auth/passkeys/register/options', {
    preHandler: app.requireUser, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    if (!(await verifyReauthentication(request.user!.id, request.body?.password, request.body?.secondFactor))) {
      return reply.code(401).send({ error: 'Reauthentication failed' });
    }
    const existing = await db.query<{ id: string; transports: string[] }>('SELECT id, transports FROM webauthn_credentials WHERE user_id = $1', [request.user!.id]);
    const options = await generateRegistrationOptions({
      rpName: config.webauthnRpName, rpID: config.webauthnRpId,
      userID: Buffer.from(request.user!.id), userName: request.user!.username, userDisplayName: request.user!.displayName,
      attestationType: 'none', timeout: 60_000,
      excludeCredentials: existing.rows.map((row) => ({ id: row.id, transports: row.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
    });
    await createChallenge(reply, 'register', options.challenge, request.user!.id);
    return options;
  });

  app.post<{ Body: { response?: RegistrationResponseJSON; name?: string } }>('/api/auth/passkeys/register/verify', {
    preHandler: app.requireUser, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const challenge = await consumeChallenge(request, 'register', request.user!.id);
    clearFlowCookie(reply);
    if (!challenge || !request.body?.response) return reply.code(400).send({ error: 'Registration expired' });
    try {
      const result = await verifyRegistrationResponse({
        response: request.body.response, expectedChallenge: challenge,
        expectedOrigin: expectedOrigins, expectedRPID: config.webauthnRpId,
        requireUserVerification: true
      });
      if (!result.verified) return reply.code(400).send({ error: 'Passkey verification failed' });
      const credential = result.registrationInfo.credential;
      const name = typeof request.body.name === 'string' && request.body.name.trim() ? request.body.name.trim().slice(0, 80) : 'Passkey';
      await db.query(
        `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [credential.id, request.user!.id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), result.registrationInfo.credentialDeviceType, result.registrationInfo.credentialBackedUp ? 1 : 0, name]
      );
      return reply.code(204).send();
    } catch {
      return reply.code(400).send({ error: 'Passkey verification failed' });
    }
  });

  app.post('/api/auth/passkeys/login/options', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (_request, reply) => {
    const options = await generateAuthenticationOptions({ rpID: config.webauthnRpId, timeout: 60_000, userVerification: 'required' });
    await createChallenge(reply, 'authenticate', options.challenge, null);
    return options;
  });

  app.post<{ Body: { response?: AuthenticationResponseJSON } }>('/api/auth/passkeys/login/verify', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const challenge = await consumeChallenge(request, 'authenticate', null);
    clearFlowCookie(reply);
    const response = request.body?.response;
    if (!challenge || !response) return reply.code(400).send({ error: 'Authentication expired' });
    const stored = await db.query<{ id: string; user_id: string; public_key: Buffer; counter: string; transports: string[] }>(
      'SELECT id, user_id, public_key, counter, transports FROM webauthn_credentials WHERE id = $1', [response.id]
    );
    const credential = stored.rows[0];
    if (!credential) return reply.code(401).send({ error: 'Passkey authentication failed' });
    try {
      const result = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: expectedOrigins, expectedRPID: config.webauthnRpId,
        credential: { id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: Number(credential.counter), transports: credential.transports },
        requireUserVerification: true
      });
      if (!result.verified) return reply.code(401).send({ error: 'Passkey authentication failed' });
      await db.query("UPDATE webauthn_credentials SET counter = $2, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1", [credential.id, result.authenticationInfo.newCounter]);
      await createSession(credential.user_id, reply, request, getSessionToken(request));
      return reply.code(204).send();
    } catch {
      return reply.code(401).send({ error: 'Passkey authentication failed' });
    }
  });

  app.delete<{ Params: { id: string }; Body: { password?: string; secondFactor?: string } }>('/api/security/passkeys/:id', {
    preHandler: app.requireUser, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    if (!(await verifyReauthentication(request.user!.id, request.body?.password, request.body?.secondFactor))) {
      return reply.code(401).send({ error: 'Reauthentication failed' });
    }
    const deleted = await db.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [request.params.id, request.user!.id]);
    return deleted.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'Passkey not found' });
  });

  app.post<{ Body: { currentPassword?: string; newPassword?: string; secondFactor?: string; backup?: unknown; expectedBackupRevision?: unknown } }>('/api/security/password', {
    preHandler: app.requireUser, bodyLimit: 16 * 1024, config: { rateLimit: { max: 5, timeWindow: '1 hour' } }
  }, async (request, reply) => {
    const { currentPassword, newPassword, secondFactor, expectedBackupRevision } = request.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length > 1_024) return reply.code(403).send({ error: 'Reauthentication failed' });
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 1_024) {
      return reply.code(400).send({ error: 'New password must be at least 12 characters' });
    }
    if (!Number.isSafeInteger(expectedBackupRevision) || (expectedBackupRevision as number) < 0) {
      return reply.code(400).send({ error: 'Expected backup revision is required' });
    }
    const rawBackup = request.body?.backup;
    const backup = rawBackup === undefined ? null : parseBackupBlob(rawBackup as Parameters<typeof parseBackupBlob>[0]);
    if (rawBackup !== undefined && !backup) return reply.code(400).send({ error: 'Invalid key backup' });
    if ((await hasTotp(request.user!.id)) && !(await verifySecondFactor(request.user!.id, secondFactor))) {
      return reply.code(403).send({ error: 'Reauthentication failed' });
    }
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const account = (await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [request.user!.id])).rows[0];
      if (!account || !(await verifyPassword(account.password_hash, currentPassword))) {
        await client.query('ROLLBACK'); return reply.code(403).send({ error: 'Reauthentication failed' });
      }
      const state = (await client.query<{ mode: 'auto' | 'manual'; revision: number }>(
        'SELECT mode, revision FROM user_crypto_backups WHERE user_id = $1', [request.user!.id]
      )).rows[0];
      if ((state?.revision ?? 0) !== expectedBackupRevision) {
        await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Key backup changed; reload and retry' });
      }
      const mode = state?.mode ?? 'auto';
      const hasIdentity = (await client.query('SELECT 1 FROM user_crypto_identities WHERE user_id = $1', [request.user!.id])).rowCount === 1;
      if ((mode === 'auto' && hasIdentity && !backup) || (mode === 'manual' && backup)) {
        await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Current encryption identity backup is required for Auto mode' });
      }
      if (state) {
        await client.query(`UPDATE user_crypto_backups SET salt = $2, iterations = $3, wrapped = $4, version = $5,
          revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = $1`,
        [request.user!.id, backup?.salt ?? null, backup?.iterations ?? null, backup?.wrapped ?? null, backup ? 1 : null]);
      } else {
        await client.query(`INSERT INTO user_crypto_backups (user_id, mode, salt, iterations, wrapped, version, revision)
          VALUES ($1, 'auto', $2, $3, $4, $5, 1)`,
        [request.user!.id, backup?.salt ?? null, backup?.iterations ?? null, backup?.wrapped ?? null, backup ? 1 : null]);
      }
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [request.user!.id, hash]);
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [request.user!.id, currentTokenHash(request)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    notifySessionsRevoked({ userId: request.user!.id, exceptTokenHash: currentTokenHash(request) });
    return reply.code(204).send();
  });
};
