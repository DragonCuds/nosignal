-- Per-user media ownership. Packs and GIFs belong to exactly one user; byte_size feeds the per-user quota.
-- Nothing is deleted except user_sticker_packs links that pointed at a pack owned by someone else.
ALTER TABLE sticker_packs ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE stickers ADD COLUMN byte_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gifs ADD COLUMN byte_size INTEGER NOT NULL DEFAULT 0;

-- Existing packs stay with the user who already has them (lowest user id when several do);
-- a pack nobody has goes to the first user.
UPDATE sticker_packs SET owner_id = COALESCE(
  (SELECT min(up.user_id) FROM user_sticker_packs up WHERE up.pack_id = sticker_packs.id),
  (SELECT min(id) FROM users));

-- Existing GIFs: uploader if known, otherwise the earliest user who saved it, otherwise the first user.
UPDATE gifs SET owner_id = COALESCE(
  owner_id,
  (SELECT sg.user_id FROM saved_gifs sg WHERE sg.gif_id = gifs.id ORDER BY sg.created_at, sg.user_id LIMIT 1),
  (SELECT min(id) FROM users))
WHERE owner_id IS NULL;

-- A pack library link only makes sense for the owner.
DELETE FROM user_sticker_packs
WHERE pack_id IN (SELECT id FROM sticker_packs WHERE owner_id IS NOT NULL)
  AND user_id <> (SELECT p.owner_id FROM sticker_packs p WHERE p.id = user_sticker_packs.pack_id);

INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id, sort)
SELECT p.owner_id, p.id, 0 FROM sticker_packs p WHERE p.owner_id IS NOT NULL;

CREATE INDEX sticker_packs_owner_idx ON sticker_packs (owner_id);
CREATE INDEX gifs_owner_idx ON gifs (owner_id);
