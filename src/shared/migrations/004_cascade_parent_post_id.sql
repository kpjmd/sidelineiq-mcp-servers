-- Recreate the injury_posts.parent_post_id self-FK with ON DELETE CASCADE.
-- This enables web_delete_injury_post's force:true path to cascade-delete
-- TRACKING descendants atomically inside Postgres. The default (non-force)
-- delete path still pre-checks for children and refuses, so cascade only
-- fires on deliberate intent.
--
-- md_reviews.post_id already has ON DELETE CASCADE from migration 002.
ALTER TABLE injury_posts
  DROP CONSTRAINT IF EXISTS injury_posts_parent_post_id_fkey;

ALTER TABLE injury_posts
  ADD CONSTRAINT injury_posts_parent_post_id_fkey
  FOREIGN KEY (parent_post_id)
  REFERENCES injury_posts(id)
  ON DELETE CASCADE;
