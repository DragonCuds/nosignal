CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip_hash TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  authenticated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX sessions_token_hash_idx ON sessions (token_hash);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX sessions_user_id_idx ON sessions (user_id, created_at DESC);

CREATE TABLE chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'direct' CHECK (type = 'direct'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE chat_members (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX chat_members_user_id_idx ON chat_members (user_id, chat_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'sticker', 'gif', 'photo')),
  text TEXT,
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
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

CREATE INDEX messages_chat_id_id_desc_idx ON messages (chat_id, id DESC);
CREATE UNIQUE INDEX messages_encrypted_media_unique
  ON messages (encrypted_media_id) WHERE encrypted_media_id IS NOT NULL;

CREATE TABLE sticker_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  thumb_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE stickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('tgs', 'webm', 'webp')),
  emoji TEXT NOT NULL DEFAULT '',
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (pack_id, file_path)
);

CREATE INDEX stickers_pack_sort_idx ON stickers (pack_id, sort, id);

CREATE TABLE user_sticker_packs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, pack_id)
);

CREATE TABLE recent_stickers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sticker_id INTEGER NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, sticker_id)
);

CREATE INDEX recent_stickers_user_used_idx ON recent_stickers (user_id, used_at DESC);

CREATE TABLE gifs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mp4_path TEXT NOT NULL,
  poster_path TEXT NOT NULL,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX gifs_tags_idx ON gifs (tags);

CREATE TABLE saved_gifs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gif_id INTEGER NOT NULL REFERENCES gifs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, gif_id)
);

CREATE TABLE user_crypto_identities (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_jwk TEXT NOT NULL CHECK (json_valid(public_jwk)),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE chat_key_envelopes (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version = 1),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 32),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 40 AND 256),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (chat_id, recipient_id)
);

CREATE TABLE user_security (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret_enc BLOB,
  totp_enabled_at TEXT,
  last_totp_step INTEGER,
  CHECK ((totp_secret_enc IS NULL) = (totp_enabled_at IS NULL))
);

CREATE TABLE mfa_enrollments (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  secret_enc BLOB NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports) AND json_type(transports) = 'array'),
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);

CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id, created_at DESC);

CREATE TABLE webauthn_challenges (
  flow_hash TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'authenticate')),
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX webauthn_challenges_expires_idx ON webauthn_challenges (expires_at);

CREATE TABLE encrypted_chat_media (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_path TEXT NOT NULL UNIQUE CHECK (
    length(file_path) = 50
    AND substr(file_path, 1, 10) = 'encrypted/'
    AND substr(file_path, 47, 4) = '.bin'
    AND substr(file_path, 11, 36) NOT GLOB '*[^a-f0-9-]*'
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 17 AND 26214416),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX encrypted_chat_media_chat_idx ON encrypted_chat_media (chat_id, created_at DESC);

CREATE TABLE message_cipher_ids (
  cipher_id TEXT PRIMARY KEY CHECK (
    length(cipher_id) = 36
    AND substr(cipher_id, 9, 1) = '-'
    AND substr(cipher_id, 14, 1) = '-'
    AND substr(cipher_id, 19, 1) = '-'
    AND substr(cipher_id, 24, 1) = '-'
    AND length(replace(cipher_id, '-', '')) = 32
    AND replace(cipher_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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
