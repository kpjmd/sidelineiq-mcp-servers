-- 021_injury_posts_retirement.sql
-- Adds two post statuses that both mean "this row never reached an audience
-- and is not a live queue item": REJECTED and SUPERSEDED.
--
-- The gap they close. injury_posts.status has only ever held PUBLISHED and
-- PENDING_REVIEW in production (census on 2026-08-24: 448 / 7 of 455 rows; no
-- DRAFT row has ever been written, because createPost omits status entirely and
-- takes the column default, and flagForMdReview is the only writer of
-- PENDING_REVIEW). There was no way to record a decision that a post should NOT
-- publish, so:
--
--   REJECTED — the MD's Reject button called web_delete_injury_post, a hard
--   DELETE. The agent's findEquivalentPendingReview (agents
--   src/utils/publishing-pipeline.ts) suppresses re-filing a review item while
--   an equivalent one sits PENDING_REVIEW, and rejection deleted exactly the
--   row that suppression anchors on. Rejecting was therefore the one action
--   that guaranteed the story came back on the next 6h poll, forever.
--
--   SUPERSEDED — a pending item can be overtaken by events. Alvin Kamara,
--   2026-08-21: TRACKING c59cba69 filed to PENDING_REVIEW at 12:26 (thread
--   b8d94a3f, 4 weeks); TRACKING caf3fee4 PUBLISHED at 12:41 on the same
--   thread with the same timeline. The pending item was now a duplicate of
--   published content and approving it would have double-posted to Farcaster
--   and X. It was rejected by hand instead — which, per the above, hard-deleted
--   it, and is why its row cannot be recovered as a test fixture.
--
-- Why a status and not a DELETE — the same argument 020 makes for VOID.
-- md_reviews.post_id is ON DELETE CASCADE (002:15), so deleting the post erased
-- the review row too: the record that an MD looked at this and said no was the
-- thing being destroyed. Keeping the row is what gives the queue a memory and
-- the MD an audit trail.
--
-- Consequence the callers must handle, spelled out because it is not obvious:
-- both FKs back to injury_posts are ON DELETE SET NULL
-- (injury_entities.canonical_post_id 009:21, injury_updates.post_id 009:39), so
-- the DELETE was performing a cleanup that nothing else does. Stop deleting and
-- an entity stays anchored to a rejected post — updateThreadDates only backfills
-- canonical_post_id when it is NULL — and shouldVoidThreadOnReject reads a
-- previously-rejected post's injury_updates row as "other coverage exists" and
-- refuses to void, silently re-opening the Greenard failure mode 020 fixed.
-- rejectPost therefore performs that nulling explicitly. This migration cannot
-- enforce it; the tests in web-retirement.test.ts do.
--
-- Applied manually like 007-020: psql $DATABASE_URL -f this file.
--
-- Pre-flight — must return only PUBLISHED and PENDING_REVIEW before running:
--   SELECT status, COUNT(*) FROM injury_posts GROUP BY 1 ORDER BY 2 DESC;

-- 001:20 declared status as a bare VARCHAR(50) DEFAULT with NO constraint, so
-- there is nothing to drop on a first run; the DROP is here for re-runs. The
-- whole safety argument for these statuses rests on "only these five exist" —
-- every reader is an allowlist or an exclusion against that set — and an
-- unconstrained column lets a typo in any of the three repos create a sixth
-- that every allowlist ignores and every exclusion misses.
ALTER TABLE injury_posts DROP CONSTRAINT IF EXISTS injury_posts_status_check;
ALTER TABLE injury_posts ADD CONSTRAINT injury_posts_status_check
  CHECK (status IN ('PUBLISHED','PENDING_REVIEW','DRAFT','REJECTED','SUPERSEDED'));

-- DRAFT stays in the list although no row has ever used it: it is in
-- statusEnum (servers/web/tools.ts) and in the frontend's PostStatus, and
-- making the constraint stricter than the tool schema would turn a valid tool
-- call into a database error. Removing it is a separate decision.

-- When the row was retired. NOT created_at, which is filing time and would
-- often leave no suppression window at all, and NOT updated_at, which
-- web_update_injury_post and the social-hash writeback both bump — the
-- 21-day rejection window would silently stretch every time one ran.
-- Nullable: only retired rows carry one.
ALTER TABLE injury_posts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- Why, in the MD's words for a rejection and the pipeline's for a supersede.
ALTER TABLE injury_posts ADD COLUMN IF NOT EXISTS retirement_reason TEXT;

-- The post that published instead. SUPERSEDED rows only. ON DELETE SET NULL to
-- match the two existing self-references; a superseding post that is itself
-- later deleted must not take the audit row with it.
ALTER TABLE injury_posts ADD COLUMN IF NOT EXISTS superseded_by UUID
  REFERENCES injury_posts(id) ON DELETE SET NULL;

-- 002:17-18 declared this CHECK inline, so Postgres auto-named it
-- md_reviews_status_check. Confirm before running if you want to be sure:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'md_reviews'::regclass AND contype = 'c';
-- A rename would make the DROP a silent no-op and the ADD would then fail on
-- the duplicate name — which is the safe direction to fail.
--
-- A review row is closed as SUPERSEDED, not REJECTED: no MD rejected it. The
-- distinction is what lets the queue show "published instead →" rather than
-- implying a clinical judgement nobody made.
ALTER TABLE md_reviews DROP CONSTRAINT IF EXISTS md_reviews_status_check;
ALTER TABLE md_reviews ADD CONSTRAINT md_reviews_status_check
  CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED'));

-- idx_injury_posts_status (001:31) already leads with status, so REJECTED and
-- SUPERSEDED rows drop out of the PUBLISHED/PENDING_REVIEW lookups by the same
-- index scan. No new index needed.
