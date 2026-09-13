-- 024_metrics.sql
-- Baseline instrumentation: the starting numbers every growth gate is measured
-- against (monetization plan, Phase 0.3).
--
-- Why it exists. Gate G2 is "≥2%/week follower growth on at least one platform
-- after 90 days" — a weekly RATE, which one hand-copied number cannot measure.
-- Nothing recorded follower counts, and nothing could say whether a type-led
-- DEEP_DIVE sent anyone to AequOs: the web CTA linked straight out with
-- rel=noreferrer and aequos.io reads no `ref`.
--
-- metric_snapshots — one reading per metric per UTC day.
--   PRIMARY KEY (metric, day) and the writer UPSERTS: a Railway redeploy
--   restarts the agents' snapshot loop, so several readings can land in one
--   day and the latest wins. The metric is an allowlist so a typo is a
--   rejected write, not a new series nobody reads. A failed read writes NO
--   row — "unreadable" and "zero followers" must never be the same value, so
--   value is NOT NULL and there is no default.
--
-- cta_click_daily — an aggregate counter, per day, per post, per link.
--   Deliberately no IP, no user agent, no per-visitor row: the site is
--   physician-branded and medical-adjacent, and a count answers the funnel
--   question without storing anything about who clicked. No FK to
--   injury_posts: the writer checks the slug exists at increment time, and a
--   later slug change must not erase history.
--
-- Deploy order: apply BEFORE deploying the mcp that registers the tools. The
-- agents and frontend that call them deploy after; either one against an mcp
-- without these tools gets isError and records nothing (logged), never a crash.

CREATE TABLE IF NOT EXISTS metric_snapshots (
  metric      TEXT        NOT NULL,
  day         DATE        NOT NULL,
  value       INTEGER     NOT NULL,
  source      TEXT        NOT NULL,
  detail      JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (metric, day),
  CONSTRAINT metric_snapshots_metric_values
    CHECK (metric IN ('x_followers', 'farcaster_followers', 'web_monthly_uniques', 'web_monthly_pageviews')),
  CONSTRAINT metric_snapshots_source_values
    CHECK (source IN ('neynar', 'x_api', 'manual')),
  CONSTRAINT metric_snapshots_value_nonnegative
    CHECK (value >= 0)
);

CREATE TABLE IF NOT EXISTS cta_click_daily (
  day       DATE    NOT NULL,
  post_slug TEXT    NOT NULL,
  link      TEXT    NOT NULL,
  clicks    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, post_slug, link),
  CONSTRAINT cta_click_daily_link_values CHECK (link IN ('cta', 'byline')),
  CONSTRAINT cta_click_daily_clicks_nonnegative CHECK (clicks >= 0)
);
