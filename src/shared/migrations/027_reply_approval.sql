-- 027_reply_approval.sql
-- Gated replies, step two (agents docs/paratrOs Prognosis Ledger — Working
-- Spec.md, "Implementation handoff → Automation boundary": third-party replies
-- "require the physician's confirmation before anything is published"; "the
-- system records who confirmed and when").
--
-- 026 gave reply_proposals three states: pending → posted | discarded, with
-- 'posted' requiring the platform's id. That made the physician's decision
-- recordable only AFTER the post had gone out — the record followed the act.
-- This migration inserts the missing state so the record PRECEDES the act, the
-- same shape as a forecast publish:
--
--   pending ──(MD: web_decide_reply)──▶ approved ──(system claims, posts)──▶ posted
--      └──(MD)──▶ discarded
--
-- 'approved' carries decided_by/decided_at (the confirmation) and approved_text
-- (the MD's final wording, if edited). The agents' reply publisher may post ONLY
-- an approved proposal, and it first CLAIMS the row (post_attempted_at, set once
-- while NULL) so a double click or a retried request cannot post twice; a post
-- that fails clears the claim and records post_error so the MD can retry.
--
-- Applied manually like 007–026: psql $DATABASE_URL -f this file.
-- Deploy order: apply BEFORE deploying the mcp whose web_decide_reply emits
-- 'approved'; the old mcp never writes that value, so applying early is safe.

-- The 026 CHECK was declared inline, so its name is whatever Postgres generated
-- (normally reply_proposals_decision_check). Find it by definition and drop it
-- rather than depending on the name.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'reply_proposals'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%decision%'
    AND pg_get_constraintdef(oid) NOT LIKE '%posted_id%'
    AND pg_get_constraintdef(oid) NOT LIKE '%decided_by%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE reply_proposals DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE reply_proposals
  ADD CONSTRAINT reply_proposals_decision_check
    CHECK (decision IN ('pending','approved','posted','discarded'));

ALTER TABLE reply_proposals
  ADD COLUMN IF NOT EXISTS approved_text      TEXT,
  ADD COLUMN IF NOT EXISTS post_attempted_at  TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS post_error         TEXT;

-- An approval is a recorded confirmation: who and when, always.
ALTER TABLE reply_proposals
  DROP CONSTRAINT IF EXISTS reply_proposals_approved_complete;
ALTER TABLE reply_proposals
  ADD CONSTRAINT reply_proposals_approved_complete
    CHECK (decision <> 'approved' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));

-- Verification:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid = 'reply_proposals'::regclass AND contype = 'c';
--   -- expect reply_proposals_decision_check with four states,
--   --        reply_proposals_approved_complete, reply_proposals_posted_complete
--   SELECT count(*) FROM reply_proposals WHERE decision = 'approved';   -- 0 on apply
-- Behavioural proof: src/scripts/ledger-schema-check.ts (section "reply
-- proposals") shows pending→approved, a single claim, claim→posted, and a
-- second claim refused.
