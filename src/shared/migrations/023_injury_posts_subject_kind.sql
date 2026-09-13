-- 023_injury_posts_subject_kind.sql
-- What a post is ABOUT: one named athlete, or an injury type.
--
-- Why it exists. The commercial AequOs CTA ("Get Clinical Guidance →") may
-- appear only on injury-TYPE-led content, never beside a named non-patient's
-- medical situation — the adjacency that reads as advertising under a
-- physician byline (monetization plan, Phase 0.2). Nothing stored could tell
-- the two apart: every DEEP_DIVE carries exactly one athlete_name, including the
-- trending-type ones, whose athlete_name is simply the first of several.
-- Deciding it from headline prose would key a commercial decision on free model
-- text, so the PRODUCER records it instead: the agents' trending-type scheduler
-- writes INJURY_TYPE, the athlete news path writes ATHLETE.
--
-- NULL stays legal and means "not recorded" — every row before this migration.
-- Consumers treat NULL as NOT injury-type-led, so a legacy row shows no CTA.
-- That is the fail-closed direction: a missing CTA costs a click, a wrong one
-- puts a sales ask beside an athlete's injury.
--
-- Schema only. Existing DEEP_DIVE rows are tagged by hand, by id, after this is
-- applied — see the agents' cta-adjacency-dryrun.ts for the list and the check.
--
-- Deploy order: apply this BEFORE deploying the mcp that writes the column, and
-- deploy that mcp BEFORE the agents that send `subject_kind` (strict inputs
-- reject an undeclared key and fail the whole create).

ALTER TABLE injury_posts ADD COLUMN IF NOT EXISTS subject_kind TEXT;

ALTER TABLE injury_posts ADD CONSTRAINT injury_posts_subject_kind_values
  CHECK (subject_kind IS NULL OR subject_kind IN ('INJURY_TYPE', 'ATHLETE'));
