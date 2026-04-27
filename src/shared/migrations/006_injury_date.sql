-- Add injury_date column to store the actual date the injury/surgery occurred,
-- distinct from the report date (created_at) or current date.
ALTER TABLE injury_posts ADD COLUMN IF NOT EXISTS injury_date DATE;
