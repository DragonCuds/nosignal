-- Chunked E2EE attachments (docs/ATTACHMENTS.md). The server stores opaque ciphertext only.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 16),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expired_at TEXT
);

CREATE INDEX attachments_uploader_idx ON attachments (uploader_id, expired_at);
CREATE INDEX attachments_chat_idx ON attachments (chat_id);

-- A message references its attachment by id (the server cannot read the encrypted payload).
-- NOTE for wire-up: messages.kind CHECK still lists only text/sticker/gif/photo.
ALTER TABLE messages ADD COLUMN attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL;
CREATE INDEX messages_attachment_id_idx ON messages (attachment_id) WHERE attachment_id IS NOT NULL;
