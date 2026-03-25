import { getDatabase } from "../../shared/database.js";
import { McpToolError } from "../../shared/errors.js";
import type { InjuryPost, PostStatus, Sport, ContentType } from "../../shared/types.js";

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

  async createPost(data: CreatePostInput): Promise<InjuryPost> {
    const rows = await this.sql`
      INSERT INTO injury_posts (
        athlete_name, sport, team, injury_type, injury_severity,
        content_type, headline, clinical_summary,
        return_to_play_min_weeks, return_to_play_max_weeks,
        rtp_probability_week_2, rtp_probability_week_4, rtp_probability_week_8,
        rtp_confidence, farcaster_hash, twitter_id, source_url, md_review_required
      ) VALUES (
        ${data.athlete_name}, ${data.sport}, ${data.team},
        ${data.injury_type}, ${data.injury_severity},
        ${data.content_type}, ${data.headline}, ${data.clinical_summary},
        ${data.return_to_play_min_weeks ?? null}, ${data.return_to_play_max_weeks ?? null},
        ${data.rtp_probability_week_2 ?? null}, ${data.rtp_probability_week_4 ?? null},
        ${data.rtp_probability_week_8 ?? null}, ${data.rtp_confidence ?? null},
        ${data.farcaster_hash ?? null}, ${data.twitter_id ?? null},
        ${data.source_url ?? null}, ${data.md_review_required ?? false}
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
    // Build dynamic update — only set fields that were provided
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

    // Always bump version and updated_at
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

  async getPost(id: string): Promise<InjuryPost | null> {
    const rows = await this.sql`
      SELECT * FROM injury_posts WHERE id = ${id}
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

    return rows[0] as InjuryPost;
  }

  async listPosts(
    filters: ListPostsFilters,
    limit: number,
    offset: number,
  ): Promise<{ posts: InjuryPost[]; total: number }> {
    // Build dynamic WHERE clauses
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

    // Count query
    const countQuery = `SELECT COUNT(*) as total FROM injury_posts ${whereClause}`;
    const countRows = await this.sql(countQuery, values);
    const total = parseInt(String(countRows[0].total), 10);

    // Data query
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
}
