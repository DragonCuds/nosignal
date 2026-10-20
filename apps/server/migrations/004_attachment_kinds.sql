-- Rebuild `messages` so `kind` also allows video / voice / file (attachment messages).
-- Everything else is unchanged: columns, CHECKs, indexes, the v2-ciphertext triggers and
-- attachment_id (added by 003). The runner wraps this file in a transaction, so foreign keys
-- cannot be switched off; DROP TABLE would cascade-delete message_cipher_ids, which is why it
-- is saved first and restored after the rebuild. reply_to_id points at messages_new so that
-- dropping the old table does not null it; the RENAME rewrites that self-reference to `messages`.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE message_cipher_ids_saved AS SELECT cipher_id, message_id, first_seen_at FROM message_cipher_ids;

CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'sticker', 'gif', 'photo', 'video', 'voice', 'file')),
  text TEXT,
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  reply_to_id INTEGER REFERENCES messages_new(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  edited_at TEXT,
  deleted_at TEXT,
  encryption_version INTEGER,
  nonce TEXT,
  ciphertext TEXT,
  encrypted_media_id TEXT REFERENCES encrypted_chat_media(id) ON DELETE RESTRICT,
  cipher_id TEXT CHECK (
    cipher_id IS NULL OR (
      length(cipher_id) = 36
      AND substr(cipher_id, 9, 1) = '-'
      AND substr(cipher_id, 14, 1) = '-'
      AND substr(cipher_id, 19, 1) = '-'
      AND substr(cipher_id, 24, 1) = '-'
      AND length(replace(cipher_id, '-', '')) = 32
      AND replace(cipher_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    )
  ),
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  CHECK (
    deleted_at IS NOT NULL OR (
      (encryption_version IS NULL AND nonce IS NULL AND ciphertext IS NULL
        AND kind = 'text' AND text IS NOT NULL AND length(trim(text)) > 0)
      OR
      (encryption_version IN (1, 2) AND nonce IS NOT NULL AND ciphertext IS NOT NULL
        AND text IS NULL AND length(nonce) BETWEEN 16 AND 32
        AND length(ciphertext) BETWEEN 23 AND 21846)
      OR kind <> 'text'
    )
  )
);

INSERT INTO messages_new (id, chat_id, sender_id, kind, text, payload, reply_to_id, created_at, edited_at, deleted_at,
                          encryption_version, nonce, ciphertext, encrypted_media_id, cipher_id, attachment_id)
SELECT id, chat_id, sender_id, kind, text, payload, reply_to_id, created_at, edited_at, deleted_at,
       encryption_version, nonce, ciphertext, encrypted_media_id, cipher_id, attachment_id
FROM messages ORDER BY id;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX messages_chat_id_id_desc_idx ON messages (chat_id, id DESC);
CREATE UNIQUE INDEX messages_encrypted_media_unique
  ON messages (encrypted_media_id) WHERE encrypted_media_id IS NOT NULL;
CREATE INDEX messages_attachment_id_idx ON messages (attachment_id) WHERE attachment_id IS NOT NULL;

CREATE TRIGGER messages_require_v2_insert
BEFORE INSERT ON messages
FOR EACH ROW
WHEN NEW.deleted_at IS NULL AND (
  NEW.encryption_version IS NOT 2
  OR NEW.cipher_id IS NULL
  OR length(NEW.cipher_id) <> 36
  OR NEW.cipher_id GLOB '*[^a-f0-9-]*'
  OR substr(NEW.cipher_id, 9, 1) <> '-'
  OR substr(NEW.cipher_id, 14, 1) <> '-'
  OR substr(NEW.cipher_id, 19, 1) <> '-'
  OR substr(NEW.cipher_id, 24, 1) <> '-'
  OR NEW.text IS NOT NULL
  OR NEW.nonce IS NULL
  OR length(NEW.nonce) <> 16
  OR NEW.nonce GLOB '*[^A-Za-z0-9_-]*'
  OR NEW.ciphertext IS NULL
  OR length(NEW.ciphertext) NOT BETWEEN 23 AND 21846
  OR NEW.ciphertext GLOB '*[^A-Za-z0-9_-]*'
)
BEGIN
  SELECT RAISE(ABORT, 'new messages must use valid v2 ciphertext');
END;

CREATE TRIGGER messages_require_v2_update
BEFORE UPDATE ON messages
FOR EACH ROW
WHEN NEW.deleted_at IS NULL AND (
  NEW.encryption_version IS NOT 2
  OR NEW.cipher_id IS NULL
  OR length(NEW.cipher_id) <> 36
  OR NEW.cipher_id GLOB '*[^a-f0-9-]*'
  OR substr(NEW.cipher_id, 9, 1) <> '-'
  OR substr(NEW.cipher_id, 14, 1) <> '-'
  OR substr(NEW.cipher_id, 19, 1) <> '-'
  OR substr(NEW.cipher_id, 24, 1) <> '-'
  OR NEW.text IS NOT NULL
  OR NEW.nonce IS NULL
  OR length(NEW.nonce) <> 16
  OR NEW.nonce GLOB '*[^A-Za-z0-9_-]*'
  OR NEW.ciphertext IS NULL
  OR length(NEW.ciphertext) NOT BETWEEN 23 AND 21846
  OR NEW.ciphertext GLOB '*[^A-Za-z0-9_-]*'
)
BEGIN
  SELECT RAISE(ABORT, 'messages must retain valid v2 ciphertext until deleted');
END;

CREATE TRIGGER messages_reject_reused_cipher_id_insert
AFTER INSERT ON messages
FOR EACH ROW
WHEN NEW.encryption_version = 2
BEGIN
  INSERT INTO message_cipher_ids (cipher_id, message_id) VALUES (NEW.cipher_id, NEW.id);
END;

CREATE TRIGGER messages_reject_reused_cipher_id_update
AFTER UPDATE OF cipher_id ON messages
FOR EACH ROW
WHEN NEW.encryption_version = 2
BEGIN
  INSERT INTO message_cipher_ids (cipher_id, message_id) VALUES (NEW.cipher_id, NEW.id);
END;

INSERT INTO message_cipher_ids (cipher_id, message_id, first_seen_at)
SELECT cipher_id, message_id, first_seen_at FROM message_cipher_ids_saved;
DROP TABLE message_cipher_ids_saved;
