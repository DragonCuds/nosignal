import type { RealtimeClientEvent, RealtimeServerEvent } from '@tel-messenger/media-contract';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';
import { currentTokenHash, getSessionUserForToken, isSessionTokenHashValid, isTrustedOrigin, onSessionsRevoked, tokenHash as hashToken, type SessionRevocation } from './auth.js';

const SESSION_COOKIE = 'tel_session';
const HEARTBEAT_MS = 25_000;
const MAX_CLIENT_EVENTS_PER_WINDOW = 20;
const CLIENT_EVENT_WINDOW_MS = 10_000;
const WS_AUTH_TIMEOUT_MS = 5_000;
const WS_MAX_PENDING = 64;
const WS_MAX_PENDING_PER_IP = 8;
const WS_MAX_CONNECTIONS_PER_IP = 32;
const WS_MAX_CONNECTIONS_PER_USER = 12;
const WS_MAX_CONNECTIONS_PER_SESSION = 6;
const WS_MAX_CONNECTIONS = 512;
const WS_MAX_BUFFERED = 1024 * 1024;

const SSE_KEEPALIVE_MS = 15_000;
const SSE_MAX_BUFFERED = 1024 * 1024;

// One connected client, over WebSocket or SSE. `send` never throws.
// `tokenHash` identifies the session the connection was authenticated with; `close` ends it (WS code 4401 / SSE end).
type SocketState = { socket?: WebSocket; userId: string; tokenHash: string | null; ip?: string; alive: boolean; events: number[]; send(event: RealtimeServerEvent): void; close(): void; live(): boolean };
type RealtimeService = {
  broadcastToChat(chatId: string, event: RealtimeServerEvent): void;
  /** Close live connections of revoked sessions: one session (tokenHash) or all of userId except exceptTokenHash. */
  closeSessionConnections(revocation: SessionRevocation): number;
  /** Push an event to every live connection of these users (no chat-membership check). */
  sendToUsers(userIds: string[], event: RealtimeServerEvent): void;
};

/** Tell users a chat appeared for them. Safe when realtime is not registered (tests). */
export const notifyChatNew = (app: FastifyInstance, userIds: string[], chatId: string): void => {
  (app.realtime as Partial<RealtimeService> | undefined)?.sendToUsers?.(userIds, { type: 'chat.new', chatId });
};
export const WS_CLOSE_SESSION_REVOKED = 4401;

declare module 'fastify' {
  interface FastifyInstance { realtime: RealtimeService }
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
export const send = (socket: WebSocket, event: RealtimeServerEvent): void => {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    const payload = JSON.stringify(event);
    if (socket.bufferedAmount + Buffer.byteLength(payload) > WS_MAX_BUFFERED) {
      socket.terminate();
      return;
    }
    socket.send(payload, (error) => { if (error) socket.terminate(); });
  } catch {
    socket.terminate();
  }
};
const isPing = (event: unknown): event is { type: 'ping'; t: number } =>
  typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'ping' && typeof (event as { t?: unknown }).t === 'number' && Number.isFinite((event as { t: number }).t);

const parseClientEvent = (data: WebSocket.RawData): RealtimeClientEvent | { type: 'ping'; t: number } | null => {
  try {
    const event: unknown = JSON.parse(data.toString());
    if (isPing(event)) return { type: 'ping', t: event.t };
    if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'typing' && validId((event as { chatId?: unknown }).chatId) && ((event as { isTyping?: unknown }).isTyping === undefined || typeof (event as { isTyping?: unknown }).isTyping === 'boolean')) return event as RealtimeClientEvent;
  } catch { /* Ignore malformed client messages. */ }
  return null;
};

const isChatMember = async (chatId: string, userId: string): Promise<boolean> =>
  (await db.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])).rowCount === 1;

// Creating a direct chat or adding someone to a group is unilateral. A recipient may see
// the sender's presence only after the sender has actually messaged that recipient in a
// current, two-person direct chat. Group/channel membership grants no presence access.
const presenceAudience = async (userId: string): Promise<Set<string>> => {
  const result = await db.query<{ user_id: string }>(
    `SELECT DISTINCT recipient.user_id
     FROM chat_members sender
     JOIN chat_members recipient ON recipient.chat_id = sender.chat_id AND recipient.user_id <> sender.user_id
     JOIN chats c ON c.id = sender.chat_id AND c.type = 'direct'
     WHERE sender.user_id = $1
       AND (SELECT count(*) FROM chat_members WHERE chat_id = c.id) = 2
       AND NOT EXISTS (SELECT 1 FROM saved_chats WHERE chat_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM groups WHERE chat_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM channels WHERE chat_id = c.id)
       AND EXISTS (
         SELECT 1 FROM messages m
         WHERE m.chat_id = c.id AND m.sender_id = sender.user_id AND m.deleted_at IS NULL
       )`,
    [userId]
  );
  return new Set(result.rows.map((row) => row.user_id));
};

export const registerRealtime = async (app: FastifyInstance): Promise<void> => {
  // Bound the HTTP header phase too; the upgrade listener runs only after headers arrive.
  app.server.headersTimeout = Math.min(app.server.headersTimeout, 10_000);
  const sockets = new Set<SocketState>();
  const pending = new Set<import('node:stream').Duplex>();
  const pendingByIp = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  // The installer overwrites X-Real-IP at the loopback proxy. A public or
  // non-loopback peer can never choose the address used for the per-IP limit.
  const peerIp = (request: IncomingMessage): string => {
    const remote = request.socket.remoteAddress ?? 'unknown';
    const real = request.headers['x-real-ip'];
    if (config.isProduction && config.tlsMode === 'off' &&
        (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
      if (typeof real === 'string' && isIP(real)) return real;
    }
    return remote;
  };
  const onlineElsewhere = (userId: string): boolean => [...sockets].some((state) => state.userId === userId);
  const broadcastPresence = async (userId: string, online: boolean, lastSeen: string | null): Promise<void> => {
    const audience = await presenceAudience(userId);
    // An earlier query may finish after a newer connect/disconnect transition.
    if (onlineElsewhere(userId) !== online) return;
    const event: RealtimeServerEvent = { type: 'presence', userId, online, lastSeen };
    for (const state of sockets) if (audience.has(state.userId)) state.send(event);
  };
  const connect = (state: SocketState): void => {
    const becameOnline = !onlineElsewhere(state.userId);
    sockets.add(state);
    if (becameOnline) void broadcastPresence(state.userId, true, null).catch((error: unknown) => app.log.error(error, 'Failed to deliver presence'));
  };
  // One connection budget for BOTH transports (WebSocket and SSE): global, per IP, per user, per session.
  const overConnectionLimit = (ip: string, userId: string, tokenHash: string | null): boolean => {
    const active = [...sockets].filter((state) => state.live());
    return active.length >= WS_MAX_CONNECTIONS ||
      active.filter((state) => state.ip === ip).length >= WS_MAX_CONNECTIONS_PER_IP ||
      active.filter((state) => state.userId === userId).length >= WS_MAX_CONNECTIONS_PER_USER ||
      (tokenHash !== null && active.filter((state) => state.tokenHash === tokenHash).length >= WS_MAX_CONNECTIONS_PER_SESSION);
  };
  const disconnect = (state: SocketState): void => {
    if (!sockets.delete(state)) return;
    if (!onlineElsewhere(state.userId)) void broadcastPresence(state.userId, false, new Date().toISOString()).catch((error: unknown) => app.log.error(error, 'Failed to deliver presence'));
  };
  // Shared by WS typing frames and POST /api/typing. Returns false when the client is over its limit.
  const allowEvent = (state: Pick<SocketState, 'events'>): boolean => {
    const now = Date.now();
    state.events = state.events.filter((time) => time > now - CLIENT_EVENT_WINDOW_MS);
    if (state.events.length >= MAX_CLIENT_EVENTS_PER_WINDOW) return false;
    state.events.push(now);
    return true;
  };
  const typingWindows = new Map<string, { events: number[] }>();
  const typingCleanup = setInterval(() => {
    const cutoff = Date.now() - CLIENT_EVENT_WINDOW_MS;
    for (const [id, w] of typingWindows) if (!w.events.some((t) => t > cutoff)) typingWindows.delete(id);
  }, 60_000);
  typingCleanup.unref();
  const emitTyping = (userId: string, chatId: string, isTyping: boolean): void => {
    void isChatMember(chatId, userId).then((member) => {
      if (member) app.realtime.broadcastToChat(chatId, { type: 'typing', chatId, userId, isTyping });
    }).catch((error: unknown) => app.log.error(error, 'Failed to process realtime event'));
  };

  const closeSessionConnections = ({ userId, tokenHash, exceptTokenHash }: SessionRevocation): number => {
    let closed = 0;
    for (const state of [...sockets]) {
      const match = tokenHash ? state.tokenHash === tokenHash : userId !== undefined && state.userId === userId && (!exceptTokenHash || state.tokenHash !== exceptTokenHash);
      if (!match) continue;
      state.close();
      disconnect(state);
      closed += 1;
    }
    return closed;
  };
  onSessionsRevoked((revocation) => { closeSessionConnections(revocation); });

  app.decorate('realtime', {
    broadcastToChat(chatId, event) {
      if (!sockets.size) return;
      void db.query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]).then((result) => {
        const members = new Set(result.rows.map((row) => row.user_id));
        for (const state of sockets) if (members.has(state.userId)) state.send(event);
      }).catch((error: unknown) => app.log.error(error, 'Failed to deliver realtime event'));
    },
    closeSessionConnections,
    sendToUsers(userIds, event) {
      const wanted = new Set(userIds);
      for (const state of sockets) if (wanted.has(state.userId)) state.send(event);
    }
  });

  wss.on('connection', (socket: WebSocket, _request: IncomingMessage, userId: string, tokenHash: string, ip: string) => {
    const state: SocketState = { socket, userId, tokenHash, ip, alive: true, events: [], send: (event) => send(socket, event), close: () => socket.close(WS_CLOSE_SESSION_REVOKED, 'session revoked'), live: () => socket.readyState !== WebSocket.CLOSED };
    connect(state);
    socket.on('pong', () => { state.alive = true; });
    socket.on('message', (data: WebSocket.RawData) => {
      if (!allowEvent(state)) return;
      const event = parseClientEvent(data);
      if (!event) return;
      if (event.type === 'ping') { send(socket, { type: 'pong', t: event.t }); return; }
      emitTyping(userId, event.chatId, event.isTyping ?? true);
    });
    socket.on('close', () => disconnect(state));
    socket.on('error', (error: Error) => app.log.debug(error, 'WebSocket error'));
  });

  // SSE fallback (C3): same events as the WS, typing goes up via POST /api/typing.
  app.get('/api/events', { preHandler: app.requireUser }, (request, reply) => {
    // EventSource on the same origin sends no Origin header; if one is present it must be trusted (like the WS upgrade).
    if (request.headers.origin !== undefined && !isTrustedOrigin(request.headers.origin)) {
      void reply.code(403).send({ error: 'Untrusted request origin' });
      return;
    }
    const raw = reply.raw;
    const userId = request.user!.id;
    const ip = peerIp(request.raw);
    const sessionHash = currentTokenHash(request);
    // Same caps as the WebSocket, checked before any stream header is written. The check and connect() below
    // run in one synchronous turn, so concurrent opens cannot all slip under the cap.
    if (overConnectionLimit(ip, userId, sessionHash)) {
      void reply.code(503).header('Retry-After', '30').send({ error: 'Too many realtime connections' });
      return;
    }
    // hijack() skips Fastify's own writer, so carry over the headers helmet already set.
    reply.hijack();
    raw.socket?.setTimeout(0);
    raw.socket?.setNoDelay(true);
    raw.socket?.setKeepAlive(true, 30_000);
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) raw.setHeader(name, value);
    raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    raw.setHeader('cache-control', 'no-cache, no-transform');
    raw.setHeader('x-accel-buffering', 'no');
    raw.setHeader('connection', 'keep-alive');
    raw.writeHead(200);
    raw.flushHeaders();
    const write = (chunk: string): void => {
      if (raw.destroyed || raw.writableEnded) return;
      if (raw.writableLength > SSE_MAX_BUFFERED) { raw.destroy(); return; }
      raw.write(chunk);
    };
    const state: SocketState = { userId, tokenHash: sessionHash, ip, alive: true, events: [], send: (event) => write(`data: ${JSON.stringify(event)}\n\n`), close: () => { if (!raw.destroyed && !raw.writableEnded) raw.end(); }, live: () => !raw.destroyed && !raw.writableEnded };
    const keepalive = setInterval(() => write(': keepalive\n\n'), SSE_KEEPALIVE_MS);
    keepalive.unref();
    const cleanup = (): void => { clearInterval(keepalive); disconnect(state); };
    raw.on('close', cleanup);
    raw.on('error', (error: Error) => app.log.debug(error, 'SSE error'));
    state.send({ type: 'hello' });
    connect(state);
  });

  app.post<{ Body: { chatId?: unknown; isTyping?: unknown } }>('/api/typing', { preHandler: app.requireUser, config: { rateLimit: { max: 60, timeWindow: '10 seconds' } } }, async (request, reply) => {
    const { chatId, isTyping } = request.body ?? {};
    if (!validId(chatId) || (isTyping !== undefined && typeof isTyping !== 'boolean')) return reply.code(400).send({ error: 'Invalid typing event' });
    const userId = request.user!.id;
    let window = typingWindows.get(userId);
    if (!window) typingWindows.set(userId, window = { events: [] });
    if (allowEvent(window)) emitTyping(userId, chatId, isTyping ?? true);
    return reply.code(204).send();
  });

  // Fallback for revocations without a hook (expiry, idle cleanup, account deletion): re-verify open sessions.
  const reverify = async (): Promise<void> => {
    const hashes = new Set<string>();
    for (const state of sockets) if (state.tokenHash) hashes.add(state.tokenHash);
    for (const hash of hashes) {
      if (!(await isSessionTokenHashValid(hash))) closeSessionConnections({ tokenHash: hash });
    }
  };
  const heartbeat = setInterval(() => {
    void reverify().catch((error: unknown) => app.log.error(error, 'Realtime session re-verification failed'));
    for (const state of sockets) {
      if (!state.socket) continue;
      if (!state.alive) state.socket.terminate();
      else { state.alive = false; state.socket.ping(); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  app.server.on('upgrade', (request, socket, head) => {
    const reject = (status: string): void => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') { reject('404 Not Found'); return; }
      if (!isTrustedOrigin(request.headers.origin)) { reject('403 Forbidden'); return; }
      const ip = peerIp(request);
      if (pending.size >= WS_MAX_PENDING || (pendingByIp.get(ip) ?? 0) >= WS_MAX_PENDING_PER_IP) { reject('503 Service Unavailable'); return; }
      const token = app.parseCookie(request.headers.cookie ?? '')[SESSION_COOKIE];
      if (!token) { reject('401 Unauthorized'); return; }
      const tokenHash = hashToken(token);
      pending.add(socket);
      pendingByIp.set(ip, (pendingByIp.get(ip) ?? 0) + 1);
      const release = (): void => {
        if (!pending.delete(socket)) return;
        const count = (pendingByIp.get(ip) ?? 1) - 1;
        if (count) pendingByIp.set(ip, count); else pendingByIp.delete(ip);
        clearTimeout(deadline);
        socket.off('close', release);
        socket.off('error', onError);
      };
      const onError = (): void => { release(); socket.destroy(); };
      const deadline = setTimeout(() => { release(); reject('408 Request Timeout'); }, WS_AUTH_TIMEOUT_MS);
      deadline.unref();
      socket.once('close', release);
      socket.once('error', onError);
      void getSessionUserForToken(token).then((user) => {
        if (!pending.has(socket) || socket.destroyed) return;
        if (!user) { release(); reject('401 Unauthorized'); return; }
        if (overConnectionLimit(ip, user.id, tokenHash)) {
          release(); reject('503 Service Unavailable'); return;
        }
        try {
          wss.handleUpgrade(request, socket, head, (websocket) => {
            release();
            wss.emit('connection', websocket, request, user.id, tokenHash, ip);
          });
        } catch (error) {
          release();
          app.log.error(error, 'WebSocket upgrade failed');
          socket.destroy();
        }
      }).catch((error: unknown) => { release(); app.log.error(error, 'WebSocket authentication failed'); socket.destroy(); });
    } catch {
      reject('400 Bad Request');
    }
  });

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    clearInterval(typingCleanup);
    for (const socket of pending) socket.destroy();
    for (const state of sockets) state.socket?.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
};
