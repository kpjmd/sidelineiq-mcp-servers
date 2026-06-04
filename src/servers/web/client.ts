import { getDatabase } from "../../shared/database.js";
import { McpToolError } from "../../shared/errors.js";
import { hashPayload } from "../../shared/hash.js";
import type { InjuryPost, MdReview, MdReviewStatus, PostStatus, Sport, ContentType } from "../../shared/types.js";

// ── Audit log types ──────────────────────────────────────────────────
export type AuditActor = "system" | "md" | "automation" | "agent";

export interface AuditAppendInput {
  actor: AuditActor;
  actor_id?: string;
  entity_type: string;
  entity_id?: string;
  action: string;
  before?: unknown;
  after?: unknown;
  payload?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  ts: string;
  actor: AuditActor;
  actor_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  before_hash: string | null;
  after_hash: string | null;
  payload: Record<string, unknown> | null;
}

// ── Social engagement types ───────────────────────────────────────────
export interface InsertProcessedMentionInput {
  platform: string;
  mention_id: string;
  author_handle: string;
  author_follower_count?: number;
  mention_text: string;
  intent: string;
  intent_confidence?: number;
  action_taken: string;
  reply_content?: string;
  reply_post_id?: string;
  raw_payload?: Record<string, unknown>;
}

export interface InsertPendingCorrectionInput {
  original_post_id?: string;
  mention_id: string;
  platform: string;
  correction_field: string;
  old_value: string;
  new_value: string;
  submitted_by_handle: string;
}

export interface PendingCorrection {
  id: string;
  original_post_id?: string;
  mention_id: string;
  platform: string;
  correction_field: string;
  old_value: string;
  new_value: string;
  submitted_by_handle: string;
  submitted_at: string;
  status: string;
  reviewed_at?: string;
  reviewed_by?: string;
}

export interface CreatePostInput {
  athlete_name: string;
  sport: string;
  team: string;
  injury_type: string;
  injury_severity: string;
  content_type: string;
  headline: string;
  clinical_summary: string;
  return_to_play_min_weeks?: number;
  return_to_play_max_weeks?: number;
  rtp_probability_week_2?: number;
  rtp_probability_week_4?: number;
  rtp_probability_week_8?: number;
  rtp_confidence?: number;
  farcaster_hash?: string;
  twitter_id?: string;
  source_url?: string;
  md_review_required?: boolean;
  parent_post_id?: string;
  conflict_reason?: string;
  team_timeline_weeks?: number;
  injury_date?: string;
}

export interface UpdatePostInput {
  athlete_name?: string;
  sport?: string;
  team?: string;
  injury_type?: string;
  injury_severity?: string;
  content_type?: string;
  headline?: string;
  clinical_summary?: string;
  return_to_play_min_weeks?: number;
  return_to_play_max_weeks?: number;
  rtp_probability_week_2?: number;
  rtp_probability_week_4?: number;
  rtp_probability_week_8?: number;
  rtp_confidence?: number;
  farcaster_hash?: string;
  twitter_id?: string;
  source_url?: string;
  md_review_required?: boolean;
  conflict_reason?: string;
  team_timeline_weeks?: number;
}

export interface UpdateMdReviewInput {
  id: string;
  status: "APPROVED" | "REJECTED";
  reviewer_notes?: string;
}

// ── Players & teams ──────────────────────────────────────────────────
export interface UpsertTeamInput {
  sport: string;
  espn_team_id?: string;
  name: string;
  abbreviation?: string;
  location?: string;
  display_name?: string;
  conference?: string;
}

export interface Team {
  id: string;
  sport: string;
  espn_team_id: string | null;
  name: string;
  abbreviation: string | null;
  location: string | null;
  display_name: string | null;
  conference: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertPlayerInput {
  sport: string;
  espn_athlete_id?: string;
  full_name: string;
  current_team_id?: string;
  position?: string;
  jersey?: string;
  prominence_tier?: number;
  prominence_source?: string;
}

export interface Player {
  id: string;
  sport: string;
  espn_athlete_id: string | null;
  full_name: string;
  normalized_name: string;
  current_team_id: string | null;
  position: string | null;
  jersey: string | null;
  prominence_tier: number | null;
  prominence_source: string | null;
  last_synced_at: string;
  retired_at: string | null;
}

export interface ResolvedPlayer {
  player_id: string;
  full_name: string;
  current_team_id: string | null;
  current_team_name: string | null;
  current_team_abbreviation: string | null;
  prominence_tier: number | null;
  confidence: "exact" | "normalized" | "ambiguous" | "miss";
  match_count: number;
}

// ── Injury entities & updates ────────────────────────────────────────
export type Laterality = "LEFT" | "RIGHT" | "BILATERAL" | "UNSPECIFIED";
export type EntityStatus = "ACTIVE" | "RESOLVED" | "RETIRED";
export type UpdateKind =
  | "INITIAL"
  | "TRACKING"
  | "CONFLICT"
  | "DEEP_DIVE"
  | "CORRECTION"
  | "RESOLUTION";

export interface InjuryEntity {
  id: string;
  player_id: string;
  body_part: string | null;
  laterality: Laterality;
  injury_type: string | null;
  status: EntityStatus;
  canonical_post_id: string | null;
  first_reported_at: string;
  last_updated_at: string;
  actual_return_date: string | null;
}

export interface InjuryUpdate {
  id: string;
  entity_id: string;
  post_id: string | null;
  update_kind: UpdateKind;
  severity_at_time: string | null;
  team_timeline_weeks: number | null;
  otm_min_weeks: number | null;
  source_url: string | null;
  description: string | null;
  created_at: string;
}

export interface FindMatchingEntityInput {
  player_id: string;
  body_part?: string;
  laterality?: Laterality;
  injury_type?: string;
  recency_days?: number;
}

export interface MatchingEntityResult {
  matched: boolean;
  entity_id: string | null;
  canonical_post_id: string | null;
  body_part: string | null;
  laterality: Laterality | null;
  injury_type: string | null;
  last_update_kind: UpdateKind | null;
  last_severity: string | null;
  last_team_weeks: number | null;
  match_count: number;
}

// ── Desk candidates (Phase 1 promotion path) ─────────────────────────
export type CandidateStatus = "PROPOSED" | "ACCEPTED" | "DISMISSED" | "PROMOTED";

export interface DeskCandidate {
  id: string;
  entity_id: string;
  source_post_id: string | null;
  promotion_score: number;
  reasons: unknown;
  status: CandidateStatus;
  proposed_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface ProposeCandidateInput {
  entity_id: string;
  source_post_id?: string;
  promotion_score: number;
  reasons?: unknown;
  // Origin of the proposal: 'system' for auto, MD user id for manual promote.
  proposed_by?: string;
}

// A candidate joined to the display fields the Candidates queue needs so the
// frontend doesn't have to fan out per-row lookups.
export interface CandidateListItem extends DeskCandidate {
  athlete_name: string | null;
  sport: string | null;
  body_part: string | null;
  laterality: Laterality | null;
  injury_type: string | null;
  headline: string | null;
  slug: string | null;
}

// Lowercase, strip diacritics, remove common suffixes, collapse punctuation.
// Shared between upsert (write) and resolve (read) so both sides agree.
export function normalizePlayerName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9\s.-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, "")
    .replace(/[.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ListPostsFilters {
  sport?: Sport;
  athlete_name?: string;
  content_type?: ContentType;
  status?: PostStatus;
}

export class WebDatabaseClient {
  private get sql() {
    return getDatabase();
  }

  // ── Slug helpers ────────────────────────────────────────────────────
  private generateBaseSlug(athleteName: string, injuryType: string, date: Date): string {
    const dateStr = date.toISOString().split("T")[0];
    return `${athleteName}-${injuryType}-${dateStr}`
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private async resolveUniqueSlug(baseSlug: string): Promise<string> {
    let rows = await this.sql`SELECT id FROM injury_posts WHERE slug = ${baseSlug}`;
    if (rows.length === 0) return baseSlug;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${baseSlug}-${i}`;
      rows = await this.sql`SELECT id FROM injury_posts WHERE slug = ${candidate}`;
      if (rows.length === 0) return candidate;
    }
    return `${baseSlug}-${Date.now()}`;
  }

  // ── Posts ────────────────────────────────────────────────────────────
  async createPost(data: CreatePostInput): Promise<InjuryPost> {
    const slug = await this.resolveUniqueSlug(
      this.generateBaseSlug(data.athlete_name, data.injury_type, new Date()),
    );

    const rows = await this.sql`
      INSERT INTO injury_posts (
        athlete_name, sport, team, injury_type, injury_severity,
        content_type, headline, clinical_summary,
        return_to_play_min_weeks, return_to_play_max_weeks,
        rtp_probability_week_2, rtp_probability_week_4, rtp_probability_week_8,
        rtp_confidence, farcaster_hash, twitter_id, source_url, md_review_required,
        parent_post_id, slug, conflict_reason, team_timeline_weeks, injury_date
      ) VALUES (
        ${data.athlete_name}, ${data.sport}, ${data.team},
        ${data.injury_type}, ${data.injury_severity},
        ${data.content_type}, ${data.headline}, ${data.clinical_summary},
        ${data.return_to_play_min_weeks ?? null}, ${data.return_to_play_max_weeks ?? null},
        ${data.rtp_probability_week_2 ?? null}, ${data.rtp_probability_week_4 ?? null},
        ${data.rtp_probability_week_8 ?? null}, ${data.rtp_confidence ?? null},
        ${data.farcaster_hash ?? null}, ${data.twitter_id ?? null},
        ${data.source_url ?? null}, ${data.md_review_required ?? false},
        ${data.parent_post_id ?? null}, ${slug},
        ${data.conflict_reason ?? null}, ${data.team_timeline_weeks ?? null},
        ${data.injury_date ?? null}
      )
      RETURNING *
    `;
    return rows[0] as InjuryPost;
  }

  async updatePost(
    id: string,
    updates: UpdatePostInput,
    updateReason: string,
  ): Promise<InjuryPost> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const fields: Array<[string, unknown]> = Object.entries(updates).filter(
      ([, v]) => v !== undefined,
    );

    if (fields.length === 0) {
      throw new McpToolError(
        "No fields to update",
        "Provide at least one field to update in the updates object.",
      );
    }

    for (const [key, value] of fields) {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }

    setClauses.push(`version = version + 1`);
    setClauses.push(`updated_at = NOW()`);

    const query = `
      UPDATE injury_posts
      SET ${setClauses.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING *
    `;
    values.push(id);

    const rows = await this.sql(query, values);

    if (rows.length === 0) {
      throw new McpToolError(
        `Post ${id} not found`,
        "Verify the post_id is correct. Use web_list_posts to find valid post IDs.",
      );
    }

    return rows[0] as InjuryPost;
  }

  async countTrackingChildren(parentId: string): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count
      FROM injury_posts
      WHERE parent_post_id = ${parentId}
    `;
    return (rows[0] as { count: number }).count;
  }

  async deletePost(id: string): Promise<{ deleted: true; post_id: string }> {
    const rows = await this.sql`
      DELETE FROM injury_posts
      WHERE id = ${id}
      RETURNING id
    `;

    if (rows.length === 0) {
      throw new McpToolError(
        `Post ${id} not found`,
        "Verify the post_id is correct. Use web_list_posts to find valid post IDs.",
      );
    }

    return { deleted: true, post_id: id };
  }

  async approveInjuryPost(id: string): Promise<InjuryPost> {
    const rows = await this.sql`
      UPDATE injury_posts
      SET status = 'PUBLISHED', updated_at = NOW()
      WHERE id = ${id} AND status = 'PENDING_REVIEW'
      RETURNING *
    `;

    if (rows.length === 0) {
      throw new McpToolError(
        "Post not found or not in PENDING_REVIEW status",
        "Verify the post_id is correct and that the post is currently PENDING_REVIEW. Use web_list_md_reviews to find posts awaiting approval.",
      );
    }

    const post = rows[0] as InjuryPost;

    // Keep the md_reviews audit row in sync so the admin dashboard's
    // PENDING queue reflects the approval.
    await this.sql`
      UPDATE md_reviews
      SET status = 'APPROVED', reviewed_at = NOW()
      WHERE post_id = ${id} AND status = 'PENDING'
    `;

    return post;
  }

  async getPost(id: string): Promise<InjuryPost | null> {
    const rows = await this.sql`
      SELECT * FROM injury_posts WHERE id = ${id}
    `;
    return (rows[0] as InjuryPost) ?? null;
  }

  async getPostBySlug(slug: string): Promise<InjuryPost | null> {
    const rows = await this.sql`
      SELECT * FROM injury_posts WHERE slug = ${slug}
    `;
    return (rows[0] as InjuryPost) ?? null;
  }

  async getPostBySocialId(platform: 'twitter' | 'farcaster', socialId: string): Promise<InjuryPost | null> {
    const rows = platform === 'twitter'
      ? await this.sql`SELECT * FROM injury_posts WHERE twitter_id = ${socialId} LIMIT 1`
      : await this.sql`SELECT * FROM injury_posts WHERE farcaster_hash = ${socialId} LIMIT 1`;
    return (rows[0] as InjuryPost) ?? null;
  }

  async flagForMdReview(
    id: string,
    reason: string,
    confidenceScore: number,
    flaggedBy: string,
    preserveStatus = false,
  ): Promise<InjuryPost> {
    // preserveStatus=true is for retrospective flags on already-PUBLISHED posts
    // (legacy fact sweep, post-hoc audits). The default behavior — flipping to
    // PENDING_REVIEW — is correct for new agent-generated content that hasn't
    // published yet, but applying it to live posts pulls them out of any
    // "PUBLISHED only" filter and creates confusing review-queue states.
    const rows = preserveStatus
      ? await this.sql`
          UPDATE injury_posts
          SET md_review_required = true,
              md_review_reason = ${reason},
              md_review_confidence = ${confidenceScore},
              updated_at = NOW()
          WHERE id = ${id}
          RETURNING *
        `
      : await this.sql`
          UPDATE injury_posts
          SET status = 'PENDING_REVIEW',
              md_review_required = true,
              md_review_reason = ${reason},
              md_review_confidence = ${confidenceScore},
              updated_at = NOW()
          WHERE id = ${id}
          RETURNING *
        `;

    if (rows.length === 0) {
      throw new McpToolError(
        `Post ${id} not found`,
        "Verify the post_id is correct. Use web_list_posts to find valid post IDs.",
      );
    }

    // Insert into md_reviews for admin dashboard
    await this.sql`
      INSERT INTO md_reviews (post_id, reason, status)
      VALUES (${id}, ${reason}, 'PENDING')
    `;

    return rows[0] as InjuryPost;
  }

  async listPosts(
    filters: ListPostsFilters,
    limit: number,
    offset: number,
  ): Promise<{ posts: InjuryPost[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.sport) {
      conditions.push(`sport = $${paramIndex}`);
      values.push(filters.sport);
      paramIndex++;
    }
    if (filters.athlete_name) {
      conditions.push(`athlete_name ILIKE $${paramIndex}`);
      values.push(`%${filters.athlete_name}%`);
      paramIndex++;
    }
    if (filters.content_type) {
      conditions.push(`content_type = $${paramIndex}`);
      values.push(filters.content_type);
      paramIndex++;
    }
    if (filters.status) {
      conditions.push(`status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM injury_posts ${whereClause}`;
    const countRows = await this.sql(countQuery, values);
    const total = parseInt(String(countRows[0].total), 10);

    const dataQuery = `
      SELECT * FROM injury_posts
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    const dataValues = [...values, limit, offset];
    const rows = await this.sql(dataQuery, dataValues);

    return {
      posts: rows as InjuryPost[],
      total,
    };
  }

  // ── Bulk Admin ───────────────────────────────────────────────────────
  async getTableCounts(): Promise<{ injury_posts: number; md_reviews: number }> {
    const rows = await this.sql`
      SELECT
        (SELECT COUNT(*)::int FROM injury_posts) AS injury_posts_count,
        (SELECT COUNT(*)::int FROM md_reviews) AS md_reviews_count
    `;
    const row = rows[0] as { injury_posts_count: number; md_reviews_count: number };
    return { injury_posts: row.injury_posts_count, md_reviews: row.md_reviews_count };
  }

  async purgeAllPosts(): Promise<number> {
    const rows = await this.sql`DELETE FROM injury_posts RETURNING id`;
    return rows.length;
  }

  // ── MD Reviews ───────────────────────────────────────────────────────
  async listMdReviews(status?: MdReviewStatus): Promise<MdReview[]> {
    const query = `
      SELECT
        r.id, r.post_id, r.reason, r.status, r.reviewer_notes,
        r.created_at, r.reviewed_at,
        p.athlete_name, p.sport, p.headline, p.slug
      FROM md_reviews r
      JOIN injury_posts p ON p.id = r.post_id
      ${status ? `WHERE r.status = $1` : ""}
      ORDER BY r.created_at DESC
    `;
    const rows = status
      ? await this.sql(query, [status])
      : await this.sql(query, []);

    return rows as MdReview[];
  }

  // ── Social engagement ────────────────────────────────────────────────
  async getSocialState(key: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT value FROM social_monitor_state WHERE key = ${key}
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as { value: string | null };
    return row.value ?? null;
  }

  async setSocialState(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO social_monitor_state (key, value, updated_at)
      VALUES (${key}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `;
  }

  async checkMentionProcessed(platform: string, mentionId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT id FROM processed_mentions
      WHERE platform = ${platform} AND mention_id = ${mentionId}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async insertProcessedMention(data: InsertProcessedMentionInput): Promise<{ id: string }> {
    const rows = await this.sql`
      INSERT INTO processed_mentions (
        platform, mention_id, author_handle, author_follower_count,
        mention_text, intent, intent_confidence, action_taken,
        reply_content, reply_post_id, raw_payload
      ) VALUES (
        ${data.platform}, ${data.mention_id}, ${data.author_handle},
        ${data.author_follower_count ?? null}, ${data.mention_text},
        ${data.intent}, ${data.intent_confidence ?? null}, ${data.action_taken},
        ${data.reply_content ?? null}, ${data.reply_post_id ?? null},
        ${data.raw_payload ? JSON.stringify(data.raw_payload) : null}
      )
      ON CONFLICT (platform, mention_id) DO NOTHING
      RETURNING id
    `;
    const id = rows[0] ? (rows[0] as { id: string }).id : "duplicate";
    return { id };
  }

  async insertPendingCorrection(data: InsertPendingCorrectionInput): Promise<{ id: string }> {
    const rows = await this.sql`
      INSERT INTO pending_corrections (
        original_post_id, mention_id, platform,
        correction_field, old_value, new_value, submitted_by_handle
      ) VALUES (
        ${data.original_post_id ?? null}, ${data.mention_id}, ${data.platform},
        ${data.correction_field}, ${data.old_value}, ${data.new_value},
        ${data.submitted_by_handle}
      )
      RETURNING id
    `;
    return { id: (rows[0] as { id: string }).id };
  }

  async listPendingCorrections(status?: string): Promise<PendingCorrection[]> {
    const rows = status
      ? await this.sql`
          SELECT * FROM pending_corrections
          WHERE status = ${status}
          ORDER BY submitted_at DESC
        `
      : await this.sql`
          SELECT * FROM pending_corrections
          ORDER BY submitted_at DESC
        `;
    return rows as PendingCorrection[];
  }

  // ── Teams & players ──────────────────────────────────────────────────
  async upsertTeam(input: UpsertTeamInput): Promise<Team> {
    if (input.espn_team_id) {
      const rows = await this.sql`
        INSERT INTO teams (
          sport, espn_team_id, name, abbreviation, location, display_name, conference, last_synced_at, updated_at
        ) VALUES (
          ${input.sport}, ${input.espn_team_id}, ${input.name},
          ${input.abbreviation ?? null}, ${input.location ?? null},
          ${input.display_name ?? null}, ${input.conference ?? null},
          NOW(), NOW()
        )
        ON CONFLICT (sport, espn_team_id) DO UPDATE SET
          name = EXCLUDED.name,
          abbreviation = EXCLUDED.abbreviation,
          location = EXCLUDED.location,
          display_name = EXCLUDED.display_name,
          conference = COALESCE(EXCLUDED.conference, teams.conference),
          last_synced_at = NOW(),
          updated_at = NOW()
        RETURNING *
      `;
      return rows[0] as Team;
    }
    const rows = await this.sql`
      INSERT INTO teams (sport, name, abbreviation, location, display_name, conference, last_synced_at, updated_at)
      VALUES (
        ${input.sport}, ${input.name}, ${input.abbreviation ?? null},
        ${input.location ?? null}, ${input.display_name ?? null},
        ${input.conference ?? null}, NOW(), NOW()
      )
      RETURNING *
    `;
    return rows[0] as Team;
  }

  async upsertPlayer(input: UpsertPlayerInput): Promise<Player> {
    const normalized = normalizePlayerName(input.full_name);
    if (input.espn_athlete_id) {
      const rows = await this.sql`
        INSERT INTO players (
          sport, espn_athlete_id, full_name, normalized_name, current_team_id,
          position, jersey, prominence_tier, prominence_source,
          last_synced_at, updated_at
        ) VALUES (
          ${input.sport}, ${input.espn_athlete_id}, ${input.full_name}, ${normalized},
          ${input.current_team_id ?? null}, ${input.position ?? null},
          ${input.jersey ?? null}, ${input.prominence_tier ?? null},
          ${input.prominence_source ?? null}, NOW(), NOW()
        )
        ON CONFLICT (sport, espn_athlete_id) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          normalized_name = EXCLUDED.normalized_name,
          current_team_id = COALESCE(EXCLUDED.current_team_id, players.current_team_id),
          position = COALESCE(EXCLUDED.position, players.position),
          jersey = COALESCE(EXCLUDED.jersey, players.jersey),
          prominence_tier = COALESCE(EXCLUDED.prominence_tier, players.prominence_tier),
          prominence_source = COALESCE(EXCLUDED.prominence_source, players.prominence_source),
          last_synced_at = NOW(),
          updated_at = NOW()
        RETURNING *
      `;
      return rows[0] as Player;
    }
    // No ESPN id (override-list player). Upsert on (sport, normalized_name).
    const existing = await this.sql`
      SELECT * FROM players
      WHERE sport = ${input.sport} AND normalized_name = ${normalized}
      LIMIT 1
    `;
    if (existing.length > 0) {
      const id = (existing[0] as Player).id;
      const rows = await this.sql`
        UPDATE players SET
          prominence_tier = COALESCE(${input.prominence_tier ?? null}, prominence_tier),
          prominence_source = COALESCE(${input.prominence_source ?? null}, prominence_source),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return rows[0] as Player;
    }
    const rows = await this.sql`
      INSERT INTO players (
        sport, full_name, normalized_name, current_team_id,
        position, jersey, prominence_tier, prominence_source,
        last_synced_at, updated_at
      ) VALUES (
        ${input.sport}, ${input.full_name}, ${normalized},
        ${input.current_team_id ?? null}, ${input.position ?? null},
        ${input.jersey ?? null}, ${input.prominence_tier ?? null},
        ${input.prominence_source ?? null}, NOW(), NOW()
      )
      RETURNING *
    `;
    return rows[0] as Player;
  }

  async setPlayerProminence(
    playerId: string,
    tier: number,
    source: string,
  ): Promise<Player> {
    const rows = await this.sql`
      UPDATE players
      SET prominence_tier = ${tier},
          prominence_source = ${source},
          updated_at = NOW()
      WHERE id = ${playerId}
      RETURNING *
    `;
    if (rows.length === 0) {
      throw new McpToolError(
        `Player ${playerId} not found`,
        "Verify the player id is correct.",
      );
    }
    return rows[0] as Player;
  }

  async resolvePlayer(name: string, sport?: string): Promise<ResolvedPlayer | null> {
    const normalized = normalizePlayerName(name);
    const rows = sport
      ? await this.sql`
          SELECT
            p.id AS player_id, p.full_name, p.prominence_tier,
            p.current_team_id, t.name AS current_team_name, t.abbreviation AS current_team_abbreviation,
            p.retired_at
          FROM players p
          LEFT JOIN teams t ON t.id = p.current_team_id
          WHERE p.sport = ${sport} AND p.normalized_name = ${normalized}
            AND p.retired_at IS NULL
          LIMIT 5
        `
      : await this.sql`
          SELECT
            p.id AS player_id, p.full_name, p.prominence_tier,
            p.current_team_id, t.name AS current_team_name, t.abbreviation AS current_team_abbreviation,
            p.retired_at
          FROM players p
          LEFT JOIN teams t ON t.id = p.current_team_id
          WHERE p.normalized_name = ${normalized}
            AND p.retired_at IS NULL
          LIMIT 5
        `;

    if (rows.length === 0) return null;
    const first = rows[0] as Omit<ResolvedPlayer, "confidence" | "match_count">;
    const confidence: ResolvedPlayer["confidence"] =
      rows.length > 1 ? "ambiguous" : "normalized";
    return {
      ...first,
      confidence,
      match_count: rows.length,
    };
  }

  // ── Post corrections (legacy fact sweep) ─────────────────────────────
  async applyCorrection(
    postId: string,
    field: string,
    newValue: string,
    note: string,
  ): Promise<{ post: InjuryPost; previous_value: string | null }> {
    // Allowlist: only fields safe to programmatically correct.
    const allowed = new Set([
      "team",
      "injury_type",
      "injury_severity",
      "team_timeline_weeks",
    ]);
    if (!allowed.has(field)) {
      throw new McpToolError(
        `Field '${field}' is not correctable`,
        `Allowed: ${Array.from(allowed).join(", ")}`,
      );
    }

    const beforeRows = await this.sql`
      SELECT * FROM injury_posts WHERE id = ${postId}
    `;
    if (beforeRows.length === 0) {
      throw new McpToolError(`Post ${postId} not found`, "Verify the post_id.");
    }
    const before = beforeRows[0] as Record<string, unknown>;
    const previousValue = before[field] != null ? String(before[field]) : null;

    // Visible note appended to the public clinical_summary; the existing copy
    // never gets silently overwritten.
    const today = new Date().toISOString().slice(0, 10);
    const updateNote = `\n\nUpdated on ${today}: ${note}`;
    const newSummary = `${String(before.clinical_summary ?? "")}${updateNote}`;

    // Dynamic UPDATE so we can target the right column.
    const query = `
      UPDATE injury_posts
      SET ${field} = $1,
          clinical_summary = $2,
          corrected_at = NOW(),
          correction_count = correction_count + 1,
          version = version + 1,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `;
    const rows = await this.sql(query, [newValue, newSummary, postId]);
    return {
      post: rows[0] as InjuryPost,
      previous_value: previousValue,
    };
  }

  // ── Injury entities ──────────────────────────────────────────────────
  async findMatchingEntity(input: FindMatchingEntityInput): Promise<MatchingEntityResult> {
    const recencyDays = input.recency_days ?? 21;
    const bodyPart = input.body_part?.toLowerCase() ?? null;
    const laterality = input.laterality ?? null;
    const injuryType = input.injury_type?.toLowerCase() ?? null;

    // Body-part match is exact (lowercased). Laterality match: UNSPECIFIED
    // ↔ anything, else exact. Injury-type match: substring (covers
    // "ACL tear" vs "ACL reconstruction").
    const rows = await this.sql`
      SELECT e.id, e.canonical_post_id, e.body_part, e.laterality, e.injury_type,
             u.update_kind AS last_update_kind,
             u.severity_at_time AS last_severity,
             u.team_timeline_weeks AS last_team_weeks
      FROM injury_entities e
      LEFT JOIN LATERAL (
        SELECT update_kind, severity_at_time, team_timeline_weeks
        FROM injury_updates
        WHERE entity_id = e.id
        ORDER BY created_at DESC
        LIMIT 1
      ) u ON true
      WHERE e.player_id = ${input.player_id}
        AND e.status = 'ACTIVE'
        AND e.last_updated_at >= NOW() - (${recencyDays} || ' days')::interval
        AND (
          ${bodyPart}::text IS NULL
          OR e.body_part IS NULL
          OR LOWER(e.body_part) = ${bodyPart}
        )
        AND (
          ${laterality}::text IS NULL
          OR e.laterality = 'UNSPECIFIED'
          OR ${laterality} = 'UNSPECIFIED'
          OR e.laterality = ${laterality}
        )
        AND (
          ${injuryType}::text IS NULL
          OR e.injury_type IS NULL
          OR LOWER(e.injury_type) LIKE '%' || ${injuryType} || '%'
          OR ${injuryType} LIKE '%' || LOWER(e.injury_type) || '%'
        )
      ORDER BY e.last_updated_at DESC
      LIMIT 5
    `;

    if (rows.length === 0) {
      return {
        matched: false,
        entity_id: null,
        canonical_post_id: null,
        body_part: null,
        laterality: null,
        injury_type: null,
        last_update_kind: null,
        last_severity: null,
        last_team_weeks: null,
        match_count: 0,
      };
    }
    const first = rows[0] as Record<string, unknown>;
    return {
      matched: true,
      entity_id: first.id as string,
      canonical_post_id: (first.canonical_post_id as string | null) ?? null,
      body_part: (first.body_part as string | null) ?? null,
      laterality: (first.laterality as Laterality | null) ?? null,
      injury_type: (first.injury_type as string | null) ?? null,
      last_update_kind: (first.last_update_kind as UpdateKind | null) ?? null,
      last_severity: (first.last_severity as string | null) ?? null,
      last_team_weeks: (first.last_team_weeks as number | null) ?? null,
      match_count: rows.length,
    };
  }

  async getEntityForPost(postId: string): Promise<InjuryEntity | null> {
    // Look up the entity that has this post as its canonical, OR the entity
    // whose timeline includes this post via injury_updates.
    const rows = await this.sql`
      SELECT e.*
      FROM injury_entities e
      WHERE e.canonical_post_id = ${postId}
      UNION
      SELECT e.*
      FROM injury_entities e
      JOIN injury_updates u ON u.entity_id = e.id
      WHERE u.post_id = ${postId}
      LIMIT 1
    `;
    return (rows[0] as InjuryEntity) ?? null;
  }

  async createInjuryEntity(input: {
    player_id: string;
    body_part?: string;
    laterality?: Laterality;
    injury_type?: string;
    canonical_post_id?: string;
  }): Promise<InjuryEntity> {
    const rows = await this.sql`
      INSERT INTO injury_entities (
        player_id, body_part, laterality, injury_type, canonical_post_id,
        first_reported_at, last_updated_at, updated_at
      ) VALUES (
        ${input.player_id}, ${input.body_part ?? null},
        ${input.laterality ?? 'UNSPECIFIED'}, ${input.injury_type ?? null},
        ${input.canonical_post_id ?? null}, NOW(), NOW(), NOW()
      )
      RETURNING *
    `;
    return rows[0] as InjuryEntity;
  }

  async appendInjuryUpdate(input: {
    entity_id: string;
    post_id?: string;
    update_kind: UpdateKind;
    severity_at_time?: string;
    team_timeline_weeks?: number;
    otm_min_weeks?: number;
    source_url?: string;
    description?: string;
  }): Promise<InjuryUpdate> {
    const rows = await this.sql`
      INSERT INTO injury_updates (
        entity_id, post_id, update_kind, severity_at_time,
        team_timeline_weeks, otm_min_weeks, source_url, description
      ) VALUES (
        ${input.entity_id}, ${input.post_id ?? null}, ${input.update_kind},
        ${input.severity_at_time ?? null}, ${input.team_timeline_weeks ?? null},
        ${input.otm_min_weeks ?? null}, ${input.source_url ?? null},
        ${input.description ?? null}
      )
      RETURNING *
    `;
    // Bump entity's last_updated_at so future recency window matches.
    await this.sql`
      UPDATE injury_entities SET last_updated_at = NOW(), updated_at = NOW()
      WHERE id = ${input.entity_id}
    `;
    return rows[0] as InjuryUpdate;
  }

  // ── Audit log ────────────────────────────────────────────────────────
  async auditAppend(input: AuditAppendInput): Promise<AuditEntry> {
    const beforeHash = input.before !== undefined ? hashPayload(input.before) : null;
    const afterHash = input.after !== undefined ? hashPayload(input.after) : null;
    const payload = input.payload ?? null;

    const rows = await this.sql`
      INSERT INTO audit_log (
        actor, actor_id, entity_type, entity_id, action,
        before_hash, after_hash, payload
      ) VALUES (
        ${input.actor}, ${input.actor_id ?? null},
        ${input.entity_type}, ${input.entity_id ?? null}, ${input.action},
        ${beforeHash}, ${afterHash},
        ${payload ? JSON.stringify(payload) : null}
      )
      RETURNING *
    `;
    return rows[0] as AuditEntry;
  }

  async listAuditEntries(
    entityType: string,
    entityId: string,
    limit = 100,
  ): Promise<AuditEntry[]> {
    const rows = await this.sql`
      SELECT * FROM audit_log
      WHERE entity_type = ${entityType} AND entity_id = ${entityId}
      ORDER BY ts DESC
      LIMIT ${limit}
    `;
    return rows as AuditEntry[];
  }

  // ── Desk candidates (Phase 1 promotion path) ──────────────────────────
  // Upsert the OPEN proposal for an entity. If a PROPOSED candidate already
  // exists (uniq_open_candidate_per_entity), refresh its score/reasons/source
  // in place instead of inserting a duplicate. Decided rows are untouched.
  async proposeCandidate(input: ProposeCandidateInput): Promise<DeskCandidate> {
    const reasons = input.reasons !== undefined ? JSON.stringify(input.reasons) : null;
    const rows = await this.sql`
      INSERT INTO desk_candidates (
        entity_id, source_post_id, promotion_score, reasons, status
      ) VALUES (
        ${input.entity_id}, ${input.source_post_id ?? null},
        ${input.promotion_score}, ${reasons}, 'PROPOSED'
      )
      ON CONFLICT (entity_id) WHERE status = 'PROPOSED'
      DO UPDATE SET
        source_post_id = EXCLUDED.source_post_id,
        promotion_score = EXCLUDED.promotion_score,
        reasons = EXCLUDED.reasons,
        proposed_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `;
    const candidate = rows[0] as DeskCandidate;
    await this.auditAppend({
      actor: input.proposed_by && input.proposed_by !== "system" ? "md" : "system",
      actor_id: input.proposed_by ?? "promotion-scorer",
      entity_type: "desk_candidate",
      entity_id: candidate.id,
      action: "propose_candidate",
      payload: {
        injury_entity_id: input.entity_id,
        source_post_id: input.source_post_id ?? null,
        promotion_score: input.promotion_score,
        reasons: input.reasons ?? null,
      },
    });
    return candidate;
  }

  async listCandidates(status?: CandidateStatus, limit = 100): Promise<CandidateListItem[]> {
    const base = `
      SELECT
        c.*,
        p.full_name      AS athlete_name,
        e.injury_type    AS injury_type,
        e.body_part      AS body_part,
        e.laterality     AS laterality,
        pl.sport         AS sport,
        pl.headline      AS headline,
        pl.slug          AS slug
      FROM desk_candidates c
      JOIN injury_entities e ON e.id = c.entity_id
      LEFT JOIN players p     ON p.id = e.player_id
      LEFT JOIN injury_posts pl ON pl.id = c.source_post_id
    `;
    const rows = status
      ? await this.sql(
          `${base} WHERE c.status = $1 ORDER BY c.promotion_score DESC, c.proposed_at DESC LIMIT $2`,
          [status, limit],
        )
      : await this.sql(
          `${base} ORDER BY c.promotion_score DESC, c.proposed_at DESC LIMIT $1`,
          [limit],
        );
    return rows as CandidateListItem[];
  }

  // MD triage. PROPOSED → ACCEPTED | DISMISSED. (PROMOTED is set in Phase 2
  // when an accepted candidate actually produces a desk_post.)
  async decideCandidate(
    candidateId: string,
    decision: "ACCEPTED" | "DISMISSED",
    decidedBy: string,
  ): Promise<DeskCandidate> {
    const rows = await this.sql`
      UPDATE desk_candidates
      SET status = ${decision}, decided_at = NOW(), decided_by = ${decidedBy}, updated_at = NOW()
      WHERE id = ${candidateId} AND status = 'PROPOSED'
      RETURNING *
    `;
    if (rows.length === 0) {
      throw new McpToolError(
        `Candidate ${candidateId} not found or already decided`,
        "Only PROPOSED candidates can be decided. Use web_list_candidates to find open candidates.",
      );
    }
    const candidate = rows[0] as DeskCandidate;
    await this.auditAppend({
      actor: "md",
      actor_id: decidedBy,
      entity_type: "desk_candidate",
      entity_id: candidate.id,
      action: decision === "ACCEPTED" ? "accept_candidate" : "dismiss_candidate",
      payload: { injury_entity_id: candidate.entity_id, decision },
    });
    return candidate;
  }

  async updateMdReview(input: UpdateMdReviewInput): Promise<MdReview & { post_updated: boolean }> {
    const rows = await this.sql(
      `UPDATE md_reviews
       SET status = $1, reviewer_notes = $2, reviewed_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [input.status, input.reviewer_notes ?? null, input.id],
    );

    if (rows.length === 0) {
      throw new McpToolError(
        `MD review ${input.id} not found`,
        "Verify the review id is correct. Use web_list_md_reviews to find valid review IDs.",
      );
    }

    const review = rows[0] as MdReview;
    let post_updated = false;

    if (input.status === "APPROVED") {
      await this.sql`
        UPDATE injury_posts
        SET status = 'PUBLISHED', updated_at = NOW()
        WHERE id = ${review.post_id}
      `;
      post_updated = true;
    }

    return { ...review, post_updated };
  }
}
