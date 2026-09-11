-- 022_confidence_range_checks.sql
-- Range CHECKs on the two confidence columns of injury_posts.
--
-- The gap it closes. md_review_confidence and rtp_confidence are DECIMAL(4,3)
-- (001:16, 001:23) with no CHECK anywhere, so the column accepts up to 9.999.
-- zod's .min(0).max(1) on web_create_injury_post and web_flag_for_md_review is
-- the only range enforcement, and it covers only callers that go through
-- tools/call — not a hand-applied UPDATE, a script, or a future tool that
-- forgets the bound. The failure is fail-OPEN: the agent's needsMDReview asks
-- `confidence < threshold`, which is false for anything above 1, so an
-- out-of-range post-level confidence publishes WITHOUT physician review.
--
-- Census before applying (2026-09-11, all statuses paged through the public
-- MCP endpoint): md_review_confidence 326 non-null, min 0.35 max 0.92;
-- rtp_confidence 509 non-null, min 0.00 max 0.93. Zero rows outside [0,1].
-- If that has changed, ADD CONSTRAINT fails loudly and names the constraint —
-- run the SELECT below, fix the rows by hand, then re-apply. Never widen the
-- bound to make it pass.
--
--   SELECT id, md_review_confidence, rtp_confidence FROM injury_posts
--   WHERE md_review_confidence NOT BETWEEN 0 AND 1
--      OR rtp_confidence NOT BETWEEN 0 AND 1;
--
-- NULL stays legal on purpose. 183 historical PUBLISHED rows have a NULL
-- md_review_confidence because web_create_injury_post silently stripped the key
-- the agent sent (fixed 2026-09-10, mcp #27 / agents #45). There is no source to
-- derive them from, and a CHECK that forbade NULL would force a fabricated
-- backfill.
--
-- Related, same day (mcp fix/review-status-on-create): createPost now writes
-- `status` and `md_review_reason` itself — 021's header note that "createPost
-- omits status entirely" was true when written and is not any more.

ALTER TABLE injury_posts ADD CONSTRAINT injury_posts_md_review_confidence_range
  CHECK (md_review_confidence IS NULL OR md_review_confidence BETWEEN 0 AND 1);

ALTER TABLE injury_posts ADD CONSTRAINT injury_posts_rtp_confidence_range
  CHECK (rtp_confidence IS NULL OR rtp_confidence BETWEEN 0 AND 1);
