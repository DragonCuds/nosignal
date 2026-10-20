import type { FastifyInstance } from 'fastify';
import { createSession, getSessionToken, hashPassword } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { isReservedUsername, isValidUsernameShape, normalizeUsername, validateNewUser } from './users.js';

const IP_MAX = 5;
const IP_WINDOW_MS = 15 * 60_000;
const GLOBAL_MAX = 100;
const GLOBAL_WINDOW_MS = 60 * 60_000;

const ipAttempts = new Map<string, number[]>();
let globalCreated: number[] = [];

const recent = (list: number[], windowMs: number, now: number): number[] => list.filter((t) => now - t < windowMs);

/** Counts a signup attempt for this IP; false = over the per-IP limit. */
export const allowRegistrationAttempt = (ip: string, now = Date.now()): boolean => {
  const list = recent(ipAttempts.get(ip) ?? [], IP_WINDOW_MS, now);
  if (list.length >= IP_MAX) {
    ipAttempts.set(ip, list);
    return false;
  }
  list.push(now);
  ipAttempts.set(ip, list);
  if (ipAttempts.size > 10_000) {
    for (const [k, v] of ipAttempts) if (!v.some((t) => now - t < IP_WINDOW_MS)) ipAttempts.delete(k);
  }
  return true;
};

const globalCapReached = (now = Date.now()): boolean => {
  globalCreated = recent(globalCreated, GLOBAL_WINDOW_MS, now);
  return globalCreated.length >= GLOBAL_MAX;
};

export const resetRegistrationLimits = (): void => {
  ipAttempts.clear();
  globalCreated = [];
};

export const registerRegistration = async (app: FastifyInstance): Promise<void> => {
  app.get<{ Querystring: { u?: unknown } }>('/api/username-available', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    if (!config.openRegistration) return reply.code(404).send({ error: 'Not found' });
    const u = request.query?.u;
    if (typeof u !== 'string' || u.length > 64) return { available: false, valid: false };
    const name = normalizeUsername(u);
    if (!isValidUsernameShape(name) || isReservedUsername(name)) return { available: false, valid: false };
    const taken = await db.query('SELECT 1 FROM users WHERE username = $1', [name]);
    return { available: taken.rowCount === 0, valid: true };
  });

  app.post<{ Body: { username?: unknown; password?: unknown; displayName?: unknown } }>('/api/register', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    if (!config.openRegistration) return reply.code(404).send({ error: 'Not found' });
    if (!allowRegistrationAttempt(request.ip) || globalCapReached()) {
      return reply.code(429).send({ error: 'Too many signups. Try again later.' });
    }
    const { username, password, displayName } = request.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 1_024
      || (displayName !== undefined && displayName !== null && (typeof displayName !== 'string' || displayName.length > 100))) {
      return reply.code(400).send({ error: 'username and password are required' });
    }
    const name = normalizeUsername(username);
    const shown = (typeof displayName === 'string' && displayName.trim()) || name;
    try { validateNewUser(name, shown, password); } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid input' });
    }

    // Always hash first so "taken" and "created" cost about the same time.
    const passwordHash = await hashPassword(password);
    let userId: string;
    try {
      const created = await db.query<{ id: string }>(
        'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1, $2, $3, 0) RETURNING id',
        [name, shown.trim(), passwordHash]
      );
      userId = created.rows[0].id;
    } catch (error) {
      const taken = await db.query('SELECT 1 FROM users WHERE username = $1', [name]);
      if (taken.rowCount) return reply.code(409).send({ error: 'Username is taken' });
      throw error;
    }
    globalCreated.push(Date.now());
    await createSession(userId, reply, request, getSessionToken(request));
    return reply.code(204).send();
  });
};
