# Weak-network research (2026-10-18)

Sources: Telegram MTProto/API docs, tweb + telegram-tt source, Signal Android, Discord gateway, Meta Messenger sync post, FOCI 2026 / Lantern / Amnezia on Iran filtering. Code audit of this repo at c0daca2.

## Current gaps (audit, ranked)
1. No client message id → lost response + retry = duplicate (web/src/api.ts:169, server/src/chats.ts:353).
2. No timeout/abort on any fetch/XHR → stalled link hangs forever (api.ts:123, :190, :211).
3. Upload = one PUT of whole ciphertext, buffered in memory, no resume (attachments/send.ts:45, server attachments/index.ts:171).
4. Reconnect refetch replaces list with last 50 → loses pending/failed/older pages; no `since` cursor (Conversation.tsx:170).
5. No app-level compression / immutable cache headers; SW does not cache emoji PNGs (server index.ts:108, service-worker.js).
6. Download all-or-nothing, photos auto-download full size (attachments/load.ts:90, :105).
7. No client heartbeat/connect timeout/visibilitychange; no fallback when WS blocked (web/src/realtime.ts).
8. No persisted outbox; stickers/GIFs/attachments vanish on failure (send.ts:53, Conversation.tsx:279, :290).

## Techniques (what the big ones do)
- **Idempotent send**: client random id + server dedupe (Telegram random_id/msg_id; Signal jobs retry until network). → `client_msg_id` UNIQUE(sender, id), INSERT OR IGNORE.
- **Outbox**: optimistic bubble pending/failed, persisted in IndexedDB, auto retry with backoff (telegram-tt sendMessageLocal / messageSendingStatePending).
- **Seq sync**: per-user monotonic event id; client resumes with `last_event_id`; server replays or says "too old → refetch" (Telegram pts + getDifference, Discord RESUME).
- **Heartbeat**: app-level ping ~15–20 s, timeout from measured RTT (floor ~10 s), reconnect on `online`/`visibilitychange`, full-jitter backoff cap 30 s.
- **Fallback transport**: after ~3 failed WS handshakes use SSE down + POST up; remember choice.
- **Chunk upload**: idempotent `PUT /up/:id/:n`, `GET /up/:id` bitmap, per-chunk timeout+retry, concurrency 1–3 adaptive (Telegram saveFilePart, 512 KB parts; we keep 256 KiB).
- **Chunk download**: Range aligned to chunks, decrypt per chunk, keep finished chunks in IndexedDB/OPFS to resume.
- **Media**: photo 1280 px q≈0.75 (HD 1600 opt-in), ThumbHash placeholder (~30 B), voice Opus 16–24 kbps mono, video via WebCodecs + mediabunny 720p ~1 Mbps (no ffmpeg.wasm).
- **Data saver**: tap-to-download for photos above a size, never auto video/files; default on when link is "poor" (own RTT/throughput EWMA; `navigator.connection` hint only).
- **Local cache**: Dexie; render chats/last N messages from cache, then sync (telegram-tt global cache 200 chats).
- **App shell**: vite-plugin-pwa precache, brotli static, `immutable` on hashed assets, cache emoji.
- **Encoding**: no permessage-deflate (ciphertext doesn't compress); binary frames / MessagePack optional (saves base64 33%).

## Iran constraints
- QUIC/HTTP3 fully blocked since 2025; plan for TCP/443 only. Matters later for calls/live (TURN over TCP/TLS 443).
- Whitelist-style filtering likely in shutdowns → domestic server + domestic domain is the safe deploy; zero third-party origins (no FCM push, no foreign CDN/fonts).
- Expect caps on long idle connections → graceful reconnect.

## Libraries worth using
Dexie (outbox/cache), ThumbHash, mediabunny (video), vite-plugin-pwa, optional partysocket / @msgpack/msgpack. Avoid: socket.io/Centrifugo (replace our WS), Replicache (maintenance), RxDB (heavy), Uppy, ffmpeg.wasm, tus (offset-based, we already chunk).
