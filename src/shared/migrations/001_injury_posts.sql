CREATE TABLE IF NOT EXISTS injury_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_name VARCHAR(255) NOT NULL,
  sport VARCHAR(50) NOT NULL,
  team VARCHAR(255) NOT NULL,
  injury_type VARCHAR(255) NOT NULL,
  injury_severity VARCHAR(50) NOT NULL,
  content_type VARCHAR(50) NOT NULL,
  headline VARCHAR(120) NOT NULL,
  clinical_summary TEXT NOT NULL,
  return_to_play_min_weeks INTEGER,
  return_to_play_max_weeks INTEGER,
  rtp_probability_week_2 DECIMAL(4,3),
  rtp_probability_week_4 DECIMAL(4,3),
  rtp_probability_week_8 DECIMAL(4,3),
  rtp_confidence DECIMAL(4,3),
  farcaster_hash VARCHAR(255),
  twitter_id VARCHAR(255),
  source_url TEXT,
  status VARCHAR(50) DEFAULT 'PUBLISHED',
  md_review_required BOOLEAN DEFAULT FALSE,
  md_review_reason TEXT,
  md_review_confidence DECIMAL(4,3),
  version INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_injury_posts_sport ON injury_posts(sport);
CREATE INDEX idx_injury_posts_athlete ON injury_posts(athlete_name);
CREATE INDEX idx_injury_posts_status ON injury_posts(status);
CREATE INDEX idx_injury_posts_created ON injury_posts(created_at DESC);
