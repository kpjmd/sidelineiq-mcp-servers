-- 025_thread_return_provenance.sql
-- Records WHO set injury_entities.actual_return_date, so a machine can never
-- overwrite a physician's answer.
--
-- The gap it closes. updateThreadDates has guarded injury_date since mcp #25:
-- if date_resolution_sources carries a stage of 'md_manual' and the caller is
-- a system caller, the write is refused and an md_date_write_refused audit row
-- is appended (client.ts, "Thread date MD guard"). closeThread has no such
-- guard on actual_return_date, and there is no column anywhere recording where
-- that date came from — date_resolution_sources documents the INJURY and
-- SURGERY dates only, and its stage enum ('api' | 'web_search' | 'md_manual',
-- 014:32-33) says nothing about a return.
--
-- It has never mattered because only a human has ever written the column: the
-- return detector (agents src/monitoring/return-detector.ts) is its first
-- machine writer. On the day that ships, "a system close silently replaces the
-- MD's hand-entered return date" becomes reachable on every ACTIVE thread at
-- once, and unlike a wrong injury_date it is not self-correcting — the thread
-- leaves ACTIVE on close and no feed event visits it again.
--
-- Why a column and not a JSONB stage. date_resolution_sources is a LIST of
-- resolution attempts for a different pair of dates, read by the poller, the
-- date resolver, the dry-runs and the MD's date form. Overloading it with a
-- return-date stage would make every one of those readers newly wrong about
-- what a 'md_manual' entry means. One nullable column answers one question.
--
-- The backfill is a true statement, not a guess: as of 2026-09-15 no code path
-- in any of the three repos writes actual_return_date except web_thread_close,
-- and every live caller of that tool with a date is either the MD's dashboard
-- or a hand-run script. Marking the existing rows 'md' is what makes the guard
-- protect them from the detector's first cycle rather than from its second.
--
-- NULL means "written before this migration, or by a caller that named no
-- source" and is treated as NOT md — the fail-open direction is deliberate:
-- a NULL must not freeze a column that the detector is supposed to fill.
--
-- Applied manually like 007-020: psql $DATABASE_URL -f this file.
-- Deploy order: apply BEFORE deploying the mcp that reads the column.

ALTER TABLE injury_entities
  ADD COLUMN IF NOT EXISTS return_source VARCHAR(16);

ALTER TABLE injury_entities
  DROP CONSTRAINT IF EXISTS injury_entities_return_source_check;

ALTER TABLE injury_entities
  ADD CONSTRAINT injury_entities_return_source_check
  CHECK (return_source IS NULL OR return_source IN ('detector', 'md', 'backfill'));

-- Every return date that exists today was entered by a person (see above).
-- Idempotent: re-running only touches rows still NULL.
UPDATE injury_entities
   SET return_source = 'md'
 WHERE actual_return_date IS NOT NULL
   AND return_source IS NULL;

-- Verification:
--   SELECT return_source, count(*) FROM injury_entities
--    WHERE actual_return_date IS NOT NULL GROUP BY 1;
--   -- expect every row 'md' immediately after apply.
