-- 020_injury_entities_void.sql
-- Adds a fourth entity status: VOID — "this thread should never have existed."
--
-- The gap it closes. injury_entities has three statuses (009:17-18): ACTIVE,
-- RESOLVED (athlete returned), RETIRED (career ended). All three assert that
-- the injury was REAL. Nothing said "we made this up." That mattered because
-- entities are minted BEFORE any post exists — resolveThreadAndDates
-- (agents/src/monitoring/poller.ts) creates the row pre-OTM so the date
-- resolver has somewhere to write — and because the MD's Reject button
-- (frontend app/api/admin/reject/[postId]) calls web_delete_injury_post, whose
-- FKs are ON DELETE SET NULL on both injury_entities.canonical_post_id (009:21)
-- and injury_updates.post_id (009:39). Rejecting a post therefore left its
-- entity ACTIVE, post-less, and still inside the 21-day match window of
-- web_find_matching_entity — which filters on status = 'ACTIVE'.
--
-- The live case this was written for: entity eac3cc8a-bfb6-4123-b6b1-85b63637606b
-- (Jonathan Greenard) carried body_part 'back' / injury_type 'surgery' /
-- surgery_confirmed, from an ESPN row whose comment reads "Greenard (pectoral)
-- won't be BACK at practice". Its post was rejected by the MD and deleted; the
-- entity survived with canonical_post_id NULL. Every 6h poll since re-matched
-- it and appended a CORRECTION update with post_id NULL (7 of them between
-- Aug 16-18 2026), each bumping last_updated_at and so renewing the match
-- window indefinitely. A genuine pectoralis report would have been absorbed
-- into the false thread instead of publishing.
--
-- Why a status and not a DELETE. injury_updates, desk_candidates (011:22) and
-- desk_posts (013:26) all cascade off injury_entities; deleting the row erases
-- the record that we got it wrong, which is exactly what the audit trail is
-- for. VOID keeps the row readable and out of matching.
--
-- Why not reuse RESOLVED/RETIRED: closeThread computes accuracy_record against
-- the frozen otm_projection. Scoring a projection that was never valid pollutes
-- the accuracy record the platform is judged on. The VOID path writes no
-- accuracy_record and no returned_at (see client.ts closeThread).
--
-- Applied manually like 007-019: psql $DATABASE_URL -f this file.

-- 009 declared the CHECK inline on the column, so Postgres auto-named it
-- <table>_<column>_check. Confirm before running if you want to be sure:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'injury_entities'::regclass AND contype = 'c';
-- A rename would make the DROP a silent no-op and the ADD would then fail on
-- the duplicate name — which is the safe direction to fail.
ALTER TABLE injury_entities DROP CONSTRAINT IF EXISTS injury_entities_status_check;
ALTER TABLE injury_entities ADD CONSTRAINT injury_entities_status_check
  CHECK (status IN ('ACTIVE','RESOLVED','RETIRED','VOID'));

-- Why the thread was voided, in the MD's words. Nullable: only VOID rows carry
-- one, and closeThread only writes it on the VOID path.
ALTER TABLE injury_entities ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- idx_entities_player_status (009:29-30) and idx_entities_status_updated
-- (014:54-55) both lead with status, so VOID rows drop out of the ACTIVE
-- lookups by the same index scan. No new index needed.
