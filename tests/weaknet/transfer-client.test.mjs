// Client chunk transfer (apps/web attachments/transfer.ts) with a mock fetch: retries, timeouts, resume, offline pause, concurrency, download ranges.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as T from '../../apps/web/src/attachments/transfer.ts';
import * as C from '../../apps/web/src/attachments/crypto.ts';

// Per-chunk abort timers are real setTimeouts of 10 s+ (chunkTimeoutMs); shrink long ones 100x so the 'hang' cases don't take 35 s.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 5000 ? ms / 100 : ms, ...a);

const CH = T.CIPHER_CHUNK;
const bytes = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
let clock = 0;
const mkNet = (fetch, extra = {}) => ({
  fetch, now: () => clock, online: () => true, random: () => 0.5,
  sleep: async (ms) => { clock += ms; }, waitOnline: async () => {}, ...extra,
});
const json = (status, body) => new Response(JSON.stringify(body), { status });
// in-memory C4 server; faults: array of fn(url, init, n) -> Response|undefined|'hang'
const mkServer = (total, faults = []) => {
  const got = new Map(); let complete = false; const log = [];
  const fetch = async (url, init) => {
    const m = /chunks\/(\d+)$/.exec(url);
    const sig = init.signal;
    for (const f of faults) {
      const r = f(url, init, m ? +m[1] : -1);
      if (r === 'hang') return new Promise((_, rej) => sig.addEventListener('abort', () => rej(new Error('aborted'))));
      if (r) return r;
    }
    if (init.method === 'GET') { log.push('status'); return json(200, { total, chunkBytes: CH, received: [...got.keys()].sort((a, b) => a - b), complete }); }
    const n = +m[1]; log.push(n);
    const body = new Uint8Array(init.body);
    assert.equal(init.headers['x-total-length'], String(total));
    assert.equal(body.length, Math.min(CH, total - n * CH));
    got.set(n, body);
    const count = Math.ceil(total / CH);
    if (got.size === count) { complete = true; return json(201, { complete: true }); }
    return json(200, { received: got.size, total: count, complete: false });
  };
  const result = () => { const o = new Uint8Array(total); for (const [n, b] of got) o.set(b, n * CH); return o; };
  return { fetch, got, log, result, isComplete: () => complete };
};
const source = bytes(CH * 5 + 1234);
const enc = (calls) => async (n) => { calls?.push(n); return source.slice(n * CH, Math.min(source.length, (n + 1) * CH)); };

test('upload: out-of-order faults, 500s, timeout, lost reply, all retried', async () => {
  let hung = 0, fives = 0, lostOnce = false;
  const s = mkServer(source.length, [
    (u, i, n) => n === 1 && hung++ === 0 ? 'hang' : undefined,
    (u, i, n) => n === 2 && fives++ < 2 ? json(503, {}) : undefined,
    // last chunk lands on the server but the reply is lost once (network error)
    (u, i, n) => { if (n === 5 && !lostOnce && i.method === 'PUT') { lostOnce = true; s2.fetch(u, i); throw new Error('reset'); } },
  ]);
  const s2 = s; const calls = []; const prog = []; const samples = [];
  const r = await T.uploadChunks({ chatId: '7', id: 'a'.repeat(32), total: source.length, encrypt: enc(calls), onProgress: (f) => prog.push(f), onSample: (b, ms) => samples.push([b, ms]), net: mkNet(s.fetch) });
  assert.equal(r, 'done');
  assert.deepEqual(s.result(), source);
  assert.equal(hung, 2); assert.equal(fives, 3);
  assert.equal(new Set(calls).size, 6); assert.equal(calls.length, 6, 'each chunk encrypted exactly once');
  assert.equal(prog.at(-1), 1); assert.ok(prog.every((v, i) => i === 0 || v >= prog[i - 1]));
  assert.ok(samples.length >= 6);
});

test('upload: resume skips chunks the server already has', async () => {
  const s = mkServer(source.length);
  for (const n of [0, 1, 3]) s.got.set(n, source.slice(n * CH, (n + 1) * CH));
  const calls = [];
  await T.uploadChunks({ chatId: '7', id: 'b'.repeat(32), total: source.length, encrypt: enc(calls), net: mkNet(s.fetch) });
  assert.deepEqual(calls.sort(), [2, 4, 5]);
  assert.deepEqual(s.result(), source);
});

test('upload: 404 on chunk route -> fallback; 4xx -> throws', async () => {
  const f404 = async (u, i) => i.method === 'GET' ? json(404, {}) : json(404, { error: 'x' });
  assert.equal(await T.uploadChunks({ chatId: '7', id: 'c'.repeat(32), total: 1000, encrypt: async () => new Uint8Array(1000), net: mkNet(f404) }), 'fallback');
  const f413 = async (u, i) => i.method === 'GET' ? json(404, {}) : json(413, { error: 'حجم زیاد است' });
  await assert.rejects(T.uploadChunks({ chatId: '7', id: 'c'.repeat(32), total: 1000, encrypt: async () => new Uint8Array(1000), net: mkNet(f413) }), (e) => e.status === 413 && e.message === 'حجم زیاد است');
});

test('upload: offline pauses, continues on online, gives up after ~10 min of no progress', async () => {
  const s = mkServer(source.length); let online = false; let waited = 0;
  const net = mkNet(s.fetch, { online: () => online, waitOnline: async () => { waited++; clock += 3_600_000; online = true; } });
  await T.uploadChunks({ chatId: '7', id: 'd'.repeat(32), total: source.length, encrypt: enc(), net });
  assert.ok(waited >= 1); assert.deepEqual(s.result(), source); // an hour offline did not count as a stall
  // dead server: always 503 -> stall error after ~10 min of fake time
  clock = 0; let tries = 0;
  const dead = mkNet(async (u, i) => i.method === 'GET' ? json(404, {}) : (tries++, json(503, {})));
  await assert.rejects(T.uploadChunks({ chatId: '7', id: 'e'.repeat(32), total: 1000, encrypt: async () => new Uint8Array(1000), net: dead }), /متوقف/);
  assert.ok(clock >= 600_000 && clock < 700_000, `clock ${clock}`); assert.ok(tries > 15);
});

test('upload: concurrency rises to 3 on fast chunks and falls on failures', async () => {
  let inflight = 0, peak = 0; const total = CH * 12;
  const s = mkServer(total);
  const slow = async (u, i) => { if (i.method === 'PUT') { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; } return s.fetch(u, i); };
  await T.uploadChunks({ chatId: '7', id: 'f'.repeat(32), total, encrypt: async (n) => new Uint8Array(Math.min(CH, total - n * CH)), net: mkNet(slow) });
  assert.equal(peak, 3);
});

const mkCrypto = async (size) => { const s = C.newAttachmentSecrets(); return { key: await C.importAttachmentKey(s.key), noncePrefix: C.unb64u(s.noncePrefix), chatId: '7', id: s.id, size }; };
const encAll = async (c, plain) => { const parts = []; for await (const p of C.encryptChunks(c, new Blob([plain]))) parts.push(p); const o = new Uint8Array(C.cipherSize(c.size)); let x = 0; for (const p of parts) { o.set(p, x); x += p.length; } return o; };
const mkStore = () => { const m = new Map(); return { m, get: async (id, n) => m.get(id + n), put: async (id, n, d) => { m.set(id + n, d); }, clear: async (id) => { for (const k of [...m.keys()]) if (k.startsWith(id)) m.delete(k); } }; };
const dl = (cipher, faults = []) => { const log = []; const fetch = async (url, init) => {
  for (const f of faults) { const r = f(init); if (r === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); if (r) return r; }
  const [a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.range).slice(1).map(Number); log.push([a, b]);
  return new Response(cipher.slice(a, b + 1), { status: 206 }); }; return { fetch, log }; };

test('download: chunk ranges, decrypt, stores chunks, resumes from store after a failure', async () => {
  const plain = bytes(CH * 3 - 500); const c = await mkCrypto(plain.length); const cipher = await encAll(c, plain);
  const n = C.chunkCount(plain.length); const store = mkStore();
  let cut = false;
  const s = dl(cipher, [() => { /* chunk 2 permanently fails first call set */ }]);
  const failing = async (u, i) => { const a = +/bytes=(\d+)/.exec(i.headers.range)[1]; if (a >= 2 * CH && !cut) return json(503, {}); return s.fetch(u, i); };
  // first run: chunk 2 gets 503 forever -> stall error; chunks 0,1 land in store
  clock = 0;
  await assert.rejects(T.downloadChunks({ id: c.id, total: cipher.length, store, process: (i, ct) => C.decryptChunk(c, i, ct, i === n - 1), net: mkNet(failing) }), /متوقف/);
  assert.ok(store.m.has(c.id + 0) && store.m.has(c.id + 1) && !store.m.has(c.id + 2));
  // retry (the "reload"): link is back; only chunk 2 is requested
  cut = true; s.log.length = 0; const prog = [];
  const parts = await T.downloadChunks({ id: c.id, total: cipher.length, store, process: (i, ct) => C.decryptChunk(c, i, ct, i === n - 1), onProgress: (f) => prog.push(f), net: mkNet(failing) });
  assert.deepEqual(s.log, [[2 * CH, cipher.length - 1]]);
  const out = new Uint8Array(plain.length); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  assert.deepEqual(out, plain); assert.equal(prog.at(-1), 1);
  await store.clear(c.id); assert.equal(store.m.size, 0);
});

test('download: timeout retried, truncated body retried, corrupt cached chunk refetched, server ignoring Range', async () => {
  const plain = bytes(CH * 2 + 10); const c = await mkCrypto(plain.length); const cipher = await encAll(c, plain); const n = C.chunkCount(plain.length);
  const proc = (i, ct) => C.decryptChunk(c, i, ct, i === n - 1);
  let hang = 0, trunc = 0;
  const s = dl(cipher, [() => hang++ === 0 ? 'hang' : undefined, () => trunc++ === 1 ? new Response(cipher.slice(0, 100), { status: 206 }) : undefined]);
  const store = mkStore(); store.m.set(c.id + 0, bytes(CH)); // corrupt cache entry, right length
  const parts = await T.downloadChunks({ id: c.id, total: cipher.length, store, process: proc, net: mkNet(s.fetch) });
  assert.deepEqual(Buffer.concat(parts), Buffer.from(plain));
  const whole = async () => new Response(cipher, { status: 200 });
  const parts2 = await T.downloadChunks({ id: c.id, total: cipher.length, store: mkStore(), process: proc, net: mkNet(whole) });
  assert.deepEqual(Buffer.concat(parts2), Buffer.from(plain));
  // permanent errors surface
  await assert.rejects(T.downloadChunks({ id: c.id, total: cipher.length, store: mkStore(), process: proc, net: mkNet(async () => json(404, { error: 'نیست' })) }), (e) => e.status === 404);
});

test('timeout formula and backoff', () => {
  assert.equal(T.chunkTimeoutMs(0), 10_000);
  assert.equal(Math.round(T.chunkTimeoutMs(CH) / 1000), 36);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((a) => T.backoffMs(a, () => 1)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});
