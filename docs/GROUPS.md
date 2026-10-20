# Groups (gr-1 server, gr-2 web) — current design

A group is an ordinary `direct` chat row (`chats.type` is never changed or rebuilt) linked in `groups` (migration `010_groups.sql`), like channels. Members are in `chat_members` (so messages, sync, realtime, attachments and media work unchanged) and in `group_members` (role `owner|admin|member`). The API exposes it as chat type `"group"`. Code: `apps/server/src/groups.ts` plus small hooks in `chats.ts` and `crypto.ts`. Max 100 members (creator included).

## Encryption (end to end, WebCrypto only)
- The group key is a random AES-GCM 256 key created by the creator's client. For each member it is wrapped with ECDH(P-256, wrapper private key, member public key), exactly like the direct-chat envelopes in `apps/web/src/e2ee.ts`. The server stores only the wrapped blobs (`group_key_envelopes`) and never sees a key or plaintext.
- Messages use the normal v2 encrypted-message shape and carry the key version: the client sends `keyVersion` in the body of POST/PATCH message and receives it back as `encrypted.keyVersion` (also in `lastMessage` and sync). The server only accepts the CURRENT version.
- A new member gets an envelope for the CURRENT version only, so they cannot read older messages. A removed or departed member is cut off by rotation: the server marks `pendingKeyVersion` and refuses posting/adding until an owner/admin client uploads a new key covering exactly the current members.

## Honest limits
1. No forward secrecy: anyone who has held a key version can read every message of that version, forever.
2. Trust on first use: member public keys come from the server; there is no safety-number check yet, so a malicious server could substitute a key when a member is added.
3. Rotation only happens when an owner/admin client is online and opens the group; until then the group is read-only for posting (409) rather than letting a removed member keep reading.
4. A removed member keeps the old keys and old messages they already have.
5. Group titles, member lists, roles and message sizes/times are visible to the server.
6. Anyone who is a member can add nobody; only owner/admin add, but a malicious admin client can wrap a key it already holds for anyone it likes.

## API
All routes need a login; a non-member gets `404` on every route (a group you are not in does not exist).
- `GET /api/chats` item: `{ id (chat id), groupId, type:"group", title, avatarPath, role, memberCount, peer:null, unreadCount, lastMessage }`.
- `POST /api/groups {title, memberIds:[...], envelopes?:[{userId, wrapped}]}` -> `201 {id (groupId), chatId}`. Creator is owner; needs 1+ other members, max 100 total, every member must have an encryption identity (else `409`). With `envelopes` (one per member including the creator) version 1 is live immediately; without them the group is `pendingKeyVersion: 1` and the creator must `PUT /keys` version 1 before anyone can post.
- `GET /api/groups/:id` -> `{id, chatId, title, avatarPath, role, memberCount, keyVersion, pendingKeyVersion, members:[{id, username, displayName, role, publicKey}]}`.
- `PATCH /api/groups/:id {title}` (owner/admin). `DELETE /api/groups/:id` (owner). `POST /api/groups/:id/leave` (owner gets `409`).
- `POST /api/groups/:id/members {userId, envelope}` (owner/admin; `envelope` = current key wrapped for the new member; `409` if already member / full / rotation pending / no identity). `DELETE /api/groups/:id/members/:userId` (owner/admin, or yourself = leave; admins cannot remove admins or the owner). Removal or leave sets `pendingKeyVersion = keyVersion + 1`.
- `PUT /api/groups/:id/keys {version, envelopes:[{userId, wrapped}]}` (owner/admin) -> `204`. `version` must be `pendingKeyVersion` or `keyVersion + 1`; envelopes must cover every current member exactly. `GET /api/groups/:id/keys?version=<n|latest>` (omit = all) -> `[{version, wrapped, wrappedBy}]` (mine only).
- `POST/DELETE /api/groups/:id/admins/:userId` (owner only). Extra: `POST /api/groups/:id/owner/:userId` (owner only) transfers ownership; the old owner becomes admin (so the old owner can then leave).
- Messages: every member may post; only the sender edits; the sender or an owner/admin deletes. `POST /api/chats/:chatId/crypto/envelopes` (1:1 envelopes) returns `409` for a group chat.
