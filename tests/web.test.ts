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
});
