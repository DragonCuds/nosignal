import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeEvent } from './api.js';

export type RealtimeState = 'connecting' | 'online' | 'offline';
export type RealtimeTransport = 'ws' | 'sse';
type TypingEvent = { type: 'typing'; chatId: string; isTyping?: boolean };

const PING_EVERY = 15_000;
const MIN_PONG_WAIT = 10_000;
const CONNECT_TIMEOUT = 8_000;
const MAX_BACKOFF = 30_000;
const WS_FAILS_BEFORE_SSE = 3;
const WS_PROBE_EVERY = 120_000;
const SSE_STALE_AFTER_HIDDEN = 30_000;
const STORAGE_KEY = 'rt-transport';
const OPEN = 1;

const readTransport = (): RealtimeTransport => {
  try { return sessionStorage.getItem(STORAGE_KEY) === 'sse' ? 'sse' : 'ws'; } catch { return 'ws'; }
};
const writeTransport = (value: RealtimeTransport) => {
  try { sessionStorage.setItem(STORAGE_KEY, value); } catch { /* storage may be blocked */ }
};

type Timer = ReturnType<typeof setTimeout>;

export type RealtimeHandlers = {
  onEvent: (event: RealtimeEvent) => void;
  onReconnect: () => void;
  onState: (state: RealtimeState) => void;
  onTransport: (transport: RealtimeTransport) => void;
  /** The server closed the connection because the session was revoked (WS close 4401, or SSE ended with /api/me 401). */
  onRevoked?: () => void;
};
const REVOKED_CLOSE_CODE = 4401;

/** Framework-free client; `useRealtime` below is a thin React wrapper (also lets node tests drive it). */
export class RealtimeClient {
  transport: RealtimeTransport = readTransport();
  state: RealtimeState = 'connecting';
  private ws?: WebSocket;
  private es?: EventSource;
  private probe?: WebSocket;
  private stopped = false;
  private connectedOnce = false;
  private failures = 0;
  private attempts = 0;
  private rtt?: number;
  private hiddenAt?: number;
  private retryTimer?: Timer;
  private connectTimer?: Timer;
  private pingTimer?: Timer;
  private pongTimer?: Timer;
  private probeTimer?: Timer;
  private handlers: RealtimeHandlers;

  constructor(handlers: RealtimeHandlers) {
    this.handlers = handlers;
  }

  start() {
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.open();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clearTimers();
    this.closeWs();
    this.closeSse();
    this.closeProbe();
    if (this.probeTimer) clearTimeout(this.probeTimer);
  }

  send(event: TypingEvent): boolean {
    if (this.transport === 'ws') {
      if (!this.ws || this.ws.readyState !== OPEN) return false;
      try { this.ws.send(JSON.stringify(event)); return true; } catch { return false; }
    }
    if (this.state !== 'online') return false;
    void fetch('/api/typing', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: event.chatId, isTyping: event.isTyping ?? true }),
    }).catch(() => { /* typing is best-effort */ });
    return true;
  }

  private setState(state: RealtimeState) {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state);
  }

  private setTransport(transport: RealtimeTransport) {
    writeTransport(transport);
    if (this.transport === transport) return;
    this.transport = transport;
    this.handlers.onTransport(transport);
  }

  private up() {
    const wasReconnect = this.connectedOnce;
    this.connectedOnce = true;
    this.attempts = 0;
    this.setState('online');
    if (wasReconnect) this.handlers.onReconnect();
  }

  private clearTimers() {
    for (const timer of [this.retryTimer, this.connectTimer, this.pingTimer, this.pongTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.retryTimer = this.connectTimer = this.pingTimer = this.pongTimer = undefined;
  }

  private scheduleRetry() {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ceiling = Math.min(MAX_BACKOFF, 1_000 * 2 ** this.attempts);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => this.open(), Math.max(250, Math.random() * ceiling));
  }

  private open() {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.transport === 'sse') this.openSse(); else this.openWs();
  }

  private forward(data: unknown): RealtimeEvent | undefined {
    try {
      const event = JSON.parse(String(data)) as RealtimeEvent;
      if (event && typeof event === 'object' && typeof event.type === 'string') return event;
    } catch { /* Ignore malformed frames and keep the connection alive. */ }
    return undefined;
  }

  // ---------- WebSocket ----------

  private closeWs() {
    const socket = this.ws;
    this.ws = undefined;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(); } catch { /* already closed */ }
  }

  private closeProbe() {
    const socket = this.probe;
    this.probe = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(); } catch { /* already closed */ }
  }

  private newSocket(): WebSocket {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(`${protocol}//${location.host}/ws`);
  }

  private openWs() {
    this.closeWs();
    this.closeSse();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.state !== 'online' && this.connectedOnce) this.setState('offline');
    const socket = this.newSocket();
    this.ws = socket;
    this.attachWs(socket, false);
    this.connectTimer = setTimeout(() => {
      if (this.ws === socket && socket.readyState !== OPEN) this.wsDown(socket, false, false);
    }, CONNECT_TIMEOUT);
  }

  /** `probe` sockets are background attempts while on SSE: they never count failures or retry. */
  private attachWs(socket: WebSocket, probe: boolean) {
    let opened = false;
    let main = !probe;
    socket.onopen = () => {
      opened = true;
      if (!main) {
        // probe worked: adopt this socket and drop SSE
        if (this.probe !== socket) return;
        this.probe = undefined;
        this.closeSse();
        this.closeWs();
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.ws = socket;
        main = true;
        this.setTransport('ws');
      }
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.failures = 0;
      this.attempts = 0;
      this.up();
      this.schedulePing();
    };
    socket.onmessage = (message) => {
      if (this.pongTimer) clearTimeout(this.pongTimer); // any frame proves the link is alive
      this.pongTimer = undefined;
      const event = this.forward(message.data);
      if (!event) return;
      if ((event.type as string) === 'pong') {
        const sent = Number((event as { t?: unknown }).t);
        if (Number.isFinite(sent)) {
          const sample = Math.max(0, Date.now() - sent);
          this.rtt = this.rtt === undefined ? sample : this.rtt * 0.8 + sample * 0.2;
        }
        return;
      }
      this.handlers.onEvent(event);
    };
    socket.onclose = (closeEvent) => {
      if (closeEvent?.code === REVOKED_CLOSE_CODE && (main || this.ws === socket)) { this.revoked(); return; }
      this.wsDown(socket, !main, opened);
    };
    socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
  }

  private wsDown(socket: WebSocket, probe: boolean, opened = this.state === 'online') {
    if (probe || this.probe === socket) {
      if (this.probe === socket) this.closeProbe();
      return;
    }
    if (this.ws !== socket) return; // stale
    this.closeWs();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.setState('offline');
    if (!opened) {
      this.failures += 1;
      if (this.failures >= WS_FAILS_BEFORE_SSE) {
        this.failures = 0;
        this.attempts = 0;
        this.setTransport('sse');
        this.openSse();
        return;
      }
    }
    this.scheduleRetry();
  }

  /** Session is gone: stop for good (no reconnect storm) and let the app show the login screen. */
  private revoked() {
    if (this.stopped) return;
    this.stop();
    this.setState('offline');
    this.handlers.onRevoked?.();
  }

  /** SSE ended without a status code: ask the API whether the session is still valid before retrying. */
  private checkSessionThenRetry() {
    void fetch('/api/me', { credentials: 'include' }).then((response) => {
      if (response.status === 401) this.revoked(); else this.scheduleRetry();
    }).catch(() => this.scheduleRetry());
  }

  private schedulePing() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.sendPing();
      this.schedulePing();
    }, PING_EVERY);
  }

  private sendPing() {
    const socket = this.ws;
    if (!socket || socket.readyState !== OPEN) return;
    try { socket.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch { this.wsDown(socket, false, true); return; }
    if (this.pongTimer) return;
    const wait = Math.max(MIN_PONG_WAIT, 3 * (this.rtt ?? 0));
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      if (this.ws === socket) this.wsDown(socket, false, true);
    }, wait);
  }

  // ---------- SSE fallback ----------

  private closeSse() {
    const source = this.es;
    this.es = undefined;
    if (!source) return;
    source.onopen = source.onmessage = source.onerror = null;
    source.close();
  }

  private openSse() {
    this.closeWs();
    this.closeSse();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.state !== 'online' && this.connectedOnce) this.setState('offline');
    const source = new EventSource('/api/events', { withCredentials: true });
    this.es = source;
    source.onopen = () => {
      if (this.es !== source) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.up();
      this.scheduleProbe();
    };
    source.onmessage = (message) => {
      const event = this.forward(message.data);
      if (event && (event.type as string) !== 'hello') this.handlers.onEvent(event);
    };
    source.onerror = () => {
      if (this.es !== source) return;
      this.setState('offline');
      if (source.readyState === 2) { // CLOSED: browser gave up (e.g. 401), retry ourselves
        this.closeSse();
        this.checkSessionThenRetry();
      } // CONNECTING: the browser retries on its own and onopen will fire again
    };
    this.connectTimer = setTimeout(() => {
      if (this.es !== source || this.state === 'online') return;
      this.closeSse();
      this.scheduleRetry();
    }, CONNECT_TIMEOUT);
    this.scheduleProbe();
  }

  private scheduleProbe() {
    if (this.probeTimer || this.stopped) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      if (this.stopped || this.transport !== 'sse') return;
      if (!this.probe) {
        const socket = this.newSocket();
        this.probe = socket;
        this.attachWs(socket, true);
        setTimeout(() => {
          if (this.probe === socket && socket.readyState !== OPEN) this.closeProbe();
        }, CONNECT_TIMEOUT);
      }
      this.scheduleProbe();
    }, WS_PROBE_EVERY);
  }

  // ---------- wake-up ----------

  private onVisibility = () => {
    if (document.visibilityState !== 'visible') {
      this.hiddenAt = Date.now();
      return;
    }
    const hiddenFor = this.hiddenAt === undefined ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = undefined;
    this.wake(hiddenFor);
  };

  /** Called on `online` and when the tab becomes visible: reconnect now unless the link is provably healthy. */
  private wake = (arg?: unknown) => {
    if (this.stopped) return;
    const hiddenFor = typeof arg === 'number' ? arg : Infinity;
    if (this.transport === 'ws') {
      if (this.ws && this.ws.readyState === OPEN) { this.sendPing(); return; } // zombie check, closes if no pong
    } else if (this.es && this.es.readyState === OPEN && hiddenFor < SSE_STALE_AFTER_HIDDEN) {
      return; // EventSource hides keepalive comments, so after a long sleep we just reopen
    }
    this.attempts = 0;
    this.open();
  };
}

export function useRealtime(onEvent: (event: RealtimeEvent) => void, onReconnect: () => void, onRevoked?: () => void) {
  const eventHandler = useRef(onEvent);
  const reconnectHandler = useRef(onReconnect);
  const [state, setState] = useState<RealtimeState>('connecting');
  const [transport, setTransport] = useState<RealtimeTransport>(readTransport);
  const clientRef = useRef<RealtimeClient | undefined>(undefined);
  const revokedHandler = useRef(onRevoked);
  revokedHandler.current = onRevoked;
  eventHandler.current = onEvent;
  reconnectHandler.current = onReconnect;

  useEffect(() => {
    const client = new RealtimeClient({
      onEvent: (event) => eventHandler.current(event),
      onReconnect: () => reconnectHandler.current(),
      onState: setState,
      onTransport: setTransport,
      onRevoked: () => revokedHandler.current?.(),
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = undefined;
    };
  }, []);

  const send = useCallback((event: TypingEvent): boolean => clientRef.current?.send(event) ?? false, []);

  return { state, send, transport };
}
