-- Groups. Like channels: a group is an ordinary 'direct' chat row (chats.type is never changed or
-- rebuilt) linked here; the API exposes it as type "group". Members are in chat_members (so
-- messages, sync, realtime, attachments and media work unchanged) AND in group_members (role).
-- The group key is end-to-end: the server only stores per-member wrapped envelopes.
-- key_version = newest version whose envelopes are uploaded (0 = not keyed yet);
-- pending_version = a rotation is required (set after a removal/leave) until an admin uploads it.
CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  avatar_path TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL DEFAULT 0,
  pending_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members (user_id, group_id);

CREATE TABLE group_key_envelopes (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped TEXT NOT NULL,
  wrapped_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, version, user_id)
);
CREATE INDEX group_key_envelopes_user_idx ON group_key_envelopes (user_id, group_id, version);

-- Which group key version encrypted a message (NULL for non-group chats).
ALTER TABLE messages ADD COLUMN key_version INTEGER;

-- A group's chat can never be a saved chat or a channel.
CREATE TRIGGER groups_not_saved
BEFORE INSERT ON groups
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM saved_chats s WHERE s.chat_id = NEW.chat_id)
  OR EXISTS (SELECT 1 FROM channels c WHERE c.chat_id = NEW.chat_id)
BEGIN
  SELECT RAISE(ABORT, 'saved chat or channel cannot be a group');
END;
