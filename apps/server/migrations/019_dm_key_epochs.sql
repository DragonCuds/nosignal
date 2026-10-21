-- NS-07: direct-chat key epochs.
-- A direct chat (and Saved Messages) now has numbered chat-key versions. Every envelope records the sender's public key
-- and fingerprint at the moment it was wrapped, so a contact can still open an old version after the sender started
-- fresh with a new identity (the receiving browser decides whether that old key was ever pinned; the server only stores it).
-- `direct_chat_keys` holds the current version and, after a member's identity reset, the version that must be created next.
-- Rebuilt with create / copy / drop / rename inside the migration transaction. No other table references
-- chat_key_envelopes, so DROP TABLE cascades to nothing.
CREATE TABLE chat_key_envelopes_new (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1 AND version <= 1000000),
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sender_fingerprint TEXT CHECK (
    sender_fingerprint IS NULL OR (length(sender_fingerprint) = 64 AND sender_fingerprint NOT GLOB '*[^a-f0-9]*')
  ),
  sender_public_jwk TEXT CHECK (sender_public_jwk IS NULL OR json_valid(sender_public_jwk)),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 32),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 40 AND 256),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (chat_id, version, recipient_id),
  CHECK ((sender_fingerprint IS NULL) = (sender_public_jwk IS NULL))
);

-- Existing rows are version 1. Before this migration a reset deleted every envelope of the resetting user's chats, so a
-- surviving envelope was always wrapped with the sender's current identity: copy it from user_crypto_identities.
-- A sender without an identity row gets NULL; the client then falls back to the sender's current server key.
INSERT INTO chat_key_envelopes_new (chat_id, version, recipient_id, sender_id, sender_fingerprint, sender_public_jwk, nonce, ciphertext, created_at)
SELECT e.chat_id, e.version, e.recipient_id, e.sender_id, ci.fingerprint, ci.public_jwk, e.nonce, e.ciphertext, e.created_at
FROM chat_key_envelopes e
LEFT JOIN user_crypto_identities ci ON ci.user_id = e.sender_id
ORDER BY e.chat_id, e.recipient_id;

DROP TABLE chat_key_envelopes;
ALTER TABLE chat_key_envelopes_new RENAME TO chat_key_envelopes;
CREATE INDEX chat_key_envelopes_recipient_idx ON chat_key_envelopes (recipient_id, chat_id, version);

CREATE TABLE direct_chat_keys (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  pending_version INTEGER CHECK (pending_version IS NULL OR pending_version > key_version)
);

-- A chat with envelopes has a key at version 1. Chats without envelopes get no row (their first key is created on first open).
INSERT INTO direct_chat_keys (chat_id, key_version, pending_version)
SELECT chat_id, max(version), NULL FROM chat_key_envelopes GROUP BY chat_id;
