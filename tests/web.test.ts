import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database
const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));

// Mock env vars
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { hashPayload } from "../src/shared/hash.js";

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

describe("Web MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  const CANDIDATE_ID = "990e8400-e29b-41d4-a716-446655440000";
  const ENTITY_ID = "aa0e8400-e29b-41d4-a716-446655440000";
  const AUTHOR_ID = mdUserRow.id;
  const BODY = "Public reporting indicates a left knee injury; general educational analysis follows.";

  function deskPost(overrides: Record<string, unknown> = {}) {
    return {
      id: DESK_POST_ID,
      candidate_id: CANDIDATE_ID,
      entity_id: ENTITY_ID,
      slug: "test-athlete-knee",
      title: "Test Athlete Knee",
      markdown_body: BODY,
      draft_json: null,
      status: "DRAFT",
      version: 1,
      author_id: AUTHOR_ID,
      reviewed_by: null,
      attestation_id: null,
      content_hash: hashPayload(BODY),
      source_attribution: null,
      disclaimer_present: false,
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
      published_at: null,
      ...overrides,
    };
  }

  function attestation(overrides: Record<string, unknown> = {}) {
    return {
      id: "bb0e8400-e29b-41d4-a716-446655440000",
      desk_post_id: DESK_POST_ID,
      reviewer_user_id: mdUserRow.id,
      reviewed_source_reports: true,
      edited_for_accuracy: true,
      framing_confirmed: true,
      content_hash: hashPayload(BODY),
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
        { candidate_id: CANDIDATE_ID, author_id: AUTHOR_ID, title: "Test Athlete Knee", markdown_body: BODY },
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
        { candidate_id: CANDIDATE_ID, author_id: AUTHOR_ID, title: "x", markdown_body: BODY },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects an unknown candidate", async () => {
      mockSql.mockResolvedValueOnce([]);
      const tool = getTool(createTestServer(), "desk_create_draft");
      const result = (await tool.handler(
        { candidate_id: CANDIDATE_ID, author_id: AUTHOR_ID, title: "x", markdown_body: BODY },
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
        { desk_post_id: DESK_POST_ID, edited_by: AUTHOR_ID, markdown_body: BODY + " edit" },
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
        { desk_post_id: DESK_POST_ID, edited_by: AUTHOR_ID, markdown_body: BODY + " edit" },
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
        { desk_post_id: DESK_POST_ID, edited_by: AUTHOR_ID, markdown_body: BODY },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
    });
  });

  describe("desk_lint", () => {
    it("returns empty warnings/blockers for a found post (2C stub)", async () => {
      mockSql.mockResolvedValueOnce([deskPost()]);
      const tool = getTool(createTestServer(), "desk_lint");
      const result = (await tool.handler({ desk_post_id: DESK_POST_ID }, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.warnings).toEqual([]);
      expect(data.blockers).toEqual([]);
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
        .mockResolvedValueOnce([]) // update post -> READY
        .mockResolvedValueOnce([{ id: "audit" }]); // audit
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(fullInput, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.attestation.content_hash).toBe(hashPayload(BODY));
      const updateCall = mockSql.mock.calls.find(
        (c) => Array.isArray(c[0]) && c[0].join("").includes("UPDATE desk_posts"),
      );
      expect(updateCall?.join("")).toContain("'READY'");
    });

    it("rejects a non-MD reviewer (role re-derived from DB)", async () => {
      mockSql.mockResolvedValueOnce([editorUserRow]); // getUser -> editor
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(fullInput, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects when any confirmation is false", async () => {
      mockSql.mockResolvedValueOnce([mdUserRow]); // getUser
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(
        { ...fullInput, framing_confirmed: false },
        {},
      )) as ToolResult;
      expect(result.isError).toBe(true);
    });

    it("rejects an unknown reviewer", async () => {
      mockSql.mockResolvedValueOnce([]); // getUser -> none
      const tool = getTool(createTestServer(), "desk_attest");
      const result = (await tool.handler(fullInput, {})) as ToolResult;
      expect(result.isError).toBe(true);
    });
  });

  describe("desk_publish — THE GATE", () => {
    const input = { desk_post_id: DESK_POST_ID, reviewer_user_id: mdUserRow.id };

    it("publishes when role=md, hash matches, and zero blockers", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY" })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: hashPayload(BODY) })]) // latest attestation
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
        .mockResolvedValueOnce([deskPost({ status: "READY" })]) // select post
        .mockResolvedValueOnce([editorUserRow]) // getUser -> editor
        .mockResolvedValueOnce([attestation({ content_hash: hashPayload(BODY) })]) // attestation
        .mockResolvedValueOnce([{ id: "audit" }]); // publish_blocked audit
      const tool = getTool(createTestServer(), "desk_publish");
      const result = (await tool.handler(input, {})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.published).toBe(false);
      expect(data.gate.role_ok).toBe(false);
    });

    it("blocks when the body was edited after attestation (hash mismatch)", async () => {
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY", markdown_body: "EDITED BODY" })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([attestation({ content_hash: hashPayload(BODY) })]) // stale hash
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
      mockSql
        .mockResolvedValueOnce([deskPost({ status: "READY" })]) // select post
        .mockResolvedValueOnce([mdUserRow]) // getUser
        .mockResolvedValueOnce([]) // no attestation
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
});
