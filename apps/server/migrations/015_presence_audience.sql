-- A presence transition checks whether the subject has an active message in each
-- two-person direct chat. Keep that lookup bounded as message histories grow.
CREATE INDEX messages_presence_audience_idx
  ON messages (chat_id, sender_id) WHERE deleted_at IS NULL;
