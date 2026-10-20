import { hashPassword } from './auth.js';
import { db } from './db.js';

export const normalizeUsername = (username: string): string => username.trim().toLowerCase();

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'root', 'support', 'telegram', 'tel', 'system', 'saved', 'me', 'self',
  'help', 'info', 'moderator', 'mod', 'staff', 'official', 'security', 'service', 'bot', 'null',
  'undefined', 'api', 'www', 'join', 'login', 'register', 'signup', 'settings', 'everyone', 'all'
]);

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 1_024;

export const isValidUsernameShape = (username: string): boolean => /^[a-z0-9_]{3,32}$/.test(username);
export const isReservedUsername = (username: string): boolean => RESERVED_USERNAMES.has(username);

export const validateNewUser = (
  username: string, displayName: string, password: string, options: { allowReserved?: boolean } = {}
): void => {
  if (!isValidUsernameShape(username)) {
    throw new Error('Username must be 3–32 lowercase letters, digits, or underscores.');
  }
  if (!options.allowReserved && isReservedUsername(username)) {
    throw new Error('This username is reserved.');
  }
  if (!displayName.trim() || displayName.length > 100) {
    throw new Error('Display name must be 1–100 characters.');
  }
  if (password.length < PASSWORD_MIN) {
    throw new Error(`Password must be at least ${PASSWORD_MIN} characters.`);
  }
  if (password.length > PASSWORD_MAX) {
    throw new Error(`Password must be at most ${PASSWORD_MAX} characters.`);
  }
};

// allowReserved is for the local operator CLI only; open signup and invites must never set it.
export const createUser = async (
  usernameInput: string, displayName: string, password: string, options: { allowReserved?: boolean } = {}
): Promise<string> => {
  const username = normalizeUsername(usernameInput);
  validateNewUser(username, displayName, password, options);
  const passwordHash = await hashPassword(password);
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [username, displayName.trim(), passwordHash]
  );
  return result.rows[0].id;
};
