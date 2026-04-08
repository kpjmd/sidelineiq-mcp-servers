import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebDatabaseClient } from "./client.js";
import { handleToolError, toolSuccess } from "../../shared/errors.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("web-tools");

const sportEnum = z.enum(["NFL", "NBA", "PREMIER_LEAGUE", "UFC", "OTHER"]);
const severityEnum = z.enum(["MINOR", "MODERATE", "SEVERE", "UNKNOWN"]);
const contentTypeEnum = z.enum(["BREAKING", "TRACKING", "DEEP_DIVE"]);
const statusEnum = z.enum(["PUBLISHED", "PENDING_REVIEW", "DRAFT"]);
const mdReviewStatusEnum = z.enum(["PENDING", "APPROVED", "REJECTED"]);

const returnToPlaySchema = z.object({
  min_weeks: z.number().int().min(0),
  max_weeks: z.number().int().min(0),
  probability_week_2: z.number().min(0).max(1),
  probability_week_4: z.number().min(0).max(1),
  probability_week_8: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});

export function registerWebTools(server: McpServer): void {
  const client = new WebDatabaseClient();

  // ── web_create_injury_post ──────────────────────────────────────────
  server.tool(
    "web_create_injury_post",
    "Create a new injury post in the SidelineIQ database for display on the web frontend. Stores full clinical content, platform publish status, and metadata. Auto-generates a URL slug.",
    {
      athlete_name: z.string().min(1).describe("Athlete's full name"),
      sport: sportEnum.describe("Sport league"),
      team: z.string().min(1).describe("Team name"),
      injury_type: z.string().min(1).describe("Clinical injury classification"),
      injury_severity: severityEnum.describe("Injury severity level"),
      content_type: contentTypeEnum.describe("Type of content"),
      headline: z.string().min(1).max(120).describe("Post headline (max 120 characters)"),
      clinical_summary: z.string().min(1).describe("Full clinical breakdown"),
      return_to_play_estimate: returnToPlaySchema.describe("Return-to-play timeline estimates"),
      farcaster_hash: z.string().optional().describe("Populated after Farcaster publish"),
      twitter_id: z.string().optional().describe("Populated after Twitter publish"),
      source_url: z.string().url().optional().describe("Original news source URL"),
      md_review_required: z.boolean().default(false).describe("Whether MD review is needed"),
      parent_post_id: z
        .string()
        .uuid()
        .optional()
        .describe("Parent BREAKING post ID — set on TRACKING updates"),
    },
    async (input) => {
      try {
        const result = await client.createPost({
          athlete_name: input.athlete_name,
          sport: input.sport,
          team: input.team,
          injury_type: input.injury_type,
          injury_severity: input.injury_severity,
          content_type: input.content_type,
          headline: input.headline,
          clinical_summary: input.clinical_summary,
          return_to_play_min_weeks: input.return_to_play_estimate.min_weeks,
          return_to_play_max_weeks: input.return_to_play_estimate.max_weeks,
          rtp_probability_week_2: input.return_to_play_estimate.probability_week_2,
          rtp_probability_week_4: input.return_to_play_estimate.probability_week_4,
          rtp_probability_week_8: input.return_to_play_estimate.probability_week_8,
          rtp_confidence: input.return_to_play_estimate.confidence,
          farcaster_hash: input.farcaster_hash,
          twitter_id: input.twitter_id,
          source_url: input.source_url,
          md_review_required: input.md_review_required,
          parent_post_id: input.parent_post_id,
        });

        return toolSuccess({
          post_id: result.id,
          slug: result.slug,
          created_at: result.created_at,
          status: result.status,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_update_injury_post ──────────────────────────────────────────
  server.tool(
    "web_update_injury_post",
    "Update an existing injury post. Used for Tracking updates as the injury story develops and return-to-play estimates are revised.",
    {
      post_id: z.string().uuid().describe("The post ID to update"),
      updates: z
        .object({
          athlete_name: z.string().min(1).optional(),
          sport: sportEnum.optional(),
          team: z.string().min(1).optional(),
          injury_type: z.string().min(1).optional(),
          injury_severity: severityEnum.optional(),
          content_type: contentTypeEnum.optional(),
          headline: z.string().min(1).max(120).optional(),
          clinical_summary: z.string().min(1).optional(),
          return_to_play_min_weeks: z.number().int().min(0).optional(),
          return_to_play_max_weeks: z.number().int().min(0).optional(),
          rtp_probability_week_2: z.number().min(0).max(1).optional(),
          rtp_probability_week_4: z.number().min(0).max(1).optional(),
          rtp_probability_week_8: z.number().min(0).max(1).optional(),
          rtp_confidence: z.number().min(0).max(1).optional(),
          farcaster_hash: z.string().optional(),
          twitter_id: z.string().optional(),
          source_url: z.string().url().optional(),
          md_review_required: z.boolean().optional(),
        })
        .describe("Fields to update"),
      update_reason: z.string().min(1).describe("Why this post is being updated"),
    },
    async (input) => {
      try {
        const result = await client.updatePost(
          input.post_id,
          input.updates,
          input.update_reason,
        );

        return toolSuccess({
          post_id: result.id,
          updated_at: result.updated_at,
          version: result.version,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_get_post ────────────────────────────────────────────────────
  server.tool(
    "web_get_post",
    "Retrieve an existing injury post by ID.",
    {
      post_id: z.string().uuid().describe("The post ID to retrieve"),
    },
    async (input) => {
      try {
        const result = await client.getPost(input.post_id);
        if (!result) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Post ${input.post_id} not found. Verify the post_id is correct. Use web_list_posts to find valid post IDs.`,
              },
            ],
            isError: true,
          };
        }
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_flag_for_md_review ──────────────────────────────────────────
  server.tool(
    "web_flag_for_md_review",
    "Flag an injury post for MD review. Sets post status to PENDING_REVIEW and creates a review record in the admin dashboard. Called when confidence is below threshold or injury is high-profile.",
    {
      post_id: z.string().uuid().describe("The post ID to flag"),
      reason: z.string().min(1).describe("Why MD review is needed"),
      confidence_score: z
        .number()
        .min(0)
        .max(1)
        .describe("Confidence score that triggered the review (0-1)"),
      flagged_by: z.string().min(1).describe("Which agent flagged it"),
    },
    async (input) => {
      try {
        const result = await client.flagForMdReview(
          input.post_id,
          input.reason,
          input.confidence_score,
          input.flagged_by,
        );

        return toolSuccess({
          post_id: result.id,
          review_status: result.status,
          flagged_at: result.updated_at,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_list_posts ──────────────────────────────────────────────────
  server.tool(
    "web_list_posts",
    "List injury posts with filtering. Used by the agent to check for duplicate coverage before publishing.",
    {
      sport: sportEnum.optional().describe("Filter by sport"),
      athlete_name: z.string().optional().describe("Filter by athlete name (partial match)"),
      content_type: contentTypeEnum.optional().describe("Filter by content type"),
      status: statusEnum.optional().describe("Filter by post status"),
      limit: z.number().int().min(1).max(50).default(20).describe("Results per page (max 50)"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async (input) => {
      try {
        const { posts, total } = await client.listPosts(
          {
            sport: input.sport,
            athlete_name: input.athlete_name,
            content_type: input.content_type,
            status: input.status,
          },
          input.limit,
          input.offset,
        );

        const hasMore = input.offset + input.limit < total;

        return toolSuccess({
          posts,
          total,
          has_more: hasMore,
          next_offset: hasMore ? input.offset + input.limit : null,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_list_md_reviews ─────────────────────────────────────────────
  server.tool(
    "web_list_md_reviews",
    "List MD review records for the admin dashboard, joined with injury post details. Optionally filter by review status.",
    {
      status: mdReviewStatusEnum
        .optional()
        .describe("Filter by review status (PENDING, APPROVED, REJECTED)"),
    },
    async (input) => {
      try {
        const reviews = await client.listMdReviews(input.status);
        return toolSuccess({ reviews });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_update_md_review ────────────────────────────────────────────
  server.tool(
    "web_update_md_review",
    "Approve or reject an MD review. If approved, also sets the linked injury post status to PUBLISHED. Sets reviewed_at timestamp.",
    {
      id: z.string().uuid().describe("The MD review ID to update"),
      status: z
        .enum(["APPROVED", "REJECTED"])
        .describe("The review decision"),
      reviewer_notes: z
        .string()
        .optional()
        .describe("Optional notes from the reviewing physician"),
    },
    async (input) => {
      try {
        const result = await client.updateMdReview({
          id: input.id,
          status: input.status,
          reviewer_notes: input.reviewer_notes,
        });

        return toolSuccess({
          id: result.id,
          post_id: result.post_id,
          status: result.status,
          reviewed_at: result.reviewed_at,
          post_updated: result.post_updated,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );
}
