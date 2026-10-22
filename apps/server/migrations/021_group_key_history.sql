-- NS-07b: group key history.
-- Every group key envelope now records the public key (and its fingerprint) of the member who wrapped it, as it was at the
-- moment of wrapping. A member who later starts fresh gets a new identity; the other members still open the older group key
-- versions with the stored key, but only if their own browser had pinned that fingerprint for the wrapper before (the server
-- only stores the key; it is never trusted to say who wrapped what).
-- Rebuilt with create / copy / drop / rename inside the migration transaction. No other table references
-- group_key_envelopes, so DROP TABLE cascades to nothing.
CREATE TABLE group_key_envelopes_new (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped TEXT NOT NULL,
  wrapped_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapper_fingerprint TEXT CHECK (
    wrapper_fingerprint IS NULL OR (length(wrapper_fingerprint) = 64 AND wrapper_fingerprint NOT GLOB '*[^a-f0-9]*')
  ),
  wrapper_public_jwk TEXT CHECK (wrapper_public_jwk IS NULL OR json_valid(wrapper_public_jwk)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, version, user_id),
  CHECK ((wrapper_fingerprint IS NULL) = (wrapper_public_jwk IS NULL))
);

-- Existing rows: copy the wrapper's CURRENT identity. Before this migration a reset never removed the resetting member's
-- envelopes, so a row wrapped by a member who started fresh since carries a key that does not match how it was wrapped; the
-- browser then fails to open that one envelope (as it did before) and loses nothing else. A wrapper without an identity row
-- gets NULL; the browser then falls back to the wrapper's current server key for that row.
INSERT INTO group_key_envelopes_new (group_id, version, user_id, wrapped, wrapped_by, wrapper_fingerprint, wrapper_public_jwk, created_at)
SELECT e.group_id, e.version, e.user_id, e.wrapped, e.wrapped_by, ci.fingerprint, ci.public_jwk, e.created_at
FROM group_key_envelopes e
LEFT JOIN user_crypto_identities ci ON ci.user_id = e.wrapped_by
ORDER BY e.group_id, e.version, e.user_id;

DROP TABLE group_key_envelopes;
ALTER TABLE group_key_envelopes_new RENAME TO group_key_envelopes;
CREATE INDEX group_key_envelopes_user_idx ON group_key_envelopes (user_id, group_id, version);
