# Attachments design (photo, voice, video, file) — v1

Status: design for task M5. Written 2026-10-14.

## Goals
- Works with **no international internet**, on cheap Iranian servers (small disk, modest RAM).
- **End-to-end encrypted**: the server stores opaque bytes only.
- **Efficient on phones**: never hold a whole big file in memory, resumable upload, seekable playback, small photos.
- Same code path for private chats and (later) groups.

## Message shape
Attachments ride inside the existing encrypted message. The message `kind` is one of `photo | video | voice | file` (stickers/GIFs unchanged). The decrypted payload:

```jsonc
{
  "attachment": {
    "version": 2,
    "id": "<upload id, 32 hex>",        // where the ciphertext lives on the server
    "key": "<base64url 32 bytes>",       // random per attachment, never reused
    "noncePrefix": "<base64url 8 bytes>",
    "chunkSize": 262144,                 // plaintext bytes per chunk
    "size": 1234567,                     // plaintext bytes
    "mime": "image/webp",
    "name": "IMG_1.webp",                // files only; sanitized (no path chars, ≤ 120 chars)
    "w": 1280, "h": 960,                 // photo/video
    "durationMs": 14200,                 // voice/video
    "waveform": "<64 bytes base64url>",  // voice only
    "thumb": "<base64url ≤ 2 KB>"        // tiny blurred preview (photo/video poster)
  },
  "caption": "optional text"
}
```

Because key + metadata live inside the E2EE message, forwarding an attachment = re-sending the same payload (no re-upload), and removing the message does not leak the key to anyone new.

The old single-blob format (`encryptedMedia` v1, `/api/encrypted-media/:id`) stays **readable**; no new messages use it.

## Chunked encryption
- Plaintext is cut into chunks of 256 KiB (last chunk shorter).
- Chunk *i* is encrypted with AES-256-GCM using the attachment key.
  - Nonce (12 bytes) = `noncePrefix (8)` ‖ `i` as big-endian uint32.
  - AAD = `"tel:att:v2" ‖ chatId ‖ id ‖ i ‖ lastFlag` (lastFlag = 1 for the final chunk). This stops reordering, truncation and cross-chat replay.
- Stored ciphertext = chunks concatenated; each chunk is `plaintextLen + 16` bytes, so chunk *i* starts at `i × (262144 + 16)` — the server can serve any byte range without knowing anything.
- Max chunks 2³² − 1 → far beyond our size cap.

## Upload
- **tus** resumable protocol (`@tus/server` on Fastify under `/api/uploads`, `tus-js-client` in the browser), uploading **ciphertext**.
- Create request needs: valid session, trusted Origin, chat membership, declared size ≤ `MAX_ATTACHMENT_MB` (default 100), user quota not exceeded (default 2 GB of *live* attachments).
- Upload id is random and unguessable; nothing in the filename or metadata is plaintext (`Upload-Metadata` carries only the chat id).
- The browser encrypts chunk by chunk while uploading (stream), so memory stays flat.
- An upload not referenced by any message within 1 hour is deleted (hourly cleanup job). The sender can still view their own fresh upload during that hour (as v1 does).
- Optional `ATTACHMENT_RETENTION_DAYS`: attachments older than N days are deleted from disk; the message stays and shows "file expired".

## Download / playback
- `GET /api/attachments/:id` with HTTP `Range`, membership checked through the message that references it (same rule as v1). `Cache-Control: private, no-store`, `Content-Disposition: attachment`, `nosniff`.
- **Service Worker streaming:** the page registers `/_att/:id` handling in the existing service worker. The page sends the key to the worker with `postMessage` (kept in memory only, forgotten when the worker stops). The worker fetches the needed ciphertext range, decrypts, and answers the `<video>`/`<audio>` element's Range requests. Result: seeking works, memory stays small, big files play without full download.
- Fallback when the worker is unavailable: download all chunks sequentially into a Blob (cap 100 MB) and play from an object URL.
- Decrypted photos are cached as Blobs in memory (LRU, ≈ 50 MB); optionally in Cache Storage encrypted-at-rest is **not** done in v1 (documented limitation).

## Per-type rules (all client-side)
- **Photo:** decode, apply EXIF orientation, resize to max 1600 px long edge, encode WebP q≈0.8 (JPEG q0.82 if WebP encode unsupported). Strip metadata (GPS etc.) by re-encoding. Blur preview: 24 px wide, ≤ 2 KB, stored in `thumb`. Optional "send original" for files > cap is **not** offered; use "send as file" instead.
- **Voice:** `MediaRecorder` with the first supported of `audio/webm;codecs=opus`, `audio/mp4` (Safari). Mono, target 24–32 kbps. Max 10 min. Waveform = 64 peak values computed from decoded audio. Hold-to-record, slide-to-cancel, lock.
- **Video:** poster frame (first usable frame) → `thumb`. If file > 30 MB (or > 720p) and the browser can encode H.264/AAC through WebCodecs (Mediabunny), transcode to 720p, ~2 Mbps; else send as-is if ≤ cap, else tell the user the limit and offer "send as file". Duration and size shown before sending.
- **File:** any type, name sanitized, shown with icon by extension, never executed or inlined. Download uses `Content-Disposition: attachment`.

## Server limits and config
| Setting | Default |
|---|---|
| `MAX_ATTACHMENT_MB` | 100 |
| `USER_QUOTA_MB` | 2048 |
| `ATTACHMENT_RETENTION_DAYS` | off |
| Voice max length | 10 min (client) |
| Chunk size | 256 KiB (fixed in v2) |

## What the server can still see
Who sent an attachment to which chat, when, its **ciphertext size** (≈ file size), and upload/download timing. It cannot see type, name, content, or key. The chat/sticker catalogue visibility is unchanged.

## Security notes
- A new key + nonce prefix per attachment → no nonce reuse across files.
- Truncation, reordering, swapping chunks between files/chats all fail GCM verification (tests required in M5.1).
- SW key handling: never write the key to Cache Storage/IndexedDB; the worker discards it on `activate`/idle.
- Content sniffing: the browser only ever sees our decrypted bytes under a MIME type taken from the encrypted metadata and re-validated against an allow-list (`image/*`, `audio/*`, `video/*` for inline; everything else forced to download).
- No thumbnails/previews are generated server-side (it cannot read the file) → `ffmpeg` is **not** needed for chat attachments.

## Open questions (decide while building; default in brackets)
- Show "download original" for photos? [no]
- Auto-download rules (Wi-Fi only etc.)? [photos/voice auto, video/file tap-to-download]
- Resumable *download* after a break? [Range handles it]
