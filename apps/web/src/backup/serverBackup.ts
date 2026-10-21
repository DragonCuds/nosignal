// Automatic key backup (default "Auto" mode): the identity key is wrapped in the browser with a key
// derived from the login password and stored on the server; a new browser gets it back at login.
import { api, ApiError } from '../api.js';
import { exportLocalIdentity, hasLocalIdentity, importIdentity, initializeIdentity } from '../e2ee.js';
import { unwrapFromServer, wrapForServer, type BackupPayload } from './crypto.js';

export type ServerBackupState = Awaited<ReturnType<typeof api.cryptoBackup>> | null;
export type LoginBackupResult = 'restored' | 'created' | 'uploaded' | 'pending' | 'unchanged' | 'manual' | 'needs-choice' | 'unexportable' | 'offline';

/** null = this account never stored anything on the server. */
export const fetchServerBackup = async (): Promise<ServerBackupState> => {
  try { return await api.cryptoBackup(); } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  }
};

const samePublic = (a: JsonWebKey, b: JsonWebKey) => a.x === b.x && a.y === b.y;

export const uploadBackup = async (payload: BackupPayload, password: string): Promise<void> => {
  const remote = await fetchServerBackup();
  await api.putCryptoBackup(await wrapForServer(payload, password), password, remote?.revision ?? 0);
};

// ---- "Not saved yet" tracking ------------------------------------------------------------------------
// When the first upload fails (offline, server hiccup) the wrapped key is retried in the background while this
// page lives (the password stays in memory only), and the UI shows a warning until the server holds a copy.
let pending = false;
let retry: { userId: string; password: string; timer: number; tries: number } | null = null;
const listeners = new Set<() => void>();
const setPending = (value: boolean) => { if (pending !== value) { pending = value; listeners.forEach((fn) => fn()); } };
export const isBackupPending = (): boolean => pending;
export const subscribeBackupPending = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const stopRetry = () => {
  if (retry) { window.clearInterval(retry.timer); retry = null; }
  window.removeEventListener('online', attemptRetry);
  setPending(false);
};

/** True when the server now holds a usable copy (or the account deliberately opted out). */
const settle = async (userId: string, password: string): Promise<boolean> => {
  const remote = await fetchServerBackup();
  if (remote?.mode === 'manual') return true;
  const mine = await exportLocalIdentity(userId);
  if (!mine) return true; // nothing exportable (old non-extractable key)
  if (remote?.backup) {
    const stored = await unwrapFromServer(remote.backup, password, userId);
    if (samePublic(stored.publicKey, mine.publicKey)) return true;
    throw new Error('Key backup differs from local identity');
  }
  await uploadBackup(mine, password);
  return true;
};

function attemptRetry(): void {
  const job = retry;
  if (!job) return;
  job.tries += 1;
  void settle(job.userId, job.password).then(() => { if (retry === job) stopRetry(); }).catch((error) => {
    if (retry === job && ((error instanceof ApiError && (error.status === 403 || error.status === 409))
      || (error instanceof Error && (error.message === 'bad-passphrase' || error.message === 'Key backup differs from local identity'))
      || job.tries >= 120)) stopRetry();
  });
}

const queueRetry = (userId: string, password: string): void => {
  setPending(true);
  if (retry) { window.clearInterval(retry.timer); }
  retry = { userId, password, tries: 0, timer: window.setInterval(attemptRetry, 6000) };
  window.addEventListener('online', attemptRetry);
};

/** Upload now; on failure keep retrying in the background and flag it. Never throws. */
const uploadOrQueue = async (userId: string, password: string): Promise<'uploaded' | 'pending'> => {
  try { await settle(userId, password); stopRetry(); return 'uploaded'; } catch { queueRetry(userId, password); return 'pending'; }
};

/**
 * Creates the identity key if this browser has none and makes sure the server holds the password-wrapped copy
 * IMMEDIATELY: a fresh key travels to the server together with its backup in one request.
 * 'conflict' = the account already has an identity this browser cannot open (no usable copy).
 */
export const ensureKeyAndBackup = async (userId: string, password: string): Promise<'saved' | 'pending' | 'conflict' | 'manual' | 'offline'> => {
  try {
    const result = await initializeIdentity(userId, (payload) => wrapForServer(payload, password));
    if (result.created && result.backupSaved) return 'saved';
    const state = await uploadOrQueue(userId, password);
    return state === 'uploaded' ? 'saved' : 'pending';
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 409) return 'conflict';
    try {
      if (await hasLocalIdentity(userId)) { queueRetry(userId, password); return 'pending'; } // key exists locally; registration is retried by the app
    } catch { /* ignore */ }
    return 'offline';
  }
};

/**
 * Runs right after a successful PASSWORD login (the only moment the password is at hand).
 * Never throws: a failure here must not block login; it is retried in the background and at the next login.
 */
export const syncBackupAfterLogin = async (userId: string, password: string): Promise<LoginBackupResult> => {
  try {
    const remote = await fetchServerBackup();
    const local = await hasLocalIdentity(userId);
    if (!local) {
      if (!remote?.backup) {
        if (remote?.mode === 'manual') return 'needs-choice';
        // No key here and no server copy: either a brand-new account (e.g. registered over the API) or a lost key.
        // Try to create the first key now and store its backup in the same request; a 409 means "lost key".
        const made = await ensureKeyAndBackup(userId, password);
        if (made === 'conflict') return 'needs-choice';
        return made === 'saved' ? 'created' : made === 'pending' ? 'pending' : 'offline';
      }
      try {
        await importIdentity(await unwrapFromServer(remote.backup, password, userId));
        return 'restored';
      } catch { return 'needs-choice'; }
    }
    if (remote?.mode === 'manual') return 'manual';
    const mine = await exportLocalIdentity(userId);
    if (!mine) return 'unexportable'; // key created by an older version, stored non-extractable
    if (remote?.backup) {
      try {
        const stored = await unwrapFromServer(remote.backup, password, userId);
        if (samePublic(stored.publicKey, mine.publicKey)) return 'unchanged';
        return 'needs-choice';
      } catch { return 'needs-choice'; }
    }
    return await uploadOrQueue(userId, password);
  } catch { return 'offline'; }
};

/** New account (signup form or invite): make the identity now and store its password-wrapped copy before the app opens. */
export const setupBackupAfterSignup = async (userId: string, password: string): Promise<void> => {
  await ensureKeyAndBackup(userId, password);
};

/** Rewrap the same identity before atomically changing the login password and backup. */
export const changePasswordAndBackup = async (userId: string, currentPassword: string, newPassword: string, secondFactor?: string): Promise<void> => {
  const remote = await fetchServerBackup();
  let backup: Awaited<ReturnType<typeof wrapForServer>> | undefined;
  if (remote?.mode !== 'manual') {
    const local = await exportLocalIdentity(userId);
    let identity: BackupPayload | null = null;
    if (remote?.backup) {
      try { identity = await unwrapFromServer(remote.backup, currentPassword, userId); }
      catch { throw new Error('پشتیبان فعلی با رمز عبور کنونی باز نشد. ابتدا کلید این حساب را بازیابی کنید.'); }
      if (local && !samePublic(local.publicKey, identity.publicKey)) throw new Error('کلید این دستگاه با پشتیبان فعلی یکسان نیست. ابتدا کلید را بازیابی کنید.');
    } else {
      identity = local;
    }
    if (identity) backup = await wrapForServer(identity, newPassword);
  }
  stopRetry();
  await api.changePassword(currentPassword, newPassword, remote?.revision ?? 0, backup, secondFactor);
};
