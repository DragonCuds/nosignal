CREATE TABLE crypto_action_grants (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('backup.replace', 'backup.delete', 'identity.reset')),
  backup_revision INTEGER NOT NULL,
  password_hash TEXT NOT NULL,
  mfa_enabled INTEGER NOT NULL CHECK (mfa_enabled IN (0, 1)),
  expires_at TEXT NOT NULL
);
CREATE INDEX crypto_action_grants_expires_idx ON crypto_action_grants (expires_at);

CREATE TABLE crypto_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('backup.created', 'backup.replaced', 'backup.deleted', 'identity.reset')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX crypto_security_events_user_idx ON crypto_security_events (user_id, id DESC);
