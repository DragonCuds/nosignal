// End-to-end weak-link tests: tools/netsim/proxy.mjs (fixed --seed) sits between a client and a temp server.
//  (a) same clientMsgId retried through connection resets -> exactly one message row
//  (b) ~1.3 MB chunked upload through a flaky link, client retries + GET status resume -> file byte-equal
//  (c) /api/sync after a link cut returns every missed event, in order
// Profiles keep their name (flaky / cut) but timing is overridden so the whole file stays fast.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as C from '../../apps/web/src/attachments/crypto.ts';
import { bootApp, enc, sleep, startProxy } from './helpers.mjs';

const FC = 262160;
let S;
const proxies = [];
const proxy = async (...a) => { const p = await startProxy(S.port, ...a); proxies.push(p); return p; };
before(async () => { S = await bootApp({ routes: ['realtime', 'chats', 'attachments'], prefix: 'wn-proxy', env: { MAX_ATTACHMENT_MB: '4', USER_QUOTA_MB: '8' } }); });
after(async () => { for (const p of proxies) await p.stop(); await S?.close(); });

test('(a) same clientMsgId through resets until acknowledged -> exactly one message row', async (t) => {
  // flaky profile, connection killed after ~0.5 s on average instead of ~15 s
  const px = await proxy('flaky', ['--reset-mean', 0.5, '--stall-every', 0, '--down', 0, '--up', 0], 11);
  const ids = Array.from({ length: 6 }, (_, i) => `weak-${i}-${randomBytes(6).toString('hex')}`);
  // deterministic "request landed, reply lost": first message reaches the server directly and the client never sees the answer
  const lost = await S.json('POST', '/api/chats/1/messages', { body: { kind: 'text', clientMsgId: ids[0], encrypted: enc() } });
  assert.equal(lost.status, 201);
  let attempts = 0, failures = 0;
  const statuses = {};
  for (const id of ids) {
    let acked = false;
    for (let n = 0; n < 60 && !acked; n++) {
      attempts++;
      try {
        const r = await S.json('POST', '/api/chats/1/messages', { body: { kind: 'text', clientMsgId: id, encrypted: enc() }, base: px.origin, signal: AbortSignal.timeout(2500) });
        const body = await r.json();
        assert.ok(r.status === 200 || r.status === 201, `unexpected ${r.status}`);
        assert.equal(body.clientMsgId, id);
        (statuses[id] ??= []).push(r.status);
        acked = true;
      } catch (e) {
        if (e.name === 'AssertionError') throw e;
        failures++; // reset / timeout: retry with the SAME id, like the outbox does
      }
    }
    assert.ok(acked, `message ${id} never acknowledged`);
  }
  t.diagnostic(`attempts=${attempts} failed=${failures} proxy RESET lines=${px.count(/RESET/)}`);
  assert.equal(statuses[ids[0]][0], 200, 'message whose first reply was lost is deduped');
  for (const id of ids) {
    const rows = (await S.db.query('SELECT id FROM messages WHERE client_msg_id = $1', [id])).rows;
    assert.equal(rows.length, 1, `${id}: ${rows.length} rows`);
  }
  const total = (await S.db.query(`SELECT count(*) AS n FROM messages WHERE client_msg_id LIKE 'weak-%'`)).rows[0].n;
  assert.equal(Number(total), ids.length);
});

test('(b) 1.3 MB chunked upload through a flaky link, retry + status resume -> byte-equal file', async (t) => {
  const px = await proxy('flaky', ['--up', 300000, '--down', 300000, '--reset-mean', 2.5, '--stall-every', 0], 22);
  const id = randomBytes(16).toString('hex');
  const s = C.newAttachmentSecrets();
  const c = { key: await C.importAttachmentKey(s.key), noncePrefix: C.unb64u(s.noncePrefix), chatId: '1', id, size: 1_300_000 };
  const parts = [];
  for await (const p of C.encryptChunks(c, new Blob([randomBytes(c.size)]))) parts.push(Buffer.from(p));
  const cipher = Buffer.concat(parts);
  const total = cipher.length, count = Math.ceil(total / FC);
  assert.equal(count, 5);
  const via = (method, url, o = {}) => S.req(method, url, { base: px.origin, signal: AbortSignal.timeout(o.timeout ?? 4000), body: o.body, headers: o.headers });
  const chunkUrl = (n) => `/api/chats/1/attachments/${id}/chunks/${n}`;
  const stats = { puts: 0, failedPuts: 0, statusCalls: 0, rounds: 0 };
  let injected = false, done = false;
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 50_000) {
    stats.rounds++;
    // 1. ask the server what it already has (404 = nothing yet)
    let have = new Set();
    try {
      stats.statusCalls++;
      const r = await via('GET', `/api/chats/1/attachments/${id}/upload`);
      if (r.status === 200) { const j = await r.json(); have = new Set(j.received); done = j.complete; }
      else if (r.status !== 404) throw new Error(`status ${r.status}`);
    } catch { continue; }
    // 2. send only the missing chunks, one at a time
    for (let n = 0; n < count && !done; n++) {
      if (have.has(n)) continue;
      const body = cipher.subarray(n * FC, Math.min(total, (n + 1) * FC));
      // deterministic fault: the client gives up on chunk 2 mid-flight once
      const timeout = n === 2 && !injected ? (injected = true, 120) : 4000;
      stats.puts++;
      try {
        const r = await via('PUT', chunkUrl(n), { timeout, body, headers: { 'Content-Type': 'application/octet-stream', 'X-Total-Length': String(total) } });
        assert.ok([200, 201].includes(r.status), `chunk ${n} -> ${r.status}`);
        have.add(n);
        if (r.status === 201) done = true;
      } catch (e) {
        if (e.name === 'AssertionError') throw e;
        stats.failedPuts++;
        break; // back to GET status, like a resumed upload
      }
    }
  }
  t.diagnostic(`${JSON.stringify(stats)} proxy RESET lines=${px.count(/RESET/)} in ${Date.now() - t0} ms`);
  assert.ok(done, 'upload completed');
  assert.ok(stats.failedPuts >= 1, 'at least the injected fault was exercised');
  assert.ok(stats.rounds >= 2, 'resumed via GET status at least once');
  assert.deepEqual(await readFile(path.join(S.dataDir, 'attachments', id + '.bin')), cipher);
  const fin = await (await S.req('GET', `/api/chats/1/attachments/${id}/upload`)).json();
  assert.equal(fin.complete, true);
});

test('(c) /api/sync after a link cut returns all missed events in order', async (t) => {
  // cut profile: all connections dropped at 4 s for 2 s (instead of 60 s / 10 s)
  const px = await proxy('cut', ['--cut-every', 4, '--cut-len', 2], 33);
  // client A (user a) is connected via SSE through the proxy and has seen one event
  const frames = []; let closed = false;
  const sseReq = http.get(`${px.origin}/api/events`, { headers: { Cookie: `tel_session=${S.cookies.a}` } }, (r) => {
    r.on('data', (d) => frames.push(String(d)));
    r.on('close', () => { closed = true; });
    r.on('error', () => { closed = true; });
  });
  sseReq.on('error', () => { closed = true; });
  const seen = () => frames.join('').split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.seq !== undefined);
  for (let i = 0; i < 50 && !frames.length; i++) await sleep(50);
  const m0 = await (await S.json('POST', '/api/chats/1/messages', { user: 'b', body: { kind: 'text', encrypted: enc() } })).json();
  for (let i = 0; i < 50 && !seen().length; i++) await sleep(50);
  assert.ok(seen().some((e) => e.type === 'message.new' && e.message?.id === m0.id), 'client saw the live event');
  const cursor = Math.max(...seen().map((e) => e.seq));
  // the link is cut
  await px.waitFor(/CUT start/, 10_000);
  for (let i = 0; i < 40 && !closed; i++) await sleep(50);
  assert.ok(closed, 'SSE stream dropped by the cut');
  // missed period: others write while A is offline (sent straight to the server, not through the dead link)
  const missedMsgs = [];
  for (let i = 0; i < 5; i++) missedMsgs.push(await (await S.json('POST', '/api/chats/1/messages', { user: 'b', body: { kind: 'text', clientMsgId: `missed-${i}-${randomBytes(4).toString('hex')}`, encrypted: enc() } })).json());
  assert.equal((await S.json('PATCH', `/api/chats/1/messages/${missedMsgs[1].id}`, { user: 'b', body: { encrypted: enc() } })).status, 200);
  assert.equal((await S.json('DELETE', `/api/chats/1/messages/${missedMsgs[2].id}`, { user: 'b' })).status, 200);
  assert.equal((await S.json('POST', '/api/chats/2/messages', { user: 'c', body: { kind: 'text', encrypted: enc() } })).status, 201, 'chat A is not in');
  // A reconnects through the proxy: retries /api/sync?since=cursor until the link is back
  let failures = 0, res;
  const t0 = Date.now();
  while (!res && Date.now() - t0 < 15_000) {
    try {
      const r = await S.req('GET', `/api/sync?since=${cursor}`, { base: px.origin, signal: AbortSignal.timeout(1500) });
      if (r.status === 200) res = await r.json(); else failures++;
    } catch { failures++; await sleep(250); }
  }
  t.diagnostic(`cursor=${cursor} sync failed ${failures}x during cut, ok after ${Date.now() - t0} ms, proxy CUT lines=${px.count(/CUT start/)} refused=${px.count(/refused/)}`);
  assert.ok(res, 'sync succeeded after the cut');
  assert.ok(failures >= 1, 'sync was blocked by the cut at least once');
  const expected = (await S.db.query('SELECT seq, type FROM events WHERE seq > $1 AND chat_id = 1 ORDER BY seq', [cursor])).rows;
  assert.equal(expected.length, 7);
  assert.equal(res.reset, false);
  assert.deepEqual(res.events.map((e) => e.seq), expected.map((e) => Number(e.seq)));
  assert.deepEqual(res.events.map((e) => e.type), ['message.new', 'message.new', 'message.new', 'message.new', 'message.new', 'message.edited', 'message.deleted']);
  assert.deepEqual(res.events.slice(0, 5).map((e) => e.message.id), missedMsgs.map((m) => m.id));
  assert.ok(res.events.every((e) => e.chatId === '1'));
  assert.ok(res.events.every((e, i) => i === 0 || e.seq > res.events[i - 1].seq));
  assert.equal(res.latest, Math.max(...(await S.db.query('SELECT seq FROM events')).rows.map((r) => Number(r.seq))));
  // nothing more to fetch afterwards
  const again = await (await S.req('GET', `/api/sync?since=${res.events.at(-1).seq}`, { base: S.origin })).json();
  assert.deepEqual(again.events, []);
  sseReq.destroy();
});
