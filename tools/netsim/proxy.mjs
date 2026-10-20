#!/usr/bin/env node
// Weak-network TCP proxy (no deps). See README.md.
import net from 'node:net';

const PROFILES = {
  // latency/jitter are one-way ms; down/up are bytes/s (0 = unlimited)
  '3g': { latency: 120, jitter: 60, down: 100_000, up: 50_000 },
  edge: { latency: 350, jitter: 200, down: 20_000, up: 10_000, stallEvery: 40, stallLen: 4 },
  flaky: { latency: 100, jitter: 100, down: 120_000, up: 60_000, resetMean: 15, stallEvery: 20, stallLen: 5 },
  cut: { latency: 30, jitter: 10, down: 0, up: 0, cutEvery: 60, cutLen: 10 },
};
// flag -> [profile key, type]
const FLAGS = {
  latency: 'latency', jitter: 'jitter', down: 'down', up: 'up',
  'reset-mean': 'resetMean', 'stall-every': 'stallEvery', 'stall-len': 'stallLen',
  'cut-every': 'cutEvery', 'cut-len': 'cutLen',
};

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  args[a.slice(2)] = process.argv[++i];
}
const usage = 'usage: node proxy.mjs --listen 4201 --target 127.0.0.1:3050 --profile 3g|edge|flaky|cut [--latency ms --jitter ms --down B/s --up B/s --reset-mean s --stall-every s --stall-len s --cut-every s --cut-len s] [--seed N]';
if (!args.listen || !args.target || !PROFILES[args.profile]) {
  console.error(usage);
  process.exit(2);
}
const cfg = { ...PROFILES[args.profile] };
for (const [flag, key] of Object.entries(FLAGS)) if (args[flag] !== undefined) cfg[key] = Number(args[flag]);
const [thost, tport] = (() => {
  const i = args.target.lastIndexOf(':');
  return [args.target.slice(0, i) || '127.0.0.1', Number(args.target.slice(i + 1))];
})();

// small seeded PRNG so a run can be repeated (--seed), default random
let seed = args.seed !== undefined ? Number(args.seed) >>> 0 : (Math.random() * 2 ** 32) >>> 0;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const expo = (mean) => -Math.log(1 - rnd()) * mean;
const log = (...m) => console.log(new Date().toISOString().slice(11, 23), ...m);

// Cut windows: [k*cutEvery, k*cutEvery+cutLen) counted from proxy start, k>=1
const t0 = Date.now();
const cutEnd = (now) => {
  if (!cfg.cutEvery || !cfg.cutLen) return 0;
  const el = (now - t0) / 1000;
  const k = Math.floor(el / cfg.cutEvery);
  if (k >= 1 && el - k * cfg.cutEvery < cfg.cutLen) return t0 + (k * cfg.cutEvery + cfg.cutLen) * 1000;
  return 0;
};
if (cfg.cutEvery) {
  const tick = () => {
    const now = Date.now();
    const end = cutEnd(now);
    if (end) {
      log(`CUT start, ${((end - now) / 1000).toFixed(1)}s left, dropping ${conns.size} connection(s)`);
      for (const c of [...conns]) c.kill('cut');
    }
    const el = (now - t0) / 1000;
    const next = (Math.floor(el / cfg.cutEvery) + 1) * cfg.cutEvery;
    setTimeout(tick, Math.max(50, t0 + next * 1000 - Date.now()));
  };
  setTimeout(tick, cfg.cutEvery * 1000 - 0);
}

const conns = new Set();
let nextId = 1;

// One direction: delays/throttles chunks in order, honours stalls.
function pipe(src, dst, bw, conn, name) {
  let ready = 0; // earliest time (ms) the next byte may leave (bandwidth serialization)
  let last = 0; // last scheduled release (keeps order)
  let queued = 0;
  let pending = 0;
  let ended = false;
  let stallUntil = 0;
  let stallTimer;
  const scheduleStall = () => {
    if (!cfg.stallEvery) return;
    stallTimer = setTimeout(() => {
      stallUntil = Date.now() + Math.min(expo(cfg.stallLen), cfg.stallLen * 3) * 1000;
      log(`#${conn.id} ${name} STALL ${((stallUntil - Date.now()) / 1000).toFixed(1)}s`);
      scheduleStall();
    }, expo(cfg.stallEvery) * 1000);
  };
  scheduleStall();
  conn.cleanups.push(() => clearTimeout(stallTimer));

  const finish = () => { if (ended && pending === 0 && !dst.destroyed) dst.end(); };
  src.on('data', (buf) => {
    const now = Date.now();
    let start = Math.max(now, ready, stallUntil);
    const ce = cutEnd(start);
    if (ce) start = ce; // nothing leaves during a cut (connection is normally killed anyway)
    ready = bw ? start + (buf.length / bw) * 1000 : start;
    const delay = Math.max(0, cfg.latency + (rnd() * 2 - 1) * cfg.jitter);
    const at = Math.max(last, ready + delay);
    last = at;
    pending++;
    queued += buf.length;
    if (queued > 262144) src.pause();
    setTimeout(() => {
      pending--;
      queued -= buf.length;
      if (queued < 131072 && !ended) src.resume();
      if (!dst.destroyed) dst.write(buf);
      finish();
    }, at - now);
  });
  src.on('end', () => { ended = true; finish(); });
  // a closed source still delivers what is already queued, then closes the other side
  src.on('close', () => { ended = true; finish(); });
}

const server = net.createServer({ allowHalfOpen: true }, (client) => {
  const now = Date.now();
  if (cutEnd(now)) {
    log('refused new connection (cut window)');
    client.destroy();
    return;
  }
  const upstream = net.connect({ port: tport, host: thost, allowHalfOpen: true });
  const conn = {
    id: nextId++,
    cleanups: [],
    kill(why) {
      log(`#${this.id} ${why}`);
      client.destroy();
      upstream.destroy();
    },
  };
  conns.add(conn);
  log(`#${conn.id} open (${conns.size} active)`);
  let open = 2;
  const onClose = () => {
    if (--open > 0) return;
    conns.delete(conn);
    conn.cleanups.forEach((f) => f());
  };
  client.on('close', onClose);
  upstream.on('close', onClose);
  // real errors (RST, refused target) tear the pair down at once
  client.on('error', () => conn.kill('client error'));
  upstream.on('error', () => conn.kill('target error'));
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  pipe(client, upstream, cfg.up, conn, 'up');
  pipe(upstream, client, cfg.down, conn, 'down');
  if (cfg.resetMean) {
    const t = setTimeout(() => conn.kill('RESET'), expo(cfg.resetMean) * 1000);
    conn.cleanups.push(() => clearTimeout(t));
  }
});

server.listen(Number(args.listen), '127.0.0.1', () => {
  log(`netsim ${args.profile} 127.0.0.1:${args.listen} -> ${thost}:${tport}`, JSON.stringify(cfg));
});
