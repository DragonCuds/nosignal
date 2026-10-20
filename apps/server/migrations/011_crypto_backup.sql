-- Optional server-side copy of the user's E2EE identity key, wrapped CLIENT-side with a key derived
-- from the login password (PBKDF2). The server only stores the opaque wrapped blob.
-- mode 'auto'   = a copy is kept here (default for everyone).
-- mode 'manual' = "more security" mode: the user deleted the copy and keeps a recovery key/file; blob columns are NULL.
-- No row at all = never backed up (treated as 'auto' by the client).
CREATE TABLE user_crypto_backups (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual')),
  salt TEXT,
  iterations INTEGER,
  wrapped TEXT,
  version INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (mode = 'manual' AND salt IS NULL AND iterations IS NULL AND wrapped IS NULL AND version IS NULL)
    OR (mode = 'auto' AND (
      (salt IS NULL AND iterations IS NULL AND wrapped IS NULL AND version IS NULL)
      OR (salt IS NOT NULL AND iterations IS NOT NULL AND wrapped IS NOT NULL AND version IS NOT NULL)))
  )
);
