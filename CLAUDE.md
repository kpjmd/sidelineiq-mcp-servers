# SidelineIQ MCP Servers — Claude Code Guide

## What This Repository Is

This is the MCP (Model Context Protocol) server suite for SidelineIQ —
an autonomous AI sports injury intelligence platform. This repository
is intentionally standalone and independent from sidelineiq-agents.
It represents the integration layer between SidelineIQ and all external
data sources and publishing platforms.

This repo is proprietary infrastructure. Treat it as intellectual
property with long-term licensing potential.

## Repository Purpose

Houses all MCP servers that SidelineIQ's Injury Intelligence Agent
uses as tools. Each server wraps an external API or internal data
store and exposes it as clean MCP tools.

## Current Servers (Launch)

- `farcaster-mcp-server` — Publishes to Farcaster via Neynar API
- `twitter-mcp-server` — Publishes to X/Twitter via Twitter API v2
- `sidelineiq-web-mcp-server` — Reads/writes SidelineIQ Neon PostgreSQL
  database and routes to MD review queue

## Planned Future Servers (Do Not Build Yet)

- sportradar-mcp-server
- newsapi-mcp-server
- rss-mcp-server
- apifootball-mcp-server
- rotowire-mcp-server
- instagram-mcp-server
- prediction-mcp-server
- blockchain-mcp-server

## Tech Stack

- Language: TypeScript (strict mode — no exceptions)
- Transport: Streamable HTTP (all servers are remote Railway deployments)
- MCP SDK: @modelcontextprotocol/sdk
- Schema validation: Zod (all inputs must be validated)
- Database: Neon Serverless PostgreSQL
- Database pattern: Tagged template literals ONLY — no ORM, no query
  builders
- Deployment: Railway
- Node: 18+

## Critical Conventions

### Never Do These
- Never use an ORM (Prisma, Drizzle, TypeORM etc.)
- Never write SQL without tagged template literals
- Never log to stdout (stderr only — stdout breaks MCP protocol)
- Never hardcode API keys or secrets
- Never expose internal error details to MCP clients
- Never skip Zod validation on any tool input

### Always Do These
- All tools must have complete Zod input schemas
- All tools must have proper MCP annotations
  (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
- All tools must return both success and error shapes
- All environment variables must be in .env.example
- All errors must include actionable next steps in the message

### Tool Naming Convention
Format: `{server}_{action}_{resource}`
Examples: `farcaster_publish_cast`, `twitter_delete_tweet`,
`web_create_injury_post`
Always snake_case. Always service-prefixed.

### Port Assignments
- Farcaster MCP Server: 3101
- Twitter MCP Server: 3102
- SidelineIQ Web MCP Server: 3103

### A review-routed post is born PENDING_REVIEW, with its queue item

`web_create_injury_post` declares `status` (PUBLISHED | PENDING_REVIEW only —
retired statuses cannot be created) and `md_review_reason`. `createPost` is ONE
data-modifying CTE: the post and, when it is PENDING_REVIEW with a reason, its
md_reviews row commit together (the FK is checked at end of statement). The
result echoes `md_review_filed`. Before this `status` was stripped, every row
landed PUBLISHED, and the agent flipped it with a second call — so a failed
flag left a post routed to physician review live on the site and eligible for
the agent's ApprovalSync re-cast to social.

A PENDING_REVIEW create WITHOUT a reason is accepted on purpose: it is what a
pre-change agent sends mid-deploy. It lands non-public with no queue item and
`md_review_filed: false`, and that agent's own flag call files the row. Do not
"tighten" this into a rejection — it would fail every review-routed create in
the window between an mcp deploy and an agents deploy.

`web_flag_for_md_review`'s `confidence_score` is optional and COALESCEs onto
the stored value. A caller with no number of its own must not overwrite the
model's — never pass a placeholder. Migration 022 CHECKs both confidence
columns into [0,1] (NULL stays legal: the historical NULLs have no source).

### web_thread_update_dates re-anchors the OTM projection

`projected_return_date` is frozen at thread open as `injury_date` plus the midpoint
of the OTM week window. When `injury_date` CHANGES and the thread already carries an
`otm_projection`, `updateThreadDates` recomputes it from the STORED weeks and writes
an `otm_projection_reanchored` row to `audit_log`. This is the single place that
covers both the frontend MD date edit and the agents poller.

OTM is deliberately NOT re-run. The WEEKS are a clinical judgement about the injury
and do not change when the calendar anchor is corrected — only the arithmetic does,
and re-running would rewrite already-published content behind the MD's back. Pass an
explicit `otm_projection` to override the recomputation.

It fails closed on a missing projection or a non-numeric week bound. Check the TYPE,
not the coercion: `Number(null)` is `0` and `0` is finite, so a null `min_weeks` would
otherwise anchor the projection to half the window.

### A hand-set date outranks a re-derived one

`updateThreadDates`' UPDATE is `COALESCE(param, column)` — **param first, so any
supplied value OVERWRITES**. `canonical_post_id` in the same statement is inverted on
purpose so it only fills when null; `injury_date` never was. The agents poller calls
this tool on every cycle that reaches `resolveThreadAndDates`, carrying a freshly
resolved date, so an MD's hand correction was reverted on the next pass-through cycle.

Thread `83951acd` took four corrections and four reverts in three days — one of them
seven minutes after the edit — flipping `2025-12-14` back to `2024-12-14` and dragging
`projected_return_date` to a return date in the past. Both symptoms the MD reported,
"the date won't stick" and "the post is off by a year", were that one COALESCE.

So a **system** caller can no longer overwrite `injury_date`,
`injury_date_confidence`, `surgery_date`, `surgery_confirmed`,
`date_resolution_sources` or `needs_date_review` on a thread whose stored
`date_resolution_sources` carries `stage: 'md_manual'`. The discriminator is
`updated_by`, the same one the audit `actor` already derives from: the frontend MD
route passes the reviewer's id, the poller passes nothing. An MD can always correct
their own correction — the guard keys on WHO is writing, not on what.

`otm_projection` and `canonical_post_id` are deliberately NOT guarded. They are
bookkeeping rather than the date decision, and the poller builds its projection from a
thread read-back that now returns the MD's date, so protecting the entity protects the
post too.

A refusal that would have CHANGED the date logs `[Thread] … kept the MD's injury_date`
and appends an `md_date_write_refused` audit row; re-deriving the same value is silent.
That audit write is best-effort in a try/catch — the guard is the guarantee, the record
of it is not, and a failing insert must not throw on the poller's hot path.

This does NOT fix the resolver. It still returns different dates for one event across
cycles (`26f531ec` oscillated 08-19/08-20 four times with no MD involved) and is
systematically a year early on December injuries. That is a separate, open defect in
the agents repo's `resolveInjuryDate`; this guard only stops a human's answer being
thrown away by a machine's.

Side effect worth knowing: `computeAccuracyRecord` scores `error_days` off the frozen
`projected_return_date` while `within_range` uses the live `injury_date`. The
re-anchor keeps those two consistent for every row written after this shipped.

## Environment Variables

See .env.example for all required variables.
Never commit .env files. Railway manages production secrets.

## Relationship to Other Repos

- `sidelineiq-agents` — Consumes these MCP servers as tools.
  That repo connects to these servers via HTTP. Changes here
  may require corresponding updates there.
- `sidelineiq` — Frontend (Next.js/Vercel). Reads from the
  same Neon database this repo writes to.
- `orthoiq-agents` — Separate platform (OrthoIQ). Shares the
  same founder/physician but is an independent codebase.
  Do not cross-import.

## Deployment

Each server deploys as a separate process on Railway.
See railway.json and Procfile for configuration.
Each server is independently restartable.

## Adding a New MCP Server

When adding a new server follow this exact pattern:
1. Create `src/servers/{name}/` directory
2. Add `server.ts`, `client.ts`, `tools.ts`
3. Add port assignment to this CLAUDE.md and to .env.example
4. Register in `src/index.ts`
5. Add Railway process to Procfile
6. Update README.md server list

## Testing

Tests live in `tests/` directory.
Each server has its own test file.
Mock all external API calls — tests must run without live credentials.
