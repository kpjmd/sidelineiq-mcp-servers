-- 010_post_corrections.sql
-- Track corrections applied to published injury_posts (the Luka-class
-- legacy sweep). Every correction also writes an injury_updates row of
-- kind 'CORRECTION' for the timeline and an audit_log entry for replay.

ALTER TABLE injury_posts
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE injury_posts
  ADD COLUMN IF NOT EXISTS correction_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_injury_posts_corrected
  ON injury_posts(corrected_at DESC)
  WHERE corrected_at IS NOT NULL;
