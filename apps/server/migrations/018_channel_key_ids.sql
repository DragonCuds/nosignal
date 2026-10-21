-- Existing rows use the original SESSION_SECRET-derived wrapping key.
-- Rewrapping is performed by the application after this schema migration.
ALTER TABLE channels ADD COLUMN key_id TEXT NOT NULL DEFAULT 'legacy-session-v1';
CREATE INDEX channels_key_id_idx ON channels (key_id);
