import type { RealtimeClientEvent, RealtimeServerEvent } from '@tel-messenger/media-contract';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { getSessionUserForToken, isTrustedOrigin } from './auth.js';

const SESSION_COOKIE = 'tel_session';
const HEARTBEAT_MS = 25_000;
const MAX_CLIENT_EVENTS_PER_WINDOW = 20;
const CLIENT_EVENT_WINDOW_MS = 10_000;

const SSE_KEEPALIVE_MS = 15_000;
const SSE_MAX_BUFFERED = 1024 * 1024;

// One connected client, over WebSocket or SSE. `send` never throws.
type SocketState = { socket?: WebSocket; userId: string; alive: boolean; events: number[]; send(event: RealtimeServerEvent): void };
type RealtimeService = { broadcastToChat(chatId: string, event: RealtimeServerEvent): void };

declare module 'fastify' {
  interface FastifyInstance { realtime: RealtimeService }
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const send = (socket: WebSocket, event: RealtimeServerEvent): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
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

export const registerRealtime = async (app: FastifyInstance): Promise<void> => {
  const sockets = new Set<SocketState>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  const onlineElsewhere = (userId: string): boolean => [...sockets].some((state) => state.userId === userId);
  const broadcastPresence = (userId: string, online: boolean, lastSeen: string | null): void => {
    const event: RealtimeServerEvent = { type: 'presence', userId, online, lastSeen };
    for (const state of sockets) if (state.userId !== userId) state.send(event);
  };
  const connect = (state: SocketState): void => {
    const becameOnline = !onlineElsewhere(state.userId);
    sockets.add(state);
    if (becameOnline) broadcastPresence(state.userId, true, null);
  };
  const disconnect = (state: SocketState): void => {
    if (!sockets.delete(state)) return;
    if (!onlineElsewhere(state.userId)) broadcastPresence(state.userId, false, new Date().toISOString());
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

  app.decorate('realtime', {
    broadcastToChat(chatId, event) {
      for (const state of sockets) void isChatMember(chatId, state.userId).then((member) => {
        if (member) state.send(event);
      }).catch((error: unknown) => app.log.error(error, 'Failed to deliver realtime event'));
    }
  });

  wss.on('connection', (socket: WebSocket, _request: IncomingMessage, userId: string) => {
    const state: SocketState = { socket, userId, alive: true, events: [], send: (event) => send(socket, event) };
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
    const state: SocketState = { userId, alive: true, events: [], send: (event) => write(`data: ${JSON.stringify(event)}\n\n`) };
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

  const heartbeat = setInterval(() => {
    for (const state of sockets) {
      if (!state.socket) continue;
      if (!state.alive) state.socket.terminate();
      else { state.alive = false; state.socket.ping(); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  app.server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') return;
    if (!isTrustedOrigin(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const token = app.parseCookie(request.headers.cookie ?? '')[SESSION_COOKIE];
    if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    void getSessionUserForToken(token).then((user) => {
      if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request, user.id));
    }).catch((error: unknown) => { app.log.error(error, 'WebSocket authentication failed'); socket.destroy(); });
  });

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    clearInterval(typingCleanup);
    for (const state of sockets) state.socket?.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
};
