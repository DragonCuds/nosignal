import { ApiError } from '../api.js';

export type GroupRole = 'owner' | 'admin' | 'member';
export type GroupMember = { id: string; username: string; displayName: string; role: GroupRole; publicKey: JsonWebKey | null };
export type GroupDetail = {
  id: string; chatId: string; title: string; avatarPath: string | null; role: GroupRole;
  memberCount: number; keyVersion: number; pendingKeyVersion: number | null; members: GroupMember[];
};
/** `wrapper*` is the wrapper's public key as it was when the envelope was wrapped (null for rows from before NS-07b). Untrusted: see e2ee.ts. */
export type GroupKeyEntry = { version: number; wrapped: string; wrappedBy: string; wrapperFingerprint?: string | null; wrapperPublicKey?: JsonWebKey | null };

// Own fetch wrapper (same idea as channelsApi): errors carry the server message.
const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'include', headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  } catch { throw new ApiError('اتصال به سرور قطع شد.', 0); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(body?.error ?? 'در ارتباط با سرور مشکلی پیش آمد.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
};

const enc = encodeURIComponent;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const groupsApi = {
  create: (title: string, memberIds: string[]) => call<{ id: string; chatId: string }>('/api/groups', json('POST', { title, memberIds })),
  get: (id: string) => call<GroupDetail>(`/api/groups/${enc(id)}`),
  rename: (id: string, title: string) => call<void>(`/api/groups/${enc(id)}`, json('PATCH', { title })),
  remove: (id: string) => call<void>(`/api/groups/${enc(id)}`, json('DELETE')),
  leave: (id: string) => call<void>(`/api/groups/${enc(id)}/leave`, json('POST')),
  addMember: (id: string, userId: string) => call<void>(`/api/groups/${enc(id)}/members`, json('POST', { userId })),
  removeMember: (id: string, userId: string) => call<void>(`/api/groups/${enc(id)}/members/${enc(userId)}`, json('DELETE')),
  makeAdmin: (id: string, userId: string) => call<void>(`/api/groups/${enc(id)}/admins/${enc(userId)}`, json('POST')),
  removeAdmin: (id: string, userId: string) => call<void>(`/api/groups/${enc(id)}/admins/${enc(userId)}`, json('DELETE')),
  transfer: (id: string, userId: string) => call<void>(`/api/groups/${enc(id)}/owner/${enc(userId)}`, json('POST')),
  keys: (id: string, version: number | 'latest') => call<GroupKeyEntry[]>(`/api/groups/${enc(id)}/keys?version=${version}`),
  putKeys: (id: string, version: number, expectedMembers: Array<{ userId: string; fingerprint: string }>, envelopes: Array<{ userId: string; wrapped: string }>) => call<void>(`/api/groups/${enc(id)}/keys`, json('PUT', { version, expectedMembers, envelopes })),
};
