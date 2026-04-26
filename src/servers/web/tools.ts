import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebDatabaseClient } from "./client.js";
import type { InsertProcessedMentionInput, InsertPendingCorrectionInput } from "./client.js";
import { handleToolError, McpToolError, toolSuccess } from "../../shared/errors.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("web-tools");

const sportEnum = z.enum(["NFL", "NBA", "PREMIER_LEAGUE", "UFC", "OTHER"]);
const severityEnum = z.enum(["MINOR", "MODERATE", "SEVERE", "UNKNOWN"]);
const contentTypeEnum = z.enum(["BREAKING", "TRACKING", "DEEP_DIVE", "CONFLICT_FLAG"]);
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
      conflict_reason: z
        .string()
        .optional()
        .describe("Reason for conflict flag — set on CONFLICT_FLAG posts"),
      team_timeline_weeks: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Team's official return timeline in weeks"),
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
          conflict_reason: input.conflict_reason,
          team_timeline_weeks: input.team_timeline_weeks,
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
          conflict_reason: z.string().optional(),
          team_timeline_weeks: z.number().int().min(0).optional(),
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

  // ── web_delete_injury_post ──────────────────────────────────────────
  server.tool(
    "web_delete_injury_post",
    "Hard delete an injury post from the SidelineIQ database. Protected against accidentally deleting posts with TRACKING children — pass force:true to cascade-delete children and md_reviews.",
    {
      post_id: z.string().describe("The post ID to delete"),
      reason: z
        .string()
        .optional()
        .describe("Why this post is being deleted (for audit log)"),
      force: z
        .boolean()
        .optional()
        .describe(
          "If true, cascade-delete all TRACKING descendants and md_reviews. Required when the post has children.",
        ),
    },
    async (input) => {
      try {
        const childCount = await client.countTrackingChildren(input.post_id);

        if (!input.force && childCount > 0) {
          throw new McpToolError(
            `Cannot delete: post has ${childCount} TRACKING child post(s)`,
            "Delete children first or pass force:true to cascade-delete them along with the parent.",
          );
        }

        const result = await client.deletePost(input.post_id);

        logger.info("injury post deleted", {
          post_id: input.post_id,
          force: input.force ?? false,
          cascaded_count: input.force ? childCount : 0,
          ...(input.reason ? { reason: input.reason } : {}),
        });

        return toolSuccess({
          ...result,
          ...(input.force ? { cascaded_count: childCount } : {}),
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

  // ── web_get_post_by_slug ────────────────────────────────────────────
  server.tool(
    "web_get_post_by_slug",
    "Retrieve an injury post by its URL slug. Used by the frontend for slug-based routing.",
    {
      slug: z.string().min(1).describe("The URL slug to look up"),
    },
    async (input) => {
      try {
        const result = await client.getPostBySlug(input.slug);
        if (!result) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Post with slug '${input.slug}' not found. Use web_list_posts to find valid slugs.`,
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

  // ── web_purge_all_posts ─────────────────────────────────────────────
  server.tool(
    "web_purge_all_posts",
    "Purge ALL injury posts and their cascaded md_reviews from the database. One-time pre-launch operation. Requires confirm:true. Returns row counts before and after.",
    {
      confirm: z.literal(true).describe("Must be true to execute the purge"),
      reason: z.string().min(1).describe("Why the purge is being performed"),
    },
    async (input) => {
      try {
        const before = await client.getTableCounts();
        const deletedPosts = await client.purgeAllPosts();
        const after = await client.getTableCounts();

        logger.info("database purged", {
          reason: input.reason,
          deleted_posts: deletedPosts,
          before,
          after,
        });

        return toolSuccess({
          before,
          after,
          deleted_posts: deletedPosts,
          deleted_reviews: before.md_reviews - after.md_reviews,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_get_social_state ────────────────────────────────────────────
  server.tool(
    "web_get_social_state",
    "Read a value from the social monitor state table. Used to retrieve pagination cursors (twitter_mentions_since_id, farcaster_notifications_cursor) between polling cycles.",
    {
      key: z.string().describe("The state key to read"),
    },
    async (input) => {
      try {
        const value = await client.getSocialState(input.key);
        return toolSuccess({ key: input.key, value });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_set_social_state ────────────────────────────────────────────
  server.tool(
    "web_set_social_state",
    "Upsert a value in the social monitor state table. Used to persist pagination cursors between polling cycles.",
    {
      key: z.string().describe("The state key to write"),
      value: z.string().describe("The value to store"),
    },
    async (input) => {
      try {
        await client.setSocialState(input.key, input.value);
        return toolSuccess({ key: input.key, updated: true });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_check_mention_processed ─────────────────────────────────────
  server.tool(
    "web_check_mention_processed",
    "Check whether a social mention has already been processed. Returns processed:true if a matching row exists in processed_mentions.",
    {
      platform: z.string().describe("Platform: 'twitter' or 'farcaster'"),
      mention_id: z.string().describe("Tweet ID or cast hash"),
    },
    async (input) => {
      try {
        const processed = await client.checkMentionProcessed(input.platform, input.mention_id);
        return toolSuccess({ processed });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_insert_processed_mention ────────────────────────────────────
  server.tool(
    "web_insert_processed_mention",
    "Log a processed mention to the processed_mentions table. Call this after every mention regardless of action taken (REPLIED, IGNORED, QUEUED_CORRECTION). Silently ignores duplicates.",
    {
      platform: z.string().describe("Platform: 'twitter' or 'farcaster'"),
      mention_id: z.string().describe("Tweet ID or cast hash — unique mention identifier"),
      author_handle: z.string().describe("Author's @handle"),
      author_follower_count: z.number().int().optional().describe("Author's follower count"),
      mention_text: z.string().describe("Full text of the mention"),
      intent: z.string().describe("Classified intent (CORRECTION, CLINICAL_QUESTION, ENGAGEMENT, PUSHBACK, SOURCING, IGNORE)"),
      intent_confidence: z.number().min(0).max(1).optional().describe("Intent classification confidence 0-1"),
      action_taken: z.string().describe("Action taken: REPLIED | IGNORED | QUEUED_CORRECTION"),
      reply_content: z.string().optional().describe("Text of the reply posted"),
      reply_post_id: z.string().optional().describe("ID of the reply tweet or cast hash"),
      raw_payload: z.record(z.unknown()).optional().describe("Raw platform API response for audit"),
    },
    async (input) => {
      try {
        const data: InsertProcessedMentionInput = {
          platform: input.platform,
          mention_id: input.mention_id,
          author_handle: input.author_handle,
          author_follower_count: input.author_follower_count,
          mention_text: input.mention_text,
          intent: input.intent,
          intent_confidence: input.intent_confidence,
          action_taken: input.action_taken,
          reply_content: input.reply_content,
          reply_post_id: input.reply_post_id,
          raw_payload: input.raw_payload,
        };
        const result = await client.insertProcessedMention(data);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_insert_pending_correction ───────────────────────────────────
  server.tool(
    "web_insert_pending_correction",
    "Queue a user-submitted correction for admin review. Called when a mention is classified as CORRECTION with confidence > 0.8. Corrections do NOT auto-update posts.",
    {
      original_post_id: z.string().uuid().optional().describe("UUID of the OTM post being corrected"),
      mention_id: z.string().describe("Tweet ID or cast hash of the correcting mention"),
      platform: z.string().describe("Platform: 'twitter' or 'farcaster'"),
      correction_field: z.string().describe("Which field is being corrected (e.g. player_team, injury_type, rtp_weeks)"),
      old_value: z.string().describe("The value OTM originally stated"),
      new_value: z.string().describe("The corrected value from the user"),
      submitted_by_handle: z.string().describe("@handle of the user who submitted the correction"),
    },
    async (input) => {
      try {
        const data: InsertPendingCorrectionInput = {
          original_post_id: input.original_post_id,
          mention_id: input.mention_id,
          platform: input.platform,
          correction_field: input.correction_field,
          old_value: input.old_value,
          new_value: input.new_value,
          submitted_by_handle: input.submitted_by_handle,
        };
        const result = await client.insertPendingCorrection(data);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_list_pending_corrections ────────────────────────────────────
  server.tool(
    "web_list_pending_corrections",
    "List pending corrections submitted by users. Used by the admin dashboard to review and approve/dismiss factual corrections to OTM posts.",
    {
      status: z.enum(["PENDING", "APPROVED", "DISMISSED"]).optional().describe("Filter by status (default: all)"),
    },
    async (input) => {
      try {
        const corrections = await client.listPendingCorrections(input.status);
        return toolSuccess({ corrections });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_approve_injury_post ─────────────────────────────────────────
  server.tool(
    "web_approve_injury_post",
    "One-click approve a PENDING_REVIEW injury post. Flips status to PUBLISHED and marks the linked md_reviews row as APPROVED. Returns the full post row for downstream social publishing (Farcaster, Twitter). No reviewer notes required — for richer reviews with notes, use web_update_md_review.",
    {
      post_id: z.string().describe("The post ID to approve"),
    },
    async (input) => {
      try {
        const post = await client.approveInjuryPost(input.post_id);

        logger.info("injury post approved", { post_id: post.id });

        return toolSuccess({ approved: true, post });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );
}
