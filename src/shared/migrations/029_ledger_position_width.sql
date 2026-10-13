-- 029_ledger_position_width.sql
-- ledger_forecasts.position was VARCHAR(16), but the draft form autofills it
-- from players.position, which is VARCHAR(32) and holds ESPN display names:
-- "Inside Linebacker" is 17 characters. The first draft for an ILB (T.J.
-- Edwards, 2026-10-12) failed in createDraft with "value too long for type
-- character varying(16)", and nothing upstream capped the length, so it
-- surfaced as a 500.
--
-- Widening a VARCHAR rewrites no row and changes no stored byte, so every
-- row_hash (which hashes the string, not the column width) is unaffected, and
-- the row-level immutability trigger does not fire.
--
-- Applied manually like 007–028: psql $DATABASE_URL -f this file.

ALTER TABLE ledger_forecasts ALTER COLUMN position TYPE VARCHAR(32);
