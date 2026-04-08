ALTER TABLE injury_posts
  ADD COLUMN IF NOT EXISTS conflict_reason TEXT;

ALTER TABLE injury_posts
  ADD COLUMN IF NOT EXISTS team_timeline_weeks INTEGER;
