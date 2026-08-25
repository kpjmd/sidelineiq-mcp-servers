import { describe, it, expect, vi, beforeEach } from "vitest";

// Post retirement — REJECTED and SUPERSEDED (migration 021).
//
// These assert on the SQL the client issues, because the whole safety argument
// lives in the WHERE clauses rather than in any return value:
//
//   - reject and supersede both guard on `status = 'PENDING_REVIEW'`, so
//     neither can ever touch a post an audience has seen. That guard is what
//     preserves "REJECTED implies no farcaster_hash / twitter_id", which
//     republish-social-orphans depends on without checking.
//   - reject nulls injury_entities.canonical_post_id and injury_updates.post_id
//     by hand, reproducing the ON DELETE SET NULL that the hard DELETE used to
//     perform. Skip it and shouldVoidThreadOnReject silently stops voiding.
//
// Every test here fails against pre-fix code: the tools did not exist, and
// web_list_posts' status enum rejected "REJECTED" outright.

const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));
vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: vi.fn(() => false),
  classifyDeskPost: vi.fn(),
}));
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWebTools } from "../src/servers/web/tools.js";

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function tool(name: string): RegisteredTool {
  const server = new McpServer(
    { name: "test-web", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerWebTools(server);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const found = tools[name];
  if (!found) throw new Error(`Tool ${name} not found`);
  return found;
}

const POST = "550e8400-e29b-41d4-a716-446655440000";
const NEWER = "550e8400-e29b-41d4-a716-4466554400ff";
const REVIEW = "660e8400-e29b-41d4-a716-446655440001";

/** Every statement the client issued, as one whitespace-collapsed string each. */
function statements(): string[] {
  return mockSql.mock.calls.map((call) => {
    const first = call[0];
    const text = Array.isArray(first) ? first.join(" ? ") : String(first);
    return text.replace(/\s+/g, " ").trim();
  });
}

const matching = (needle: RegExp) => statements().filter((s) => needle.test(s));

function unwrap(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  mockSql.mockReset();
});

describe("web_reject_injury_post", () => {
  /** SELECT status → UPDATE post → UPDATE review → UPDATE entity → UPDATE updates → audit */
  function stubPendingReject() {
    mockSql
      .mockResolvedValueOnce([{ id: POST, status: "PENDING_REVIEW" }]) // status probe
      .mockResolvedValueOnce([{ id: POST, status: "REJECTED" }]) // post update
      .mockResolvedValueOnce([{ id: REVIEW }]) // review close
      .mockResolvedValueOnce([{ id: "entity-1" }]) // canonical null
      .mockResolvedValueOnce([{ id: "update-1" }]) // updates null
      .mockResolvedValue([{ id: "audit-1" }]);
  }

  it("only flips a post that is PENDING_REVIEW", async () => {
    stubPendingReject();
    await tool("web_reject_injury_post").handler(
      { post_id: POST, reason: "wrong athlete", rejected_by: "md-1" },
      {},
    );
    const updates = matching(/UPDATE injury_posts/);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("status = 'REJECTED'");
    expect(updates[0]).toContain("status = 'PENDING_REVIEW'");
    expect(updates[0]).toContain("retired_at = NOW()");
  });

  it("closes the pending md_reviews row so the item leaves the queue", async () => {
    // md_reviews.post_id is ON DELETE CASCADE, so the old hard DELETE removed
    // the review row as a side effect. Keeping the post means this has to be
    // done explicitly or the rejected item sits in the MD queue forever.
    stubPendingReject();
    await tool("web_reject_injury_post").handler({ post_id: POST, rejected_by: "md-1" }, {});
    const reviews = matching(/UPDATE md_reviews/);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain("status = 'REJECTED'");
    expect(reviews[0]).toContain("status = 'PENDING'");
  });

  it("nulls both FKs the ON DELETE SET NULL used to null", async () => {
    stubPendingReject();
    const out = unwrap(
      await tool("web_reject_injury_post").handler({ post_id: POST, rejected_by: "md-1" }, {}),
    );
    expect(matching(/UPDATE injury_entities SET canonical_post_id = NULL/)).toHaveLength(1);
    expect(matching(/UPDATE injury_updates SET post_id = NULL/)).toHaveLength(1);
    expect(out.entity_links_cleared).toEqual({ canonical: 1, updates: 1 });
  });

  it("leaves an already-PUBLISHED post alone and does not throw", async () => {
    // flagForMdReview(preserve_status) can attach a PENDING review to live
    // content, so Reject is clickable on a published post. The old path
    // hard-deleted it. Failing closed here is what keeps the invariant
    // "REJECTED implies never published" true for every downstream reader.
    //
    // This one asserts the RESULT given a stubbed empty UPDATE, so it passes in
    // both directions — it pins the response shape, not the guard. The guard
    // itself is pinned by "only flips a post that is PENDING_REVIEW" above,
    // which reads the SQL.
    mockSql
      .mockResolvedValueOnce([{ id: POST, status: "PUBLISHED" }]) // status probe
      .mockResolvedValueOnce([]) // guarded UPDATE matches nothing
      .mockResolvedValueOnce([{ id: REVIEW }]) // review still closes
      .mockResolvedValue([{ id: "audit-1" }]);

    const out = unwrap(
      await tool("web_reject_injury_post").handler({ post_id: POST, rejected_by: "md-1" }, {}),
    );
    expect(out.post_updated).toBe(false);
    expect(out.post_status).toBe("PUBLISHED");
    expect(matching(/UPDATE md_reviews/)).toHaveLength(1);
    // The live post keeps its entity links — nothing about it was retracted.
    expect(matching(/canonical_post_id = NULL/)).toHaveLength(0);
    expect(matching(/UPDATE injury_updates SET post_id = NULL/)).toHaveLength(0);
  });

  it("resolves a review_id to its post", async () => {
    mockSql
      .mockResolvedValueOnce([{ post_id: POST }]) // review → post
      .mockResolvedValueOnce([{ id: POST, status: "PENDING_REVIEW" }])
      .mockResolvedValueOnce([{ id: POST, status: "REJECTED" }])
      .mockResolvedValueOnce([{ id: REVIEW }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "audit-1" }]);

    const out = unwrap(
      await tool("web_reject_injury_post").handler({ review_id: REVIEW, rejected_by: "md-1" }, {}),
    );
    expect(out.post_id).toBe(POST);
    expect(out.post_updated).toBe(true);
  });

  it("refuses both post_id and review_id together", async () => {
    const result = await tool("web_reject_injury_post").handler(
      { post_id: POST, review_id: REVIEW, rejected_by: "md-1" },
      {},
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("web_supersede_injury_post", () => {
  it("only retires rows that are PENDING_REVIEW, and reports the rest as skipped", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: POST }]) // guarded UPDATE
      .mockResolvedValueOnce([{ id: NEWER, status: "PUBLISHED" }]) // blocked probe
      .mockResolvedValue([{ id: "x" }]);

    const out = unwrap(
      await tool("web_supersede_injury_post").handler(
        { post_ids: [POST, NEWER], superseded_by: NEWER, reason: "already published" },
        {},
      ),
    );
    const update = matching(/UPDATE injury_posts/)[0];
    expect(update).toContain("status = 'SUPERSEDED'");
    expect(update).toContain("status = 'PENDING_REVIEW'");
    expect(out.superseded).toEqual([POST]);
    expect(out.skipped).toEqual([{ post_id: NEWER, status: "PUBLISHED" }]);
  });

  it("re-points canonical_post_id at the superseding post rather than nulling it", async () => {
    // Unlike a rejection: the superseding post is on the same thread by
    // construction, so it is the correct new anchor.
    mockSql
      .mockResolvedValueOnce([{ id: POST }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "x" }]);

    await tool("web_supersede_injury_post").handler(
      { post_ids: [POST], superseded_by: NEWER, reason: "already published" },
      {},
    );
    expect(matching(/UPDATE injury_entities SET canonical_post_id = \?/)).toHaveLength(1);
    expect(matching(/canonical_post_id = NULL/)).toHaveLength(0);
    expect(matching(/UPDATE injury_updates SET post_id = NULL/)).toHaveLength(1);
  });

  it("closes the review rows as SUPERSEDED, not REJECTED — no MD judged them", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: POST }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "x" }]);

    await tool("web_supersede_injury_post").handler(
      { post_ids: [POST], superseded_by: NEWER, reason: "already published" },
      {},
    );
    const reviews = matching(/UPDATE md_reviews/);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain("status = 'SUPERSEDED'");
    expect(reviews[0]).not.toContain("'REJECTED'");
  });

  it("touches nothing when nothing was pending", async () => {
    mockSql
      .mockResolvedValueOnce([]) // guarded UPDATE matched nothing
      .mockResolvedValueOnce([{ id: POST, status: "PUBLISHED" }])
      .mockResolvedValue([{ id: "x" }]);

    const out = unwrap(
      await tool("web_supersede_injury_post").handler(
        { post_ids: [POST], superseded_by: NEWER, reason: "already published" },
        {},
      ),
    );
    expect(out.superseded).toEqual([]);
    expect(matching(/UPDATE md_reviews/)).toHaveLength(0);
    expect(matching(/UPDATE injury_entities/)).toHaveLength(0);
  });
});

describe("web_list_posts status filter", () => {
  // FAILS against pre-fix code in the most direct way available: the zod enum
  // was ["PUBLISHED","PENDING_REVIEW","DRAFT"], so this argument was rejected
  // before the handler ran. Without it the agent cannot query its own
  // rejections and the reader audit cannot be verified live.
  it.each(["REJECTED", "SUPERSEDED"])("accepts status %s", async (status) => {
    mockSql.mockResolvedValue([{ total: "0" }]);
    const result = await tool("web_list_posts").handler({ status, limit: 20, offset: 0 }, {});
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });
});
