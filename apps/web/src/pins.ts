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
