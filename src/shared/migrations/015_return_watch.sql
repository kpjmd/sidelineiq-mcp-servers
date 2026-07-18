-- 015_return_watch.sql
-- Return Watch — a second desk_candidate flavor for entities that already have
-- a PUBLISHED desk_post and just received new activity (a status change or a
-- return-to-play resolution). Unlike a NEW_POST candidate, accepting a
-- RETURN_WATCH_UPDATE candidate does not create another desk_post — it routes
-- the MD to the EXISTING published post to append a dated follow-up entry
-- (desk_post_updates below), so a months-long recovery story stays a single,
-- already-ranking URL instead of spawning duplicate posts.
--
-- candidate_kind reuses desk_candidates rather than a parallel table: the
-- queue semantics (score, reasons, PROPOSED/ACCEPTED/DISMISSED, one open
-- candidate per entity) are identical for both kinds, and the existing
-- uniq_open_candidate_per_entity index (011) already gives Return Watch its
-- required dedup guardrail — an entity can't have two open candidates of
-- either kind stacked at once.
--
-- Applied manually like 007-014: psql $DATABASE_URL -f this file.

ALTER TABLE desk_candidates
  ADD COLUMN IF NOT EXISTS candidate_kind VARCHAR(24) NOT NULL DEFAULT 'NEW_POST'
    CHECK (candidate_kind IN ('NEW_POST', 'RETURN_WATCH_UPDATE'));

-- The already-PUBLISHED desk_post a RETURN_WATCH_UPDATE candidate targets.
-- NULL for NEW_POST (there is no existing post yet); required for
-- RETURN_WATCH_UPDATE (enforced below). ON DELETE SET NULL matches
-- source_post_id's existing pattern — the entity is the durable subject, not
-- this pointer.
ALTER TABLE desk_candidates
  ADD COLUMN IF NOT EXISTS target_desk_post_id UUID REFERENCES desk_posts(id) ON DELETE SET NULL;

ALTER TABLE desk_candidates
  DROP CONSTRAINT IF EXISTS chk_return_watch_target;
ALTER TABLE desk_candidates
  ADD CONSTRAINT chk_return_watch_target CHECK (
    (candidate_kind = 'NEW_POST' AND target_desk_post_id IS NULL) OR
    (candidate_kind = 'RETURN_WATCH_UPDATE' AND target_desk_post_id IS NOT NULL)
  );

-- Append-only dated follow-ups on a PUBLISHED desk_post — the updates[] array
-- of the (still-unbuilt) kpjmd JSON handoff, and the source that
-- assembleDeskHandoff (desk-handoff.ts) reads to populate desk_posts.draft_json.
-- No separate authorship-approval table: author_id + the desk_append_update
-- tool's server-side MD role re-derive is the gate, matching
-- desk_post_versions' existing edited_by pattern rather than inventing a
-- second attestation flow for a lower-stakes action.
CREATE TABLE IF NOT EXISTS desk_post_updates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  desk_post_id  UUID NOT NULL REFERENCES desk_posts(id) ON DELETE CASCADE,
  headline      VARCHAR(255) NOT NULL,
  markdown_body TEXT NOT NULL,
  -- The real-world date the update reflects (e.g. game date), distinct from
  -- created_at (when it was authored in the editor).
  occurred_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  author_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  content_hash  VARCHAR(64) NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_desk_post_updates_post
  ON desk_post_updates(desk_post_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_candidates_kind
  ON desk_candidates(candidate_kind, status);
