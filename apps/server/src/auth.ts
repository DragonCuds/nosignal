import argon2 from 'argon2';
import '@fastify/cookie';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db } from './db.js';

const SESSION_COOKIE = 'tel_session';
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const IDLE_DAYS = 14;
const IDLE_OK = `last_seen_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${IDLE_DAYS} days')`;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  avatarPath: string | null;
};

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, { type: argon2.argon2id });

export const verifyPassword = (hash: string, password: string): Promise<boolean> =>
  argon2.verify(hash, password);

// A real argon2id hash of a random value, so unknown usernames cost the same verify time.
const dummyHash = argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });

/** Verifies against the account hash, or against a dummy hash when the account does not exist. */
export const verifyLoginPassword = async (hash: string | undefined | null, password: string): Promise<boolean> => {
  if (hash) return argon2.verify(hash, password);
  await argon2.verify(await dummyHash, password);
  return false;
};

const LOGIN_USER_MAX = 10;
const LOGIN_USER_WINDOW_MS = 15 * 60_000;
const loginAttempts = new Map<string, number[]>();

/** Per-username login limiter (in addition to the per-IP route limit). Counts this attempt; false = blocked. */
export const allowLoginAttempt = (username: string, now = Date.now()): boolean => {
  const name = username.normalize('NFKC').trim().toLowerCase().slice(0, 200);
  const recent = (loginAttempts.get(name) ?? []).filter((t) => now - t < LOGIN_USER_WINDOW_MS);
  if (recent.length >= LOGIN_USER_MAX) {
    loginAttempts.set(name, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(name, recent);
  if (loginAttempts.size > 10_000) {
    for (const [k, v] of loginAttempts) if (!v.some((t) => now - t < LOGIN_USER_WINDOW_MS)) loginAttempts.delete(k);
  }
  return true;
};

export const resetLoginAttempts = (): void => loginAttempts.clear();

const tokenHash = (token: string): string =>
  createHmac('sha256', config.sessionSecret).update(token).digest('hex');

// Secure cookies whenever clients reach us over HTTPS: production (behind a TLS proxy) or own TLS.
let cookieSecure = config.isProduction || config.tlsMode !== 'off';
export const setCookieSecure = (secure: boolean): void => { cookieSecure = secure; };

const setSessionCookie = (reply: FastifyReply, token: string): void => {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    maxAge: THIRTY_DAYS_SECONDS,
    priority: 'high'
  });
};

export const clearSessionCookie = (reply: FastifyReply): void => {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict'
  });
};

export const createSession = async (
  userId: string,
  reply: FastifyReply,
  request: FastifyRequest,
  previousToken?: string
): Promise<void> => {
  const token = randomBytes(32).toString('base64url');
  const userAgent = request.headers['user-agent']?.slice(0, 500) ?? null;
  const ipHash = createHmac('sha256', config.sessionSecret).update(`ip\0${request.ip}`).digest('hex');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR NOT (${IDLE_OK})`);
    if (previousToken) {
      await client.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(previousToken)]);
    }
    await client.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip_hash)
       VALUES ($1, $2, $3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'), $4, $5)`,
      [randomUUID(), userId, tokenHash(token), userAgent, ipHash]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  setSessionCookie(reply, token);
};

export const isTrustedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return false;
  try {
    return config.trustedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
};

export const requireTrustedOrigin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (!request.url.startsWith('/api/') || !STATE_CHANGING_METHODS.has(request.method)) return;
  if (!isTrustedOrigin(request.headers.origin)) {
    await reply.code(403).send({ error: 'Untrusted request origin' });
  }
};

export const getSessionToken = (request: FastifyRequest): string | undefined =>
  request.cookies[SESSION_COOKIE];

export const getSessionUser = async (request: FastifyRequest): Promise<SessionUser | null> => {
  const token = getSessionToken(request);
  return token ? getSessionUserForToken(token) : null;
};

export const getSessionUserForToken = async (token: string): Promise<SessionUser | null> => {
  await db.query(
    `UPDATE sessions
     SET last_seen_at = CASE
       WHEN last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
       THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE last_seen_at END
     WHERE token_hash = $1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND ${IDLE_OK}`,
    [tokenHash(token)]
  );
  const result = await db.query<{
    id: string;
    username: string;
    display_name: string;
    avatar_path: string | null;
  }>(
    `SELECT users.id, users.username, users.display_name, users.avatar_path
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
       AND sessions.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND sessions.${IDLE_OK}`,
    [tokenHash(token)]
  );
  const user = result.rows[0];
  return user
    ? { id: user.id, username: user.username, displayName: user.display_name, avatarPath: user.avatar_path }
    : null;
};

export const requireUser = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const user = await getSessionUser(request);
  if (!user) {
    await reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  request.user = user;
};

declare module 'fastify' { interface FastifyRequest { user?: SessionUser; } }

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: typeof requireUser;
  }
}

export const deleteSession = async (token: string | undefined): Promise<void> => {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
};

export const getSessionId = async (request: FastifyRequest): Promise<string | null> => {
  const token = getSessionToken(request);
  if (!token) return null;
  const result = await db.query<{ id: string }>(
    `SELECT id FROM sessions WHERE token_hash = $1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND ${IDLE_OK}`,
    [tokenHash(token)]
  );
  return result.rows[0]?.id ?? null;
};

export const currentTokenHash = (request: FastifyRequest): string | null => {
  const token = getSessionToken(request);
  return token ? tokenHash(token) : null;
};
