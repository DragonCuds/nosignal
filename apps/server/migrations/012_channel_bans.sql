-- A member removed (kicked) by the channel owner cannot rejoin with an old invite link.
-- Leaving on your own does not ban. The owner can lift the ban (DELETE /api/channels/:id/bans/:userId).
CREATE TABLE channel_bans (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  banned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel_id, user_id)
);
