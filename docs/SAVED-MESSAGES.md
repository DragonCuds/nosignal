# Saved Messages and people search (os-2)

Decision (3 lines):
1. A saved chat is an ordinary chat with ONE member (the owner), marked by a row in `saved_chats(user_id PK, chat_id UNIQUE)`. The `chats.type` column stays `'direct'` (no table rebuild: it would cascade-delete data inside the migration transaction); the API reports `type: "saved"`. DB triggers make sure nobody else can ever join it.
2. E2EE is unchanged: the client creates the chat key and wraps it to ITS OWN public key. `POST /api/chats/:id/crypto/envelopes` takes exactly ONE envelope (`recipientId` = own id) for a saved chat and two for a direct chat. `GET /api/chats/:id/crypto` returns `members` with only the owner, so the web's existing `establishKey`/`unwrapKey` work as they are.
3. Messages, attachments, edit, delete, read, realtime and `/api/sync` already only check `chat_members`, so they work for a single member without any change.

## JSON shapes

`POST /api/chats/saved` (no body) -> `201 {"id":"12","created":true}` the first time, `200 {"id":"12","created":false}` after.

`GET /api/chats` (saved chat has `peer: null`, `unreadCount` is always 0):
```json
[
  { "id": "12", "type": "saved", "createdAt": "2026-10-20T10:00:00.000Z", "peer": null, "unreadCount": 0, "lastMessage": null },
  { "id": "7", "type": "direct", "createdAt": "2026-10-01T09:00:00.000Z",
    "peer": { "id": "3", "username": "bob", "displayName": "Bob", "avatarPath": null },
    "unreadCount": 2, "lastMessage": { "id": "90", "chatId": "7", "senderId": "3", "kind": "text" } }
]
```
(`lastMessage` has the same fields as before.)

`GET /api/users/search?q=@ali` -> `200`, at most 20, never includes the caller, ordered exact match first then by username:
```json
[ { "id": "5", "username": "alice", "displayName": "Alice", "avatarPath": null } ]
```
Rules: leading `@` is stripped, text is lowercased, fewer than 3 characters or characters outside `[a-z0-9_]` give `[]` (not an error); missing `q` gives `400`. Matching is by username prefix (which includes an exact match). Rate limit 60/min.

`GET /api/users` -> same item shape, only people who share a chat with the caller (empty for a new user).

Messages in the saved chat use the same routes as any chat: `POST/GET /api/chats/12/messages`, `PATCH|DELETE /api/chats/12/messages/:id`, `POST /api/chats/12/read`, attachments under `/api/chats/12/attachments`.
Message objects are identical; `sender` is always the owner. Realtime events (`message.new` etc.) arrive for the owner as usual.

Web flow: tap «پیام‌های ذخیره‌شده» -> `POST /api/chats/saved` -> open chat `id` -> `GET /api/chats/:id/crypto`; if `envelope` is null, wrap the chat key to your own public key (one envelope, `recipientId` = your id) and POST it.
