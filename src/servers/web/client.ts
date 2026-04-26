import { getDatabase } from "../../shared/database.js";
import { McpToolError } from "../../shared/errors.js";
import type { InjuryPost, MdReview, MdReviewStatus, PostStatus, Sport, ContentType } from "../../shared/types.js";

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
        parent_post_id, slug, conflict_reason, team_timeline_weeks
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
        ${data.conflict_reason ?? null}, ${data.team_timeline_weeks ?? null}
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

  async flagForMdReview(
    id: string,
    reason: string,
    confidenceScore: number,
    flaggedBy: string,
  ): Promise<InjuryPost> {
    const rows = await this.sql`
      UPDATE injury_posts
      SET
        status = 'PENDING_REVIEW',
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
