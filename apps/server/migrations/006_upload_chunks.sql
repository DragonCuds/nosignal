-- Resumable chunked uploads (docs/WEAK-NET.md C4). A row lives from the first chunk until the
-- last chunk lands and the file is promoted to `attachments` (or the hourly cleanup drops it).
CREATE TABLE attachment_uploads (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 16),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
  finalizing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX attachment_uploads_uploader_idx ON attachment_uploads (uploader_id);
CREATE INDEX attachment_uploads_updated_idx ON attachment_uploads (updated_at);

CREATE TABLE attachment_upload_chunks (
  upload_id TEXT NOT NULL REFERENCES attachment_uploads(id) ON DELETE CASCADE,
  n INTEGER NOT NULL CHECK (n >= 0),
  PRIMARY KEY (upload_id, n)
) WITHOUT ROWID;
