// "Remind me later" bookkeeping for the backup warning (max 3 postpones).
export const MAX_POSTPONES = 3;
const k = (userId: string, what: string) => `tel:backup:${what}:${userId}`;
const get = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const set = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* ignore */ } };

export const markBackedUp = (userId: string) => set(k(userId, 'done'), '1');
export const postponesUsed = (userId: string): number => Number(get(k(userId, 'later')) ?? 0) || 0;
export const postpone = (userId: string) => set(k(userId, 'later'), String(postponesUsed(userId) + 1));
export const canPostpone = (userId: string): boolean => postponesUsed(userId) < MAX_POSTPONES;
/** True when the strong warning should be shown (not backed up yet). */
export const needsWarning = (userId: string): boolean => get(k(userId, 'done')) !== '1';
