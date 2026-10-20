-- Saved Messages: one private chat per user with a single member (the owner).
-- `chats.type` has CHECK (type = 'direct') and SQLite cannot alter a CHECK without a table rebuild.
-- This file runs inside the migration runner's transaction where foreign keys cannot be switched
-- off, so DROP TABLE chats would implicitly DELETE FROM chats and CASCADE away every member,
-- message, envelope, attachment and event. A rebuild is therefore unsafe; instead the chat row
-- keeps type 'direct' and this table marks it as saved. The API exposes it as type "saved".
-- Nothing existing is touched: ids, members, messages, FKs and indexes stay intact.
CREATE TABLE saved_chats (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A saved chat belongs to exactly its owner: nobody else can ever be added to it.
CREATE TRIGGER saved_chats_owner_only_member
BEFORE INSERT ON chat_members
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM saved_chats s WHERE s.chat_id = NEW.chat_id AND s.user_id <> NEW.user_id)
  OR (EXISTS (SELECT 1 FROM saved_chats s WHERE s.chat_id = NEW.chat_id)
      AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = NEW.chat_id))
BEGIN
  SELECT RAISE(ABORT, 'saved chat has a single member');
END;

-- A chat that already has other members cannot be turned into a saved chat.
CREATE TRIGGER saved_chats_must_be_single_member
BEFORE INSERT ON saved_chats
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = NEW.chat_id AND m.user_id <> NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'chat has other members');
END;
