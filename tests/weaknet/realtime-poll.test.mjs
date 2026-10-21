// Realtime client third transport: HTTP polling when both WebSocket and SSE cannot connect.
// Fake WebSocket/EventSource + mocked timers (same style as realtime-client.test.mjs).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const setup = async (handlersOver = {}) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const listeners = {};
  const mk = () => ({ addEventListener: (n, f) => (listeners[n] ??= new Set()).add(f), removeEventListener: (n, f) => listeners[n]?.delete(f) });
  globalThis.window = mk(); globalThis.document = Object.assign(mk(), { visibilityState: 'visible' });
  globalThis.location = { protocol: 'https:', host: 'x.test' };
  const store = {}; globalThis.sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const sockets = [], sources = [];
  globalThis.WebSocket = class { constructor(u) { this.url = u; this.readyState = 0; sockets.push(this); }
    send() {} close() { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.({ code: 1006 }); } }
    open() { this.readyState = 1; this.onopen?.(); } };
  globalThis.EventSource = class { constructor(u) { this.url = u; this.readyState = 0; sources.push(this); } close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); } msg(o) { this.onmessage?.({ data: JSON.stringify(o) }); } };
  globalThis.fetch = async () => ({});
  const { RealtimeClient } = await import('../../apps/web/src/realtime.ts');
  const log = { polls: [], times: [], recon: 0, states: [], transports: [], revoked: 0, events: [] };
  let pollImpl = async () => {};
  const c = new RealtimeClient({
    onEvent: (e) => log.events.push(e.type), onReconnect: () => log.recon++, onState: (s) => log.states.push(s),
    onTransport: (t) => log.transports.push(t), onRevoked: () => log.revoked++,
    onPoll: async (full) => { log.polls.push(full); log.times.push(Date.now()); await pollImpl(full); },
    ...handlersOver,
  });
  return { c, log, sockets, sources, listeners, store, setPoll: (f) => { pollImpl = f; }, tick: async (ms) => { mock.timers.tick(ms); await flush(); } };
};

/** Drive WS (3 timeouts) then SSE (2 timeouts) to failure -> polling. */
const driveToPoll = async (t) => {
  t.c.start();
  for (let i = 0; i < 40 && t.c.transport !== 'poll'; i++) await t.tick(8000), await t.tick(2000), await t.tick(30000);
  assert.equal(t.c.transport, 'poll');
};

test('polling: WS fails -> SSE fails -> poll; first poll is full, state goes online, nothing persisted', async () => {
  const t = await setup();
  try {
    await driveToPoll(t);
    assert.deepEqual(t.log.transports, ['sse', 'poll']);
    assert.equal(t.store['rt-transport'], 'sse', 'poll is not persisted as the preferred transport');
    await t.tick(10);
    assert.deepEqual(t.log.polls, [true]);
    assert.equal(t.c.state, 'online');
    assert.equal(t.log.recon, 0, 'poll catch-up goes through onPoll, not onReconnect');
  } finally { t.c.stop(); mock.timers.reset(); }
});

test('polling: 6-10 s cadence with jitter, fast after nudge, full refresh every 5th poll', async () => {
  const t = await setup();
  try {
    await driveToPoll(t);
    await t.tick(10);
    const n0 = t.log.polls.length;
    for (let i = 0; i < 12; i++) await t.tick(1000);
    const n12 = t.log.polls.length - n0;
    assert.ok(n12 >= 1 && n12 <= 2, `~1 poll per 6-10 s, got ${n12} in 12 s`);
    // gaps are within [6s, 10s]
    for (let i = 0; i < 600; i++) await t.tick(100);
    const gaps = t.log.times.slice(1).map((v, i) => v - t.log.times[i]);
    assert.ok(gaps.every((g) => g >= 6000 && g <= 10_100), gaps.join(','));
    // fulls: first, then every 5th
    assert.equal(t.log.polls[0], true);
    assert.deepEqual(t.log.polls.map((f, i) => f === (i === 0 || (i + 1) % 5 === 0)).every(Boolean), true);
    // nudge: next poll within 3.6 s, and fast afterwards for a while
    await t.tick(500);
    const before = t.log.polls.length;
    t.c.nudge();
    await t.tick(3700);
    assert.equal(t.log.polls.length, before + 1, 'nudge polls fast');
    await t.tick(3700);
    assert.equal(t.log.polls.length, before + 2, 'still fast inside the window');
    await t.tick(60_000);
    const cnt = t.log.polls.length; await t.tick(12_000);
    assert.ok(t.log.polls.length - cnt <= 2, 'back to slow cadence after the window');
  } finally { t.c.stop(); mock.timers.reset(); }
});

test('polling: paused while hidden, resumes instantly on visibilitychange', async () => {
  const t = await setup();
  try {
    await driveToPoll(t);
    await t.tick(10);
    document.visibilityState = 'hidden'; t.listeners.visibilitychange.forEach((f) => f());
    const n = t.log.polls.length;
    await t.tick(120_000);
    assert.equal(t.log.polls.length, n, 'no polls while hidden');
    document.visibilityState = 'visible'; t.listeners.visibilitychange.forEach((f) => f());
    await t.tick(1);
    assert.equal(t.log.polls.length, n + 1, 'immediate poll on show');
    assert.equal(t.log.polls.at(-1), true, 'long hide -> full refresh');
  } finally { t.c.stop(); mock.timers.reset(); }
});

test('polling: errors back off and mark offline; a failed full refresh is retried as full; recovery goes online', async () => {
  const t = await setup();
  try {
    await driveToPoll(t);
    await t.tick(10);
    t.setPoll(async () => { throw Object.assign(new Error('net'), { status: 0 }); });
    const n = t.log.polls.length;
    for (let i = 0; i < 20; i++) await t.tick(10_000); // 200 s
    const errPolls = t.log.polls.length - n;
    assert.ok(errPolls >= 3 && errPolls <= 9, `backed off, got ${errPolls}`);
    assert.equal(t.c.state, 'offline');
    t.setPoll(async () => {});
    await t.tick(70_000);
    assert.equal(t.c.state, 'online');
    assert.equal(t.log.polls.at(-1) === false || t.log.polls.includes(true), true);
  } finally { t.c.stop(); mock.timers.reset(); }
});

test('polling: 401 -> onRevoked once, polling stops for good (no storm)', async () => {
  const t = await setup();
  try {
    await driveToPoll(t);
    await t.tick(10);
    t.setPoll(async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); });
    await t.tick(11_000);
    assert.equal(t.log.revoked, 1);
    const n = t.log.polls.length;
    await t.tick(300_000);
    assert.equal(t.log.polls.length, n);
    assert.equal(t.log.revoked, 1);
  } finally { t.c.stop(); mock.timers.reset(); }
});

test('polling: every 60 s WS then SSE are re-probed; a working WS takes over and polling stops', async () => {
  const t = await setup();
  try {
    await driveToPoll(t);
    await t.tick(10);
    const ws0 = t.sockets.length, es0 = t.sources.length;
    await t.tick(60_000);
    assert.equal(t.sockets.length, ws0 + 1, 'WS probe after 60 s');
    t.sockets.at(-1).close(); // blocked: fails fast
    await t.tick(8100);
    assert.equal(t.sources.length, es0 + 1, 'then SSE probe');
    assert.equal(t.c.transport, 'poll');
    await t.tick(8100); // SSE probe times out
    const ws1 = t.sockets.length;
    await t.tick(60_000);
    assert.equal(t.sockets.length, ws1 + 1, 'probe cycle repeats');
    t.sockets.at(-1).open();
    assert.equal(t.c.transport, 'ws');
    assert.equal(t.c.state, 'online');
    assert.equal(t.log.recon, 1, 'switching up runs the normal reconnect catch-up');
    const n = t.log.polls.length;
    await t.tick(120_000);
    assert.equal(t.log.polls.length, n, 'no polling once WS is up');
  } finally { t.c.stop(); mock.timers.reset(); }
});

test('polling: a working SSE probe takes over; events then flow, polling stops', async () => {
  const t = await setup();
  try {
    await driveToPoll(t);
    await t.tick(10);
    await t.tick(60_000);
    t.sockets.at(-1).close();
    await t.tick(8100);
    const probe = t.sources.at(-1);
    probe.open();
    assert.equal(t.c.transport, 'sse');
    assert.equal(t.log.recon, 1);
    probe.msg({ type: 'message.new' });
    assert.deepEqual(t.log.events, ['message.new']);
    const n = t.log.polls.length;
    await t.tick(60_000);
    assert.equal(t.log.polls.length, n);
  } finally { t.c.stop(); mock.timers.reset(); }
});
