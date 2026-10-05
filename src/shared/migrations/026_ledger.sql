-- 026_ledger.sql
-- The paratrOs Prognosis Ledger (agents docs/paratrOs Prognosis Ledger — Working
-- Spec.md, "Implementation handoff → Ledger schema"). A public, timestamped record
-- of NFL injury forecasts signed by a licensed physician and scored against public
-- outcomes. The spec's two tables plus the corrections table it names, plus the
-- tables the automation boundary needs (proposals, the entry-id sequence, the
-- base-rate sheet) and the gated reply queue decided on 2026-10-04 (D6).
--
-- The one property everything here protects: A FORECAST ROW IS IMMUTABLE ONCE
-- PUBLISHED. Revisions are new rows. Corrections are rows in ledger_corrections.
-- The immutability is enforced by triggers, as audit_log's is (007), because the
-- service runs as a single Neon role and a code convention is not enforcement.
--
-- Hash/timestamp decision (D7): published_at is stamped by the server at the
-- moment the physician confirms and is INSIDE row_hash. The publish statement
-- truncates it to milliseconds so the JS Date that comes back (ms precision)
-- hashes to the same value Postgres stored. row_hash itself is written by a
-- second statement from the RETURNING row, which is why it is a once-settable
-- column rather than part of the publish UPDATE; a published row with a NULL
-- row_hash is a row the publish function must refuse to post and may repair.
--
-- Applied manually like 007–025: psql $DATABASE_URL -f this file.
-- Deploy order: apply BEFORE deploying the mcp that registers the ledger tools.

-- ── Base-rate sheet ─────────────────────────────────────────────────────
-- One row per injury type (spec "Base-rate sheet"). The physician enters these;
-- a forecast row copies base_rate_row + base_rate_strength at publish, so a
-- later edit here never rewrites what a published card said.
CREATE TABLE IF NOT EXISTS ledger_base_rates (
  row_key         VARCHAR(64) PRIMARY KEY,
  injury_type     VARCHAR(128) NOT NULL,
  strength        VARCHAR(16) NOT NULL CHECK (strength IN ('strong','moderate','thin')),
  -- Spec "Source hierarchy": 1 empirical NFL history, 2 NFL-specific literature,
  -- 3 other elite cohorts, 4 general athletic populations.
  source_rank     SMALLINT CHECK (source_rank BETWEEN 1 AND 4),
  sources         TEXT,
  n               INTEGER CHECK (n IS NULL OR n >= 0),
  year_range      VARCHAR(32),
  f1_ir           NUMERIC(5,4) CHECK (f1_ir IS NULL OR (f1_ir >= 0 AND f1_ir <= 1)),
  f2_next         NUMERIC(5,4) CHECK (f2_next IS NULL OR (f2_next >= 0 AND f2_next <= 1)),
  f3_4wk          NUMERIC(5,4) CHECK (f3_4wk IS NULL OR (f3_4wk >= 0 AND f3_4wk <= 1)),
  f5_reinjury     NUMERIC(5,4) CHECK (f5_reinjury IS NULL OR (f5_reinjury >= 0 AND f5_reinjury <= 1)),
  f4_point        INTEGER CHECK (f4_point IS NULL OR f4_point >= 0),
  f4_low          INTEGER CHECK (f4_low IS NULL OR f4_low >= 0),
  f4_high         INTEGER CHECK (f4_high IS NULL OR f4_high >= 0),
  notes           TEXT,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT ledger_base_rates_f4_order
    CHECK (f4_low IS NULL OR f4_point IS NULL OR f4_high IS NULL OR (f4_low <= f4_point AND f4_point <= f4_high))
);

-- ── Entry-id sequence ───────────────────────────────────────────────────
-- PT-YYYY-NNN, allocated INSIDE the publish statement so an abandoned draft
-- never burns a number: a gap would read as a deletion, and nothing is deleted.
CREATE TABLE IF NOT EXISTS ledger_entry_sequence (
  year    INTEGER PRIMARY KEY,
  next_n  INTEGER NOT NULL DEFAULT 1 CHECK (next_n >= 1)
);

-- ── Forecast rows ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_forecasts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status              VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  -- NULL while a NEW entry is a draft; a revision draft carries its parent's id.
  entry_id            VARCHAR(16),
  version             INTEGER NOT NULL CHECK (version >= 1),
  -- Spec: "The scoring timestamp; set at post time." Stamped at confirm (D7).
  published_at        TIMESTAMP WITH TIME ZONE,
  -- Spec: "Required for version > 1; a public event." Enforced at publish.
  trigger             TEXT,
  player              VARCHAR(255) NOT NULL,
  team                VARCHAR(64) NOT NULL,
  position            VARCHAR(16) NOT NULL,
  injury_date         DATE NOT NULL,
  reported_injury     TEXT NOT NULL,
  source_tier         VARCHAR(1) NOT NULL CHECK (source_tier IN ('A','B','C')),
  source_urls         JSONB NOT NULL DEFAULT '[]'::jsonb,
  mechanism           TEXT NOT NULL,
  base_rate_row       VARCHAR(64) NOT NULL REFERENCES ledger_base_rates(row_key),
  base_rate_strength  VARCHAR(16) NOT NULL CHECK (base_rate_strength IN ('strong','moderate','thin')),
  f1_ir               NUMERIC(5,4) NOT NULL CHECK (f1_ir >= 0 AND f1_ir <= 1),
  f2_next             NUMERIC(5,4) NOT NULL CHECK (f2_next >= 0 AND f2_next <= 1),
  f3_4wk              NUMERIC(5,4) NOT NULL CHECK (f3_4wk >= 0 AND f3_4wk <= 1),
  f4_point            INTEGER NOT NULL CHECK (f4_point >= 0),
  f4_low              INTEGER NOT NULL CHECK (f4_low >= 0),
  f4_high             INTEGER NOT NULL CHECK (f4_high >= 0),
  -- NULL only for a concussion entry (F5 void by rule); the publish gate checks.
  f5_reinjury         NUMERIC(5,4) CHECK (f5_reinjury IS NULL OR (f5_reinjury >= 0 AND f5_reinjury <= 1)),
  season_ending       BOOLEAN NOT NULL DEFAULT FALSE,
  what_moves_this     TEXT NOT NULL,
  tier                SMALLINT NOT NULL CHECK (tier IN (1, 2)),
  -- Hash of every field above plus published_at (agents src/ledger/row-hash.ts,
  -- twin src/servers/web/ledger-hash.ts). Printed on the card. Set once.
  row_hash            VARCHAR(64),
  -- ── Outside the hash: who confirmed, and provenance written after publish ──
  confirmed_by        UUID REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at        TIMESTAMP WITH TIME ZONE,
  commit_sha          VARCHAR(64),
  commit_url          TEXT,
  x_post_id           VARCHAR(64),
  x_self_reply_id     VARCHAR(64),
  farcaster_hash      VARCHAR(80),
  -- The report post the card replies to (spec "Channel scope": reply-first).
  reply_to_url        TEXT,
  -- ── Linkage for the resolution ingest; never hashed, never printed ──
  espn_athlete_id     VARCHAR(32),
  gsis_id             VARCHAR(16),
  pfr_id              VARCHAR(16),
  -- The abbreviation nflverse games.csv uses for the team (e.g. BUF).
  nflverse_team       VARCHAR(4),
  season              INTEGER,
  player_id           UUID REFERENCES players(id) ON DELETE SET NULL,
  entity_id           UUID REFERENCES injury_entities(id) ON DELETE SET NULL,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT ledger_forecasts_f4_order CHECK (f4_low <= f4_point AND f4_point <= f4_high),
  CONSTRAINT ledger_forecasts_published_complete
    CHECK (status = 'draft' OR (entry_id IS NOT NULL AND published_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT ledger_forecasts_revision_has_trigger
    CHECK (status = 'draft' OR version = 1 OR trigger IS NOT NULL),
  CONSTRAINT ledger_forecasts_entry_id_shape
    CHECK (entry_id IS NULL OR entry_id ~ '^PT-[0-9]{4}-[0-9]{3,}$')
);

-- One row per (entry, version). NULL entry_id (new-entry drafts) is exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ledger_forecasts_entry_version
  ON ledger_forecasts(entry_id, version) WHERE entry_id IS NOT NULL;
-- At most one draft revision in progress per entry.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ledger_forecasts_one_draft_per_entry
  ON ledger_forecasts(entry_id) WHERE status = 'draft' AND entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_forecasts_published
  ON ledger_forecasts(published_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_ledger_forecasts_status
  ON ledger_forecasts(status, updated_at DESC);

-- Immutability. A published row may change only in the once-settable provenance
-- columns, each from NULL to a value exactly once, plus updated_at. Everything
-- else — every hashed field, the status, the confirmer — is frozen. DELETE of a
-- published row is never permitted; a draft may be deleted.
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

  frozen_old := to_jsonb(OLD) - 'row_hash' - 'commit_sha' - 'commit_url' - 'x_post_id' - 'x_self_reply_id' - 'farcaster_hash' - 'updated_at';
  frozen_new := to_jsonb(NEW) - 'row_hash' - 'commit_sha' - 'commit_url' - 'x_post_id' - 'x_self_reply_id' - 'farcaster_hash' - 'updated_at';
  IF frozen_old <> frozen_new THEN
    RAISE EXCEPTION 'ledger_forecasts: a published row is immutable; only provenance columns may be set (entry %, v%)', OLD.entry_id, OLD.version;
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_forecasts_no_mutation ON ledger_forecasts;
CREATE TRIGGER ledger_forecasts_no_mutation
  BEFORE UPDATE OR DELETE ON ledger_forecasts
  FOR EACH ROW EXECUTE FUNCTION ledger_forecasts_immutable();

-- ── Resolutions ─────────────────────────────────────────────────────────
-- One row per entry per field, opened by the publish of v1. Spec: "A resolved
-- field locks and is never revised." resolved_at is when the physician confirmed;
-- outcome_date is the calendar date the rules say the field resolved on;
-- freeze_at is the first resolvable moment and decides which version scores.
CREATE TABLE IF NOT EXISTS ledger_resolutions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      VARCHAR(16) NOT NULL,
  field         VARCHAR(2) NOT NULL CHECK (field IN ('F1','F2','F3','F4','F5')),
  status        VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','void')),
  outcome       NUMERIC(6,2),
  outcome_date  DATE,
  resolved_at   TIMESTAMP WITH TIME ZONE,
  freeze_at     TIMESTAMP WITH TIME ZONE,
  void_reason   VARCHAR(64),
  evidence_url  TEXT,
  evidence      JSONB,
  proposal_id   UUID,
  confirmed_by  UUID REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at  TIMESTAMP WITH TIME ZONE,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_ledger_resolutions_entry_field UNIQUE (entry_id, field),
  CONSTRAINT ledger_resolutions_resolved_complete
    CHECK (status <> 'resolved' OR (outcome IS NOT NULL AND freeze_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT ledger_resolutions_void_complete
    CHECK (status <> 'void' OR (void_reason IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ledger_resolutions_status ON ledger_resolutions(status, entry_id);

-- A resolved or void row is locked. No row is ever deleted.
CREATE OR REPLACE FUNCTION ledger_resolutions_locked() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_resolutions: rows are never deleted (entry %, %)', OLD.entry_id, OLD.field;
  END IF;
  IF OLD.status IN ('resolved', 'void') THEN
    RAISE EXCEPTION 'ledger_resolutions: a % field is locked and is never revised (entry %, %)', OLD.status, OLD.entry_id, OLD.field;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_resolutions_no_mutation ON ledger_resolutions;
CREATE TRIGGER ledger_resolutions_no_mutation
  BEFORE UPDATE OR DELETE ON ledger_resolutions
  FOR EACH ROW EXECUTE FUNCTION ledger_resolutions_locked();

-- ── Resolution proposals ────────────────────────────────────────────────
-- "Ingest proposes; the physician confirms; the system records who confirmed
-- and when." The ingest writes here and nowhere else. A confirm copies the
-- proposal onto ledger_resolutions and locks it.
CREATE TABLE IF NOT EXISTS ledger_resolution_proposals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id          VARCHAR(16) NOT NULL,
  field             VARCHAR(2) NOT NULL CHECK (field IN ('F1','F2','F3','F4','F5')),
  proposed_status   VARCHAR(16) NOT NULL CHECK (proposed_status IN ('resolved','void')),
  proposed_outcome  NUMERIC(6,2),
  outcome_date      DATE,
  freeze_at         TIMESTAMP WITH TIME ZONE,
  void_reason       VARCHAR(64),
  evidence_url      TEXT,
  evidence          JSONB,
  proposer          VARCHAR(32) NOT NULL DEFAULT 'ingest',
  proposed_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  decision          VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','confirmed','rejected')),
  decided_by        UUID REFERENCES users(id) ON DELETE RESTRICT,
  decided_at        TIMESTAMP WITH TIME ZONE,
  note              TEXT,
  CONSTRAINT ledger_proposals_resolved_has_outcome
    CHECK (proposed_status <> 'resolved' OR (proposed_outcome IS NOT NULL AND freeze_at IS NOT NULL)),
  CONSTRAINT ledger_proposals_void_has_reason
    CHECK (proposed_status <> 'void' OR void_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_ledger_proposals_pending
  ON ledger_resolution_proposals(decision, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_proposals_entry_field
  ON ledger_resolution_proposals(entry_id, field, decision);

-- ── Corrections ─────────────────────────────────────────────────────────
-- Spec: "corrections of clerical errors (wrong player, wrong date) are logged as
-- a separate correction row with a note, not as a revision." Append-only.
CREATE TABLE IF NOT EXISTS ledger_corrections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      VARCHAR(16) NOT NULL,
  field         VARCHAR(64) NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  note          TEXT NOT NULL,
  corrected_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  corrected_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_corrections_entry ON ledger_corrections(entry_id, corrected_at DESC);

CREATE OR REPLACE FUNCTION ledger_corrections_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_corrections is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_corrections_no_update ON ledger_corrections;
CREATE TRIGGER ledger_corrections_no_update
  BEFORE UPDATE ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION ledger_corrections_immutable();

DROP TRIGGER IF EXISTS ledger_corrections_no_delete ON ledger_corrections;
CREATE TRIGGER ledger_corrections_no_delete
  BEFORE DELETE ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION ledger_corrections_immutable();

-- ── Gated replies (D6, 2026-10-04) ──────────────────────────────────────
-- The mention-reply agent used to post model-written replies on its own. It now
-- files a proposal here and the physician posts or discards it; the system
-- records who and when. mention_id is the platform's id for the mention.
CREATE TABLE IF NOT EXISTS reply_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        VARCHAR(16) NOT NULL CHECK (platform IN ('x','farcaster')),
  mention_id      VARCHAR(128) NOT NULL,
  mention_url     TEXT,
  mention_author  VARCHAR(255),
  mention_text    TEXT,
  proposed_text   TEXT NOT NULL,
  proposed_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  decision        VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','posted','discarded')),
  decided_by      UUID REFERENCES users(id) ON DELETE RESTRICT,
  decided_at      TIMESTAMP WITH TIME ZONE,
  -- What actually went out, if the physician edited the proposal before posting.
  posted_text     TEXT,
  posted_id       VARCHAR(128),
  note            TEXT,
  CONSTRAINT uniq_reply_proposals_mention UNIQUE (platform, mention_id),
  CONSTRAINT reply_proposals_posted_complete
    CHECK (decision <> 'posted' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND posted_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_reply_proposals_pending ON reply_proposals(decision, proposed_at DESC);

-- Verification:
--   SELECT count(*) FROM ledger_forecasts;               -- 0 on first apply
--   SELECT tgname FROM pg_trigger WHERE tgname LIKE 'ledger_%';
--   -- expect ledger_forecasts_no_mutation, ledger_resolutions_no_mutation,
--   --        ledger_corrections_no_update, ledger_corrections_no_delete
-- The behavioural proof is src/scripts/ledger-schema-check.ts against a scratch
-- branch: it must show every forbidden write raising and each provenance write
-- succeeding exactly once.
