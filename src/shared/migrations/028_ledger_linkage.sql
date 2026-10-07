-- 028_ledger_linkage.sql
-- Linkage ids after publish (agents docs/paratrOs Prognosis Ledger — Working
-- Spec.md, "Implementation handoff → Ledger schema" and "Automation boundary":
-- the resolution ingest needs public-record ids to read the gamebook and the
-- injury report; agents docs/ledger-preregistration.md "Identity": a player
-- missing an id is unresolvable and is surfaced, never matched by name).
--
-- 026 froze espn_athlete_id / gsis_id / pfr_id / nflverse_team / season on a
-- published row. PT-2026-001 was confirmed without them, so the ingest could
-- never resolve it. None of these columns is in the row hash
-- (LEDGER_HASH_FIELDS), so setting them changes neither row_hash nor the
-- committed JSON. They become ONCE-SETTABLE on a published row, exactly like
-- the provenance columns: NULL → value once, never changed, never cleared.
-- Every other column stays frozen.
--
-- The write path is web_record_ledger_linkage (MD only), which records the ids
-- in ledger_corrections in the same statement, so the attachment is itself a
-- public, append-only record.
--
-- Applied manually like 007–027: psql $DATABASE_URL -f this file.
-- Deploy order: apply BEFORE deploying the mcp that registers
-- web_record_ledger_linkage. Applying early is safe: the old mcp never writes
-- these columns on a published row.

CREATE OR REPLACE FUNCTION ledger_forecasts_immutable() RETURNS TRIGGER AS $$
DECLARE
  frozen_old JSONB;
  frozen_new JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'ledger_forecasts: a published row is immutable; DELETE is not permitted (entry %, v%)', OLD.entry_id, OLD.version;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'published' THEN
    RETURN NEW;
  END IF;

  frozen_old := to_jsonb(OLD) - 'row_hash' - 'commit_sha' - 'commit_url' - 'x_post_id' - 'x_self_reply_id' - 'farcaster_hash' - 'updated_at'
                - 'espn_athlete_id' - 'gsis_id' - 'pfr_id' - 'nflverse_team' - 'season';
  frozen_new := to_jsonb(NEW) - 'row_hash' - 'commit_sha' - 'commit_url' - 'x_post_id' - 'x_self_reply_id' - 'farcaster_hash' - 'updated_at'
                - 'espn_athlete_id' - 'gsis_id' - 'pfr_id' - 'nflverse_team' - 'season';
  IF frozen_old <> frozen_new THEN
    RAISE EXCEPTION 'ledger_forecasts: a published row is immutable; only provenance and linkage columns may be set (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;

  IF OLD.row_hash IS NOT NULL AND NEW.row_hash IS DISTINCT FROM OLD.row_hash THEN
    RAISE EXCEPTION 'ledger_forecasts: row_hash is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.commit_sha IS NOT NULL AND NEW.commit_sha IS DISTINCT FROM OLD.commit_sha THEN
    RAISE EXCEPTION 'ledger_forecasts: commit_sha is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.commit_url IS NOT NULL AND NEW.commit_url IS DISTINCT FROM OLD.commit_url THEN
    RAISE EXCEPTION 'ledger_forecasts: commit_url is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.x_post_id IS NOT NULL AND NEW.x_post_id IS DISTINCT FROM OLD.x_post_id THEN
    RAISE EXCEPTION 'ledger_forecasts: x_post_id is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.x_self_reply_id IS NOT NULL AND NEW.x_self_reply_id IS DISTINCT FROM OLD.x_self_reply_id THEN
    RAISE EXCEPTION 'ledger_forecasts: x_self_reply_id is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.farcaster_hash IS NOT NULL AND NEW.farcaster_hash IS DISTINCT FROM OLD.farcaster_hash THEN
    RAISE EXCEPTION 'ledger_forecasts: farcaster_hash is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.espn_athlete_id IS NOT NULL AND NEW.espn_athlete_id IS DISTINCT FROM OLD.espn_athlete_id THEN
    RAISE EXCEPTION 'ledger_forecasts: espn_athlete_id is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.gsis_id IS NOT NULL AND NEW.gsis_id IS DISTINCT FROM OLD.gsis_id THEN
    RAISE EXCEPTION 'ledger_forecasts: gsis_id is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.pfr_id IS NOT NULL AND NEW.pfr_id IS DISTINCT FROM OLD.pfr_id THEN
    RAISE EXCEPTION 'ledger_forecasts: pfr_id is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.nflverse_team IS NOT NULL AND NEW.nflverse_team IS DISTINCT FROM OLD.nflverse_team THEN
    RAISE EXCEPTION 'ledger_forecasts: nflverse_team is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  IF OLD.season IS NOT NULL AND NEW.season IS DISTINCT FROM OLD.season THEN
    RAISE EXCEPTION 'ledger_forecasts: season is set once (entry %, v%)', OLD.entry_id, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- The trigger itself (ledger_forecasts_no_mutation) is unchanged; it already
-- calls this function by name.
