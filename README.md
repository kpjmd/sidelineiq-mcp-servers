 # SidelineIQ MCP Servers

MCP (Model Context Protocol) server suite for **SidelineIQ** — an autonomous AI sports injury intelligence platform. This repository houses all MCP servers that the SidelineIQ Injury Intelligence Agent uses as tools.

## Architecture

```
┌─────────────────────┐     HTTP      ┌──────────────────────────────┐
│  sidelineiq-agents  │ ────────────> │  sidelineiq-mcp-servers      │
│  (Claude Agent)     │               │                              │
└─────────────────────┘               │  ┌─ Farcaster Server :3101   │
                                      │  ├─ Twitter Server   :3102   │
                                      │  └─ Web Server       :3103   │
                                      └──────────────────────────────┘
                                               │            │
                                               ▼            ▼
                                         External APIs   Neon PostgreSQL
```

Each server is an independent Express app exposing MCP tools via **Streamable HTTP** transport on `/mcp`. All servers are stateless and deployed as separate Railway processes.

## Servers & Tools

### Farcaster MCP Server (port 3101)

Publishes to Farcaster via Neynar API.

| Tool | Description |
|------|-------------|
| `farcaster_publish_cast` | Publish a single cast (max 320 chars) |
| `farcaster_publish_thread` | Publish a multi-cast thread (2-10 casts) |
| `farcaster_get_cast` | Retrieve a cast by hash |
| `farcaster_delete_cast` | Delete a cast by hash |

### Twitter MCP Server (port 3102)

Publishes to X/Twitter via Twitter API v2.

| Tool | Description |
|------|-------------|
| `twitter_publish_tweet` | Publish a single tweet (max 280 chars) |
| `twitter_publish_thread` | Publish a multi-tweet thread (2-10 tweets) |
| `twitter_get_tweet` | Retrieve a tweet by ID |
| `twitter_delete_tweet` | Delete a tweet by ID |

### SidelineIQ Web MCP Server (port 3103)

Reads/writes injury posts to Neon PostgreSQL.

| Tool | Description |
|------|-------------|
| `web_create_injury_post` | Create a new injury post |
| `web_update_injury_post` | Update an existing post |
| `web_get_post` | Retrieve a post by ID |
| `web_flag_for_md_review` | Flag a post for MD review |
| `web_list_posts` | List/filter injury posts |

## Quick Start

### Prerequisites

- Node.js 18+
- Neon PostgreSQL database
- Neynar API key (for Farcaster)
- Twitter API v2 credentials (for Twitter)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd sidelineiq-mcp-servers
npm install

# Configure environment
cp .env.example .env
# Fill in your API keys in .env

# Run database migration
psql $DATABASE_URL -f src/shared/migrations/001_injury_posts.sql

# Start all servers (development)
npm run dev

# Or start individual servers
npm run dev:farcaster
npm run dev:twitter
npm run dev:web
```

### Verify

Each server exposes a health endpoint:

```bash
curl http://localhost:3101/health  # Farcaster
curl http://localhost:3102/health  # Twitter
curl http://localhost:3103/health  # Web
```

## Environment Variables

See [.env.example](.env.example) for all required variables:

| Variable | Description |
|----------|-------------|
| `PORT_FARCASTER` | Farcaster server port (default: 3101) |
| `PORT_TWITTER` | Twitter server port (default: 3102) |
| `PORT_WEB` | Web server port (default: 3103) |
| `NEYNAR_API_KEY` | Neynar API key for Farcaster |
| `NEYNAR_SIGNER_UUID` | Neynar signer UUID |
| `SIDELINEIQ_FARCASTER_FID` | SidelineIQ Farcaster FID |
| `TWITTER_API_KEY` | Twitter API key |
| `TWITTER_API_SECRET` | Twitter API secret |
| `TWITTER_ACCESS_TOKEN` | Twitter access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | Twitter access token secret |
| `TWITTER_BEARER_TOKEN` | Twitter bearer token |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `MD_REVIEW_CONFIDENCE_THRESHOLD` | Confidence threshold for MD review (default: 0.75) |

## Development

```bash
# Build
npm run build

# Type check
npm run lint

# Run tests
npm test

# Watch tests
npm run test:watch
```

## Railway Deployment

Each server deploys as a separate Railway process via the `Procfile`:

```
farcaster: node dist/servers/farcaster/server.js
twitter: node dist/servers/twitter/server.js
web: node dist/servers/web/server.js
```

1. Connect the repo to Railway
2. Set all environment variables in Railway dashboard
3. Railway auto-detects the `Procfile` and runs each process

Each server is independently restartable.

## Adding a New MCP Server

1. Create `src/servers/{name}/` directory
2. Add `server.ts` (Express + MCP server setup)
3. Add `client.ts` (API client wrapper)
4. Add `tools.ts` (tool definitions with Zod schemas)
5. Add port assignment to `CLAUDE.md` and `.env.example`
6. Register in `src/index.ts`
7. Add Railway process to `Procfile`
8. Add tests in `tests/{name}.test.ts`
9. Update this README

## Tool Naming Convention

Format: `{server}_{action}_{resource}`

- Always `snake_case`
- Always service-prefixed
- Examples: `farcaster_publish_cast`, `twitter_delete_tweet`, `web_create_injury_post`

## Project Structure

```
src/
├── index.ts                    # Main entry (starts all servers)
├── shared/
│   ├── database.ts             # Neon PostgreSQL client
│   ├── errors.ts               # Error handling utilities
│   ├── logger.ts               # Structured logging (stderr only)
│   ├── types.ts                # Shared TypeScript interfaces
│   └── migrations/
│       └── 001_injury_posts.sql
└── servers/
    ├── farcaster/
    │   ├── server.ts
    │   ├── client.ts
    │   └── tools.ts
    ├── twitter/
    │   ├── server.ts
    │   ├── client.ts
    │   └── tools.ts
    └── web/
        ├── server.ts
        ├── client.ts
        └── tools.ts
```

## Related Repositories

- **sidelineiq-agents** — Consumes these MCP servers as tools via HTTP
- **sidelineiq** — Frontend (Next.js/Vercel), reads from the same Neon database
- **orthoiq-agents** — Separate platform, independent codebase
