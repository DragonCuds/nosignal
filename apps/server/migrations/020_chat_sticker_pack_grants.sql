-- "Pack P has been shared into chat C" (019 is taken by another branch on main; 020 is intentional).
-- The sticker reference inside a message is end-to-end encrypted, so the server cannot see which pack a
-- message uses. When a member sends a sticker, the client records this one (chat, pack) grant, once.
-- Current members of chat C may then preview and add pack P. The server learns only that P was shared
-- into C by granted_by, not which message, which sticker, or when each sticker was sent.
CREATE TABLE chat_sticker_pack_grants (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (chat_id, pack_id)
);
CREATE INDEX chat_sticker_pack_grants_pack_idx ON chat_sticker_pack_grants (pack_id, chat_id);
