-- Add parent_post_id for TRACKING → BREAKING linkage
ALTER TABLE injury_posts
  ADD COLUMN IF NOT EXISTS parent_post_id UUID REFERENCES injury_posts(id);

-- Add slug for frontend URL routing
ALTER TABLE injury_posts
  ADD COLUMN IF NOT EXISTS slug VARCHAR(255) UNIQUE;

-- Delete existing test posts (all [E2E TEST] posts, safe to remove)
DELETE FROM injury_posts;

-- Create md_reviews table for admin dashboard
CREATE TABLE IF NOT EXISTS md_reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        UUID NOT NULL REFERENCES injury_posts(id) ON DELETE CASCADE,
  reason         TEXT NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewer_notes TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_md_reviews_post_id ON md_reviews(post_id);
CREATE INDEX IF NOT EXISTS idx_md_reviews_status  ON md_reviews(status);
