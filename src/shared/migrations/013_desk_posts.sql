-- 013_desk_posts.sql
-- Phase 2C — the Tier 2 authored artifact and its medico-legal defensibility
-- backbone. A desk_post is a physician-attributed Injury Desk breakdown created
-- from an ACCEPTED desk_candidate (Phase 1). Unlike Tier 1 injury_posts (machine-
-- published autonomously), a desk_post CANNOT reach PUBLISHED without passing a
-- server-enforced gate (desk_publish):
--   1. the reviewer's role is RE-DERIVED from users (never trusted from the
--      caller) and must be 'md',
--   2. the LATEST attestation's content_hash must equal the post's CURRENT
--      content_hash — catching any edit made after attestation, and
--   3. the content linter must return zero blockers.
-- This is the only path that lets Dr. Johnson's name attach to commentary about
-- named athletes.
--
-- content_hash everywhere = hashPayload(markdown_body) = sha256 of the canonical
-- markdown body, NOT rendered HTML. The same input is hashed on create / update /
-- attest / publish so the gate's equality check holds across a template change.
--
-- Applied manually like 007–012: psql $DATABASE_URL -f this file.

CREATE TABLE IF NOT EXISTS desk_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The accepted candidate that produced this draft. Nullable + SET NULL because
  -- the entity is the durable subject; a candidate row can be pruned.
  candidate_id    UUID REFERENCES desk_candidates(id) ON DELETE SET NULL,
  entity_id       UUID NOT NULL REFERENCES injury_entities(id) ON DELETE CASCADE,
  slug            VARCHAR(255) NOT NULL UNIQUE,
  title           VARCHAR(512) NOT NULL,
  markdown_body   TEXT NOT NULL,
  -- The canonical kpjmd handoff artifact (Phase 3 schema). markdown_body is the
  -- editable body broken out as its own column for indexing/lint convenience.
  draft_json      JSONB,
  status          VARCHAR(16) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','READY','PUBLISHED','RETRACTED')),
  version         INTEGER NOT NULL DEFAULT 1,
  author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Denormalized "latest attestation" pointer. NON-AUTHORITATIVE convenience only:
  -- the publish gate queries desk_attestations by desk_post_id ORDER BY timestamp
  -- DESC LIMIT 1 for the real answer. Deliberately NOT a foreign key —
  -- desk_attestations.desk_post_id already points back here, and a formal circular
  -- FK would break order-independent, idempotent CREATE TABLE IF NOT EXISTS. Do
  -- not "fix" this into a REFERENCES constraint.
  attestation_id  UUID,
  content_hash    VARCHAR(64) NOT NULL,
  source_attribution JSONB,
  disclaimer_present BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  published_at    TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_desk_posts_status
  ON desk_posts(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_desk_posts_entity
  ON desk_posts(entity_id, created_at DESC);

-- An immutable history row written on EVERY save (create + each update). The
-- editor never loses prior bodies; correction/retraction provenance is intact.
CREATE TABLE IF NOT EXISTS desk_post_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  desk_post_id  UUID NOT NULL REFERENCES desk_posts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  markdown_body TEXT NOT NULL,
  draft_json    JSONB,
  content_hash  VARCHAR(64) NOT NULL,
  edited_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  edit_diff     JSONB,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_desk_post_version
  ON desk_post_versions(desk_post_id, version);

-- The physician attestation. content_hash snapshots the body at attest time so
-- the publish gate can detect a post-attestation edit (hash drift). reviewer_user_id
-- uses ON DELETE RESTRICT: an attestation is a legal record and must never be
-- orphaned by deleting the user who made it.
CREATE TABLE IF NOT EXISTS desk_attestations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  desk_post_id            UUID NOT NULL REFERENCES desk_posts(id) ON DELETE CASCADE,
  reviewer_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_source_reports BOOLEAN NOT NULL,
  edited_for_accuracy     BOOLEAN NOT NULL,
  framing_confirmed       BOOLEAN NOT NULL,
  content_hash            VARCHAR(64) NOT NULL,
  timestamp               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ip                      VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_desk_attestations_post
  ON desk_attestations(desk_post_id, timestamp DESC);
