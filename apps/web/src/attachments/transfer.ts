// Resumable chunk transfer for attachments.
// No runtime imports on purpose: node tests load this file directly with a mock `net`.
export const CIPHER_CHUNK = 262_160; // 256 KiB + 16 byte GCM tag
const STALL_MS = 600_000; // give up after this long without progress (offline time not counted)
const MAX_CONCURRENCY = 3;

export class TransferError extends Error {
  readonly status: number;
  /** Upload only: the server has no chunk route, caller should use the old single PUT. */
  readonly fallback: boolean;
  constructor(message: string, status = 0, fallback = false) {
    super(message);
    this.name = 'TransferError';
    this.status = status;
    this.fallback = fallback;
  }
}

/** Everything the transfer touches from the outside, replaceable in tests. */
export type Net = {
  fetch: typeof fetch;
  now: () => number;
  online: () => boolean;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  waitOnline: (signal?: AbortSignal) => Promise<void>;
  random: () => number;
};

const abortError = () => new TransferError('انتقال لغو شد.', 0);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { done(); reject(abortError()); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort);
  });

const waitOnline = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => { window.removeEventListener('online', onOnline); signal?.removeEventListener('abort', onAbort); };
    const onOnline = () => { done(); resolve(); };
    const onAbort = () => { done(); reject(abortError()); };
    window.addEventListener('online', onOnline);
    signal?.addEventListener('abort', onAbort);
  });

export const realNet: Net = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  sleep,
  waitOnline,
  random: () => Math.random(),
};

/** 10 s + size at a floor of 10 KB/s. */
export const chunkTimeoutMs = (bytes: number): number => 10_000 + Math.ceil((bytes / 10_240) * 1000);
/** 1 s, 2 s, 4 s ... capped at 30 s, with up to 50% jitter downwards. */
export const backoffMs = (attempt: number, random: () => number): number => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 6)) * (0.5 + random() / 2);
const retryableStatus = (s: number) => s === 0 || s === 408 || s === 429 || s >= 500;

type Reply = { status: number; bytes: Uint8Array; header: (name: string) => string | null };

/** One fetch whose whole body read is bound by a timeout. Network failure and timeout both -> TransferError(status 0). */
const exchange = async (net: Net, url: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<Reply> => {
  if (outer?.aborted) throw abortError();
  const ctl = new AbortController();
  const onOuter = () => ctl.abort();
  outer?.addEventListener('abort', onOuter);
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { ...init, credentials: 'include', signal: ctl.signal });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, bytes, header: (name) => res.headers.get(name) };
  } catch {
    throw outer?.aborted ? abortError() : new TransferError('ارتباط با سرور برقرار نشد.', 0);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
};

const readJson = <T>(reply: Reply): T | undefined => {
  try { return JSON.parse(new TextDecoder().decode(reply.bytes)) as T; } catch { return undefined; }
};
const serverMessage = (reply: Reply, fallback: string): string => {
  const body = readJson<{ error?: unknown }>(reply);
  return typeof body?.error === 'string' && body.error ? body.error : fallback;
};

/** Shared stall clock + offline pause + abort for one transfer. */
const makeGuard = (net: Net, outer?: AbortSignal) => {
  const ctl = new AbortController();
  if (outer?.aborted) ctl.abort();
  outer?.addEventListener('abort', () => ctl.abort());
  let last = net.now();
  return {
    signal: ctl.signal,
    fail: () => ctl.abort(),
    touch: () => { last = net.now(); },
    /** Call before every attempt: waits while offline, throws on abort or ~10 min without progress. */
    gate: async () => {
      if (ctl.signal.aborted) throw abortError();
      if (!net.online()) { await net.waitOnline(ctl.signal); last = net.now(); }
      if (net.now() - last > STALL_MS) throw new TransferError('انتقال فایل متوقف شد. دوباره امتحان کنید.', 0);
    },
  };
};

/** Run `task(n)` for every item with a live-adjustable concurrency limit; first failure stops the rest. */
const runPool = (items: number[], limit: () => number, task: (n: number) => Promise<void>, fail: () => void): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const queue = [...items];
    let inflight = 0;
    let failure: unknown;
    let failed = false;
    const pump = () => {
      if (failed) { if (inflight === 0) reject(failure); return; }
      while (inflight < limit() && queue.length) {
        const n = queue.shift() as number;
        inflight++;
        task(n).then(
          () => { inflight--; pump(); },
          (error) => { inflight--; if (!failed) { failed = true; failure = error; fail(); } pump(); },
        );
      }
      if (!queue.length && inflight === 0) resolve();
    };
    pump();
  });

/** Concurrency 1..max: up after a clean fast chunk, down after a slow or retried one. */
const makeAdaptive = (max: number) => {
  let n = 1;
  return {
    limit: () => n,
    sample: (ms: number, clean: boolean) => {
      if (clean && ms < 2_500) n = Math.min(max, n + 1);
      else if (!clean || ms > 8_000) n = Math.max(1, n - 1);
    },
  };
};

// ---------------------------------------------------------------------------- upload

export type UploadOptions = {
  chatId: string;
  id: string;
  /** Total ciphertext bytes. */
  total: number;
  /** Ciphertext of chunk n, produced lazily (once per chunk; the bytes are kept only while that chunk is in flight). */
  encrypt: (n: number) => Promise<Uint8Array>;
  onProgress?: (fraction: number) => void;
  onSample?: (bytes: number, ms: number) => void;
  signal?: AbortSignal;
  net?: Net;
  maxConcurrency?: number;
};

type UploadStatus = { total: number; chunkBytes: number; received: number[]; complete: boolean };
type PutReply = { received?: number; total?: number; complete?: boolean };

/** 'done' = server holds the whole file; 'fallback' = no chunk route, use the old single PUT. */
export const uploadChunks = async (o: UploadOptions): Promise<'done' | 'fallback'> => {
  const net = o.net ?? realNet;
  const guard = makeGuard(net, o.signal);
  const adaptive = makeAdaptive(Math.max(1, Math.min(MAX_CONCURRENCY, o.maxConcurrency ?? MAX_CONCURRENCY)));
  const count = Math.max(1, Math.ceil(o.total / CIPHER_CHUNK));
  const base = `/api/chats/${encodeURIComponent(o.chatId)}/attachments/${encodeURIComponent(o.id)}`;
  const have = new Set<number>();
  let complete = false;
  let ackedBytes = 0;
  const lengthOf = (n: number) => Math.min(CIPHER_CHUNK, o.total - n * CIPHER_CHUNK);
  const mark = (n: number) => {
    if (have.has(n)) return;
    have.add(n);
    ackedBytes += lengthOf(n);
    guard.touch();
    o.onProgress?.(Math.min(1, ackedBytes / o.total));
  };

  /** GET status. null = could not tell (no upload yet, old server, network). */
  const status = async (): Promise<UploadStatus | null> => {
    try {
      const r = await exchange(net, `${base}/upload`, { method: 'GET' }, 10_000, guard.signal);
      const body = r.status === 200 ? readJson<UploadStatus>(r) : undefined;
      return body && Array.isArray(body.received) ? body : null;
    } catch (error) {
      if (guard.signal.aborted) throw error;
      return null;
    }
  };
  const absorb = (s: UploadStatus | null) => {
    if (!s) return;
    if (s.complete) complete = true;
    for (const n of s.received) if (Number.isInteger(n) && n >= 0 && n < count) mark(n);
  };

  const put = async (n: number): Promise<void> => {
    const data = await o.encrypt(n);
    if (data.length !== lengthOf(n)) throw new TransferError('ارسال فایل انجام نشد.', 0);
    for (let attempt = 0; ; attempt++) {
      await guard.gate();
      const started = net.now();
      try {
        const r = await exchange(net, `${base}/chunks/${n}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-total-length': String(o.total) },
          body: data as BodyInit,
        }, chunkTimeoutMs(data.length), guard.signal);
        if (r.status === 404 || r.status === 405) throw new TransferError('', r.status, true);
        if (r.status >= 200 && r.status < 300) {
          const ms = Math.max(1, net.now() - started);
          if (readJson<PutReply>(r)?.complete) complete = true;
          mark(n);
          o.onSample?.(data.length, ms);
          adaptive.sample(ms, attempt === 0);
          return;
        }
        if (!retryableStatus(r.status)) throw new TransferError(serverMessage(r, 'ارسال فایل انجام نشد.'), r.status);
      } catch (error) {
        if (!(error instanceof TransferError) || error.status !== 0 || guard.signal.aborted) throw error;
      }
      adaptive.sample(net.now() - started, false);
      await net.sleep(backoffMs(attempt, net.random), guard.signal);
    }
  };

  try {
    absorb(await status());
    for (let round = 0; round < 4 && !complete; round++) {
      const missing = Array.from({ length: count }, (_, n) => n).filter((n) => !have.has(n));
      if (missing.length) await runPool(missing, adaptive.limit, put, guard.fail);
      if (complete) break;
      // Every chunk acknowledged but no "complete": ask the server (lost last reply, or it is still finalizing).
      const s = await status();
      if (s && !s.complete) { have.clear(); ackedBytes = 0; }
      absorb(s);
      if (!complete && round > 0) await net.sleep(backoffMs(round, net.random), guard.signal);
    }
    if (!complete) throw new TransferError('ارسال فایل کامل نشد.', 0);
    o.onProgress?.(1);
    return 'done';
  } catch (error) {
    if (error instanceof TransferError && error.fallback) return 'fallback';
    throw error;
  }
};

// -------------------------------------------------------------------------- download

/** Finished ciphertext chunks kept across retries/reloads (db.chunks). */
export type ChunkStore = {
  get: (id: string, n: number) => Promise<Uint8Array | undefined>;
  put: (id: string, n: number, data: Uint8Array) => Promise<void>;
  clear: (id: string) => Promise<void>;
};

export type DownloadOptions<T> = {
  id: string;
  /** Total ciphertext bytes. */
  total: number;
  store: ChunkStore;
  /** Decrypt chunk n. A throw on cached bytes means "cache is bad" and the chunk is fetched again. */
  process: (n: number, cipher: Uint8Array) => Promise<T>;
  onProgress?: (fraction: number) => void;
  onSample?: (bytes: number, ms: number) => void;
  signal?: AbortSignal;
  net?: Net;
  concurrency?: number;
};

/** Chunk-aligned Range download; returns process() results in chunk order. Finished chunks are stored as they land. */
export const downloadChunks = async <T>(o: DownloadOptions<T>): Promise<T[]> => {
  const net = o.net ?? realNet;
  const guard = makeGuard(net, o.signal);
  const count = Math.max(1, Math.ceil(o.total / CIPHER_CHUNK));
  const results = new Array<T>(count);
  let doneBytes = 0;
  const lengthOf = (n: number) => Math.min(CIPHER_CHUNK, o.total - n * CIPHER_CHUNK);
  const finish = (n: number, value: T) => {
    results[n] = value;
    doneBytes += lengthOf(n);
    guard.touch();
    o.onProgress?.(Math.min(1, doneBytes / o.total));
  };

  const fetchChunk = async (n: number): Promise<Uint8Array> => {
    const from = n * CIPHER_CHUNK;
    const want = lengthOf(n);
    for (let attempt = 0; ; attempt++) {
      await guard.gate();
      const started = net.now();
      try {
        const r = await exchange(net, `/api/attachments/${encodeURIComponent(o.id)}`, { method: 'GET', headers: { range: `bytes=${from}-${from + want - 1}` } }, chunkTimeoutMs(want), guard.signal);
        if (r.status === 206 && r.bytes.length === want) { o.onSample?.(want, Math.max(1, net.now() - started)); return r.bytes; }
        if (r.status === 200 && r.bytes.length === o.total) { o.onSample?.(want, Math.max(1, net.now() - started)); return r.bytes.slice(from, from + want); } // server ignored Range
        if (r.status >= 400 && !retryableStatus(r.status)) throw new TransferError(serverMessage(r, 'فایل دریافت نشد.'), r.status);
        // 2xx with a wrong length = cut body: just try again
      } catch (error) {
        if (!(error instanceof TransferError) || error.status !== 0 || guard.signal.aborted) throw error;
      }
      await net.sleep(backoffMs(attempt, net.random), guard.signal);
    }
  };

  const one = async (n: number): Promise<void> => {
    const cached = await o.store.get(o.id, n);
    if (cached && cached.length === lengthOf(n)) {
      try { return finish(n, await o.process(n, cached)); } catch { /* bad cache, fetch again */ }
    }
    const fresh = await fetchChunk(n);
    const value = await o.process(n, fresh);
    await o.store.put(o.id, n, fresh);
    finish(n, value);
  };

  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, o.concurrency ?? 2));
  await runPool(Array.from({ length: count }, (_, n) => n), () => concurrency, one, guard.fail);
  return results;
};
