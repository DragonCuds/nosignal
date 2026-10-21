// Automatic key backup (default "Auto" mode): the identity key is wrapped in the browser with a key
// derived from the login password and stored on the server; a new browser gets it back at login.
import { api, ApiError } from '../api.js';
import { exportLocalIdentity, hasLocalIdentity, importIdentity, initializeIdentity } from '../e2ee.js';
import { unwrapFromServer, wrapForServer, type BackupPayload } from './crypto.js';

export type ServerBackupState = Awaited<ReturnType<typeof api.cryptoBackup>> | null;
export type LoginBackupResult = 'restored' | 'created' | 'uploaded' | 'pending' | 'unchanged' | 'manual' | 'needs-choice' | 'unexportable' | 'offline';

/** null = this account never stored anything on the server. */
export const fetchServerBackup = async (signal?: AbortSignal): Promise<ServerBackupState> => {
  try { return await api.cryptoBackup(signal); } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  }
};

const samePublic = (a: JsonWebKey, b: JsonWebKey) => a.x === b.x && a.y === b.y;

type BackupScope = { userId: string; epoch: number; signal: AbortSignal };
let activeUserId: string | null = null;
let epoch = 0;
let controller = new AbortController();
const scopeFor = (userId: string): BackupScope => ({ userId, epoch, signal: controller.signal });
const isCurrent = (scope: BackupScope): boolean => activeUserId === scope.userId && epoch === scope.epoch && !scope.signal.aborted;
const requireCurrent = (scope: BackupScope): void => { if (!isCurrent(scope)) throw new Error('Backup session changed'); };

export const uploadBackup = async (payload: BackupPayload, password: string, actionToken?: string, scope = scopeFor(payload.userId)): Promise<void> => {
  requireCurrent(scope);
  const remote = await fetchServerBackup(scope.signal);
  requireCurrent(scope);
  const blob = await wrapForServer(payload, password);
  requireCurrent(scope);
  await api.putCryptoBackup(scope.userId, blob, password, remote?.revision ?? 0, actionToken, scope.signal);
  requireCurrent(scope);
};

// ---- "Not saved yet" tracking ------------------------------------------------------------------------
// When the first upload fails (offline, server hiccup) the wrapped key is retried in the background while this
// page lives (the password stays in memory only), and the UI shows a warning until the server holds a copy.
let pending = false;
let retry: { scope: BackupScope; password: string; timer: number; tries: number; busy: boolean } | null = null;
const listeners = new Set<() => void>();
const setPending = (value: boolean) => { if (pending !== value) { pending = value; listeners.forEach((fn) => fn()); } };
export const isBackupPending = (): boolean => pending;
export const subscribeBackupPending = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const stopRetry = () => {
  if (retry) { window.clearInterval(retry.timer); retry = null; }
  window.removeEventListener('online', attemptRetry);
  setPending(false);
};

/** A new authenticated session invalidates work and credentials from the previous one. */
export const setBackupAccount = (userId: string): void => {
  if (activeUserId === userId) return;
  controller.abort();
  controller = new AbortController();
  epoch += 1;
  activeUserId = userId;
  stopRetry();
};

export const clearBackupAccount = (): void => {
  controller.abort();
  controller = new AbortController();
  epoch += 1;
  activeUserId = null;
  stopRetry();
};

/** True when the server now holds a usable copy (or the account deliberately opted out). */
const settle = async (scope: BackupScope, password: string): Promise<boolean> => {
  requireCurrent(scope);
  const remote = await fetchServerBackup(scope.signal);
  requireCurrent(scope);
  if (remote?.mode === 'manual') return true;
  const mine = await exportLocalIdentity(scope.userId);
  requireCurrent(scope);
  if (!mine) return true; // nothing exportable (old non-extractable key)
  if (remote?.backup) {
    const stored = await unwrapFromServer(remote.backup, password, scope.userId);
    requireCurrent(scope);
    if (samePublic(stored.publicKey, mine.publicKey)) return true;
    throw new Error('Key backup differs from local identity');
  }
  await uploadBackup(mine, password, undefined, scope);
  return true;
};

function attemptRetry(): void {
  const job = retry;
  if (!job || job.busy || !isCurrent(job.scope)) return;
  job.busy = true;
  job.tries += 1;
  void settle(job.scope, job.password).then(() => { if (retry === job) stopRetry(); }).catch((error) => {
    if (retry === job && ((error instanceof ApiError && (error.status === 403 || error.status === 409))
      || (error instanceof Error && (error.message === 'bad-passphrase' || error.message === 'Key backup differs from local identity'))
      || job.tries >= 120)) stopRetry();
  }).finally(() => { job.busy = false; });
}

const queueRetry = (scope: BackupScope, password: string): void => {
  if (!isCurrent(scope)) return;
  setPending(true);
  if (retry) { window.clearInterval(retry.timer); }
  retry = { scope, password, tries: 0, busy: false, timer: window.setInterval(attemptRetry, 6000) };
  window.addEventListener('online', attemptRetry);
};

/** Upload now; on failure keep retrying in the background and flag it. Never throws. */
const uploadOrQueue = async (scope: BackupScope, password: string): Promise<'uploaded' | 'pending'> => {
  try { await settle(scope, password); if (isCurrent(scope)) stopRetry(); return 'uploaded'; }
  catch { queueRetry(scope, password); return 'pending'; }
};

/**
 * Creates the identity key if this browser has none and makes sure the server holds the password-wrapped copy
 * IMMEDIATELY: a fresh key travels to the server together with its backup in one request.
 * 'conflict' = the account already has an identity this browser cannot open (no usable copy).
 */
export const ensureKeyAndBackup = async (userId: string, password: string): Promise<'saved' | 'pending' | 'conflict' | 'manual' | 'offline'> => {
  const scope = scopeFor(userId);
  try {
    requireCurrent(scope);
    const result = await initializeIdentity(userId, (payload) => wrapForServer(payload, password), () => requireCurrent(scope), scope.signal);
    requireCurrent(scope);
    if (result.created && result.backupSaved) return 'saved';
    const state = await uploadOrQueue(scope, password);
    return state === 'uploaded' ? 'saved' : 'pending';
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 409) return 'conflict';
    try {
      if (isCurrent(scope) && await hasLocalIdentity(userId)) { queueRetry(scope, password); return 'pending'; } // key exists locally; registration is retried by the app
    } catch { /* ignore */ }
    return 'offline';
  }
};

/**
 * Runs right after a successful PASSWORD login (the only moment the password is at hand).
 * Never throws: a failure here must not block login; it is retried in the background and at the next login.
 */
export const syncBackupAfterLogin = async (userId: string, password: string): Promise<LoginBackupResult> => {
  const scope = scopeFor(userId);
  try {
    requireCurrent(scope);
    const remote = await fetchServerBackup(scope.signal);
    requireCurrent(scope);
    const local = await hasLocalIdentity(userId);
    requireCurrent(scope);
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
        const restored = await unwrapFromServer(remote.backup, password, userId);
        requireCurrent(scope);
        await importIdentity(restored, () => requireCurrent(scope), scope.signal);
        requireCurrent(scope);
        return 'restored';
      } catch { return 'needs-choice'; }
    }
    if (remote?.mode === 'manual') return 'manual';
    const mine = await exportLocalIdentity(userId);
    requireCurrent(scope);
    if (!mine) return 'unexportable'; // key created by an older version, stored non-extractable
    if (remote?.backup) {
      try {
        const stored = await unwrapFromServer(remote.backup, password, userId);
        requireCurrent(scope);
        if (samePublic(stored.publicKey, mine.publicKey)) return 'unchanged';
        return 'needs-choice';
      } catch { return 'needs-choice'; }
    }
    return await uploadOrQueue(scope, password);
  } catch { return 'offline'; }
};

/** New account (signup form or invite): make the identity now and store its password-wrapped copy before the app opens. */
export const setupBackupAfterSignup = async (userId: string, password: string): Promise<void> => {
  await ensureKeyAndBackup(userId, password);
};

/** Rewrap the same identity before atomically changing the login password and backup. */
export const changePasswordAndBackup = async (userId: string, currentPassword: string, newPassword: string, secondFactor?: string): Promise<void> => {
  const scope = scopeFor(userId);
  requireCurrent(scope);
  const remote = await fetchServerBackup(scope.signal);
  requireCurrent(scope);
  let backup: Awaited<ReturnType<typeof wrapForServer>> | undefined;
  if (remote?.mode !== 'manual') {
    const local = await exportLocalIdentity(userId);
    requireCurrent(scope);
    let identity: BackupPayload | null = null;
    if (remote?.backup) {
      try { identity = await unwrapFromServer(remote.backup, currentPassword, userId); }
      catch { throw new Error('پشتیبان فعلی با رمز عبور کنونی باز نشد. ابتدا کلید این حساب را بازیابی کنید.'); }
      requireCurrent(scope);
      if (local && !samePublic(local.publicKey, identity.publicKey)) throw new Error('کلید این دستگاه با پشتیبان فعلی یکسان نیست. ابتدا کلید را بازیابی کنید.');
    } else {
      identity = local;
    }
    if (identity) backup = await wrapForServer(identity, newPassword);
    requireCurrent(scope);
  }
  stopRetry();
  requireCurrent(scope);
  await api.changePassword(userId, currentPassword, newPassword, remote?.revision ?? 0, backup, secondFactor, scope.signal);
};
