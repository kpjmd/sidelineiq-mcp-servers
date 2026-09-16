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
- Never pass a prebuilt `z.object(...)` to `server.tool()` — the SDK treats any
  non-raw-shape object in that slot as ANNOTATIONS and the tool registers with no
  input schema. Pass the raw shape; `withInputKeyPolicy` makes it strict.

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

### A clinical attribute was INSERT-only until it wasn't

`laterality`, `body_part` and `injury_type` on `injury_entities` were written by
`createInjuryEntity` and by nothing else, so a thread opened with the wrong side
could not be corrected through any tool. `fix-injury-laterality.ts`'s `--fix-entity`
path in the agents repo had been calling `web_apply_correction` with
`{entity_id, field:'laterality'}` — undeclared on three counts at once (that tool
targets `injury_posts`, `post_id` is required, and `laterality` is not in its field
enum) — and never checked `isError`, so entity laterality had never once been
corrected.

`web_thread_correct_laterality` closes that, and ONLY for laterality. `body_part`
and `injury_type` key entity matching in a way an in-place correction cannot
repair: changing them retroactively re-points which past reports should have
matched this thread, which is a larger decision than "the side is wrong".

Two behaviours worth keeping:
- **It does not touch `last_updated_at`.** That column drives
  `web_find_matching_entity`'s 21-day recency window, and a correction is
  bookkeeping, not new injury activity — bumping it silently extends the window in
  which the thread absorbs new reports.
- **Correcting to the stored value writes nothing at all** — no UPDATE and no audit
  row — so a repair script re-run cannot manufacture a change that did not happen.
  It also refuses a `VOID` thread: that thread was retracted as never having
  described a real injury, so there is no side to correct.

The readable diff lives in the audit `payload` (`previous_laterality` /
`new_laterality`), because `before`/`after` reach `audit_log` only as hashes — the
same rule `otm_projection_reanchored` follows.

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

### A close is not the end of the argument

`web_thread_close` used to be the one write in this server that nothing checked.
It would overwrite any `actual_return_date`, close a VOID thread, re-close a
settled one, and — because `computeAccuracyRecord` returned null with no
`otm_projection` — ERASE an accuracy record on the way past. All four were
harmless for as long as only a person ever closed a thread, one at a time,
knowing they had done it. The agents' return detector closes threads on a timer,
which changes the shape of every one of those mistakes.

**`return_source` (migration 025) is the missing half of the `md_manual` rule.**
`date_resolution_sources` documents the injury and surgery dates only; nothing
recorded where a RETURN date came from, so the guard above had nothing to key on.
The column is backfilled to `'md'` because, as of 2026-09-15, every return date
in the table was typed by a person. A system caller may not overwrite a stored
`'md'` date: the write is dropped, logged, and audited as
`md_return_write_refused` while **the close itself still proceeds** — refusing
the date must not leave the thread ACTIVE forever.

This matters more than the `injury_date` version. A wrong `injury_date` is
revisited every cycle by the next feed event; a closed thread leaves ACTIVE and
`web_find_matching_entity` never looks at it again, so nothing here is
self-correcting.

**Three refusals**, each mirroring a guard that already existed one tool over:
a VOID thread cannot be closed at all (`correctThreadLaterality` has refused
VOID since it shipped — closing one RESOLVED would score a projection built on a
wrong athlete, which is what migration 020 exists to prevent); a **system**
caller may only close an ACTIVE thread (a human may still re-close their own);
and `computeAccuracyRecord` now **always returns a record**, so the erase is
structurally unreachable rather than merely unlikely.

**`accuracy_record.scoreable`** carries that last change. Every other field is
nullable, so a reader could not tell "the projection was wrong" from "we never
had the inputs" — and an accuracy page that drops the second kind while counting
the first in its denominator is reporting a different number than the one it
names. `scoreable: false` names the missing input (`no_projection`,
`no_injury_date`, `no_actual_return_date`). It is **absent** on every row written
before 2026-09-15: readers must treat `scoreable === undefined` as "derive it"
(the historical equivalent is `within_range != null`), never as `false`.
`scoreable` tracks `within_range`, the headline metric — `error_days` may be null
on a scoreable record, which is why the median-signed-error metric carries its
own n.

**`web_thread_reopen` is the undo.** Until it shipped, `status` could never
return to `'ACTIVE'` through any tool in any of the three repos, so a wrong close
was repairable only by hand-written SQL against production, with no audit row. It
clears everything the close wrote — a half-reopened thread is worse than either
state, because an accuracy view would still score its stale record. VOID is
deliberately not reopenable, and it does not touch `last_updated_at`: a thread
reopened outside the 21-day matching window must not start absorbing reports
again because we fixed our own mistake.

### An unknown input key is an error, not a dropped field

Every tool registers a raw zod shape, which the SDK wraps in a plain `z.object`
— and `z.object` STRIPS undeclared keys and returns success, while tools/list
advertised `additionalProperties: false` on every object the whole time. That
mismatch cost the agent the model's post-level confidence on 183 rows (it sent a
flat `confidence`) and made `status` on web_create_injury_post a no-op for
months.

`withInputKeyPolicy` (`src/shared/input-key-policy.ts`) is applied in every
`server.ts` and rebuilds each registered tool's `inputSchema` with `.strict()` at
every depth, cloning wrapper defs so `.describe()` text survives. `z.record` /
`z.unknown` stay open (`payload`, `raw_payload`, `before`, `after`). Lever:
`MCP_UNKNOWN_KEYS=strict|strip`, default strict; only an explicit `strip`
reopens it. tools/list is byte-identical under both modes — strict changes what
is ENFORCED, not what is ADVERTISED; `tests/input-key-policy.test.ts` pins that
for all of them (79 as of 2026-09-15; the number is pinned in that test and in
`tests/annotations.test.ts`, so adding a tool means three edits, not one).

Before it shipped (2026-09-11) every caller was audited: all 123 agents call
sites, all 33 frontend ones, and a replay of every payload the agents test suite
builds against the strict schemas (0 undeclared keys; the same replay against
the pre-change schema flagged exactly `status`). A rejection reaches the caller
as a VALUE with `isError`, so the agents' `callTool` logs `[MCP] INPUT REJECTED`
for every caller at once.

**Test through validation.** `getTool(server, name).handler(args, {})` calls the
RAW callback — zod never runs, so neither stripping nor rejection is visible to
it. Use `tool.inputSchema.parse()` first, or a real `Client` over
`InMemoryTransport` (see `tests/input-key-policy.test.ts`).

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
