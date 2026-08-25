import { describe, it, expect, vi } from "vitest";

// Every tool must carry all four MCP annotation hints. This matters more than
// it looks: the SDK's ToolAnnotationsSchema defaults are pessimistic
// (readOnlyHint false, destructiveHint true, openWorldHint true), so an
// unannotated tool advertises the worst reading of itself — a single SELECT
// looks exactly as dangerous as an unqualified DELETE.
//
// These are hints, not enforcement. The spec requires clients to treat them as
// untrusted unless the server is trusted; the real gates (publish gate,
// assertCanAttest, MD review queue) live server-side and are unaffected.

const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));

vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: vi.fn(() => false),
  classifyDeskPost: vi.fn(),
}));

vi.mock("../src/servers/farcaster/client.js", () => ({
  NeynarClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/servers/twitter/client.js", () => ({
  TwitterClient: vi.fn().mockImplementation(() => ({})),
}));

// Both social clients call requireEnv in their constructors, and construction
// happens during tool registration.
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
vi.stubEnv("NEYNAR_API_KEY", "test-key");
vi.stubEnv("NEYNAR_SIGNER_UUID", "test-signer");
vi.stubEnv("TWITTER_API_KEY", "test-key");
vi.stubEnv("TWITTER_API_SECRET", "test-secret");
vi.stubEnv("TWITTER_ACCESS_TOKEN", "test-token");
vi.stubEnv("TWITTER_ACCESS_TOKEN_SECRET", "test-token-secret");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { registerFarcasterTools } from "../src/servers/farcaster/tools.js";
import { registerTwitterTools } from "../src/servers/twitter/tools.js";

interface AnnotatedTool {
  annotations?: ToolAnnotations;
}

function annotationsByTool(
  register: (server: McpServer) => void,
): Record<string, ToolAnnotations | undefined> {
  const server = new McpServer(
    { name: "test-annotations", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  register(server);

  const registered = (server as unknown as { _registeredTools: Record<string, AnnotatedTool> })
    ._registeredTools;

  return Object.fromEntries(
    Object.entries(registered).map(([name, tool]) => [name, tool.annotations]),
  );
}

// [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]
type Hints = [boolean, boolean, boolean, boolean];

const READ: Hints = [true, false, true, false];
const READ_OPEN: Hints = [true, false, true, true];

function expand([readOnly, destructive, idempotent, openWorld]: Hints): ToolAnnotations {
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };
}

// Values derived per-tool from what each client method actually does in
// src/servers/*/client.ts — deliberately NOT from the tool name. The three
// rules behind the table:
//
//   destructiveHint — recoverability, not SQL shape. True only where rows are
//     deleted, public content is removed, or data is clobbered with no
//     in-system recovery path.
//   idempotentHint  — effect on domain state. audit_log is an append-only
//     observability ledger and is excluded; rows that are domain content
//     (attestations, draft versions) still count.
//   the pair        — destructiveHint says additive-vs-destructive,
//     idempotentHint says safe-to-redo. Publishing is additive but unsafe to
//     redo; deleting is destructive but converges.
const WEB: Record<string, Hints> = {
  web_create_injury_post: [false, false, false, false],
  // Overwrites in place with no version-history table; version increments.
  web_update_injury_post: [false, true, false, false],
  web_delete_injury_post: [false, true, true, false],
  // Neither destroys anything: the row survives with a retired status. That is
  // the whole reason they exist in place of a DELETE — see migration 021.
  // Idempotent because both guard on the source status, so a second call is a
  // no-op rather than a second retirement.
  web_reject_injury_post: [false, false, true, false],
  web_supersede_injury_post: [false, false, true, false],
  web_get_post: READ,
  web_get_post_by_slug: READ,
  web_get_post_by_social_id: READ,
  // Appends a new md_reviews PENDING row every call.
  web_flag_for_md_review: [false, false, false, false],
  web_list_posts: READ,
  web_list_md_reviews: READ,
  web_update_md_review: [false, false, true, false],
  // Unqualified DELETE FROM injury_posts.
  web_purge_all_posts: [false, true, true, false],
  web_get_social_state: READ,
  web_set_social_state: [false, false, true, false],
  web_check_mention_processed: READ,
  web_insert_processed_mention: [false, false, true, false],
  web_insert_pending_correction: [false, false, false, false],
  web_list_pending_corrections: READ,
  web_approve_injury_post: [false, false, true, false],
  // A true upsert on both paths: (sport, espn_team_id), else the partial unique
  // index on (sport, lower(btrim(name))) WHERE espn_team_id IS NULL.
  web_upsert_team: [false, false, true, false],
  web_upsert_player: [false, false, true, false],
  web_set_player_prominence: [false, false, true, false],
  web_resolve_player: READ,
  web_list_teams: READ,
  web_list_players: READ,
  // Reversible flag flip, not a delete: the row and every player link survive,
  // in_coverage=true restores it, and web_upsert_team restores it automatically
  // when the club reappears in the ESPN feed. Idempotent because the timestamp
  // is COALESCEd, so a replay cannot move an already-recorded departure date.
  web_set_team_coverage: [false, false, true, false],
  // Appends the correction note into the public clinical_summary; no undo.
  web_apply_correction: [false, true, false, false],
  web_get_entity_for_post: READ,
  web_get_entity: READ,
  web_get_published_desk_post_for_entity: READ,
  web_list_injury_updates: READ,
  web_find_matching_entity: READ,
  web_create_injury_entity: [false, false, false, false],
  web_append_injury_update: [false, false, false, false],
  web_thread_update_dates: [false, false, true, false],
  web_thread_append_timeline: [false, false, false, false],
  web_thread_close: [false, false, true, false],
  web_thread_get: READ,
  web_list_threads: READ,
  web_audit_append: [false, false, false, false],
  web_list_audit_entries: READ,
  web_propose_candidate: [false, false, true, false],
  web_list_candidates: READ,
  web_decide_candidate: [false, false, true, false],
  web_get_user: READ,
  web_get_user_by_email: READ,
  web_upsert_user: [false, false, true, false],
  web_create_verification_token: [false, false, false, false],
  // DELETE ... RETURNING — a single-use consume-on-read despite the name.
  web_use_verification_token: [false, true, true, false],
  desk_create_draft: [false, false, false, false],
  // Every save writes a desk_post_versions row: recoverable, but not idempotent.
  desk_update_draft: [false, false, false, false],
  // Read-only SQL, but the classifier calls Haiku.
  desk_lint: READ_OPEN,
  // A new desk_attestations row per call.
  desk_attest: [false, false, false, false],
  // Runs the linter (Haiku) on every invocation; guard throws before any write.
  desk_publish: [false, false, true, true],
  // Removes live public content.
  desk_retract: [false, true, true, false],
  // Fetches kpjmd.com; re-running after a redeploy is the intended flow.
  desk_confirm_kpjmd_live: [false, false, true, true],
  desk_append_update: [false, false, false, false],
  desk_list_updates: READ,
  desk_list: READ,
  desk_get: READ,
};

// Both social servers are pure external-API proxies — every tool is open-world.
const FARCASTER: Record<string, Hints> = {
  // Additive, but no idempotency key is sent: a retry publishes a duplicate.
  farcaster_publish_cast: [false, false, false, true],
  farcaster_publish_thread: [false, false, false, true],
  farcaster_get_cast: READ_OPEN,
  farcaster_get_notifications: READ_OPEN,
  // Irreversible externally, but re-deleting the same hash converges.
  farcaster_delete_cast: [false, true, true, true],
};

const TWITTER: Record<string, Hints> = {
  twitter_publish_tweet: [false, false, false, true],
  twitter_publish_thread: [false, false, false, true],
  twitter_get_tweet: READ_OPEN,
  twitter_get_mentions: READ_OPEN,
  twitter_delete_tweet: [false, true, true, true],
};

const SERVERS = [
  { label: "web", register: registerWebTools, expected: WEB, count: 61 },
  { label: "farcaster", register: registerFarcasterTools, expected: FARCASTER, count: 5 },
  { label: "twitter", register: registerTwitterTools, expected: TWITTER, count: 5 },
] as const;

const HINT_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

describe.each(SERVERS)("$label tool annotations", ({ register, expected, count }) => {
  const actual = annotationsByTool(register);

  // The completeness assertion. A tool added later without a table entry fails
  // here — this is what stops the annotation gap from silently reopening.
  it("annotates exactly the expected set of tools", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  });

  it("registers the expected number of tools", () => {
    expect(Object.keys(actual)).toHaveLength(count);
  });

  // A partially-filled annotation object would pass the set check above, so
  // assert every hint is explicitly present rather than falling back to the
  // SDK's pessimistic defaults.
  it("defines all four hints on every tool", () => {
    const incomplete = Object.entries(actual)
      .filter(([, ann]) => !ann || HINT_KEYS.some((k) => typeof ann[k] !== "boolean"))
      .map(([name]) => name);

    expect(incomplete).toEqual([]);
  });

  it("never marks a read-only tool destructive", () => {
    const contradictory = Object.entries(actual)
      .filter(([, ann]) => ann?.readOnlyHint === true && ann?.destructiveHint !== false)
      .map(([name]) => name);

    expect(contradictory).toEqual([]);
  });

  // Per-tool so a failure names the offending tool instead of dumping a 56-key diff.
  it.each(Object.keys(expected))("%s carries the expected hints", (name) => {
    expect(actual[name]).toEqual(expand(expected[name]));
  });
});

describe("annotation coverage across all servers", () => {
  it("covers all 71 tools", () => {
    const total = SERVERS.reduce(
      (sum, { register }) => sum + Object.keys(annotationsByTool(register)).length,
      0,
    );

    expect(total).toBe(71);
  });
});
