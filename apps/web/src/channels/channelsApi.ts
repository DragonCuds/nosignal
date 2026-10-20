import { ApiError } from '../api.js';

export type ChannelRole = 'owner' | 'admin' | 'member';
export type ChannelMember = { id: string; username: string; displayName: string; role: ChannelRole };
export type ChannelDetail = {
  id: string; title: string; avatarPath: string | null; role: ChannelRole; memberCount: number;
  members?: ChannelMember[];
  invites?: Array<{ id: string; createdAt: string }>;
};

// Own fetch wrapper: a 401 here (e.g. a guest opening a /c/ link) must not trigger the app-wide logout handler.
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

export const channelsApi = {
  create: (title: string) => call<{ id: string; chatId: string }>('/api/channels', json('POST', { title })),
  get: (id: string) => call<ChannelDetail>(`/api/channels/${enc(id)}`),
  rename: (id: string, title: string) => call<void>(`/api/channels/${enc(id)}`, json('PATCH', { title })),
  remove: (id: string) => call<void>(`/api/channels/${enc(id)}`, json('DELETE')),
  createInvite: (id: string) => call<{ id: string; token: string }>(`/api/channels/${enc(id)}/invites`, json('POST')),
  revokeInvite: (id: string, invId: string) => call<void>(`/api/channels/${enc(id)}/invites/${enc(invId)}`, json('DELETE')),
  preview: (token: string) => call<{ title: string; memberCount: number }>(`/api/channels/join/${enc(token)}`),
  join: (token: string) => call<{ id: string; chatId: string }>(`/api/channels/join/${enc(token)}`, json('POST')),
  leave: (id: string) => call<void>(`/api/channels/${enc(id)}/leave`, json('POST')),
  makeAdmin: (id: string, userId: string) => call<void>(`/api/channels/${enc(id)}/admins/${enc(userId)}`, json('POST')),
  removeAdmin: (id: string, userId: string) => call<void>(`/api/channels/${enc(id)}/admins/${enc(userId)}`, json('DELETE')),
  removeMember: (id: string, userId: string) => call<void>(`/api/channels/${enc(id)}/members/${enc(userId)}`, json('DELETE')),
};

export const inviteLink = (token: string): string => `${window.location.origin}/c/${token}`;

/** Returns the channel invite token for `/c/:token` paths, otherwise null. */
export const channelTokenFromPath = (pathname: string): string | null => {
  const match = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return match ? match[1] : null;
};
