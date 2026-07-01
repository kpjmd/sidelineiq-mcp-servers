-- 014_injury_thread_dates.sql
-- Managed Session / Injury-Thread layer. Extends injury_entities (the existing
-- per-athlete injury index from 009) into a durable "injury thread": resolved
-- injury/surgery dates + provenance, the frozen OTM projection captured at
-- thread open, and the accuracy record computed when the athlete returns.
--
-- Why extend injury_entities instead of a new injury_threads table: the entity
-- row already keys on player_id + body_part + laterality + injury_type and owns
-- status/canonical_post_id/actual_return_date. injury_updates (009) is already
-- the append-only trajectory log (team_timeline_weeks, otm_min_weeks per report).
-- The thread is those two tables read together — no new store.
--
-- All columns are nullable or DEFAULTed and readers use SELECT * / COALESCE, so
-- an un-applied migration degrades gracefully. Lifecycle stays on the existing
-- status enum (ACTIVE=open, RESOLVED=returned, RETIRED=career-ended); we only add
-- returned_at/closed_at timestamps. actual_return_date already exists (009) —
-- reused, not duplicated.
--
-- Applied manually like 007-013: psql $DATABASE_URL -f this file.

-- Resolved injury/surgery dates (output of the pre-OTM Date Resolution Loop).
-- NOTE: distinct from injury_posts.injury_date (006), which is per-post; this is
-- the thread-level resolved anchor that drives conflict-flag accuracy.
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS injury_date DATE;
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS injury_date_confidence VARCHAR(16)
  NOT NULL DEFAULT 'unknown'
  CHECK (injury_date_confidence IN ('unknown','possible','probable','confirmed'));
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS surgery_date DATE;
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS surgery_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

-- Provenance of the resolution: which stage resolved it and the cited sources
-- (web_search citations). Shape: [{ url?, title?, stage: 'api'|'web_search'|'md_manual' }]
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS date_resolution_sources JSONB;

-- Frozen OTM projection captured at thread open. Shape:
--   { min_weeks, max_weeks, probability_week_2, probability_week_4,
--     probability_week_8, projected_return_date, created_at }
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS otm_projection JSONB;

-- Accuracy record, populated at thread close. Shape:
--   { projected_return_date, actual_return_date, error_days, within_range,
--     otm_min_weeks, otm_max_weeks }
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS accuracy_record JSONB;

-- Lifecycle timestamps beyond the status enum.
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS returned_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP WITH TIME ZONE;

-- Flags threads whose injury date could not be resolved → MD manual-input queue.
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS needs_date_review BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_entities_needs_date_review
  ON injury_entities(needs_date_review) WHERE needs_date_review = TRUE;
CREATE INDEX IF NOT EXISTS idx_entities_status_updated
  ON injury_entities(status, last_updated_at DESC);
