import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database
const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));

// Mock the Haiku framing classifier — the only network-touching seam in the
// linter. Default unconfigured (regex-only, no network); classifier-path tests
// flip classifierConfigured to true and stub classifyDeskPost per case.
vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: vi.fn(() => false),
  classifyDeskPost: vi.fn(),
}));

// Mock env vars
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { hashPayload } from "../src/shared/hash.js";
import { TIER2_DISCLAIMER } from "../src/servers/web/disclaimer.js";
import { deskContentHash, serializeSections } from "../src/servers/web/desk-sections.js";
import { classifierConfigured, classifyDeskPost } from "../src/servers/web/linter-classifier.js";
import {
  checkCareerPrognosis,
  checkDiagnosisAsFact,
  checkDisclaimer,
  checkSourceAttribution,
  checkNonPublicDetailRegex,
} from "../src/servers/web/linter.js";

const mockClassifierConfigured = vi.mocked(classifierConfigured);
const mockClassifyDeskPost = vi.mocked(classifyDeskPost);

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "test-web", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerWebTools(server);
  return server;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

const samplePost = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  athlete_name: "Patrick Mahomes",
  sport: "NFL",
  team: "Kansas City Chiefs",
  injury_type: "Ankle sprain",
  injury_severity: "MODERATE",
  content_type: "BREAKING",
  headline: "Mahomes suffers ankle sprain in practice",
  clinical_summary: "Grade 2 lateral ankle sprain with partial ligament tear.",
  return_to_play_min_weeks: 2,
  return_to_play_max_weeks: 4,
  rtp_probability_week_2: 0.3,
  rtp_probability_week_4: 0.75,
  rtp_probability_week_8: 0.95,
  rtp_confidence: 0.82,
  farcaster_hash: null,
  twitter_id: null,
  source_url: null,
  conflict_reason: null,
  team_timeline_weeks: null,
  status: "PUBLISHED",
  md_review_required: false,
  md_review_reason: null,
  md_review_confidence: null,
  version: 1,
  parent_post_id: null,
  slug: "patrick-mahomes-ankle-sprain-2026-03-24",
  created_at: "2026-03-24T00:00:00Z",
  updated_at: "2026-03-24T00:00:00Z",
};

const sampleReview = {
  id: "660e8400-e29b-41d4-a716-446655440001",
  post_id: samplePost.id,
  reason: "Low confidence score",
  status: "PENDING",
  reviewer_notes: null,
  created_at: "2026-03-24T01:00:00Z",
  reviewed_at: null,
  athlete_name: "Patrick Mahomes",
  sport: "NFL",
  headline: "Mahomes suffers ankle sprain in practice",
  slug: samplePost.slug,
};

const sampleEntity = {
  id: "770e8400-e29b-41d4-a716-446655440002",
  player_id: "880e8400-e29b-41d4-a716-446655440003",
  body_part: "ankle",
  laterality: "RIGHT",
  injury_type: "Ankle sprain",
  status: "ACTIVE",
  canonical_post_id: samplePost.id,
  first_reported_at: "2026-03-24T00:00:00Z",
  last_updated_at: "2026-03-26T00:00:00Z",
  actual_return_date: null,
};

const sampleUpdates = [
  {
    id: "990e8400-e29b-41d4-a716-446655440005",
    entity_id: sampleEntity.id,
    post_id: samplePost.id,
    update_kind: "TRACKING",
    severity_at_time: "MODERATE",
    team_timeline_weeks: 3,
    otm_min_weeks: 2,
    source_url: "https://espn.com/story/2",
    description: "Limited in practice",
    created_at: "2026-03-26T00:00:00Z",
  },
  {
    id: "aa0e8400-e29b-41d4-a716-446655440006",
    entity_id: sampleEntity.id,
    post_id: samplePost.id,
    update_kind: "INITIAL",
    severity_at_time: "MODERATE",
    team_timeline_weeks: 4,
    otm_min_weeks: 2,
    source_url: "https://espn.com/story/1",
    description: "Initial report",
    created_at: "2026-03-24T00:00:00Z",
  },
];

describe("Web MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-assert classifier defaults (clearAllMocks keeps implementations, so a
    // prior test's override would otherwise leak): unconfigured, empty result.
    mockClassifierConfigured.mockReturnValue(false);
    mockClassifyDeskPost.mockResolvedValue([]);
  });

  describe("web_create_injury_post", () => {
    it("should create a post successfully and return slug", async () => {
      // resolveUniqueSlug check (no collision) + INSERT
      mockSql
        .mockResolvedValueOnce([]) // slug uniqueness check — no collision
        .mockResolvedValueOnce([samplePost]); // INSERT RETURNING

      const server = createTestServer();
      const tool = getTool(server, "web_create_injury_post");

      const result = (await tool.handler(
        {
          athlete_name: "Patrick Mahomes",
          sport: "NFL",
          team: "Kansas City Chiefs",
          injury_type: "Ankle sprain",
          injury_severity: "MODERATE",
          content_type: "BREAKING",
          headline: "Mahomes suffers ankle sprain in practice",
          clinical_summary: "Grade 2 lateral ankle sprain.",
          return_to_play_estimate: {
            min_weeks: 2,
            max_weeks: 4,
            probability_week_2: 0.3,
            probability_week_4: 0.75,
            probability_week_8: 0.95,
            confidence: 0.82,
          },
        },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.post_id).toBe(samplePost.id);
      expect(data.slug).toBe(samplePost.slug);
      expect(data.status).toBe("PUBLISHED");
    });

    it("should append -2 to slug on collision", async () => {
      const collisionPost = { ...samplePost, slug: "patrick-mahomes-ankle-sprain-2026-03-24-2" };
      mockSql
        .mockResolvedValueOnce([{ id: "existing" }]) // base slug exists
        .mockResolvedValueOnce([])                    // -2 slug is free
        .mockResolvedValueOnce([collisionPost]);       // INSERT RETURNING

      const server = createTestServer();
      const tool = getTool(server, "web_create_injury_post");

      const result = (await tool.handler(
        {
          athlete_name: "Patrick Mahomes",
          sport: "NFL",
          team: "Kansas City Chiefs",
          injury_type: "Ankle sprain",
          injury_severity: "MODERATE",
          content_type: "BREAKING",
          headline: "Duplicate headline",
          clinical_summary: "Summary.",
          return_to_play_estimate: {
            min_weeks: 2,
            max_weeks: 4,
            probability_week_2: 0.3,
            probability_week_4: 0.75,
            probability_week_8: 0.95,
            confidence: 0.82,
          },
        },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.slug).toContain("-2");
    });

    it("should accept parent_post_id for TRACKING posts", async () => {
      const trackingPost = { ...samplePost, content_type: "TRACKING", parent_post_id: samplePost.id };
      mockSql
        .mockResolvedValueOnce([])               // slug check
        .mockResolvedValueOnce([trackingPost]);   // INSERT RETURNING

      const server = createTestServer();
      const tool = getTool(server, "web_create_injury_post");

      const result = (await tool.handler(
        {
          athlete_name: "Patrick Mahomes",
          sport: "NFL",
          team: "Kansas City Chiefs",
          injury_type: "Ankle sprain",
          injury_severity: "MODERATE",
          content_type: "TRACKING",
          headline: "Mahomes week 2 update",
          clinical_summary: "Progressing well.",
          return_to_play_estimate: {
            min_weeks: 1,
            max_weeks: 2,
            probability_week_2: 0.7,
            probability_week_4: 0.95,
            probability_week_8: 1.0,
            confidence: 0.9,
          },
          parent_post_id: samplePost.id,
        },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
    });

    it("should handle database errors", async () => {
      mockSql.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Connection refused"));

      const server = createTestServer();
      const tool = getTool(server, "web_create_injury_post");

      const result = (await tool.handler(
        {
          athlete_name: "Test",
          sport: "NFL",
          team: "Test Team",
          injury_type: "ACL",
          injury_severity: "SEVERE",
          content_type: "BREAKING",
          headline: "Test headline",
          clinical_summary: "Test summary",
          return_to_play_estimate: {
            min_weeks: 6,
            max_weeks: 12,
            probability_week_2: 0.0,
            probability_week_4: 0.1,
            probability_week_8: 0.4,
            confidence: 0.7,
          },
        },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("web_get_post_by_slug", () => {
    it("should retrieve a post by slug", async () => {
      mockSql.mockResolvedValue([samplePost]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_post_by_slug");

      const result = (await tool.handler(
        { slug: samplePost.slug },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.athlete_name).toBe("Patrick Mahomes");
      expect(data.slug).toBe(samplePost.slug);
    });

    it("should return error for missing slug", async () => {
      mockSql.mockResolvedValue([]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_post_by_slug");

      const result = (await tool.handler(
        { slug: "nonexistent-slug" },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("web_get_post", () => {
    it("should retrieve a post by ID", async () => {
      mockSql.mockResolvedValue([samplePost]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_post");

      const result = (await tool.handler(
        { post_id: samplePost.id },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.athlete_name).toBe("Patrick Mahomes");
      expect(data.slug).toBe(samplePost.slug);
    });

    it("should return error for missing post", async () => {
      mockSql.mockResolvedValue([]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_post");

      const result = (await tool.handler(
        { post_id: "550e8400-e29b-41d4-a716-446655440099" },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("web_get_entity", () => {
    it("should resolve an entity by id", async () => {
      mockSql.mockResolvedValue([sampleEntity]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_entity");

      const result = (await tool.handler(
        { entity_id: sampleEntity.id },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.entity.id).toBe(sampleEntity.id);
      expect(data.entity.canonical_post_id).toBe(samplePost.id);
    });

    it("should return error for missing entity", async () => {
      mockSql.mockResolvedValue([]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_entity");

      const result = (await tool.handler(
        { entity_id: "770e8400-e29b-41d4-a716-446655440099" },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  // canonical_post_id is a fill-if-null backfill, unlike every other field in
  // this statement. mockSql ignores the SQL text (it just returns queued rows),
  // so a mock can't evaluate COALESCE itself — the direction of the clause IS
  // the behaviour, and asserting on the generated SQL is the only way to pin it.
  // Transposing the two arguments would repoint every thread at its most recent
  // post instead of its originating one, silently and irreversibly.
  describe("web_thread_update_dates", () => {
    const ORIGINAL_POST_ID = samplePost.id;
    const NEW_POST_ID = "550e8400-e29b-41d4-a716-4466554400ff";

    // The tagged template arrives at mockSql as (strings, ...values).
    function lastQuery(): { text: string; values: unknown[] } {
      const call = mockSql.mock.calls[mockSql.mock.calls.length - 1] as [
        string[],
        ...unknown[],
      ];
      const [strings, ...values] = call;
      return { text: strings.join("?"), values };
    }

    it("backfills canonical_post_id when the thread has none", async () => {
      mockSql.mockResolvedValue([
        { ...sampleEntity, canonical_post_id: NEW_POST_ID },
      ]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_update_dates");

      const result = (await tool.handler(
        { entity_id: sampleEntity.id, canonical_post_id: NEW_POST_ID },
        {},
      )) as { content: Array<{ text: string }> };

      const { text, values } = lastQuery();
      expect(text).toContain("canonical_post_id = COALESCE(canonical_post_id,");
      expect(values).toContain(NEW_POST_ID);

      const data = JSON.parse(result.content[0].text);
      expect(data.entity.canonical_post_id).toBe(NEW_POST_ID);
    });

    it("never overwrites an already-set canonical_post_id", async () => {
      // Row comes back with the ORIGINAL canonical even though a different post
      // id was passed — that is the COALESCE keeping the established value.
      mockSql.mockResolvedValue([
        { ...sampleEntity, canonical_post_id: ORIGINAL_POST_ID },
      ]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_update_dates");

      const result = (await tool.handler(
        { entity_id: sampleEntity.id, canonical_post_id: NEW_POST_ID },
        {},
      )) as { content: Array<{ text: string }> };

      const { text } = lastQuery();
      // Column first, param second. Anything else is the overwrite direction.
      expect(text).toMatch(
        /canonical_post_id\s*=\s*COALESCE\(\s*canonical_post_id\s*,\s*\?::uuid\s*\)/,
      );
      expect(text).not.toMatch(
        /canonical_post_id\s*=\s*COALESCE\(\s*\?[^,)]*,\s*canonical_post_id\s*\)/,
      );

      const data = JSON.parse(result.content[0].text);
      expect(data.entity.canonical_post_id).toBe(ORIGINAL_POST_ID);
    });

    it("binds null for canonical_post_id when the caller omits it", async () => {
      // The resolveThreadAndDates() shape — dates only, no post exists yet.
      mockSql.mockResolvedValue([sampleEntity]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_update_dates");

      await tool.handler(
        { entity_id: sampleEntity.id, injury_date: "2026-03-24" },
        {},
      );

      const { text, values } = lastQuery();
      expect(text).toContain("canonical_post_id = COALESCE(canonical_post_id,");
      // COALESCE(col, NULL) → column untouched.
      expect(values).toContain(null);
      expect(values).not.toContain(NEW_POST_ID);
    });

    it("leaves the other fields on the incoming-value-wins direction", async () => {
      mockSql.mockResolvedValue([sampleEntity]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_update_dates");

      await tool.handler(
        { entity_id: sampleEntity.id, injury_date: "2026-03-24" },
        {},
      );

      // Guards against A1 having inverted the whole statement by accident.
      const { text } = lastQuery();
      expect(text).toMatch(/injury_date = COALESCE\(\?::date, injury_date\)/);
      expect(text).toMatch(/otm_projection = COALESCE\(\?::jsonb, otm_projection\)/);
    });
  });

  // web_thread_close — the VOID outcome (migration 020).
  //
  // VOID exists because entities are minted before any post exists and survive
  // their post's deletion (canonical_post_id is ON DELETE SET NULL), so an MD
  // rejecting a post used to leave an ACTIVE, post-less thread that kept
  // matching new events for that athlete. The invariant under test: a VOID
  // close must NOT write an accuracy_record, because grading a projection built
  // on a wrong body part drags the platform's published accuracy down with it.
  describe("web_thread_close", () => {
    // closeThread issues three statements: getEntity, the UPDATE, auditAppend.
    function queueCloseCalls(returned: Record<string, unknown>): void {
      mockSql
        .mockResolvedValueOnce([sampleEntity]) // getEntity
        .mockResolvedValueOnce([returned]) // UPDATE ... RETURNING *
        .mockResolvedValueOnce([{ id: "audit-1" }]); // auditAppend
    }

    function callAt(index: number): { text: string; values: unknown[] } {
      const call = mockSql.mock.calls[index] as [string[], ...unknown[]];
      const [strings, ...values] = call;
      return { text: strings.join("?"), values };
    }

    it("writes no accuracy_record and no returned_at for outcome VOID", async () => {
      const projected = {
        ...sampleEntity,
        // A projection IS present — the point is that VOID declines to score it.
        otm_projection: { min_weeks: 14, max_weeks: 24, projected_return_date: "2026-12-22" },
        injury_date: "2026-08-11",
      };
      mockSql
        .mockResolvedValueOnce([projected])
        .mockResolvedValueOnce([
          { ...projected, status: "VOID", accuracy_record: null, void_reason: "wrong body part" },
        ])
        .mockResolvedValueOnce([{ id: "audit-1" }]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_close");

      const result = (await tool.handler(
        {
          entity_id: sampleEntity.id,
          outcome: "VOID",
          void_reason: "wrong body part",
          closed_by: "md-user-1",
        },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const { text, values } = callAt(1); // the UPDATE
      // No serialized accuracy_record was bound. Checking the bound values
      // rather than the row we mocked back is what makes this test able to fail.
      expect(values.some((v) => typeof v === "string" && v.includes("projected_return_date"))).toBe(
        false,
      );
      expect(values).toContain("wrong body part");
      // returned_at is only stamped for RESOLVED; VOID must leave it alone.
      expect(text).toMatch(/returned_at = CASE WHEN \? = 'RESOLVED'/);

      const data = JSON.parse(result.content[0].text);
      expect(data.entity.status).toBe("VOID");
      expect(data.entity.accuracy_record).toBeNull();
    });

    it("audits a VOID as thread_voided, not thread_closed", async () => {
      queueCloseCalls({ ...sampleEntity, status: "VOID", void_reason: "rejected post" });

      const server = createTestServer();
      const tool = getTool(server, "web_thread_close");
      await tool.handler(
        { entity_id: sampleEntity.id, outcome: "VOID", void_reason: "rejected post" },
        {},
      );

      const audit = callAt(2);
      expect(audit.values).toContain("thread_voided");
      expect(audit.values).not.toContain("thread_closed");
    });

    it("still scores RESOLVED against the projection", async () => {
      const projected = {
        ...sampleEntity,
        otm_projection: { min_weeks: 2, max_weeks: 4, projected_return_date: "2026-04-07" },
        injury_date: "2026-03-24",
      };
      mockSql
        .mockResolvedValueOnce([projected])
        .mockResolvedValueOnce([{ ...projected, status: "RESOLVED" }])
        .mockResolvedValueOnce([{ id: "audit-1" }]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_close");
      await tool.handler(
        { entity_id: sampleEntity.id, outcome: "RESOLVED", actual_return_date: "2026-04-05" },
        {},
      );

      const { values } = callAt(1);
      const accuracy = values.find(
        (v) => typeof v === "string" && v.includes("projected_return_date"),
      ) as string | undefined;
      expect(accuracy).toBeDefined();
      expect(JSON.parse(accuracy!).actual_return_date).toBe("2026-04-05");

      const audit = callAt(2);
      expect(audit.values).toContain("thread_closed");
    });

    it("rejects actual_return_date on a VOID", async () => {
      mockSql.mockResolvedValueOnce([sampleEntity]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_close");
      const result = (await tool.handler(
        { entity_id: sampleEntity.id, outcome: "VOID", actual_return_date: "2026-04-05" },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("meaningless for outcome VOID");
      // Fail closed: only the read happened, nothing was written.
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it("rejects void_reason on a non-VOID outcome", async () => {
      mockSql.mockResolvedValueOnce([sampleEntity]);

      const server = createTestServer();
      const tool = getTool(server, "web_thread_close");
      const result = (await tool.handler(
        { entity_id: sampleEntity.id, outcome: "RETIRED", void_reason: "oops" },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  describe("web_list_injury_updates", () => {
    it("should list updates newest-first", async () => {
      mockSql.mockResolvedValue(sampleUpdates);

      const server = createTestServer();
      const tool = getTool(server, "web_list_injury_updates");

      const result = (await tool.handler(
        { entity_id: sampleEntity.id },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.updates).toHaveLength(2);
      expect(data.updates[0].update_kind).toBe("TRACKING");
      expect(data.updates[1].update_kind).toBe("INITIAL");
    });

    it("should return an empty array (not an error) when no updates exist", async () => {
      mockSql.mockResolvedValue([]);

      const server = createTestServer();
      const tool = getTool(server, "web_list_injury_updates");

      const result = (await tool.handler(
        { entity_id: sampleEntity.id },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.updates).toEqual([]);
    });
  });

  describe("web_flag_for_md_review", () => {
    it("should flag a post and insert into md_reviews", async () => {
      const flaggedPost = {
        ...samplePost,
        status: "PENDING_REVIEW",
        md_review_required: true,
        md_review_reason: "Low confidence score",
        md_review_confidence: 0.6,
      };
      // First call: UPDATE injury_posts RETURNING, second call: INSERT md_reviews
      mockSql
        .mockResolvedValueOnce([flaggedPost])
        .mockResolvedValueOnce([]);

      const server = createTestServer();
      const tool = getTool(server, "web_flag_for_md_review");

      const result = (await tool.handler(
        {
          post_id: samplePost.id,
          reason: "Low confidence score",
          confidence_score: 0.6,
          flagged_by: "injury-intelligence-agent",
        },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.review_status).toBe("PENDING_REVIEW");
      // Verify both DB calls were made
      expect(mockSql).toHaveBeenCalledTimes(2);
    });

    it("should return error for missing post", async () => {
      mockSql.mockResolvedValueOnce([]);

      const server = createTestServer();
      const tool = getTool(server, "web_flag_for_md_review");

      const result = (await tool.handler(
        {
          post_id: "550e8400-e29b-41d4-a716-446655440099",
          reason: "Test",
          confidence_score: 0.5,
          flagged_by: "test",
        },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("web_list_posts", () => {
    it("should list posts with pagination", async () => {
      mockSql
        .mockResolvedValueOnce([{ total: "2" }])
        .mockResolvedValueOnce([samplePost, { ...samplePost, id: "other-id" }]);

      const server = createTestServer();
      const tool = getTool(server, "web_list_posts");

      const result = (await tool.handler(
        { sport: "NFL", limit: 20, offset: 0 },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.posts).toHaveLength(2);
      expect(data.total).toBe(2);
      expect(data.has_more).toBe(false);
    });

    it("should indicate when more results exist", async () => {
      mockSql
        .mockResolvedValueOnce([{ total: "50" }])
        .mockResolvedValueOnce(Array(20).fill(samplePost));

      const server = createTestServer();
      const tool = getTool(server, "web_list_posts");

      const result = (await tool.handler(
        { limit: 20, offset: 0 },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.has_more).toBe(true);
      expect(data.next_offset).toBe(20);
    });
  });

  describe("web_update_injury_post", () => {
    it("should update a post", async () => {
      const updatedPost = {
        ...samplePost,
        headline: "Updated headline",
        version: 2,
        updated_at: "2026-03-24T01:00:00Z",
      };
      mockSql.mockResolvedValue([updatedPost]);

      const server = createTestServer();
      const tool = getTool(server, "web_update_injury_post");

      const result = (await tool.handler(
        {
          post_id: samplePost.id,
          updates: { headline: "Updated headline" },
          update_reason: "Corrected headline",
        },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.version).toBe(2);
    });
  });

  describe("web_list_md_reviews", () => {
    it("should list reviews with joined post fields", async () => {
      mockSql.mockResolvedValue([sampleReview]);

      const server = createTestServer();
      const tool = getTool(server, "web_list_md_reviews");

      const result = (await tool.handler({}, {})) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.reviews).toHaveLength(1);
      expect(data.reviews[0].athlete_name).toBe("Patrick Mahomes");
      expect(data.reviews[0].slug).toBe(samplePost.slug);
      expect(data.reviews[0].status).toBe("PENDING");
    });

    it("should filter by status", async () => {
      mockSql.mockResolvedValue([sampleReview]);

      const server = createTestServer();
      const tool = getTool(server, "web_list_md_reviews");

      const result = (await tool.handler({ status: "PENDING" }, {})) as {
        content: Array<{ text: string }>;
      };

      const data = JSON.parse(result.content[0].text);
      expect(data.reviews[0].status).toBe("PENDING");
      expect(mockSql).toHaveBeenCalledOnce();
    });
  });

  describe("web_update_md_review", () => {
    it("should approve a review and update linked post", async () => {
      const approvedReview = {
        ...sampleReview,
        status: "APPROVED",
        reviewed_at: "2026-03-24T02:00:00Z",
        post_id: samplePost.id,
      };
      // First call: UPDATE md_reviews RETURNING, second call: UPDATE injury_posts
      mockSql
        .mockResolvedValueOnce([approvedReview])
        .mockResolvedValueOnce([]);

      const server = createTestServer();
      const tool = getTool(server, "web_update_md_review");

      const result = (await tool.handler(
        {
          id: sampleReview.id,
          status: "APPROVED",
          reviewer_notes: "Clinically accurate, approved for publication.",
        },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("APPROVED");
      expect(data.post_updated).toBe(true);
      // Verify both DB calls (review update + post publish)
      expect(mockSql).toHaveBeenCalledTimes(2);
    });

    it("should reject a review without updating post", async () => {
      const rejectedReview = {
        ...sampleReview,
        status: "REJECTED",
        reviewed_at: "2026-03-24T02:00:00Z",
        post_id: samplePost.id,
      };
      mockSql.mockResolvedValueOnce([rejectedReview]);

      const server = createTestServer();
      const tool = getTool(server, "web_update_md_review");

      const result = (await tool.handler(
        {
          id: sampleReview.id,
          status: "REJECTED",
          reviewer_notes: "Needs clinical revision.",
        },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("REJECTED");
      expect(data.post_updated).toBe(false);
      // Only one DB call — no post update on rejection
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it("should return error for missing review", async () => {
      mockSql.mockResolvedValueOnce([]);

      const server = createTestServer();
      const tool = getTool(server, "web_update_md_review");

      const result = (await tool.handler(
        {
          id: "660e8400-e29b-41d4-a716-446655440099",
          status: "APPROVED",
        },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("web_get_user", () => {
    const mdUser = {
      id: "770e8400-e29b-41d4-a716-446655440002",
      email: "kpjohnsonmd@yahoo.com",
      role: "md",
      name: "Dr. K. P. Johnson",
      created_at: "2026-06-06T00:00:00Z",
    };

    it("should return the seeded MD with role 'md'", async () => {
      mockSql.mockResolvedValue([mdUser]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_user");

      const result = (await tool.handler(
        { user_id: mdUser.id },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.user.role).toBe("md");
      expect(data.user.email).toBe("kpjohnsonmd@yahoo.com");
    });

    it("should return null user when id is unknown", async () => {
      mockSql.mockResolvedValue([]);

      const server = createTestServer();
      const tool = getTool(server, "web_get_user");

      const result = (await tool.handler(
        { user_id: "770e8400-e29b-41d4-a716-446655440099" },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.user).toBeNull();
    });
  });

  describe("web_use_verification_token", () => {
    const tokenRow = {
      identifier: "kpjohnsonmd@yahoo.com",
      token: "hashed-token-abc",
      expires: "2026-06-06T01:00:00Z",
    };

    it("should consume a valid token (delete-on-read)", async () => {
      mockSql.mockResolvedValueOnce([tokenRow]); // DELETE ... RETURNING hits

      const server = createTestServer();
      const tool = getTool(server, "web_use_verification_token");

      const result = (await tool.handler(
        { identifier: tokenRow.identifier, token: tokenRow.token },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.verification_token.token).toBe("hashed-token-abc");
    });

    it("should return null on a second use (token already consumed)", async () => {
      mockSql.mockResolvedValueOnce([]); // DELETE matches nothing the second time

      const server = createTestServer();
      const tool = getTool(server, "web_use_verification_token");

      const result = (await tool.handler(
        { identifier: tokenRow.identifier, token: tokenRow.token },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.verification_token).toBeNull();
    });
  });

  describe("web_upsert_team", () => {
    // These assertions read the SQL text captured by mockSql. That proves which
    // branch ran and exactly what clause it emitted — it does NOT prove the
    // arbiter infers against a real index, that a second call updates instead
    // of inserting, or that COALESCE preserves prior values. Those need live
    // Postgres and are covered by the manual check in migration 017's header.
    const sampleTeam = {
      id: "cc0e8400-e29b-41d4-a716-446655440000",
      sport: "NBA",
      espn_team_id: null,
      name: "Test Club",
      abbreviation: "TC",
      location: null,
      display_name: null,
      conference: null,
      last_synced_at: "2026-08-12T00:00:00Z",
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z",
    };

    function capturedSql(): string {
      return mockSql.mock.calls
        .filter((c) => Array.isArray(c[0]))
        .map((c) => (c[0] as string[]).join(""))
        .join("\n");
    }

    it("arbitrates on (sport, espn_team_id) when an ESPN id is present", async () => {
      mockSql.mockResolvedValueOnce([{ ...sampleTeam, espn_team_id: "17" }]);
      const tool = getTool(createTestServer(), "web_upsert_team");

      const result = (await tool.handler(
        { sport: "NBA", espn_team_id: "17", name: "Test Club" },
        {},
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      const sql = capturedSql();
      expect(sql).toContain("ON CONFLICT (sport, espn_team_id)");
      expect(sql).not.toContain("lower(btrim(name))");
    });

    it("arbitrates on the partial name index when no ESPN id is supplied", async () => {
      mockSql.mockResolvedValueOnce([sampleTeam]);
      const tool = getTool(createTestServer(), "web_upsert_team");

      const result = (await tool.handler({ sport: "NBA", name: "Test Club" }, {})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      // Character-identical to uniq_teams_sport_name_no_espn in migration 017.
      // These two strings must stay in sync; any drift is a runtime 42P10, not
      // a compile error, and this assertion is the only automated guard.
      expect(capturedSql()).toContain(
        "ON CONFLICT (sport, lower(btrim(name))) WHERE espn_team_id IS NULL DO UPDATE SET",
      );
    });

    it("issues exactly one statement on the no-ESPN-id path", async () => {
      // The regression guard: upsertPlayer's no-ESPN fallback is a racy
      // SELECT-then-write. A single statement is what proves that pattern was
      // not copied here.
      mockSql.mockResolvedValueOnce([sampleTeam]);
      const tool = getTool(createTestServer(), "web_upsert_team");

      await tool.handler({ sport: "NBA", name: "Test Club" }, {});

      expect(mockSql).toHaveBeenCalledOnce();
    });

    it("never writes espn_team_id on the no-ESPN-id path", async () => {
      // Setting it would lift the row out of the partial index's predicate, so
      // the next call would insert a twin instead of updating.
      mockSql.mockResolvedValueOnce([sampleTeam]);
      const tool = getTool(createTestServer(), "web_upsert_team");

      await tool.handler({ sport: "NBA", name: "Test Club" }, {});

      const sql = capturedSql();
      expect(sql).toContain(
        "INSERT INTO teams (sport, name, abbreviation, location, display_name, conference, last_synced_at, updated_at)",
      );
      expect(sql.slice(sql.indexOf("DO UPDATE SET"))).not.toContain("espn_team_id");
    });

    it("preserves previously-populated optionals on the no-ESPN-id path", async () => {
      // The textual stand-in for the destructiveHint: false guarantee — a
      // minimal {sport, name} call must not blank fields a richer call set.
      mockSql.mockResolvedValueOnce([sampleTeam]);
      const tool = getTool(createTestServer(), "web_upsert_team");

      await tool.handler({ sport: "NBA", name: "Test Club" }, {});

      const sql = capturedSql();
      expect(sql).toContain("abbreviation = COALESCE(EXCLUDED.abbreviation, teams.abbreviation)");
      expect(sql).toContain("location = COALESCE(EXCLUDED.location, teams.location)");
      expect(sql).toContain("display_name = COALESCE(EXCLUDED.display_name, teams.display_name)");
      expect(sql).toContain("conference = COALESCE(EXCLUDED.conference, teams.conference)");
      // name is NOT NULL and .min(1), so a COALESCE there would be dead code.
      expect(sql).toContain("name = EXCLUDED.name");
    });

    it("returns the upserted row", async () => {
      mockSql.mockResolvedValueOnce([sampleTeam]);
      const tool = getTool(createTestServer(), "web_upsert_team");

      const result = (await tool.handler({ sport: "NBA", name: "Test Club" }, {})) as {
        content: Array<{ text: string }>;
      };

      const data = JSON.parse(result.content[0].text);
      expect(data.team.id).toBe(sampleTeam.id);
    });

    it("rejects an empty espn_team_id at the schema boundary", () => {
      // Asserted against inputSchema rather than through handler(): these tests
      // call the raw callback, which the SDK does not run Zod over. Without
      // .min(1), "" is falsy and would silently take the name path while the
      // caller believes it supplied an ESPN id.
      const tool = getTool(createTestServer(), "web_upsert_team") as unknown as {
        inputSchema: { safeParse(v: unknown): { success: boolean } };
      };

      expect(
        tool.inputSchema.safeParse({ sport: "NBA", name: "Test Club", espn_team_id: "" }).success,
      ).toBe(false);
      expect(
        tool.inputSchema.safeParse({ sport: "NBA", name: "Test Club", espn_team_id: "17" }).success,
      ).toBe(true);
    });

    it("clears left_coverage_at on the ESPN path but not the no-ESPN path", async () => {
      // Presence in the ESPN feed restores a club to coverage — this is what
      // makes promotion self-heal, so without it relegation is a one-way door.
      // The no-ESPN path must NOT do this: a hand-entered club should not
      // re-enter coverage as a side effect of a partial upsert.
      mockSql.mockResolvedValueOnce([{ ...sampleTeam, espn_team_id: "17" }]);
      const espnTool = getTool(createTestServer(), "web_upsert_team");
      await espnTool.handler({ sport: "NBA", espn_team_id: "17", name: "Test Club" }, {});
      expect(capturedSql()).toContain("left_coverage_at = NULL");

      mockSql.mockClear();
      mockSql.mockResolvedValueOnce([sampleTeam]);
      const nameTool = getTool(createTestServer(), "web_upsert_team");
      await nameTool.handler({ sport: "NBA", name: "Test Club" }, {});
      const sql = capturedSql();
      expect(sql.slice(sql.indexOf("DO UPDATE SET"))).not.toContain("left_coverage_at");
    });
  });

  // ── Player contract salary (migration 019) ───────────────────────────
  //
  // mockSql ignores the SQL text, so behaviour here is asserted through the
  // captured template strings. That is weaker than a real DB, but it is the
  // only guard that exists for the two failure modes below, both of which are
  // silent in production: a transposed COALESCE that wipes salaries every 6h
  // cycle, and the no-ESPN-id branch quietly not writing the column at all.
  describe("player salary", () => {
    const samplePlayer = {
      id: "dd0e8400-e29b-41d4-a716-446655440000",
      sport: "NFL",
      espn_athlete_id: "3929630",
      full_name: "Saquon Barkley",
      normalized_name: "saquon barkley",
      current_team_id: null,
      position: "RB",
      jersey: "26",
      prominence_tier: null,
      prominence_source: "espn",
      salary: 16750100,
      last_synced_at: "2026-08-12T00:00:00Z",
      retired_at: null,
    };

    function capturedSql(): string {
      return mockSql.mock.calls
        .filter((c) => Array.isArray(c[0]))
        .map((c) => (c[0] as string[]).join(""))
        .join("\n");
    }

    it("writes salary on the ESPN-id branch, preserving a known value when omitted", async () => {
      mockSql.mockResolvedValueOnce([samplePlayer]);
      const tool = getTool(createTestServer(), "web_upsert_player");

      const result = (await tool.handler(
        {
          sport: "NFL",
          espn_athlete_id: "3929630",
          full_name: "Saquon Barkley",
          salary: 16750100,
        },
        {},
      )) as { isError?: boolean };

      expect(result.isError).toBeUndefined();
      const sql = capturedSql();
      expect(sql).toContain("prominence_source, salary,");
      // Argument ORDER is the assertion, not merely the presence of a COALESCE.
      // ESPN omits contract for ~32% of NFL athletes, so roster-sync sends no
      // salary on most rows every cycle. Transposed, those cycles would blank
      // every salary we already hold and silently demote those athletes.
      expect(sql).toContain("salary = COALESCE(EXCLUDED.salary, players.salary)");
      expect(sql).not.toContain("salary = COALESCE(players.salary, EXCLUDED.salary)");
      expect(sql).not.toContain("salary = EXCLUDED.salary,");
    });

    it("writes salary on the no-ESPN-id branch, in BOTH the update and the insert", async () => {
      // The silent-no-op guard. This branch is a SELECT-then-write and its
      // UPDATE previously propagated only prominence_tier/prominence_source,
      // so a column added to the insert alone would never update for
      // override-list players (import-athlete-tiers.ts takes this path).
      mockSql.mockResolvedValueOnce([samplePlayer]); // SELECT finds an existing row
      mockSql.mockResolvedValueOnce([samplePlayer]); // UPDATE
      const tool = getTool(createTestServer(), "web_upsert_player");

      await tool.handler(
        { sport: "NFL", full_name: "Saquon Barkley", salary: 16750100 },
        {},
      );

      const updateSql = capturedSql();
      expect(updateSql).toContain("salary = COALESCE(");
      expect(updateSql.slice(updateSql.indexOf("UPDATE players SET"))).toContain("salary");

      mockSql.mockClear();
      mockSql.mockResolvedValueOnce([]); // SELECT finds nothing
      mockSql.mockResolvedValueOnce([samplePlayer]); // INSERT
      const insertTool = getTool(createTestServer(), "web_upsert_player");

      await insertTool.handler(
        { sport: "NFL", full_name: "Saquon Barkley", salary: 16750100 },
        {},
      );

      expect(capturedSql()).toContain("prominence_source, salary,");
    });

    it("list_players selects salary", async () => {
      // listPlayers has an explicit column list, so the column is invisible to
      // the agents-side snapshot unless it is named here.
      mockSql.mockResolvedValueOnce([{ ...samplePlayer, total_count: "1" }]);
      const tool = getTool(createTestServer(), "web_list_players");

      await tool.handler({ coverage: "all", limit: 100, offset: 0 }, {});

      expect(capturedSql()).toContain("p.salary");
    });

    it("resolve_player deliberately does NOT select salary", async () => {
      // The asymmetry with list_players is intentional: resolve is the
      // per-event publish-path lookup and has no salary consumer. Pinned so
      // that "completing" it reads as a deliberate change.
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      await tool.handler({ name: "Saquon Barkley", sport: "NFL" }, {});

      expect(capturedSql()).not.toContain("p.salary");
    });

    it("rejects a zero or negative salary, accepts omission", () => {
      // 0 is not a salary. Letting it through would flow into the tier bands
      // as a genuine value instead of falling back to the flat default —
      // migration 019 carries the matching CHECK constraint.
      // Asserted against inputSchema for the same reason as the espn_team_id
      // case above: these tests call the raw callback, which the SDK does not
      // run Zod over.
      const tool = getTool(createTestServer(), "web_upsert_player") as unknown as {
        inputSchema: { safeParse(v: unknown): { success: boolean } };
      };
      const base = { sport: "NFL", full_name: "Saquon Barkley" };

      expect(tool.inputSchema.safeParse({ ...base, salary: 0 }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ ...base, salary: -1 }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ ...base, salary: 1.5 }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ ...base, salary: 16750100 }).success).toBe(true);
      expect(tool.inputSchema.safeParse(base).success).toBe(true);
    });
  });

  // ── Coverage scope (migration 018) ───────────────────────────────────
  describe("coverage scope", () => {
    function capturedSql(): string {
      return mockSql.mock.calls
        .filter((c) => Array.isArray(c[0]))
        .map((c) => (c[0] as string[]).join(""))
        .join("\n");
    }

    const coverageTeamRow = {
      id: "cc0e8400-e29b-41d4-a716-446655440000",
      sport: "PREMIER_LEAGUE",
      espn_team_id: "379",
      name: "Burnley",
      abbreviation: "BUR",
      location: null,
      display_name: "Burnley",
      conference: null,
      left_coverage_at: null,
      last_synced_at: "2026-06-19T00:00:00Z",
      created_at: "2026-06-19T00:00:00Z",
      updated_at: "2026-06-19T00:00:00Z",
    };

    const resolvedRow = {
      player_id: "aa0e8400-e29b-41d4-a716-446655440000",
      full_name: "Test Player",
      prominence_tier: 2,
      current_team_id: "cc0e8400-e29b-41d4-a716-446655440000",
      current_team_name: "Test Club",
      current_team_abbreviation: "TC",
      current_team_synced_at: "2026-08-12T00:00:00Z",
      retired_at: null,
    };

    it.each([
      ["with a sport filter", { name: "Test Player", sport: "NBA" }],
      ["without a sport filter", { name: "Test Player" }],
    ])("resolve_player excludes out-of-coverage teams %s", async (_label, args) => {
      mockSql.mockResolvedValueOnce([resolvedRow]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      await tool.handler(args, {});

      expect(capturedSql()).toContain("AND t.left_coverage_at IS NULL");
    });

    it("puts the coverage predicate in WHERE, never in the LEFT JOIN's ON clause", async () => {
      // This is the assertion that matters most and the one a type checker can
      // never make. In the ON clause the predicate does NOT filter the player
      // out — it suppresses the join, returning them with a null team. That
      // converts a row hidden by design into one the fact-validator cannot
      // check, which is the exact fail-open this whole change exists to close.
      mockSql.mockResolvedValueOnce([resolvedRow]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      await tool.handler({ name: "Test Player", sport: "NBA" }, {});

      const sql = capturedSql();
      expect(sql).toContain("LEFT JOIN teams t ON t.id = p.current_team_id\n");
      expect(sql).not.toContain("ON t.id = p.current_team_id AND");
      // The predicate must sit after WHERE, not before it.
      expect(sql.indexOf("left_coverage_at")).toBeGreaterThan(sql.indexOf("WHERE"));
    });

    // ── Resolution by ESPN athlete id ──────────────────────────────────
    // UFC is the motivating case: fighters carry no team, so the name is the
    // only key a name-only lookup has, and MMA has genuine duplicate names
    // (two Bruno Silvas) that would pin the caller on 'ambiguous' permanently.
    it("resolve_player queries espn_athlete_id first and reports confidence 'exact'", async () => {
      mockSql.mockResolvedValueOnce([
        { ...resolvedRow, current_team_id: null, current_team_name: null },
      ]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      const result = (await tool.handler(
        { name: "Conor McGregor", sport: "UFC", espn_athlete_id: "3022677" },
        {},
      )) as { content: Array<{ text: string }> };

      const sql = capturedSql();
      expect(sql).toContain("p.espn_athlete_id = ");
      // The name query must not have run at all — a hit on the id is final.
      expect(sql).not.toContain("p.normalized_name = ");
      const data = JSON.parse(result.content[0].text);
      expect(data.resolved).toBe(true);
      expect(data.player.confidence).toBe("exact");
    });

    it("resolve_player carries the coverage predicate into the id query too", async () => {
      // Same fail-open as the name path: in the ON clause this would return the
      // player with a null team instead of withholding them.
      mockSql.mockResolvedValueOnce([resolvedRow]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      await tool.handler(
        { name: "Test Player", sport: "NBA", espn_athlete_id: "12345" },
        {},
      );

      const sql = capturedSql();
      expect(sql).toContain("AND t.left_coverage_at IS NULL");
      expect(sql).not.toContain("ON t.id = p.current_team_id AND");
      expect(sql.indexOf("left_coverage_at")).toBeGreaterThan(sql.indexOf("WHERE"));
    });

    it("resolve_player falls back to the name when the id finds nothing", async () => {
      mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([resolvedRow]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      const result = (await tool.handler(
        { name: "Test Player", sport: "NBA", espn_athlete_id: "does-not-exist" },
        {},
      )) as { content: Array<{ text: string }> };

      const sql = capturedSql();
      expect(sql).toContain("p.espn_athlete_id = ");
      expect(sql).toContain("p.normalized_name = ");
      const data = JSON.parse(result.content[0].text);
      expect(data.resolved).toBe(true);
      expect(data.player.confidence).toBe("normalized");
    });

    it("resolve_player is unchanged when no id is supplied", async () => {
      mockSql.mockResolvedValueOnce([resolvedRow]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      await tool.handler({ name: "Test Player", sport: "NBA" }, {});

      expect(capturedSql()).not.toContain("p.espn_athlete_id = ");
    });

    it("resolve_player returns the team's sync timestamp", async () => {
      mockSql.mockResolvedValueOnce([resolvedRow]);
      const tool = getTool(createTestServer(), "web_resolve_player");

      const result = (await tool.handler({ name: "Test Player", sport: "NBA" }, {})) as {
        content: Array<{ text: string }>;
      };

      expect(capturedSql()).toContain("t.last_synced_at AS current_team_synced_at");
      const data = JSON.parse(result.content[0].text);
      expect(data.player.current_team_synced_at).toBe("2026-08-12T00:00:00Z");
    });

    it("set_team_coverage COALESCEs the timestamp so a replay cannot move it", async () => {
      // callToolWithRetry replays an identical payload on any throw. A bare
      // NOW() would rewrite the recorded departure date every retry, which
      // would make idempotentHint: true a lie.
      mockSql.mockResolvedValueOnce([
        { ...coverageTeamRow, left_coverage_at: "2026-08-12T00:00:00Z" },
      ]);
      const tool = getTool(createTestServer(), "web_set_team_coverage");

      await tool.handler(
        { team_id: "cc0e8400-e29b-41d4-a716-446655440000", in_coverage: false },
        {},
      );

      expect(capturedSql()).toContain("COALESCE(teams.left_coverage_at, NOW())");
    });

    it("set_team_coverage errors on an unknown team id", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "web_set_team_coverage");

      const result = (await tool.handler(
        { team_id: "cc0e8400-e29b-41d4-a716-446655440000", in_coverage: false },
        {},
      )) as { isError?: boolean };

      expect(result.isError).toBe(true);
    });

    it("list_teams defaults to in-coverage, list_players defaults to all", () => {
      // Opposite defaults on purpose: list_teams feeds a diff against the ESPN
      // feed, where already-known departures would read as fresh drift every
      // cycle; list_players is diagnostic tooling for the hidden rows.
      const teams = getTool(createTestServer(), "web_list_teams") as unknown as {
        inputSchema: { parse(v: unknown): { coverage: string } };
      };
      const players = getTool(createTestServer(), "web_list_players") as unknown as {
        inputSchema: { parse(v: unknown): { coverage: string } };
      };

      expect(teams.inputSchema.parse({}).coverage).toBe("in");
      expect(players.inputSchema.parse({}).coverage).toBe("all");
    });

    it("rejects an unknown coverage value at the schema boundary", () => {
      const tool = getTool(createTestServer(), "web_list_teams") as unknown as {
        inputSchema: { safeParse(v: unknown): { success: boolean } };
      };

      expect(tool.inputSchema.safeParse({ coverage: "maybe" }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ coverage: "out" }).success).toBe(true);
    });
  });

  // ── Phase 2C — desk posts + the publish gate ─────────────────────────
  const mdUserRow = {
    id: "770e8400-e29b-41d4-a716-446655440002",
    email: "kpjohnsonmd@yahoo.com",
    role: "md",
    name: "Dr. K. P. Johnson",
    created_at: "2026-06-06T00:00:00Z",
  };
  const editorUserRow = { ...mdUserRow, id: "770e8400-e29b-41d4-a716-446655440003", role: "editor" };
  const DESK_POST_ID = "880e8400-e29b-41d4-a716-446655440000";
  const ATTESTATION_ID = "bb0e8400-e29b-41d4-a716-446655440000";
  const CANDIDATE_ID = "990e8400-e29b-41d4-a716-446655440000";
  const ENTITY_ID = "aa0e8400-e29b-41d4-a716-446655440000";
  const AUTHOR_ID = mdUserRow.id;
  const TITLE = "Test Athlete Knee";

  // A lint-clean set of the seven kpjmd sections: hedged framing, plain text
  // only. kpjmd escapes section prose and never parses markdown, so the linter
  // blocks markdown syntax — which is why attribution now comes from
  // source_attribution rather than the inline markdown link this fixture used
  // before sections existed. Keeping it clean means the publish/attest tests,
  // which rely on zero blockers, stay green.
  const SECTIONS = {
    snapshot: "Public reporting indicates a left knee issue, with no timeline shared.",
    what_happened: "According to public reports, the issue emerged during practice.",
    anatomy: "The knee carries load through several ligaments and the meniscus.",
    treatment: "Management of this category of injury ranges from rest to surgery.",
    timeline: "Recovery timelines vary widely and depend on the confirmed grade.",
    bridge: "For a recreational athlete, persistent knee swelling warrants evaluation.",
    dr_take: "This is general educational analysis, not a diagnosis of this athlete.",
  };

  // The body is DERIVED from the sections (serializeSections appends the Tier 2
  // disclaimer), and content_hash covers title+sections+meta. So a test that
  // wants to simulate an edit-after-attestation must vary `sections`, not
  // `markdown_body` — changing the body alone no longer moves the hash.
  const BODY = serializeSections(SECTIONS, {});
  const SOURCES = [{ url: "https://espn.com/story", outlet: "ESPN" }];
  // What attestDeskPost snapshots and evaluatePublishGate recomputes for an
  // un-overridden fixture post.
  const CLEAN_HASH = deskContentHash(TITLE, SECTIONS, {}, BODY);

  function deskPost(overrides: Record<string, unknown> = {}) {
    const sections = (overrides.sections ?? SECTIONS) as typeof SECTIONS;
    const meta = (overrides.meta ?? {}) as Record<string, unknown>;
    const title = (overrides.title ?? TITLE) as string;
    const markdown_body = (overrides.markdown_body ?? serializeSections(sections, meta)) as string;
    return {
      id: DESK_POST_ID,
      candidate_id: CANDIDATE_ID,
      entity_id: ENTITY_ID,
      slug: "test-athlete-knee",
      title,
      markdown_body,
      sections,
      meta,
      draft_json: null,
      status: "DRAFT",
      version: 1,
      author_id: AUTHOR_ID,
      reviewed_by: null,
      attestation_id: null,
      content_hash: deskContentHash(title, sections, meta, markdown_body),
      source_attribution: SOURCES,
      disclaimer_present: false,
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
      published_at: null,
      kpjmd_published_at: null,
      kpjmd_url: null,
      kpjmd_content_hash: null,
      ...overrides,
    };
  }

  function attestation(overrides: Record<string, unknown> = {}) {
    return {
      id: ATTESTATION_ID,
      desk_post_id: DESK_POST_ID,
      reviewer_user_id: mdUserRow.id,
      reviewed_source_reports: true,
      edited_for_accuracy: true,
      framing_confirmed: true,
      content_hash: CLEAN_HASH,
      timestamp: "2026-06-12T01:00:00Z",
      ip: null,
      ...overrides,
    };
  }

  type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

  describe("desk_create_draft", () => {
    it("creates a DRAFT from an ACCEPTED candidate and flips it to PROMOTED", async () => {
      mockSql
        .mockResolvedValueOnce([{ id: CANDIDATE_ID, entity_id: ENTITY_ID, status: "ACCEPTED" }]) // select candidate
        .mockResolvedValueOnce([]) // slug uniqueness
        .mockResolvedValueOnce([deskPost()]) // insert desk_posts
        .mockResolvedValueOnce([]) // insert version
        .mockResolvedValueOnce([]) // update candidate -> PROMOTED
        .mockResolvedValueOnce([{ id: "audit" }]); // audit

      const tool = getTool(createTestServer(), "desk_create_draft");
      const result = (await tool.handler(
        { candidate_id: CANDIDATE_ID, author_id: AUTHOR_ID, title: TITLE, sections: SECTIONS },
        {},
      )) as ToolResult;

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.post.status).toBe("DRAFT");
      const updatedCandidate = mockSql.mock.calls.find(
        (c) => Array.isArray(c[0]) && c[0].join("").includes("UPDATE desk_candidates"),
      );
      expect(updatedCandidate?.join("")).toContain("PROMOTED");
    });

    it("rejects a candidate that is not ACCEPTED", async () => {
      mockSql.mockResolvedValueOnce([{ id: CANDIDATE_ID, entity_id: ENTITY_ID, status: "PROPOSED" }]);
      const tool = getTool(createTestServer(), "desk_create_draft");
      const result = (await tool.handler(
        { candidate_id: CANDIDATE_ID, author_id: AUTHOR_ID, title: "x", sections: SECTIONS },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects an unknown candidate", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "desk_create_draft");
      const result = (await tool.handler(
        { candidate_id: CANDIDATE_ID, author_id: AUTHOR_ID, title: "x", sections: SECTIONS },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
    });
  });

  describe("desk_update_draft", () => {
    it("keeps DRAFT status and writes a new version", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "DRAFT", version: 1 })]) // select
        .mockResolvedValueOnce([deskPost({ status: "DRAFT", version: 2 })]) // update returning
        .mockResolvedValueOnce([]) // insert version
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_update_draft");
      const result = (await tool.handler(
        { desk_post_id: DESK_POST_ID, edited_by: AUTHOR_ID, sections: { snapshot: SECTIONS.snapshot + " Edited." } },
        {},
      )) as ToolResult;
      expect(result.isError).toBeUndefined();
    });

    it("reverts a READY post to DRAFT on edit (stale attestation)", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", version: 1 })]) // select
        .mockResolvedValueOnce([deskPost({ status: "DRAFT", version: 2 })]) // update returning
        .mockResolvedValueOnce([]) // insert version
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_update_draft");
      await tool.handler(
        { desk_post_id: DESK_POST_ID, edited_by: AUTHOR_ID, sections: { snapshot: SECTIONS.snapshot + " Edited." } },
        {},
      );
      const updateCall = mockSql.mock.calls.find(
        (c) => Array.isArray(c[0]) && c[0].join("").includes("UPDATE desk_posts SET"),
      );
      // newStatus is interpolated as a bound value; a READY source must write 'DRAFT'.
      expect(updateCall?.slice(1)).toContain("DRAFT");
    });

    it("rejects editing a PUBLISHED post", async () => {
      mockSql.mockResolvedValueOnce([deskPost({ status: "PUBLISHED" })]);
      const tool = getTool(createTestServer(), "desk_update_draft");
      const result = (await tool.handler(
        { desk_post_id: DESK_POST_ID, edited_by: AUTHOR_ID, sections: SECTIONS },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("errors when the optimistic-lock UPDATE matches nothing (concurrent change)", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "DRAFT", version: 1 })]) // select
        .mockResolvedValueOnce([]); // guarded update matched nothing (row moved)
      const tool = getTool(createTestServer(), "desk_update_draft");
      const result = (await tool.handler(
        { desk_post_id: DESK_POST_ID, edited_by: AUTHOR_ID, sections: { snapshot: SECTIONS.snapshot + " Edited." } },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("concurrently");
    });
  });

  describe("desk_lint", () => {
    it("returns no blockers for a clean, disclaimed, sourced body", async () => {
      mockSql.mockResolvedValueOnce([deskPost()]);
      const tool = getTool(createTestServer(), "desk_lint");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.blockers).toEqual([]);
      // Classifier mocked unconfigured → fail-open warning; deterministic checks still ran.
      expect(data.warnings.map((w: { code: string }) => w.code)).toContain("classifier_unavailable");
    });

    it("blocks a body that violates every deterministic rule", async () => {
      // source_attribution is cleared too: the fixture now carries structured
      // sources (sections cannot hold a markdown link — kpjmd escapes them), so
      // the attribution blocker only fires when there is genuinely no source.
      mockSql.mockResolvedValueOnce([
        deskPost({
          markdown_body: "He tore his ACL and is done for good.",
          source_attribution: null,
        }),
      ]);
      const tool = getTool(createTestServer(), "desk_lint");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      const codes = data.blockers.map((b: { code: string }) => b.code);
      expect(codes).toContain("diagnosis_as_fact");
      expect(codes).toContain("career_prognosis");
      expect(codes).toContain("missing_disclaimer");
      expect(codes).toContain("missing_source_attribution");
    });

    it("clears the disclaimer blocker once the canonical footer is present", async () => {
      mockSql.mockResolvedValueOnce([
        deskPost({ markdown_body: `See [ESPN](https://espn.com). ${TIER2_DISCLAIMER}` }),
      ]);
      const tool = getTool(createTestServer(), "desk_lint");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      const data = JSON.parse(result.content[0].text);
      const codes = data.blockers.map((b: { code: string }) => b.code);
      expect(codes).not.toContain("missing_disclaimer");
      expect(codes).not.toContain("missing_source_attribution");
    });

    it("adds a classifier blocker when configured", async () => {
      mockClassifierConfigured.mockReturnValue(true);
      mockClassifyDeskPost.mockResolvedValue([
        { code: "diagnosis_as_fact", severity: "blocker", message: "paraphrased diagnosis" },
      ]);
      mockSql.mockResolvedValueOnce([deskPost()]); // clean regex body
      const tool = getTool(createTestServer(), "desk_lint");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      const data = JSON.parse(result.content[0].text);
      expect(data.blockers.map((b: { code: string }) => b.code)).toContain("diagnosis_as_fact");
      expect(data.warnings.map((w: { code: string }) => w.code)).not.toContain("classifier_unavailable");
    });

    it("fails open with a warning when the classifier throws", async () => {
      mockClassifierConfigured.mockReturnValue(true);
      mockClassifyDeskPost.mockRejectedValue(new Error("Anthropic 529"));
      mockSql.mockResolvedValueOnce([deskPost()]); // clean regex body
      const tool = getTool(createTestServer(), "desk_lint");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      const data = JSON.parse(result.content[0].text);
      expect(data.blockers).toEqual([]); // clean body → no classifier blocker leaks through
      expect(data.warnings.map((w: { code: string }) => w.code)).toContain("classifier_unavailable");
    });

    it("errors on an unknown post", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "desk_lint");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });
  });

  describe("desk_attest", () => {
    const fullInput = {
      desk_post_id: DESK_POST_ID,
      reviewer_user_id: mdUserRow.id,
      reviewed_source_reports: true,
      edited_for_accuracy: true,
      framing_confirmed: true,
    };

    it("records an attestation as MD and moves the post to READY", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([deskPost({ status: "DRAFT" })]) // select post
        .mockResolvedValueOnce([attestation()]) // insert attestation
        .mockResolvedValueOnce([{ id: DESK_POST_ID }]) // status-guarded update post -> READY
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(fullInput, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.attestation.content_hash).toBe(CLEAN_HASH);
      const updateCall = mockSql.mock.calls.find(
        (c) => Array.isArray(c[0]) && c[0].join("").includes("UPDATE desk_posts"),
      );
      expect(updateCall?.join("")).toContain("'READY'");
    });

    it("rejects a non-MD reviewer (role re-derived from DB)", async () => {
      mockSql
        .mockResolvedValueOnce([editorUserRow]) // getUser -> editor
        .mockResolvedValueOnce([deskPost({ status: "DRAFT" })]); // select post
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(fullInput, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects when any confirmation is false", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([deskPost({ status: "DRAFT" })]); // select post
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(
        { ...fullInput, framing_confirmed: false },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects an unknown reviewer", async () => {
      mockSql
        .mockResolvedValueOnce([]) // getUser -> none
        .mockResolvedValueOnce([deskPost({ status: "DRAFT" })]); // select post
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(fullInput, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("errors when the status-guarded UPDATE matches nothing (concurrent publish)", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([deskPost({ status: "DRAFT" })]) // select post
        .mockResolvedValueOnce([attestation()]) // insert attestation
        .mockResolvedValueOnce([]); // guarded update -> READY matched nothing
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(fullInput, {})) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("changed status");
    });
  });

  describe("desk_publish — THE GATE", () => {
    const input = { desk_post_id: DESK_POST_ID, reviewer_user_id: mdUserRow.id };

    it("publishes when role=md, hash matches, and zero blockers", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", attestation_id: ATTESTATION_ID })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: CLEAN_HASH })]) // attestation by id
        .mockResolvedValueOnce([deskPost({ status: "PUBLISHED", published_at: "2026-06-12T02:00:00Z" })]) // update
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(true);
      expect(data.gate.passed).toBe(true);
      expect(data.post.status).toBe("PUBLISHED");
    });

    it("blocks a non-MD reviewer (published:false, role_ok:false)", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", attestation_id: ATTESTATION_ID })]) // select post
        .mockResolvedValueOnce([editorUserRow]) // getUser -> editor
        .mockResolvedValueOnce([attestation({ content_hash: CLEAN_HASH })]) // attestation by id
        .mockResolvedValueOnce([{ id: "audit" }]); // publish_blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.gate.role_ok).toBe(false);
    });

    it("blocks when a section was edited after attestation (hash mismatch)", async () => {
      const edited = { ...SECTIONS, snapshot: SECTIONS.snapshot + " Edited after attestation." };
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", sections: edited, attestation_id: ATTESTATION_ID })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: CLEAN_HASH })]) // stale hash
        .mockResolvedValueOnce([{ id: "audit" }]); // blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.gate.role_ok).toBe(true);
      expect(data.gate.hash_match).toBe(false);
    });

    it("blocks when there is no attestation", async () => {
      // attestation_id null → the by-id fetch is skipped; gate sees no attestation.
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", attestation_id: null })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([{ id: "audit" }]); // blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.gate.hash_match).toBe(false);
      expect(data.gate.reasons).toContain("no attestation found");
    });

    it("errors (not a gate-fail) when the post is not READY", async () => {
      mockSql.mockResolvedValueOnce([deskPost({ status: "DRAFT" })]);
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("errors when the post is not found", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("reports published:false (not a false success) if the row leaves READY before the write", async () => {
      // Gate passes, but the guarded UPDATE matches nothing — a concurrent
      // edit/publish moved the row. Must NOT record a publish that didn't happen.
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", attestation_id: ATTESTATION_ID })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: CLEAN_HASH })]) // attestation by id
        .mockResolvedValueOnce([]) // status-guarded UPDATE matched nothing
        .mockResolvedValueOnce([{ id: "audit" }]); // publish_blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.post).toBeNull();
      expect(data.gate.reasons.join(" ")).toContain("concurrent modification");
    });

    // The reason deskContentHash covers `meta` and not just the prose: without
    // it, an MD could attest, then add an FAQ or a conflict_flag, and publish
    // content that was never attested to. The gate must catch a meta-only edit
    // exactly as it catches a prose edit.
    it("blocks when only meta was edited after attestation (hash mismatch)", async () => {
      const withFaq = { faqs: [{ q: "Added after attestation?", a: "Yes." }] };
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", meta: withFaq, attestation_id: ATTESTATION_ID })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: CLEAN_HASH })]) // attested before the FAQ existed
        .mockResolvedValueOnce([{ id: "audit" }]); // blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.gate.role_ok).toBe(true);
      expect(data.gate.hash_match).toBe(false);
    });

    it("blocks when the body trips a regex blocker, even with role+hash OK", async () => {
      const dirtySections = { ...SECTIONS, dr_take: "His career is over — done for good." };
      const dirty = serializeSections(dirtySections, {});
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", sections: dirtySections, attestation_id: ATTESTATION_ID })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: deskContentHash(TITLE, dirtySections, {}, dirty) })]) // hash matches
        .mockResolvedValueOnce([{ id: "audit" }]); // blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.gate.role_ok).toBe(true);
      expect(data.gate.hash_match).toBe(true);
      expect(data.gate.blockers.map((b: { code: string }) => b.code)).toContain("career_prognosis");
    });

    it("blocks when the classifier returns a blocker, even with role+hash OK", async () => {
      mockClassifierConfigured.mockReturnValue(true);
      mockClassifyDeskPost.mockResolvedValue([
        { code: "diagnosis_as_fact", severity: "blocker", message: "paraphrased diagnosis" },
      ]);
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", attestation_id: ATTESTATION_ID })]) // select post (clean regex body)
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: CLEAN_HASH })]) // hash matches
        .mockResolvedValueOnce([{ id: "audit" }]); // blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.gate.role_ok).toBe(true);
      expect(data.gate.hash_match).toBe(true);
      expect(data.gate.blockers.map((b: { code: string }) => b.code)).toContain("diagnosis_as_fact");
    });
  });

  describe("desk_retract", () => {
    const input = { desk_post_id: DESK_POST_ID, reviewer_user_id: mdUserRow.id };

    it("retracts a PUBLISHED post as MD", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([deskPost({ status: "RETRACTED" })]) // update returning
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_retract");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.post.status).toBe("RETRACTED");
    });

    it("rejects retracting a non-PUBLISHED post", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([]); // update matched nothing
      const tool = getTool(createTestServer(), "desk_retract");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects a non-MD reviewer", async () => {
      mockSql.mockResolvedValueOnce([editorUserRow]); // getUser -> editor
      const tool = getTool(createTestServer(), "desk_retract");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });
  });

  describe("desk_list / desk_get", () => {
    it("lists desk posts", async () => {
      mockSql.mockResolvedValueOnce([deskPost(), deskPost({ id: "x", status: "PUBLISHED" })]);
      const tool = getTool(createTestServer(), "desk_list");
      const result = (await tool.handler({ limit: 100 }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.posts).toHaveLength(2);
    });

    it("gets a post with its attestations", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost()]) // select post
        .mockResolvedValueOnce([attestation()]); // select attestations
      const tool = getTool(createTestServer(), "desk_get");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.post.id).toBe(DESK_POST_ID);
      expect(data.attestations).toHaveLength(1);
    });

    it("errors getting an unknown post", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "desk_get");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });
  });

  // ── Return Watch (migration 015) ──────────────────────────────────────
  describe("web_get_published_desk_post_for_entity", () => {
    it("returns the most recent PUBLISHED desk post for an entity", async () => {
      mockSql.mockResolvedValueOnce([deskPost({ status: "PUBLISHED" })]);
      const tool = getTool(createTestServer(), "web_get_published_desk_post_for_entity");
      const result = (await tool.handler({ entity_id: ENTITY_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.post.status).toBe("PUBLISHED");
    });

    it("returns null when the entity has no PUBLISHED post", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "web_get_published_desk_post_for_entity");
      const result = (await tool.handler({ entity_id: ENTITY_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.post).toBeNull();
    });
  });

  describe("web_propose_candidate — candidate_kind", () => {
    it("rejects RETURN_WATCH_UPDATE without target_desk_post_id", async () => {
      const tool = getTool(createTestServer(), "web_propose_candidate");
      const result = (await tool.handler(
        { entity_id: ENTITY_ID, promotion_score: 60, candidate_kind: "RETURN_WATCH_UPDATE" },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
      expect(mockSql).not.toHaveBeenCalled();
    });

    it("rejects NEW_POST with a target_desk_post_id", async () => {
      const tool = getTool(createTestServer(), "web_propose_candidate");
      const result = (await tool.handler(
        {
          entity_id: ENTITY_ID,
          promotion_score: 60,
          candidate_kind: "NEW_POST",
          target_desk_post_id: DESK_POST_ID,
        },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
      expect(mockSql).not.toHaveBeenCalled();
    });

    it("proposes a RETURN_WATCH_UPDATE candidate targeting an existing post", async () => {
      mockSql
        .mockResolvedValueOnce([
          {
            id: CANDIDATE_ID,
            entity_id: ENTITY_ID,
            source_post_id: null,
            promotion_score: 60,
            reasons: null,
            status: "PROPOSED",
            candidate_kind: "RETURN_WATCH_UPDATE",
            target_desk_post_id: DESK_POST_ID,
            proposed_at: "2026-07-18T00:00:00Z",
            decided_at: null,
            decided_by: null,
          },
        ]) // insert/upsert candidate
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "web_propose_candidate");
      const result = (await tool.handler(
        {
          entity_id: ENTITY_ID,
          promotion_score: 60,
          candidate_kind: "RETURN_WATCH_UPDATE",
          target_desk_post_id: DESK_POST_ID,
        },
        {},
      )) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.candidate.candidate_kind).toBe("RETURN_WATCH_UPDATE");
      expect(data.candidate.target_desk_post_id).toBe(DESK_POST_ID);
    });
  });

  describe("desk_append_update", () => {
    const input = {
      desk_post_id: DESK_POST_ID,
      author_id: mdUserRow.id,
      headline: "Day 298: first game back",
      markdown_body: "Minutes restriction lifted; full participation in shootaround.",
      occurred_at: "2026-07-18T00:00:00Z",
    };
    const updateRow = {
      id: "cc0e8400-e29b-41d4-a716-446655440000",
      desk_post_id: DESK_POST_ID,
      headline: input.headline,
      markdown_body: input.markdown_body,
      occurred_at: input.occurred_at,
      author_id: mdUserRow.id,
      content_hash: hashPayload(input.markdown_body),
      created_at: "2026-07-18T00:00:00Z",
    };

    it("appends an update to a PUBLISHED post and refreshes draft_json", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([deskPost({ status: "PUBLISHED" })]) // select post
        .mockResolvedValueOnce([updateRow]) // insert desk_post_updates
        .mockResolvedValueOnce([{ athlete_name: "Test Athlete", sport: "NBA" }]) // getAthleteDisplayForEntity
        .mockResolvedValueOnce([updateRow]) // listDeskPostUpdates
        .mockResolvedValueOnce([]) // update draft_json
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_append_update");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.update.headline).toBe(input.headline);
    });

    it("rejects a non-MD author", async () => {
      mockSql.mockResolvedValueOnce([editorUserRow]); // getUser -> editor
      const tool = getTool(createTestServer(), "desk_append_update");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects appending to a non-PUBLISHED post", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([deskPost({ status: "DRAFT" })]); // select post
      const tool = getTool(createTestServer(), "desk_append_update");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("flips the linked RETURN_WATCH_UPDATE candidate to PROMOTED when candidate_id is supplied", async () => {
      mockSql
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([deskPost({ status: "PUBLISHED" })]) // select post
        .mockResolvedValueOnce([updateRow]) // insert desk_post_updates
        .mockResolvedValueOnce([{ athlete_name: "Test Athlete", sport: "NBA" }]) // getAthleteDisplayForEntity
        .mockResolvedValueOnce([updateRow]) // listDeskPostUpdates
        .mockResolvedValueOnce([]) // update draft_json
        .mockResolvedValueOnce([]) // update candidate -> PROMOTED
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_append_update");
      const result = (await tool.handler({ ...input, candidate_id: CANDIDATE_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const candidateUpdateCall = mockSql.mock.calls.find(
        (c) => Array.isArray(c[0]) && c[0].join("").includes("UPDATE desk_candidates"),
      );
      expect(candidateUpdateCall).toBeDefined();
    });
  });

  describe("desk_list_updates", () => {
    it("lists a desk post's updates newest-first", async () => {
      mockSql.mockResolvedValueOnce([
        { ...deskPost(), id: "u2", occurred_at: "2026-07-18T00:00:00Z" },
        { ...deskPost(), id: "u1", occurred_at: "2026-06-01T00:00:00Z" },
      ]);
      const tool = getTool(createTestServer(), "desk_list_updates");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.updates).toHaveLength(2);
    });

    it("returns an empty array when there are no updates", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "desk_list_updates");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.updates).toEqual([]);
    });
  });
});

// Pure deterministic linter rules — no server, no sql, no network.
describe("linter regex rules", () => {
  it("checkCareerPrognosis flags career-prognosis language", () => {
    expect(checkCareerPrognosis("This could be career-ending.")).toHaveLength(1);
    expect(checkCareerPrognosis("He may never play again.")).toHaveLength(1);
    expect(checkCareerPrognosis("This is done for good.")).toHaveLength(1);
    expect(checkCareerPrognosis("A short recovery is expected.")).toHaveLength(0);
  });

  it("checkDiagnosisAsFact flags definitive structure claims but not hedged ones", () => {
    expect(checkDiagnosisAsFact("He tore his ACL.")).toHaveLength(1);
    expect(checkDiagnosisAsFact("He has a torn labrum.")).toHaveLength(1);
    expect(checkDiagnosisAsFact("He reportedly tore his ACL.")).toHaveLength(0);
    expect(checkDiagnosisAsFact("According to ESPN, he has a torn labrum.")).toHaveLength(0);
    expect(checkDiagnosisAsFact("General ACL recovery takes months.")).toHaveLength(0);
  });

  it("checkDisclaimer requires the canonical footer", () => {
    expect(checkDisclaimer({ title: "t", markdown_body: "no footer here" })).toHaveLength(1);
    expect(
      checkDisclaimer({ title: "t", markdown_body: `analysis. ${TIER2_DISCLAIMER}` }),
    ).toHaveLength(0);
  });

  it("checkSourceAttribution accepts a link, <cite>, or structured sources", () => {
    expect(checkSourceAttribution({ title: "t", markdown_body: "plain text" })).toHaveLength(1);
    expect(
      checkSourceAttribution({ title: "t", markdown_body: "see [ESPN](https://espn.com)" }),
    ).toHaveLength(0);
    expect(
      checkSourceAttribution({ title: "t", markdown_body: "<cite>ESPN</cite> reported" }),
    ).toHaveLength(0);
    expect(
      checkSourceAttribution({ title: "t", markdown_body: "plain", source_attribution: [{ url: "x" }] }),
    ).toHaveLength(0);
  });

  it("checkNonPublicDetailRegex warns (not blocks) on imaging-reading language", () => {
    const f = checkNonPublicDetailRegex("The MRI showed a partial tear.");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warning");
    expect(checkNonPublicDetailRegex("Recovery is progressing well.")).toHaveLength(0);
  });
});
