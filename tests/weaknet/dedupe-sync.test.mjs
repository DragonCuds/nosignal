// Server: idempotent send (client_msg_id) and /api/sync catch-up / reset rules. Real routes, temp DB.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootApp, enc } from './helpers.mjs';

let S;
before(async () => { S = await bootApp({ routes: ['realtime', 'chats'], prefix: 'wn-dedupe' }); });
after(async () => { await S?.close(); });

const send = (chat, user, extra = {}) => S.json('POST', `/api/chats/${chat}/messages`, { user, body: { kind: 'text', encrypted: enc(), ...extra } });
const sync = async (since, user = 'a') => (await S.req('GET', `/api/sync${since === undefined ? '' : `?since=${since}`}`, { user })).json();
const state = {};

test('sync without cursor returns latest only', async () => {
  assert.deepEqual(await sync(), { events: [], latest: 0, reset: false });
  const r = await sync(0); assert.deepEqual(r.events, []); assert.equal(r.reset, false);
});

test('dedupe: same clientMsgId -> one row, one broadcast, same id', async () => {
  const body = { clientMsgId: 'abc12345-xyz', encrypted: enc() };
  const r1 = await send(1, 'a', body); const m1 = await r1.json();
  assert.equal(r1.status, 201); assert.equal(m1.clientMsgId, 'abc12345-xyz');
  state.m1 = m1;
  const r2 = await send(1, 'a', body); assert.equal(r2.status, 200); assert.equal((await r2.json()).id, m1.id);
  assert.equal((await send(1, 'a', { clientMsgId: 'abc12345-xyz' })).status, 200, 'retry with fresh cipher also dedupes');
  const [cnt] = (await S.db.query("SELECT count(*) AS n FROM messages WHERE client_msg_id = 'abc12345-xyz'")).rows;
  assert.equal(Number(cnt.n), 1);
  assert.equal(S.broadcasts.filter((e) => e.type === 'message.new').length, 1, 'one broadcast');
  assert.equal(S.broadcasts[0].seq, 1);
});

test('dedupe scope: per sender, id validation, id optional, other chat conflicts', async () => {
  assert.equal((await send(1, 'b', { clientMsgId: 'abc12345-xyz' })).status, 201);
  assert.equal((await send(1, 'a', { clientMsgId: 'short' })).status, 400);
  assert.equal((await send(1, 'a', { clientMsgId: 'bad id with spaces' })).status, 400);
  assert.equal((await send(1, 'a')).status, 201);
  assert.equal((await send(2, 'b', { clientMsgId: 'abc12345-xyz' })).status, 409, 'same sender id other chat');
});

test('dedupe: concurrent identical sends create exactly one message', async () => {
  const rs = await Promise.all([1, 2, 3, 4].map(() => send(1, 'a', { clientMsgId: 'concurrent-1' })));
  assert.deepEqual(rs.map((x) => x.status).sort(), [200, 200, 200, 201]);
});

test('edit/delete produce ordered events with seq', async () => {
  const { m1 } = state;
  assert.equal((await S.json('PATCH', `/api/chats/1/messages/${m1.id}`, { body: { encrypted: enc() } })).status, 200);
  assert.equal((await S.json('DELETE', `/api/chats/1/messages/${m1.id}`, {})).status, 200);
  assert.equal((await S.json('DELETE', `/api/chats/1/messages/${m1.id}`, {})).status, 404);
  assert.ok(S.broadcasts.every((e) => Number.isInteger(e.seq)));
  const r = await sync(0);
  assert.equal(r.latest, S.broadcasts.at(-1).seq); assert.equal(r.reset, false);
  assert.deepEqual(r.events.map((e) => e.seq), [...r.events.map((e) => e.seq)].sort((x, y) => x - y));
  assert.deepEqual(r.events.slice(-2).map((e) => e.type), ['message.edited', 'message.deleted']);
  assert.notEqual(r.events.at(-1).message.deletedAt, null);
});

test('sync: membership isolation, up-to-date, future cursor, bad input, auth', async () => {
  const m2 = await (await send(2, 'c')).json();
  let r = await sync(0, 'c'); assert.deepEqual(r.events.map((e) => e.chatId), ['2']); assert.equal(r.events[0].message.id, m2.id);
  r = await sync(0, 'a'); assert.ok(r.events.every((e) => e.chatId === '1'));
  const latest = r.latest;
  r = await sync(latest, 'a'); assert.deepEqual(r.events, []); assert.equal(r.reset, false);
  r = await sync(latest + 5, 'a'); assert.equal(r.reset, true, 'since in the future');
  assert.equal((await S.req('GET', '/api/sync?since=abc')).status, 400);
  assert.equal((await fetch(`${S.origin}/api/sync`)).status, 401);
  state.m2 = m2;
});

test('sync: more than 500 missed events -> reset; events older than the retained log -> reset', async () => {
  for (let i = 0; i < 505; i++) await S.db.query("INSERT INTO events (chat_id, type, message_id) VALUES (1, 'message.new', $1)", [state.m2.id]);
  let r = await sync(0, 'a'); assert.equal(r.reset, true); assert.deepEqual(r.events, []);
  r = await sync(r.latest - 10, 'a'); assert.equal(r.reset, false); assert.equal(r.events.length, 10);
  await S.db.query("UPDATE events SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days') WHERE seq <= 20");
  await S.sync.cleanupEvents();
  r = await sync(5, 'a'); assert.equal(r.reset, true, 'older than retained');
  r = await sync(20, 'a'); assert.equal(r.reset, false);
});
