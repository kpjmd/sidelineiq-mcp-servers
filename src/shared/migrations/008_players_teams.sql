-- 008_players_teams.sql
-- Authoritative roster store. Fixes the "Luka tagged Lakers" class of
-- fact-validation failure by giving the agent a player→current_team
-- source of truth instead of trusting the team string scraped from
-- source-article text.
--
-- Seeded and refreshed from ESPN team + roster endpoints by
-- agents/src/monitoring/roster-sync.ts at 6h cadence.

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport VARCHAR(50) NOT NULL,
  espn_team_id VARCHAR(64),
  name VARCHAR(255) NOT NULL,
  abbreviation VARCHAR(32),
  location VARCHAR(128),
  display_name VARCHAR(255),
  conference VARCHAR(64),
  last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (sport, espn_team_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_sport_abbrev ON teams(sport, abbreviation);
CREATE INDEX IF NOT EXISTS idx_teams_sport_name ON teams(sport, name);

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport VARCHAR(50) NOT NULL,
  espn_athlete_id VARCHAR(64),
  full_name VARCHAR(255) NOT NULL,
  -- normalized_name: lowercase, diacritics stripped, Jr/Sr/II/III removed,
  -- punctuation removed, single spaces. Computed by upsert helper.
  normalized_name VARCHAR(255) NOT NULL,
  current_team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  position VARCHAR(32),
  jersey VARCHAR(16),
  prominence_tier SMALLINT,         -- 1..4, lower = more prominent
  prominence_source VARCHAR(32),    -- 'espn' | 'override' | 'default'
  last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  retired_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (sport, espn_athlete_id)
);

CREATE INDEX IF NOT EXISTS idx_players_norm_name_sport ON players(normalized_name, sport);
CREATE INDEX IF NOT EXISTS idx_players_current_team ON players(current_team_id);
CREATE INDEX IF NOT EXISTS idx_players_sport_active ON players(sport) WHERE retired_at IS NULL;
