-- Migration 005: Social engagement tables
-- Supports Tier 1 Reactive Replies: mention monitoring, dedup, correction queue

CREATE TABLE IF NOT EXISTS social_monitor_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial cursor values (idempotent)
INSERT INTO social_monitor_state (key, value)
VALUES
  ('twitter_mentions_since_id', NULL),
  ('farcaster_notifications_cursor', NULL)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS processed_mentions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform             TEXT NOT NULL,
  mention_id           TEXT NOT NULL,
  author_handle        TEXT NOT NULL,
  author_follower_count INTEGER,
  mention_text         TEXT NOT NULL,
  intent               TEXT NOT NULL,
  intent_confidence    FLOAT,
  action_taken         TEXT NOT NULL,   -- REPLIED | IGNORED | QUEUED_CORRECTION
  reply_content        TEXT,
  reply_post_id        TEXT,
  raw_payload          JSONB,
  processed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, mention_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_mentions_platform_mention
  ON processed_mentions(platform, mention_id);

CREATE TABLE IF NOT EXISTS pending_corrections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_post_id    UUID REFERENCES injury_posts(id),
  mention_id          TEXT NOT NULL,
  platform            TEXT NOT NULL,
  correction_field    TEXT NOT NULL,
  old_value           TEXT NOT NULL,
  new_value           TEXT NOT NULL,
  submitted_by_handle TEXT NOT NULL,
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status              TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | DISMISSED
  reviewed_at         TIMESTAMPTZ,
  reviewed_by         TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_corrections_status
  ON pending_corrections(status);
