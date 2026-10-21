// Keep route names useful in logs without recording bearer tokens or query values.
export function safeRequestPath(url: string): string {
  let path: string;
  try {
    path = new URL(url, 'http://localhost').pathname;
  } catch {
    return '[invalid-url]';
  }

  if (/^\/api\/invites\/[^/]+\/accept(?:\/|$)/i.test(path)) return '/api/invites/[redacted]/accept';
  if (/^\/api\/invites\/[^/]+/i.test(path)) return '/api/invites/[redacted]';
  if (/^\/api\/channels\/join\/[^/]+/i.test(path)) return '/api/channels/join/[redacted]';
  if (/^\/join\/[^/]+/i.test(path)) return '/join/[redacted]';
  if (/^\/c\/[^/]+/i.test(path)) return '/c/[redacted]';
  return path;
}

// Fastify may also put a URL in an error message or stack (for example when a
// reply is sent twice), outside the normal `req` serializer.
export function safeLogText(value: string): string {
  return value.replace(/\/(?:api\/invites|api\/channels\/join|join|c)\/[A-Za-z0-9_%~.+\-/?=&]+/gi,
    (url) => safeRequestPath(url));
}

export function safeErrorSerializer(error: Error): { type: string; message: string; stack: string; [key: string]: unknown } {
  if (!(error instanceof Error)) {
    return { type: 'Error', message: safeLogText(String(error)), stack: '' };
  }
  const result: { type: string; message: string; stack: string; [key: string]: unknown } = {
    type: error.name,
    message: safeLogText(error.message),
    stack: safeLogText(error.stack ?? '')
  };
  for (const [key, value] of Object.entries(error)) {
    if (key === 'cause' && value instanceof Error) {
      result.cause = safeErrorSerializer(value);
    } else {
      result[key] = typeof value === 'string' ? safeLogText(value) : value;
    }
  }
  return result;
}

type LoggedRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
};

export const safeRequestSerializer = (request: LoggedRequest) => ({
  method: request.method,
  url: safeRequestPath(request.url ?? '/'),
  version: typeof request.headers?.['accept-version'] === 'string' ? request.headers['accept-version'] : undefined,
  host: request.host,
  remoteAddress: request.ip,
  remotePort: request.socket?.remotePort
});

export const safeLoggerOptions = {
  serializers: { req: safeRequestSerializer, err: safeErrorSerializer, error: safeErrorSerializer },
  hooks: {
    logMethod(args: unknown[], method: (...args: unknown[]) => unknown): unknown {
      return method.apply(this, args.map((arg) => typeof arg === 'string' ? safeLogText(arg) : arg));
    }
  }
};
