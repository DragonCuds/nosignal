-- Private channels. A channel is an ordinary 'direct' chat row (chats.type is never changed or
-- rebuilt) linked here; the API exposes it as type "channel". Members are in chat_members (so
-- messages, sync, realtime and media access work) AND in channel_members (role).
CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  avatar_path TEXT,
  key_wrapped TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE channel_members (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user_idx ON channel_members (user_id, channel_id);

CREATE TABLE channel_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);
CREATE INDEX channel_invites_channel_idx ON channel_invites (channel_id);

-- A channel's chat can never be a saved chat.
CREATE TRIGGER channels_not_saved
BEFORE INSERT ON channels
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM saved_chats s WHERE s.chat_id = NEW.chat_id)
BEGIN
  SELECT RAISE(ABORT, 'saved chat cannot be a channel');
END;
