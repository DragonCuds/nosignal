// Contact key pins (trust on first use) as a HISTORY of accepted fingerprints (NS-07).
// Standalone (no app imports) so it can be tested under node.
//
// A pin used to be one fingerprint. It is now a list: every fingerprint this browser accepted for the contact, oldest
// first, the LAST entry being the current one. Only the current fingerprint counts for encrypting and for checking who
// the contact is today (the key-change warning is unchanged). Older entries only let this browser open chat keys that
// the contact wrapped with a key it had already accepted before the contact started fresh.
export type PinList = string[];

const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Reads what IndexedDB holds: a legacy single fingerprint becomes a one-entry list; anything unusable becomes empty. */
export const normalizePins = (stored: unknown): PinList => {
  if (valid(stored)) return [stored];
  if (!Array.isArray(stored)) return [];
  const list: string[] = [];
  for (const item of stored) if (valid(item) && !list.includes(item)) list.push(item);
  return list;
};

/** True when the stored value is in the old single-value form and should be rewritten as a list. */
export const isLegacyPin = (stored: unknown): boolean => valid(stored);

export const currentPin = (list: PinList): string | undefined => list[list.length - 1];

/** The user accepted `fingerprint` as the contact's key: it becomes the current pin, the old ones stay in the history. */
export const acceptPin = (list: PinList, fingerprint: string): PinList => [...list.filter((item) => item !== fingerprint), fingerprint];

/** Was this fingerprint ever accepted for the contact? A fingerprint that never was is not trusted, not even to open old data. */
export const wasPinned = (list: PinList, fingerprint: string): boolean => list.includes(fingerprint);

// ---- Pin history inside the key backup (NS-07, S9b) ----------------------------------------------------------------------
// A restored browser starts with no pins, so envelopes a contact wrapped with an earlier identity (which this user had
// accepted) would stay locked. The backup therefore carries the pin history, contact by contact. It is data that comes back
// from a file or from the server, so everything read from it is checked here before it is allowed to touch a pin.
export type BackupPins = Record<string, string[]>;

/** Longest history kept per contact, in a backup and after a restore. The newest entries win; the current pin is the last. */
export const MAX_PINS_PER_CONTACT = 32;
/** Most contacts read from one backup. */
export const MAX_BACKUP_CONTACTS = 2_000;
/** Size budget (serialized JSON, bytes) for the pins of one backup. The server accepts a wrapped backup of up to 32 KiB. */
export const BACKUP_PINS_BUDGET = 16_000;

/** A fingerprint is the SHA-256 of the public key as 64 lowercase hex characters (dmKeys.fingerprintOf). */
export const isFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const isContactId = (value: string): boolean => /^[A-Za-z0-9_-]{1,64}$/u.test(value) && value !== '__proto__';

/**
 * The `pins` field of a backup, validated. A contact whose list is not an array, is empty, is longer than 32 or holds anything
 * but a fingerprint is skipped as a whole (never repaired), so a damaged entry cannot half-apply. Duplicates inside a list
 * keep their last position.
 */
export const readBackupPins = (value: unknown): Array<[string, PinList]> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const result: Array<[string, PinList]> = [];
  for (const [contactId, list] of Object.entries(value)) {
    if (result.length >= MAX_BACKUP_CONTACTS) break;
    if (!isContactId(contactId) || !Array.isArray(list) || list.length === 0 || list.length > MAX_PINS_PER_CONTACT || !list.every(isFingerprint)) continue;
    result.push([contactId, list.reduce<PinList>((kept, item) => acceptPin(kept, item), [])]);
  }
  return result;
};

/**
 * Merge a contact's pin history from a backup into what this browser already holds.
 * - This browser has a pin: its current pin stays the last entry; backup entries it does not know go in front of its own.
 * - This browser has none: the backup order is kept (its last entry becomes the current pin).
 * The result never exceeds 32 entries (oldest dropped).
 */
export const mergePins = (local: PinList, fromBackup: PinList): PinList => {
  const merged = local.length === 0 ? [...fromBackup] : [...fromBackup.filter((item) => !local.includes(item)), ...local];
  return merged.slice(-MAX_PINS_PER_CONTACT);
};

const entrySize = (contactId: string, list: PinList): number => contactId.length + 6 + list.length * 67;

/**
 * Pins to put into a backup, from what this browser holds (contact id -> list). Unusable entries are left out; each list keeps
 * its newest 32 entries. If everything does not fit the size budget, contacts with a longer history go first (those are the
 * ones whose envelopes would stay locked), then the rest in the order given. Returns undefined when nothing is to be saved.
 */
export const pinsForBackup = (entries: ReadonlyArray<readonly [string, PinList]>, budget = BACKUP_PINS_BUDGET): BackupPins | undefined => {
  const usable: Array<[string, PinList]> = [];
  for (const [contactId, list] of entries) {
    const kept = list.filter(isFingerprint).slice(-MAX_PINS_PER_CONTACT);
    if (isContactId(contactId) && kept.length > 0) usable.push([contactId, kept]);
  }
  usable.sort((a, b) => Number(b[1].length > 1) - Number(a[1].length > 1));
  const chosen: Array<[string, PinList]> = [];
  let used = 2;
  for (const [contactId, list] of usable) {
    if (chosen.length >= MAX_BACKUP_CONTACTS) break;
    const size = entrySize(contactId, list);
    if (used + size > budget) continue;
    used += size;
    chosen.push([contactId, list]);
  }
  return chosen.length === 0 ? undefined : Object.fromEntries(chosen);
};
