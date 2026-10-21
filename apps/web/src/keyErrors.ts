// Is this error the server saying "the chat key version of your message is not the current one" (NS-07)?
// Standalone and duck-typed (an ApiError has `status` and the JSON body as `data`), so the outbox can use it without pulling in the API client.
export const isStaleKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const { status, data } = error as { status?: unknown; data?: unknown };
  if (typeof status !== 'number' || !data || typeof data !== 'object') return false;
  const body = data as Record<string, unknown>;
  // 400: the version sent is not the current one. 409: a reset left a new version to be created first. Group answers carry no pendingKeyVersion.
  if (status === 400) return typeof body.keyVersion === 'number' && 'pendingKeyVersion' in body;
  if (status === 409) return typeof body.pendingKeyVersion === 'number' && typeof body.keyVersion === 'number';
  return false;
};
