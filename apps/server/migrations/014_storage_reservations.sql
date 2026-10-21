-- In-flight one-shot attachments and encrypted chat media share a durable quota.
-- Committed bytes remain in their existing tables; chunked uploads remain in attachment_uploads.
CREATE TABLE storage_reservations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX storage_reservations_user_idx ON storage_reservations (user_id);
CREATE INDEX storage_reservations_expiry_idx ON storage_reservations (expires_at);
