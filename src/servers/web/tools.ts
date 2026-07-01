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
      injury_date: z
        .string()
        .date()
        .optional()
        .describe("ISO 8601 date (YYYY-MM-DD) when the injury or surgery originally occurred"),
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
          injury_date: input.injury_date,
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

  // ── web_get_post_by_social_id ───────────────────────────────────────
  server.tool(
    "web_get_post_by_social_id",
    "Look up an OTM injury post by its Twitter ID or Farcaster hash — use this to retrieve the original post content when responding to mentions.",
    {
      platform: z.enum(["twitter", "farcaster"]).describe("The platform the social ID belongs to"),
      social_id: z.string().min(1).describe("Twitter tweet ID or Farcaster cast hash"),
    },
    async (input) => {
      try {
        const post = await client.getPostBySocialId(input.platform, input.social_id);
        if (!post) {
          return toolSuccess({ post: null });
        }
        return toolSuccess({
          post: {
            id: post.id,
            athlete_name: post.athlete_name,
            sport: post.sport,
            team: post.team,
            injury_type: post.injury_type,
            content_type: post.content_type,
            clinical_summary: post.clinical_summary,
            injury_date: post.injury_date ?? null,
            slug: post.slug,
          },
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_flag_for_md_review ──────────────────────────────────────────
  server.tool(
    "web_flag_for_md_review",
    "Flag an injury post for MD review. By default sets post status to PENDING_REVIEW (correct for new agent-generated content that hasn't published yet). Pass preserve_status=true for retrospective flags on already-PUBLISHED posts (legacy fact sweep, post-hoc audits) so the live post isn't pulled out of PUBLISHED filters.",
    {
      post_id: z.string().uuid().describe("The post ID to flag"),
      reason: z.string().min(1).describe("Why MD review is needed"),
      confidence_score: z
        .number()
        .min(0)
        .max(1)
        .describe("Confidence score that triggered the review (0-1)"),
      flagged_by: z.string().min(1).describe("Which agent flagged it"),
      preserve_status: z
        .boolean()
        .default(false)
        .describe(
          "When true, do NOT flip post status to PENDING_REVIEW. Use for retrospective flags on already-published posts.",
        ),
    },
    async (input) => {
      try {
        const result = await client.flagForMdReview(
          input.post_id,
          input.reason,
          input.confidence_score,
          input.flagged_by,
          input.preserve_status,
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

  // ── web_upsert_team ─────────────────────────────────────────────────
  server.tool(
    "web_upsert_team",
    "Upsert a team row from ESPN's teams endpoint. Conflict resolution: (sport, espn_team_id). Used by the roster-sync cycle that runs every 6h to keep teams current with trades and rebrands.",
    {
      sport: sportEnum,
      espn_team_id: z.string().optional(),
      name: z.string().min(1),
      abbreviation: z.string().optional(),
      location: z.string().optional(),
      display_name: z.string().optional(),
      conference: z.string().optional(),
    },
    async (input) => {
      try {
        const team = await client.upsertTeam(input);
        return toolSuccess({ team });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_upsert_player ───────────────────────────────────────────────
  server.tool(
    "web_upsert_player",
    "Upsert a player row from ESPN's roster endpoints (or the athlete-tier override list). Conflict resolution: (sport, espn_athlete_id) when ESPN id present, else (sport, normalized_name). The server canonicalizes full_name into normalized_name (lowercase, no diacritics, Jr/Sr stripped) to make later resolve() lookups deterministic.",
    {
      sport: sportEnum,
      espn_athlete_id: z.string().optional(),
      full_name: z.string().min(1),
      current_team_id: z.string().uuid().optional(),
      position: z.string().optional(),
      jersey: z.string().optional(),
      prominence_tier: z.number().int().min(1).max(4).optional(),
      prominence_source: z.enum(["espn", "override", "default"]).optional(),
    },
    async (input) => {
      try {
        const player = await client.upsertPlayer(input);
        return toolSuccess({ player });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_set_player_prominence ───────────────────────────────────────
  // Used by the athlete-tier override migration (data/athlete-tiers.json) and
  // future manual overrides of ESPN-default prominence.
  server.tool(
    "web_set_player_prominence",
    "Override the prominence_tier for a specific player. Used by the athlete-tier override import and any future manual prominence adjustments. prominence_source signals where the value came from for auditability ('override' for the JSON file, 'manual' for dashboard edits).",
    {
      player_id: z.string().uuid(),
      tier: z.number().int().min(1).max(4),
      source: z.string().min(1).default("override"),
    },
    async (input) => {
      try {
        const player = await client.setPlayerProminence(input.player_id, input.tier, input.source);
        return toolSuccess({ player });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_resolve_player ──────────────────────────────────────────────
  // The single function the fact-validator depends on: given a name + sport
  // from an incoming injury report, return the canonical player record so the
  // validator can compare reportedTeamName against the actual current team.
  server.tool(
    "web_resolve_player",
    "Resolve an athlete name to a canonical player record (with current team). Returns confidence='normalized' on a unique match, 'ambiguous' on multiple matches (caller should escalate to review), null on miss. This is the lookup that catches Luka-tagged-Lakers-class errors at ingestion time.",
    {
      name: z.string().min(1),
      sport: sportEnum.optional(),
    },
    async (input) => {
      try {
        const player = await client.resolvePlayer(input.name, input.sport);
        if (!player) {
          return toolSuccess({ resolved: false, player: null });
        }
        return toolSuccess({ resolved: true, player });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_apply_correction ────────────────────────────────────────────
  // Used by the legacy fact sweep (and any future manual correction tool).
  // Updates one allowlisted field on a published post, bumps correction_count,
  // sets corrected_at, appends a visible "Updated on <date>: <note>" line to
  // clinical_summary. NEVER silently overwrites — the public copy always shows
  // that a correction was made.
  server.tool(
    "web_apply_correction",
    "Apply a fact correction to a published injury post. Field must be one of: team, injury_type, injury_severity, team_timeline_weeks. Appends a visible 'Updated on <date>: <note>' line to clinical_summary and bumps correction_count — never a silent overwrite. Caller should follow up with web_append_injury_update kind=CORRECTION and web_audit_append.",
    {
      post_id: z.string().uuid(),
      field: z.enum(["team", "injury_type", "injury_severity", "team_timeline_weeks"]),
      new_value: z.string().min(1),
      note: z.string().min(1).describe("Public-facing reason for the correction"),
    },
    async (input) => {
      try {
        const result = await client.applyCorrection(
          input.post_id,
          input.field,
          input.new_value,
          input.note,
        );
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_get_entity_for_post ─────────────────────────────────────────
  server.tool(
    "web_get_entity_for_post",
    "Look up the injury entity associated with a post — either as the canonical_post_id or via an injury_updates link. Used by the entity backfill script to walk parent_post_id chains and reuse existing entities.",
    {
      post_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const entity = await client.getEntityForPost(input.post_id);
        return toolSuccess({ entity });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_get_entity ──────────────────────────────────────────────────
  server.tool(
    "web_get_entity",
    "Resolve an injury entity by id (player_id, body_part, laterality, injury_type, status, canonical_post_id, return date). Lets the Injury Desk walk a desk post's entity_id → canonical_post_id → web_get_post for fact-validation context.",
    {
      entity_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const entity = await client.getEntity(input.entity_id);
        if (!entity) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Entity ${input.entity_id} not found. Verify the entity_id is correct.`,
              },
            ],
            isError: true,
          };
        }
        return toolSuccess({ entity });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_list_injury_updates ─────────────────────────────────────────
  server.tool(
    "web_list_injury_updates",
    "List an injury entity's timeline updates newest-first (update_kind, severity_at_time, team_timeline_weeks, otm_min_weeks, source_url, description). Backs the Injury Desk entity-timeline panel. An empty array is a valid result, not an error.",
    {
      entity_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const updates = await client.listInjuryUpdates(input.entity_id);
        return toolSuccess({ updates });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_find_matching_entity ────────────────────────────────────────
  // The injury-identity dedup primitive. Replaces the 24h time-window check.
  // Given a resolved player and the body part / laterality / injury type
  // extracted from an incoming event, return the matching active entity (if
  // any) within recency_days. UNSPECIFIED laterality matches anything.
  server.tool(
    "web_find_matching_entity",
    "Find an active injury entity matching player + body part + laterality + injury type within a recency window. Returns the most recent matching entity (with last update's severity + team_timeline_weeks for delta-decision purposes) or matched=false if nothing matches.",
    {
      player_id: z.string().uuid(),
      body_part: z.string().optional(),
      laterality: z.enum(["LEFT", "RIGHT", "BILATERAL", "UNSPECIFIED"]).optional(),
      injury_type: z.string().optional(),
      recency_days: z.number().int().min(1).max(365).default(21),
    },
    async (input) => {
      try {
        const result = await client.findMatchingEntity(input);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_create_injury_entity ────────────────────────────────────────
  server.tool(
    "web_create_injury_entity",
    "Create a new injury entity. Called once per real-world injury — subsequent updates use web_append_injury_update. canonical_post_id should point to the originating BREAKING/DEEP_DIVE post when one exists.",
    {
      player_id: z.string().uuid(),
      body_part: z.string().optional(),
      laterality: z.enum(["LEFT", "RIGHT", "BILATERAL", "UNSPECIFIED"]).optional(),
      injury_type: z.string().optional(),
      canonical_post_id: z.string().uuid().optional(),
    },
    async (input) => {
      try {
        const entity = await client.createInjuryEntity(input);
        return toolSuccess({ entity });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_append_injury_update ────────────────────────────────────────
  server.tool(
    "web_append_injury_update",
    "Append an update to an injury entity's timeline. post_id is nullable (repeat source reports about the same injury append updates without producing a new post). Bumps the entity's last_updated_at so future recency-window matches stay current.",
    {
      entity_id: z.string().uuid(),
      post_id: z.string().uuid().optional(),
      update_kind: z.enum([
        "INITIAL",
        "TRACKING",
        "CONFLICT",
        "DEEP_DIVE",
        "CORRECTION",
        "RESOLUTION",
      ]),
      severity_at_time: severityEnum.optional(),
      team_timeline_weeks: z.number().int().min(0).optional(),
      otm_min_weeks: z.number().int().min(0).optional(),
      source_url: z.string().url().optional(),
      description: z.string().optional(),
    },
    async (input) => {
      try {
        const update = await client.appendInjuryUpdate(input);
        return toolSuccess({ update });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Injury threads (Managed Session layer, migration 014) ───────────
  // A "thread" is an injury_entities row read together with its injury_updates
  // trajectory. These tools persist the resolved injury/surgery dates, the
  // frozen OTM projection, and the closure/accuracy record on that entity.

  // ── web_thread_update_dates ─────────────────────────────────────────
  server.tool(
    "web_thread_update_dates",
    "Persist resolved injury/surgery dates and provenance onto an injury thread (the injury_entities row). Called by the pre-OTM date-resolution loop, the post-publish projection patch, and MD manual date entry. Every field is optional and COALESCE'd against the current value — omit a field to leave it untouched. needs_date_review auto-clears when confidence is not 'unknown' unless set explicitly.",
    {
      entity_id: z.string().uuid(),
      injury_date: z.string().date().optional(),
      injury_date_confidence: z.enum(["unknown", "possible", "probable", "confirmed"]).optional(),
      surgery_date: z.string().date().optional(),
      surgery_confirmed: z.boolean().optional(),
      date_resolution_sources: z
        .array(
          z.object({
            url: z.string().url().optional(),
            title: z.string().optional(),
            stage: z.enum(["api", "web_search", "md_manual"]),
          }),
        )
        .optional(),
      otm_projection: z
        .object({
          min_weeks: z.number(),
          max_weeks: z.number(),
          probability_week_2: z.number().optional(),
          probability_week_4: z.number().optional(),
          probability_week_8: z.number().optional(),
          projected_return_date: z.string().date().nullable().optional(),
          created_at: z.string().optional(),
        })
        .optional(),
      needs_date_review: z.boolean().optional(),
    },
    async (input) => {
      try {
        const entity = await client.updateThreadDates(input);
        return toolSuccess({ entity });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_thread_append_timeline ──────────────────────────────────────
  server.tool(
    "web_thread_append_timeline",
    "Append a trajectory data-point to a thread before the post is drafted: the reported team timeline, OTM min weeks, severity, and source. Thin wrapper over injury_updates (reported_timeline_weeks maps to team_timeline_weeks); post_id is attached later by entity bookkeeping. Use update_kind INITIAL for the first report on a new thread, TRACKING for subsequent ones.",
    {
      entity_id: z.string().uuid(),
      reported_timeline_weeks: z.number().int().min(0).optional(),
      otm_min_weeks: z.number().int().min(0).optional(),
      severity_at_time: severityEnum.optional(),
      source_url: z.string().url().optional(),
      description: z.string().optional(),
      update_kind: z.enum(["INITIAL", "TRACKING", "CONFLICT", "CORRECTION"]).default("TRACKING"),
    },
    async (input) => {
      try {
        const update = await client.appendInjuryUpdate({
          entity_id: input.entity_id,
          update_kind: input.update_kind,
          severity_at_time: input.severity_at_time,
          team_timeline_weeks: input.reported_timeline_weeks,
          otm_min_weeks: input.otm_min_weeks,
          source_url: input.source_url,
          description: input.description,
        });
        return toolSuccess({ update });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_thread_close ────────────────────────────────────────────────
  server.tool(
    "web_thread_close",
    "Close an injury thread when the athlete returns (RESOLVED) or retires (RETIRED). Records actual_return_date, computes accuracy_record against the stored otm_projection, stamps returned_at/closed_at, writes an audit entry, and sets status. Idempotent: re-closing a RESOLVED thread recomputes the record in place.",
    {
      entity_id: z.string().uuid(),
      actual_return_date: z.string().date().optional(),
      outcome: z.enum(["RESOLVED", "RETIRED"]).default("RESOLVED"),
      closed_by: z.string().optional(),
    },
    async (input) => {
      try {
        const entity = await client.closeThread(input);
        return toolSuccess({ entity });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_thread_get ──────────────────────────────────────────────────
  server.tool(
    "web_thread_get",
    "Return one injury thread in a single round-trip for the MD detail view: the entity row (resolved dates, OTM projection, accuracy record) plus its full injury_updates trajectory newest-first.",
    {
      entity_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const thread = await client.getThread(input.entity_id);
        if (!thread) {
          return handleToolError(
            new McpToolError(
              `Injury thread ${input.entity_id} not found`,
              "Verify the entity_id.",
            ),
            logger,
          );
        }
        return toolSuccess(thread);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_list_threads ────────────────────────────────────────────────
  server.tool(
    "web_list_threads",
    "List injury threads for the MD dashboard, joined with athlete name / sport / team. Filter by status (ACTIVE/RESOLVED/RETIRED) and/or needs_date_review to drive the active, date-review, and accuracy views. Ordered by last_updated_at.",
    {
      status: z.enum(["ACTIVE", "RESOLVED", "RETIRED"]).optional(),
      needs_date_review: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (input) => {
      try {
        const threads = await client.listThreads(input);
        return toolSuccess({ threads });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_audit_append ────────────────────────────────────────────────
  // Append-only audit trail. Every pipeline stage and MD action SHOULD write
  // one entry here. before/after are full payloads; the server hashes them
  // (canonical-JSON SHA-256) and stores hash + raw payload.
  server.tool(
    "web_audit_append",
    "Append an immutable audit entry. Used at every pipeline stage (ingest, validate, draft, attest, publish, correct, retract). before/after payloads are hashed server-side using canonical-JSON SHA-256.",
    {
      actor: z
        .enum(["system", "md", "automation", "agent"])
        .describe("Who/what triggered this action"),
      actor_id: z
        .string()
        .optional()
        .describe("Identifier within actor scope (e.g. MD user id, agent name)"),
      entity_type: z
        .string()
        .min(1)
        .describe("Domain of the thing being acted on (e.g. injury_post, desk_post, injury_entity)"),
      entity_id: z.string().uuid().optional().describe("Entity row id when applicable"),
      action: z.string().min(1).describe("Verb describing the change (e.g. publish, attest, fact_validate)"),
      before: z.unknown().optional().describe("Full prior state for diff/replay"),
      after: z.unknown().optional().describe("Full new state for diff/replay"),
      payload: z
        .record(z.unknown())
        .optional()
        .describe("Free-form context (validation result codes, MD notes, etc.)"),
    },
    async (input) => {
      try {
        const entry = await client.auditAppend(input);
        return toolSuccess({ id: entry.id, ts: entry.ts });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_list_audit_entries ──────────────────────────────────────────
  server.tool(
    "web_list_audit_entries",
    "List audit entries for one entity in reverse-chronological order. Use to reconstruct the history of a post, desk piece, or entity for review/defensibility.",
    {
      entity_type: z.string().min(1).describe("Domain of the entity"),
      entity_id: z.string().uuid().describe("Entity row id"),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (input) => {
      try {
        const entries = await client.listAuditEntries(
          input.entity_type,
          input.entity_id,
          input.limit,
        );
        return toolSuccess({ entries });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_propose_candidate ───────────────────────────────────────────
  // Phase 1 promotion path. Proposes (or refreshes) an OPEN Injury-Desk
  // candidate for an entity. Upserts the single PROPOSED row per entity so
  // re-proposals don't pile up. proposed_by='system' for auto-proposals, or
  // the MD user id when the human clicks "Promote to Injury Desk".
  server.tool(
    "web_propose_candidate",
    "Propose (or refresh) an Injury Desk promotion candidate for an injury entity. Upserts the single open PROPOSED candidate per entity — re-proposing updates the score/reasons in place rather than creating a duplicate. Does NOT publish anything; it queues the entity for MD triage. promotion_score is 0-100; reasons is the per-term contribution breakdown for display/audit.",
    {
      entity_id: z.string().uuid(),
      source_post_id: z.string().uuid().optional(),
      promotion_score: z.number().min(0).max(100),
      reasons: z.unknown().optional(),
      proposed_by: z
        .string()
        .optional()
        .describe("'system' for auto-proposals, or MD user id for manual promote"),
    },
    async (input) => {
      try {
        const candidate = await client.proposeCandidate(input);
        return toolSuccess({ candidate });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_list_candidates ─────────────────────────────────────────────
  server.tool(
    "web_list_candidates",
    "List Injury Desk promotion candidates, joined to athlete/entity/post display fields, ordered by promotion_score. Filter by status (PROPOSED for the open queue). Use to render the Candidates tab in /admin.",
    {
      status: z.enum(["PROPOSED", "ACCEPTED", "DISMISSED", "PROMOTED"]).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (input) => {
      try {
        const candidates = await client.listCandidates(input.status, input.limit);
        return toolSuccess({ candidates });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_decide_candidate ────────────────────────────────────────────
  // MD triage. Only PROPOSED candidates can be decided. ACCEPTED parks the
  // candidate for Phase 2 desk_post creation; DISMISSED closes it. Both are
  // audited. PROMOTED is reserved for Phase 2 (set when a desk_post is made).
  server.tool(
    "web_decide_candidate",
    "Record an MD decision on a promotion candidate: ACCEPTED (park for Injury Desk authoring) or DISMISSED (close). Only PROPOSED candidates can be decided. Audited. decided_by should be the MD user id.",
    {
      candidate_id: z.string().uuid(),
      decision: z.enum(["ACCEPTED", "DISMISSED"]),
      decided_by: z.string().min(1).describe("MD user id (or 'md' until NextAuth lands in Phase 2)"),
    },
    async (input) => {
      try {
        const candidate = await client.decideCandidate(
          input.candidate_id,
          input.decision,
          input.decided_by,
        );
        return toolSuccess({ candidate });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Auth / identity (Phase 2 foundation) ────────────────────────────
  // The users + verification_token tables back NextAuth magic-link auth in the
  // frontend, which reaches them only through these tools (never Neon directly).
  // web_get_user is the role re-derive primitive the future desk_publish gate
  // depends on: it trusts the DB's role, not a caller-supplied string.

  // ── web_get_user ────────────────────────────────────────────────────
  server.tool(
    "web_get_user",
    "Look up a verified user (identity + role) by id. The Tier 2 publish gate uses this to re-derive role from the database rather than trusting a caller-supplied role. Returns null if not found.",
    {
      user_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const user = await client.getUser(input.user_id);
        return toolSuccess({ user });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_get_user_by_email ───────────────────────────────────────────
  server.tool(
    "web_get_user_by_email",
    "Look up a verified user by email (case-insensitive). Used by the NextAuth adapter to resolve the signing-in identity and its role. Returns null if not found.",
    {
      email: z.string().email(),
    },
    async (input) => {
      try {
        const user = await client.getUserByEmail(input.email);
        return toolSuccess({ user });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_upsert_user ─────────────────────────────────────────────────
  server.tool(
    "web_upsert_user",
    "Provision or update a verified user identity (role md|editor). Idempotent on email. Audited. Administrative provisioning only — the magic-link flow does not mint users.",
    {
      email: z.string().email(),
      role: z.enum(["md", "editor"]),
      name: z.string().min(1).optional(),
    },
    async (input) => {
      try {
        const user = await client.upsertUser(input);
        return toolSuccess({ user });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_create_verification_token ───────────────────────────────────
  server.tool(
    "web_create_verification_token",
    "Persist an Auth.js magic-link verification token (issued at link-request time). identifier is the recipient email; expires is an ISO 8601 timestamp.",
    {
      identifier: z.string().min(1).describe("Recipient email (Auth.js identifier)"),
      token: z.string().min(1).describe("Hashed verification token"),
      expires: z.string().datetime().describe("ISO 8601 expiry timestamp"),
    },
    async (input) => {
      try {
        const verification_token = await client.createVerificationToken(input);
        return toolSuccess({ verification_token });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── web_use_verification_token ──────────────────────────────────────
  server.tool(
    "web_use_verification_token",
    "Atomically consume a magic-link verification token at click time (single-use, delete-on-read). Returns the token row if valid, or null if already used / never existed.",
    {
      identifier: z.string().min(1).describe("Recipient email (Auth.js identifier)"),
      token: z.string().min(1).describe("Hashed verification token to consume"),
    },
    async (input) => {
      try {
        const verification_token = await client.useVerificationToken(
          input.identifier,
          input.token,
        );
        return toolSuccess({ verification_token });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_create_draft ───────────────────────────────────────────────
  // Phase 2C. Turns an ACCEPTED candidate into a DRAFT Injury Desk post and
  // flips the candidate to PROMOTED. author_id is the editing user's id (UUID).
  server.tool(
    "desk_create_draft",
    "Create a DRAFT Injury Desk (Tier 2) post from an ACCEPTED promotion candidate. Writes the v1 version row and moves the candidate to PROMOTED. Does NOT publish — a desk post must be attested by an MD and pass the server-enforced publish gate first.",
    {
      candidate_id: z.string().uuid(),
      author_id: z.string().uuid().describe("Editing user's id (UUID = session.user.id)"),
      title: z.string().min(1),
      markdown_body: z.string().min(1).describe("Canonical markdown body; the content_hash is derived from this"),
      draft_json: z.unknown().optional().describe("kpjmd handoff artifact (Phase 3 schema)"),
      source_attribution: z.unknown().optional(),
      disclaimer_present: z.boolean().optional(),
    },
    async (input) => {
      try {
        const post = await client.createDraft(input);
        return toolSuccess({ post });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_update_draft ───────────────────────────────────────────────
  server.tool(
    "desk_update_draft",
    "Save edits to a DRAFT or READY desk post. Writes a new version row on every save. Editing a READY (attested) post reverts it to DRAFT — the prior attestation is now stale and must be redone before publishing.",
    {
      desk_post_id: z.string().uuid(),
      edited_by: z.string().uuid().describe("Editing user's id (UUID)"),
      markdown_body: z.string().min(1),
      title: z.string().min(1).optional(),
      draft_json: z.unknown().optional(),
      source_attribution: z.unknown().optional(),
      disclaimer_present: z.boolean().optional(),
      edit_diff: z.unknown().optional(),
    },
    async (input) => {
      try {
        const post = await client.updateDraft(input);
        return toolSuccess({ post });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_lint ───────────────────────────────────────────────────────
  // Typed seam. 2C returns empty findings; 2D fills in the classifier. The
  // publish gate consumes the same lint internally — blockers there block publish.
  server.tool(
    "desk_lint",
    "Lint a desk post's current body for Tier 2 framing violations. Returns {warnings, blockers}; non-empty blockers will block desk_publish. (Phase 2C: stub returning empty arrays; the real rules land in 2D.)",
    {
      desk_post_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const result = await client.lintDeskPostById(input.desk_post_id);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_attest ─────────────────────────────────────────────────────
  // The role is RE-DERIVED server-side from reviewer_user_id (never trusted from
  // the caller); all three confirmations must be true. Snapshots the body hash
  // and moves the post to READY.
  server.tool(
    "desk_attest",
    "Record a physician attestation on a desk post. The MD role is re-derived server-side from reviewer_user_id (a UUID = session.user.id) — a caller-supplied role is ignored. All three confirmations must be true. Snapshots the current body's content_hash and moves the post to READY.",
    {
      desk_post_id: z.string().uuid(),
      reviewer_user_id: z.string().uuid().describe("MD user id (UUID); role re-derived from the DB"),
      reviewed_source_reports: z.boolean(),
      edited_for_accuracy: z.boolean(),
      framing_confirmed: z.boolean(),
      ip: z.string().optional(),
    },
    async (input) => {
      try {
        const attestation = await client.attestDeskPost(input);
        return toolSuccess({ attestation });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_publish ────────────────────────────────────────────────────
  // THE GATE. A blocked publish is a SUCCESSFUL call with published:false and a
  // gate breakdown the frontend renders and maps to HTTP 422. Only a missing post
  // or wrong status is an error (isError).
  server.tool(
    "desk_publish",
    "Run the server-enforced publish gate on a READY desk post. Publishes only if ALL hold: the DB-derived role of reviewer_user_id is 'md', the latest attestation's content_hash equals the post's current body hash (catches post-attestation edits), and the linter returns zero blockers. A blocked publish returns {published:false, gate:{...}} (a successful call — map to 422), not an error.",
    {
      desk_post_id: z.string().uuid(),
      reviewer_user_id: z.string().uuid().describe("MD user id (UUID); role re-derived from the DB"),
    },
    async (input) => {
      try {
        const result = await client.publishDeskPost(input.desk_post_id, input.reviewer_user_id);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_retract ────────────────────────────────────────────────────
  server.tool(
    "desk_retract",
    "Retract a PUBLISHED desk post (status → RETRACTED). MD-only — role is re-derived from reviewer_user_id. (Phase 3 adds the .retracted.json emission for the kpjmd builder.)",
    {
      desk_post_id: z.string().uuid(),
      reviewer_user_id: z.string().uuid().describe("MD user id (UUID); role re-derived from the DB"),
    },
    async (input) => {
      try {
        const post = await client.retractDeskPost(input.desk_post_id, input.reviewer_user_id);
        return toolSuccess({ post });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_list ───────────────────────────────────────────────────────
  server.tool(
    "desk_list",
    "List Injury Desk posts (optionally filtered by status), newest-updated first, joined to athlete/injury display fields.",
    {
      status: z.enum(["DRAFT", "READY", "PUBLISHED", "RETRACTED"]).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (input) => {
      try {
        const posts = await client.listDeskPosts(input.status, input.limit);
        return toolSuccess({ posts });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── desk_get ────────────────────────────────────────────────────────
  server.tool(
    "desk_get",
    "Fetch one desk post by id plus its attestations (newest first) for the Injury Desk editor view.",
    {
      desk_post_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const detail = await client.getDeskPost(input.desk_post_id);
        return toolSuccess(detail);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );
}
