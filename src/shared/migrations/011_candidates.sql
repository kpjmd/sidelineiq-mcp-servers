-- 011_candidates.sql
-- Phase 1 — the promotion path. A desk_candidate is a proposal that a given
-- injury entity is worth a physician-attributed "Injury Desk" deep-dive
-- (Tier 2). It is NOT a published artifact and NOT clinical content — it is a
-- queue row the MD triages (ACCEPT / DISMISS). The actual Tier 2 desk_post is
-- created in Phase 2 only after a candidate is accepted.
--
-- Candidates can be proposed two ways:
--   • manually — the MD clicks "Promote to Injury Desk" on a review-queue post
--     (Phase 1, first cut), or
--   • automatically — the poller proposes when promotion_score clears a
--     threshold (deferred; wired in a later cut).
--
-- promotion_score is a DIFFERENT objective from significance_score: significance
-- decides "should the machine publish this at all"; promotion_score decides
-- "does this conflict-flagged injury deserve Dr. Johnson's name on a breakdown".
-- reasons holds the per-term contributions so the Candidates UI and audit can
-- explain the ranking.

CREATE TABLE IF NOT EXISTS desk_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES injury_entities(id) ON DELETE CASCADE,
  -- The post that triggered the proposal (the conflict-flag / breaking row).
  -- Nullable because the entity is the durable subject; a post can be deleted.
  source_post_id UUID REFERENCES injury_posts(id) ON DELETE SET NULL,
  promotion_score NUMERIC(5,2) NOT NULL,
  reasons JSONB,
  status VARCHAR(16) NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','ACCEPTED','DISMISSED','PROMOTED')),
  proposed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMP WITH TIME ZONE,
  -- 'system' for auto-proposals, MD user id (or 'md') for human decisions.
  decided_by VARCHAR(128),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- At most one OPEN proposal per entity — re-proposing an entity that already
-- has a PROPOSED candidate updates that row's score in place rather than
-- piling up duplicates (the Keegan-Murray-churn lesson applied to the queue).
-- Decided rows (ACCEPTED/DISMISSED/PROMOTED) are exempt, so history is kept.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_candidate_per_entity
  ON desk_candidates(entity_id)
  WHERE status = 'PROPOSED';

CREATE INDEX IF NOT EXISTS idx_candidates_status_score
  ON desk_candidates(status, promotion_score DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_entity
  ON desk_candidates(entity_id, proposed_at DESC);
