// Realtime client (apps/web realtime.ts) with fake WebSocket/EventSource and mocked timers:
// heartbeat, ping timeout, online/visibility reconnect, connect timeout -> SSE fallback, WS probe back.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

test('realtime client: heartbeat, reconnect, SSE fallback and probe', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
  const listeners = {};
  const mk = () => ({ addEventListener: (n, f) => (listeners[n] ??= new Set()).add(f), removeEventListener: (n, f) => listeners[n]?.delete(f) });
  globalThis.window = mk(); globalThis.document = Object.assign(mk(), { visibilityState: 'visible' });
  globalThis.location = { protocol: 'https:', host: 'x.test' };
  const store = {}; globalThis.sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const sockets = [], sources = [], posts = [];
  globalThis.WebSocket = class { constructor(u) { this.url = u; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); } close() { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.(); } }
    open() { this.readyState = 1; this.onopen?.(); } msg(o) { this.onmessage?.({ data: JSON.stringify(o) }); } };
  globalThis.EventSource = class { constructor(u) { this.url = u; this.readyState = 0; sources.push(this); } close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); } msg(o) { this.onmessage?.({ data: JSON.stringify(o) }); } };
  globalThis.fetch = async (u, i) => { posts.push([u, JSON.parse(i.body)]); return {}; };
  const { RealtimeClient } = await import('../../apps/web/src/realtime.ts');
  const log = { events: [], recon: 0, states: [], transports: [] };
  const c = new RealtimeClient({ onEvent: e => log.events.push(e.type), onReconnect: () => log.recon++, onState: s => log.states.push(s), onTransport: t => log.transports.push(t) });
  const tick = ms => mock.timers.tick(ms);
  c.start();
  let ws = sockets.at(-1); assert.equal(ws.url, 'wss://x.test/ws');
  ws.open(); assert.equal(c.state, 'online'); assert.equal(log.recon, 0);
  ws.msg({ type: 'message.new' }); assert.deepEqual(log.events, ['message.new']);
  // heartbeat: ping at 15s, pong clears timer, rtt measured
  tick(15000); assert.equal(ws.sent.at(-1).type, 'ping');
  tick(40); ws.msg({ type: 'pong', t: ws.sent.at(-1).t }); assert.equal(log.events.length, 1);
  tick(9990); assert.equal(c.state, 'online'); // pong received, no timeout kill
  // ping with no pong -> after 10s socket killed and reconnect scheduled
  tick(15000); const before = sockets.length; tick(10000);
  assert.equal(c.state, 'offline'); assert.equal(ws.readyState, 3);
  tick(30000); assert.equal(sockets.length, before + 1); ws = sockets.at(-1); ws.open();
  assert.equal(c.state, 'online'); assert.equal(log.recon, 1);
  // online event on dead socket -> immediate reconnect; on healthy -> ping
  ws.close(); const n = sockets.length; listeners.online.forEach(f => f()); assert.equal(sockets.length, n + 1);
  ws = sockets.at(-1); ws.open(); assert.equal(log.recon, 2);
  const sentBefore = ws.sent.length; document.visibilityState = 'hidden'; listeners.visibilitychange.forEach(f => f());
  document.visibilityState = 'visible'; listeners.visibilitychange.forEach(f => f()); assert.equal(ws.sent.length, sentBefore + 1);
  tick(100); ws.msg({ type: 'pong', t: 0 });
  // connect timeout 8s counts as failure; 3 failures -> SSE
  ws.close(); tick(30000); // reconnect attempt 1
  for (let i = 0; i < 3; i++) { assert.equal(c.transport, 'ws'); if (i) tick(30000); tick(8000); }
  assert.equal(c.transport, 'sse'); assert.equal(store['rt-transport'], 'sse'); assert.deepEqual(log.transports, ['sse']);
  let es = sources.at(-1); assert.equal(es.url, '/api/events'); es.open(); assert.equal(c.state, 'online');
  es.msg({ type: 'hello' }); es.msg({ type: 'message.new' }); assert.equal(log.events.at(-1), 'message.new'); assert.equal(log.events.filter(e => e === 'hello').length, 0);
  assert.equal(c.send({ type: 'typing', chatId: 'c1' }), true); assert.deepEqual(posts[0], ['/api/typing', { chatId: 'c1', isTyping: true }]);
  // probe: after 2 min tries WS; fails silently; next succeeds and switches back
  const r = log.recon; tick(120000); let probe = sockets.at(-1); probe.close(); assert.equal(c.transport, 'sse');
  tick(120000); probe = sockets.at(-1); probe.open(); assert.equal(c.transport, 'ws'); assert.equal(store['rt-transport'], 'ws');
  assert.equal(es.readyState, 2); assert.equal(c.state, 'online'); assert.equal(log.recon, r + 1);
  assert.equal(c.send({ type: 'typing', chatId: 'c1', isTyping: false }), true); assert.deepEqual(probe.sent.at(-1), { type: 'typing', chatId: 'c1', isTyping: false });
  c.stop(); assert.equal(probe.readyState, 3);
  } finally { mock.timers.reset(); }
});

test('realtime client: close code 4401 (revoked session) stops for good, a normal drop reconnects', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const mk = () => ({ addEventListener() {}, removeEventListener() {} });
    globalThis.window = mk(); globalThis.document = Object.assign(mk(), { visibilityState: 'visible' });
    globalThis.location = { protocol: 'https:', host: 'x.test' };
    globalThis.sessionStorage = { getItem: () => null, setItem() {} };
    const sockets = [];
    globalThis.WebSocket = class { constructor() { this.readyState = 0; sockets.push(this); } send() {} close() { this.readyState = 3; }
      open() { this.readyState = 1; this.onopen?.(); } drop(code) { this.readyState = 3; this.onclose?.({ code }); } };
    globalThis.EventSource = class { constructor() { this.readyState = 0; } close() {} };
    const { RealtimeClient } = await import('../../apps/web/src/realtime.ts');
    let revoked = 0;
    const c = new RealtimeClient({ onEvent() {}, onReconnect() {}, onState() {}, onTransport() {}, onRevoked: () => { revoked += 1; } });
    c.start(); let ws = sockets.at(-1); ws.open();
    ws.drop(1006); // network drop: reconnects
    mock.timers.tick(30000); assert.equal(sockets.length, 2); assert.equal(revoked, 0);
    ws = sockets.at(-1); ws.open();
    ws.drop(4401); // server revoked the session
    assert.equal(revoked, 1);
    mock.timers.tick(120000); assert.equal(sockets.length, 2, 'no reconnect after 4401');
  } finally { mock.timers.reset(); }
});
