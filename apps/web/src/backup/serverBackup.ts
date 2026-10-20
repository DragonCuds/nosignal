// Automatic key backup (default "Auto" mode): the identity key is wrapped in the browser with a key
// derived from the login password and stored on the server; a new browser gets it back at login.
import { api, ApiError } from '../api.js';
import { exportLocalIdentity, hasLocalIdentity, importIdentity, initializeEncryption } from '../e2ee.js';
import { unwrapFromServer, wrapForServer, type BackupPayload } from './crypto.js';

export type ServerBackupState = Awaited<ReturnType<typeof api.cryptoBackup>> | null;
export type LoginBackupResult = 'restored' | 'uploaded' | 'unchanged' | 'manual' | 'needs-choice' | 'unexportable' | 'offline';

/** null = this account never stored anything on the server. */
export const fetchServerBackup = async (): Promise<ServerBackupState> => {
  try { return await api.cryptoBackup(); } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  }
};

const samePublic = (a: JsonWebKey, b: JsonWebKey) => a.x === b.x && a.y === b.y;

export const uploadBackup = async (payload: BackupPayload, password: string): Promise<void> => {
  await api.putCryptoBackup(await wrapForServer(payload, password));
};

/**
 * Runs right after a successful PASSWORD login (the only moment the password is at hand).
 * Never throws: a failure here must not block login; the next login retries.
 */
export const syncBackupAfterLogin = async (userId: string, password: string): Promise<LoginBackupResult> => {
  try {
    const remote = await fetchServerBackup();
    const local = await hasLocalIdentity(userId);
    if (!local) {
      if (!remote?.backup) return 'needs-choice';
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
      } catch { /* password changed or stale copy: wrap again below */ }
    }
    await uploadBackup(mine, password);
    return 'uploaded';
  } catch { return 'offline'; }
};

/** New account: make the identity now (the messenger would do it a moment later anyway) and back it up. */
export const setupBackupAfterSignup = async (userId: string, password: string): Promise<void> => {
  try {
    await initializeEncryption(userId);
    const mine = await exportLocalIdentity(userId);
    if (mine) await uploadBackup(mine, password);
  } catch { /* retried at the next password login */ }
};
