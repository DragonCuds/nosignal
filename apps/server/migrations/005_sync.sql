-- Idempotent send (client_msg_id) + global event log for /api/sync.
ALTER TABLE messages ADD COLUMN client_msg_id TEXT;

CREATE UNIQUE INDEX messages_sender_client_msg_id
  ON messages (sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('message.new', 'message.edited', 'message.deleted')),
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX events_created_at ON events (created_at);
CREATE INDEX events_chat_seq ON events (chat_id, seq);
