# Private channels (os-8)

Encryption decision (3 lines, the owner decides):
1. Direct-chat E2EE needs one key envelope per member wrapped by an online member; a link-joiner has nobody to wrap it, so true E2EE for channels is not feasible in v1.
2. v1 uses a SERVER-HELD channel key: 32 random bytes per channel, wrapped (AES-256-GCM) with a key derived from SESSION_SECRET, given to members only via `GET /api/channels/:id/key` -> `{version:1,key:<base64url>}`. Clients encrypt posts with it using the normal v2 message shape; a DB-only leak shows ciphertext, but the server operator CAN read channel posts. Direct-chat E2EE is untouched.
3. Later upgrade path: rotate to per-member envelopes (like docs/GROUPS.md Plan B) and drop the endpoint.

Model: a channel is a `chats` row of type 'direct' (CHECK untouched) + `channels` + `channel_members(role)` + `channel_invites` (token stored hashed). Members are also in `chat_members`, so messages, sync, realtime and media access work unchanged; leave/remove deletes both rows. API reports `type: "channel"`. Direct-chat paths (`/api/users`, `POST /api/chats` lookup, `GET /api/chats` peer) exclude channel chats.

Roles: owner, admin (posts), member (reads). Posting/editing/deleting messages in a channel: owner/admin OK, member 403, non-member 404.

Routes: POST /api/channels {title} -> 201 {id, chatId}; GET/PATCH(title, avatarPath)/DELETE /api/channels/:id; POST /api/channels/:id/invites -> 201 {id, token}; DELETE .../invites/:invId; GET|POST /api/channels/join/:token (GET -> {title, memberCount}; POST -> {id, chatId}, idempotent); POST .../leave (owner gets 409); POST|DELETE .../admins/:userId; DELETE .../members/:userId; GET .../key. `/c/*` serves the SPA shell. GET /api/chats channel item: {id (chat id), type:"channel", channelId, title, avatarPath, role, memberCount, peer:null, unreadCount, lastMessage}.
Note: `id` in /api/chats is the CHAT id (use for messages); `/api/channels/:id` takes the CHANNEL id (returned by create/join as `id`, with `chatId` alongside). GET /api/chats items also carry `channelId` for this.
