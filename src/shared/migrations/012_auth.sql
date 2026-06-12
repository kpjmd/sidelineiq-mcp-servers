-- 012_auth.sql
-- Phase 2 — the auth foundation. Verified physician identity is the hard
-- prerequisite for Tier 2 attestation: the shared ADMIN_SECRET is medico-legally
-- insufficient to bind Dr. Johnson's name + license to a published breakdown.
--
-- This migration introduces the identity model the rest of Phase 2 sits on:
--   • users — the 'md'/'editor' identities that NextAuth (frontend) authenticates
--     against and that the future desk_publish gate RE-DERIVES role from. The MCP
--     layer never trusts a caller-supplied role string; authority is this table,
--     keyed by users.id (a UUID), looked up via web_get_user.
--   • verification_token — the Auth.js Email (magic-link) token store. JWT sessions
--     can't persist these (token is issued at request time, consumed at click time),
--     so this table is required even though we use a JWT session strategy.
--
-- Schema ownership stays with the mcp repo even though NextAuth lives in the
-- frontend; the frontend reaches these tables only through MCP tools, never Neon
-- directly. Applied manually like 007–011: psql $DATABASE_URL -f this file.

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       VARCHAR(320) NOT NULL UNIQUE,
  -- Generated lowercase column so lookups/uniqueness are case-insensitive without
  -- callers having to remember to lower() — email is the magic-link identifier.
  email_lower VARCHAR(320) GENERATED ALWAYS AS (lower(email)) STORED,
  role        VARCHAR(16) NOT NULL CHECK (role IN ('md','editor')),
  name        VARCHAR(255),
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email_lower ON users(email_lower);

-- Auth.js Email-provider token store. A token is single-use: created on link
-- request, deleted-on-read at click time (see useVerificationToken — atomic
-- DELETE ... RETURNING, never select-then-delete, so a link can't be replayed).
CREATE TABLE IF NOT EXISTS verification_token (
  identifier TEXT NOT NULL,
  token      TEXT NOT NULL,
  expires    TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- Seed Dr. Johnson as the sole MD. Idempotent — re-running the migration (or
-- applying it after the row exists) is a no-op. Additional editors, if ever
-- needed, are added via web_upsert_user, not by editing this seed.
INSERT INTO users (email, role, name)
VALUES ('kpjohnsonmd@yahoo.com', 'md', 'Dr. K. P. Johnson')
ON CONFLICT (email) DO NOTHING;
