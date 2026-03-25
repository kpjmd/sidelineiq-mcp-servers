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
