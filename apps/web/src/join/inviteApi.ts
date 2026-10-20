import { ApiError } from '../api.js';

export type InviteStatus = 'active' | 'used' | 'expired';

export type InviteSummary = {
  id: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  status: InviteStatus;
};

type CreatedInvite = { id: string; token: string; path: string; expiresAt: string; maxUses: number };

type AcceptBody = { username: string; displayName: string; password: string };

// Same contract as api.ts request(), kept separate so a 401 here (e.g. non-admin probing)
// never triggers the app-wide "logged out" handler.
const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(body?.error ?? 'در ارتباط با سرور مشکلی پیش آمد.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
};

const enc = encodeURIComponent;

export const checkInvite = (token: string): Promise<{ valid: boolean }> => call(`/api/invites/${enc(token)}`);
export const acceptInvite = (token: string, body: AcceptBody): Promise<void> =>
  call(`/api/invites/${enc(token)}/accept`, { method: 'POST', body: JSON.stringify(body) });
export const listInvites = (): Promise<InviteSummary[]> => call('/api/invites');
export const createInvite = (maxUses: number): Promise<CreatedInvite> =>
  call('/api/invites', { method: 'POST', body: JSON.stringify({ maxUses }) });
export const deleteInvite = (id: string): Promise<void> => call(`/api/invites/${enc(id)}`, { method: 'DELETE' });
