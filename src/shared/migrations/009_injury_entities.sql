-- 009_injury_entities.sql
-- Parallel index over injury_posts that groups all updates about the same
-- real-world injury into a single timeline. Fixes the "6 Keegan Murray
-- posts" duplicate-content problem.
--
-- injury_posts remains the source of truth for content (it's live, indexed
-- by Google, and feeds permalinks). injury_entities is an index/projection,
-- not a replacement.

CREATE TABLE IF NOT EXISTS injury_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  body_part VARCHAR(64),
  laterality VARCHAR(16) NOT NULL DEFAULT 'UNSPECIFIED'
    CHECK (laterality IN ('LEFT','RIGHT','BILATERAL','UNSPECIFIED')),
  injury_type VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RESOLVED','RETIRED')),
  -- The originating BREAKING/DEEP_DIVE injury_posts row, when one exists.
  -- Nullable because the entity can outlive its post (e.g. post deleted).
  canonical_post_id UUID REFERENCES injury_posts(id) ON DELETE SET NULL,
  first_reported_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  actual_return_date DATE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_player_status
  ON injury_entities(player_id, status, last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_player_part
  ON injury_entities(player_id, body_part, laterality);

CREATE TABLE IF NOT EXISTS injury_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES injury_entities(id) ON DELETE CASCADE,
  -- post_id is nullable: not every update produces a published post.
  -- Repeat source articles append an update with post_id NULL.
  post_id UUID REFERENCES injury_posts(id) ON DELETE SET NULL,
  update_kind VARCHAR(32) NOT NULL
    CHECK (update_kind IN ('INITIAL','TRACKING','CONFLICT','DEEP_DIVE','CORRECTION','RESOLUTION')),
  severity_at_time VARCHAR(50),
  team_timeline_weeks INTEGER,
  otm_min_weeks INTEGER,
  source_url TEXT,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_updates_entity_ts
  ON injury_updates(entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_updates_post ON injury_updates(post_id);
