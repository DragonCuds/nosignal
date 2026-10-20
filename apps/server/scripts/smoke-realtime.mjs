import { WebSocket } from 'ws';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:3050';
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
const { SMOKE_USER_A: usernameA, SMOKE_USER_B: usernameB, SMOKE_PASSWORD: password } = process.env;
if (!usernameA || !usernameB || !password) throw new Error('SMOKE_USER_A, SMOKE_USER_B, and SMOKE_PASSWORD are required');
const login = async (username) => {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const token = response.headers.get('set-cookie')?.match(/tel_session=([^;]+)/)?.[1];
  if (!response.ok || !token) throw new Error(`login for ${username} failed`);
  return token;
};
const api = async (token, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { cookie: `tel_session=${token}`, ...(options.headers ?? {}) } });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const connect = (token) => new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl, { headers: { Cookie: `tel_session=${token}` } });
  socket.once('open', () => resolve(socket)); socket.once('error', reject);
});
const tokenA = await login(usernameA); const tokenB = await login(usernameB);
const peer = (await api(tokenA, '/api/users')).find((user) => user.username === usernameB);
if (!peer) throw new Error(`could not find ${usernameB}`);
const chat = await api(tokenA, '/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: peer.id }) });
const socketA = await connect(tokenA); const socketB = await connect(tokenB);
try {
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('B did not receive message.new within 200 ms')), 200);
    socketB.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'message.new' && event.chatId === chat.id) { clearTimeout(timeout); resolve({ event, receivedAt: process.hrtime.bigint() }); } });
  });
  const sentAt = process.hrtime.bigint();
  await api(tokenA, `/api/chats/${chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'text', text: 'realtime smoke message' }) });
  const { event, receivedAt } = await received;
  const elapsedMs = Number(receivedAt - sentAt) / 1e6;
  if (elapsedMs >= 200) throw new Error(`message.new took ${elapsedMs.toFixed(1)} ms`);
  console.log(JSON.stringify({ ok: true, event: event.type, chatId: chat.id, receivedInMs: Number(elapsedMs.toFixed(1)) }));
} finally { socketA.close(); socketB.close(); }
