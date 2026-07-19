import { getDatabase } from "../../shared/database.js";
import { McpToolError } from "../../shared/errors.js";
import { hashPayload } from "../../shared/hash.js";
import { lintDeskPost, type LintFinding } from "./linter.js";
import { assembleDeskHandoff } from "./desk-handoff.js";
import { checkKpjmdLive, type LiveCheckResult } from "./kpjmd-live.js";
import {
  deskContentHash,
  normalizeMeta,
  normalizeSections,
  serializeSections,
  type DeskMeta,
  type DeskSections,
} from "./desk-sections.js";
import {
  normalizeEntityDates,
  normalizeThreadListItem,
  normalizePostDates,
} from "./date-utils.js";
import {
  evaluatePublishGate,
  computeAccuracyRecord,
  resolveActualIso,
  assertCanAttest,
  slugify,
} from "./service.js";
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

export type DateConfidence = "unknown" | "possible" | "probable" | "confirmed";

export interface DateResolutionSource {
  url?: string;
  title?: string;
  stage: "api" | "web_search" | "md_manual";
}

export interface OtmProjection {
  min_weeks: number;
  max_weeks: number;
  probability_week_2?: number;
  probability_week_4?: number;
  probability_week_8?: number;
  projected_return_date?: string | null;
  created_at?: string;
}

export interface AccuracyRecord {
  projected_return_date: string | null;
  actual_return_date: string | null;
  error_days: number | null;
  within_range: boolean | null;
  otm_min_weeks: number | null;
  otm_max_weeks: number | null;
}

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
  // Injury-thread date-resolution columns (migration 014). Present after the
  // migration is applied; readers must tolerate absence on older rows.
  injury_date: string | null;
  injury_date_confidence: DateConfidence;
  surgery_date: string | null;
  surgery_confirmed: boolean;
  date_resolution_sources: DateResolutionSource[] | null;
  otm_projection: OtmProjection | null;
  accuracy_record: AccuracyRecord | null;
  returned_at: string | null;
  closed_at: string | null;
  needs_date_review: boolean;
}

// A thread row joined with player/team display fields for the MD dashboard list.
export interface ThreadListItem {
  id: string;
  player_id: string;
  athlete_name: string | null;
  sport: string | null;
  team_name: string | null;
  body_part: string | null;
  laterality: Laterality;
  injury_type: string | null;
  status: EntityStatus;
  injury_date: string | null;
  injury_date_confidence: DateConfidence;
  surgery_date: string | null;
  surgery_confirmed: boolean;
  needs_date_review: boolean;
  otm_projection: OtmProjection | null;
  accuracy_record: AccuracyRecord | null;
  actual_return_date: string | null;
  returned_at: string | null;
  closed_at: string | null;
  first_reported_at: string;
  last_updated_at: string;
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
// NEW_POST: candidate proposes a brand-new desk_post (the original Phase 1
// flow). RETURN_WATCH_UPDATE: candidate proposes appending a dated follow-up
// to an already-PUBLISHED desk_post (target_desk_post_id) instead of creating
// a new one — see migration 015.
export type CandidateKind = "NEW_POST" | "RETURN_WATCH_UPDATE";

export interface DeskCandidate {
  id: string;
  entity_id: string;
  source_post_id: string | null;
  promotion_score: number;
  reasons: unknown;
  status: CandidateStatus;
  candidate_kind: CandidateKind;
  target_desk_post_id: string | null;
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
  // Defaults to NEW_POST. RETURN_WATCH_UPDATE requires target_desk_post_id.
  candidate_kind?: CandidateKind;
  target_desk_post_id?: string;
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

// ── Auth / identity (Phase 2 foundation) ─────────────────────────────
// The users table is the authority for role. The desk_publish gate (later
// session) re-derives role from here via getUser; it never trusts a role string
// supplied by the caller. The frontend reaches these only through MCP tools.
export type UserRole = "md" | "editor";

export interface User {
  id: string;
  email: string;
  role: UserRole;
  name: string | null;
  created_at: string;
}

export interface UpsertUserInput {
  email: string;
  role: UserRole;
  name?: string;
}

export interface CreateVerificationTokenInput {
  identifier: string;
  token: string;
  expires: string; // ISO 8601
}

export interface VerificationToken {
  identifier: string;
  token: string;
  expires: string;
}

// ── Desk posts (Phase 2C — Tier 2 authored artifact + publish gate) ───
// A desk_post is a physician-attributed Injury Desk breakdown. It moves
// DRAFT → READY (attested) → PUBLISHED, gated server-side by desk_publish:
// DB-derived role must be 'md', the latest attestation's content_hash must
// equal the post's CURRENT hash, and the linter must return zero blockers.
export type DeskPostStatus = "DRAFT" | "READY" | "PUBLISHED" | "RETRACTED";

export interface DeskPost {
  id: string;
  candidate_id: string | null;
  entity_id: string;
  slug: string;
  title: string;
  // Derived from `sections` (see serializeSections). Kept as a column because the
  // linter's prose rules, the audit before/after diff, and desk_post_versions all
  // operate on a single body string.
  markdown_body: string;
  // The seven kpjmd sections. NULL on rows predating migration 016 — such a post
  // lints with a blocker and cannot publish until it is re-sectioned.
  sections: DeskSections | null;
  // kpjmd's optional fields. Covered by content_hash, so editing them after
  // attestation invalidates the publish gate.
  meta: DeskMeta | null;
  draft_json: unknown;
  status: DeskPostStatus;
  version: number;
  author_id: string | null;
  reviewed_by: string | null;
  attestation_id: string | null;
  content_hash: string;
  source_attribution: unknown;
  disclaimer_present: boolean;
  created_at: string;
  updated_at: string;
  // Published on SidelineIQ, set by the desk_publish gate.
  published_at: string | null;
  // Live on kpjmd.com — a SECOND, downstream surface. Only ever set after a
  // server-side fetch of the live URL confirms a 200 AND a matching
  // x-sideline-content-hash meta tag. Never set from a client checkbox.
  kpjmd_published_at: string | null;
  kpjmd_url: string | null;
  kpjmd_content_hash: string | null;
}

export interface DeskAttestation {
  id: string;
  desk_post_id: string;
  reviewer_user_id: string;
  reviewed_source_reports: boolean;
  edited_for_accuracy: boolean;
  framing_confirmed: boolean;
  content_hash: string;
  timestamp: string;
  ip: string | null;
}

// markdown_body is NOT an input on either of these — it is derived from
// sections so the stored body can never disagree with the sections the MD
// actually authored (and attested to).
export interface CreateDraftInput {
  candidate_id: string;
  author_id: string;
  title: string;
  sections: DeskSections;
  meta?: DeskMeta;
  draft_json?: unknown;
  source_attribution?: unknown;
  disclaimer_present?: boolean;
}

export interface UpdateDraftInput {
  desk_post_id: string;
  edited_by: string;
  // Partial: the editor autosaves one section at a time, so an absent key
  // leaves the stored section untouched rather than blanking it.
  sections?: Partial<DeskSections>;
  meta?: DeskMeta;
  title?: string;
  draft_json?: unknown;
  source_attribution?: unknown;
  disclaimer_present?: boolean;
  edit_diff?: unknown;
}

export interface AttestInput {
  desk_post_id: string;
  reviewer_user_id: string;
  reviewed_source_reports: boolean;
  edited_for_accuracy: boolean;
  framing_confirmed: boolean;
  ip?: string;
}

// The structured outcome of the publish gate. A blocked publish is a SUCCESSFUL
// tool call with published:false — the frontend renders `reasons` and maps it to
// HTTP 422. Only true faults (post missing / wrong status) throw McpToolError.
export interface PublishGate {
  role_ok: boolean;
  hash_match: boolean;
  blockers: LintFinding[];
  passed: boolean;
  reasons: string[];
}

export interface PublishResult {
  published: boolean;
  gate: PublishGate;
  post: DeskPost | null;
}

// Like PublishResult, a failed live check is a SUCCESSFUL call with ok:false —
// "not live yet" is a normal state the editor renders, not an error.
export interface KpjmdLiveResult {
  check: LiveCheckResult;
  post: DeskPost;
}

// A desk_post joined to display fields the Injury Desk list view needs.
export interface DeskPostListItem extends DeskPost {
  athlete_name: string | null;
  sport: string | null;
  body_part: string | null;
  laterality: Laterality | null;
  injury_type: string | null;
}

export interface DeskPostDetail {
  post: DeskPost;
  attestations: DeskAttestation[];
}

// ── Desk post updates (Return Watch — migration 015) ─────────────────
// A dated follow-up appended to an already-PUBLISHED desk_post — the
// updates[] array of the kpjmd handoff (desk-handoff.ts). Only PUBLISHED
// posts accept appends (see appendDeskPostUpdate).
export interface DeskPostUpdate {
  id: string;
  desk_post_id: string;
  headline: string;
  markdown_body: string;
  occurred_at: string;
  author_id: string | null;
  content_hash: string;
  created_at: string;
}

export interface AppendUpdateInput {
  desk_post_id: string;
  author_id: string;
  headline: string;
  markdown_body: string;
  occurred_at: string;
  // When set, and the caller has an OPEN RETURN_WATCH_UPDATE candidate
  // targeting this post, that candidate is flipped to PROMOTED atomically
  // with the append — mirrors createDraft's candidate-status-flip so a
  // Return Watch candidate never lingers ACCEPTED-forever after its update
  // has actually been authored.
  candidate_id?: string;
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
    return slugify(`${athleteName}-${injuryType}-${dateStr}`);
  }

  // Shared uniqueness loop: append -2..-99, falling back to a timestamp suffix.
  // Table-specific existence is supplied as a probe so both callers keep tagged
  // template literals (table names cannot be parameterized).
  private async resolveUniqueSlugWith(
    baseSlug: string,
    exists: (slug: string) => Promise<boolean>,
  ): Promise<string> {
    if (!(await exists(baseSlug))) return baseSlug;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${baseSlug}-${i}`;
      if (!(await exists(candidate))) return candidate;
    }
    return `${baseSlug}-${Date.now()}`;
  }

  private resolveUniqueSlug(baseSlug: string): Promise<string> {
    return this.resolveUniqueSlugWith(
      baseSlug,
      async (slug) => (await this.sql`SELECT id FROM injury_posts WHERE slug = ${slug}`).length > 0,
    );
  }

  // Display fields for the kpjmd handoff (desk-handoff.ts) — desk_posts only
  // carries entity_id, so the athlete's name/sport are one join away via
  // injury_entities → players, mirroring listDeskPosts'/listCandidates' joins.
  private async getAthleteDisplayForEntity(entityId: string): Promise<{
    athlete_name: string | null;
    sport: string | null;
    injury_type: string | null;
  }> {
    const rows = await this.sql`
      SELECT p.full_name AS athlete_name, p.sport AS sport, e.injury_type AS injury_type
      FROM injury_entities e
      LEFT JOIN players p ON p.id = e.player_id
      WHERE e.id = ${entityId}
    `;
    const row = rows[0] as
      | { athlete_name: string | null; sport: string | null; injury_type: string | null }
      | undefined;
    return row ?? { athlete_name: null, sport: null, injury_type: null };
  }

  // Recompute and persist draft_json (the kpjmd handoff snapshot) for a desk
  // post from its current row + updates[]. Called at publish, on every subsequent
  // append, and at retract, so the column never drifts stale (hybrid
  // snapshot/refresh model — see desk-handoff.ts).
  private async refreshDraftJson(post: DeskPost): Promise<void> {
    const [{ athlete_name, sport, injury_type }, updates] = await Promise.all([
      this.getAthleteDisplayForEntity(post.entity_id),
      this.listDeskPostUpdates(post.id),
    ]);
    const handoff = assembleDeskHandoff(post, athlete_name, sport, updates, injury_type);
    await this.sql`
      UPDATE desk_posts SET draft_json = ${JSON.stringify(handoff)} WHERE id = ${post.id}
    `;
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
    return normalizePostDates(rows[0] as InjuryPost);
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

    return normalizePostDates(rows[0] as InjuryPost);
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

    const post = normalizePostDates(rows[0] as InjuryPost);

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
    return rows[0] ? normalizePostDates(rows[0] as InjuryPost) : null;
  }

  async getPostBySlug(slug: string): Promise<InjuryPost | null> {
    const rows = await this.sql`
      SELECT * FROM injury_posts WHERE slug = ${slug}
    `;
    return rows[0] ? normalizePostDates(rows[0] as InjuryPost) : null;
  }

  async getPostBySocialId(platform: 'twitter' | 'farcaster', socialId: string): Promise<InjuryPost | null> {
    const rows = platform === 'twitter'
      ? await this.sql`SELECT * FROM injury_posts WHERE twitter_id = ${socialId} LIMIT 1`
      : await this.sql`SELECT * FROM injury_posts WHERE farcaster_hash = ${socialId} LIMIT 1`;
    return rows[0] ? normalizePostDates(rows[0] as InjuryPost) : null;
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

    return normalizePostDates(rows[0] as InjuryPost);
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
      posts: (rows as InjuryPost[]).map(normalizePostDates),
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
      post: normalizePostDates(rows[0] as InjuryPost),
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
    return rows[0] ? normalizeEntityDates(rows[0] as InjuryEntity) : null;
  }

  async getEntity(entityId: string): Promise<InjuryEntity | null> {
    const rows = await this.sql`
      SELECT * FROM injury_entities WHERE id = ${entityId} LIMIT 1
    `;
    return rows[0] ? normalizeEntityDates(rows[0] as InjuryEntity) : null;
  }

  // The most recent PUBLISHED desk_post for an entity, if any. This is the
  // lookup Return Watch needs (sidelineiq-agents) to decide whether new
  // injury_updates activity on an entity is worth surfacing as a
  // RETURN_WATCH_UPDATE candidate — no other existing tool answers
  // "does this entity have a live Injury Desk post" by entity_id.
  async getPublishedDeskPostForEntity(entityId: string): Promise<DeskPost | null> {
    const rows = await this.sql`
      SELECT * FROM desk_posts
      WHERE entity_id = ${entityId} AND status = 'PUBLISHED'
      ORDER BY published_at DESC LIMIT 1
    `;
    return rows.length > 0 ? (rows[0] as DeskPost) : null;
  }

  async listInjuryUpdates(entityId: string): Promise<InjuryUpdate[]> {
    const rows = await this.sql`
      SELECT id, entity_id, post_id, update_kind, severity_at_time,
             team_timeline_weeks, otm_min_weeks, source_url, description, created_at
      FROM injury_updates
      WHERE entity_id = ${entityId}
      ORDER BY created_at DESC
    `;
    return rows as InjuryUpdate[];
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
    return normalizeEntityDates(rows[0] as InjuryEntity);
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

  // ── Injury threads (migration 014) ───────────────────────────────────
  // Persist resolved dates / provenance / projection onto the thread. Every
  // field is COALESCE'd against the current value, so omitting a field leaves
  // it untouched (the pre-OTM loop, the post-publish projection patch, and MD
  // manual entry all call this with different subsets). needs_date_review is
  // auto-derived from confidence ('unknown' → needs review) unless the caller
  // sets it explicitly, or omitted entirely to keep the current value.
  async updateThreadDates(input: {
    entity_id: string;
    injury_date?: string;
    injury_date_confidence?: DateConfidence;
    surgery_date?: string;
    surgery_confirmed?: boolean;
    date_resolution_sources?: DateResolutionSource[];
    otm_projection?: OtmProjection;
    needs_date_review?: boolean;
  }): Promise<InjuryEntity> {
    const needsReview =
      input.needs_date_review !== undefined
        ? input.needs_date_review
        : input.injury_date_confidence !== undefined
          ? input.injury_date_confidence === "unknown"
          : null; // keep existing

    const sources = input.date_resolution_sources
      ? JSON.stringify(input.date_resolution_sources)
      : null;
    const projection = input.otm_projection ? JSON.stringify(input.otm_projection) : null;

    const rows = await this.sql`
      UPDATE injury_entities SET
        injury_date = COALESCE(${input.injury_date ?? null}::date, injury_date),
        injury_date_confidence = COALESCE(${input.injury_date_confidence ?? null}, injury_date_confidence),
        surgery_date = COALESCE(${input.surgery_date ?? null}::date, surgery_date),
        surgery_confirmed = COALESCE(${input.surgery_confirmed ?? null}::boolean, surgery_confirmed),
        date_resolution_sources = COALESCE(${sources}::jsonb, date_resolution_sources),
        otm_projection = COALESCE(${projection}::jsonb, otm_projection),
        needs_date_review = COALESCE(${needsReview}::boolean, needs_date_review),
        last_updated_at = NOW(),
        updated_at = NOW()
      WHERE id = ${input.entity_id}
      RETURNING *
    `;
    if (rows.length === 0) {
      throw new McpToolError(
        `Injury thread ${input.entity_id} not found`,
        "Verify the entity_id.",
      );
    }
    return normalizeEntityDates(rows[0] as InjuryEntity);
  }

  // Close a thread when the athlete returns (RESOLVED) or retires (RETIRED).
  // Computes accuracy_record from the frozen otm_projection vs the actual
  // return. Idempotent: re-closing a RESOLVED thread recomputes in place.
  async closeThread(input: {
    entity_id: string;
    actual_return_date?: string;
    outcome?: "RESOLVED" | "RETIRED";
    closed_by?: string;
  }): Promise<InjuryEntity> {
    const entity = await this.getEntity(input.entity_id);
    if (!entity) {
      throw new McpToolError(
        `Injury thread ${input.entity_id} not found`,
        "Verify the entity_id.",
      );
    }
    const outcome = input.outcome ?? "RESOLVED";
    // entity dates are already normalized to 'YYYY-MM-DD' by getEntity; the pure
    // service functions accept strings or Dates either way.
    const actualIso = resolveActualIso(entity, input.actual_return_date);
    const accuracy = computeAccuracyRecord(entity, actualIso);

    const rows = await this.sql`
      UPDATE injury_entities SET
        status = ${outcome},
        actual_return_date = COALESCE(${actualIso}::date, actual_return_date),
        accuracy_record = ${accuracy ? JSON.stringify(accuracy) : null}::jsonb,
        returned_at = CASE WHEN ${outcome} = 'RESOLVED' THEN NOW() ELSE returned_at END,
        closed_at = NOW(),
        last_updated_at = NOW(),
        updated_at = NOW()
      WHERE id = ${input.entity_id}
      RETURNING *
    `;
    const closed = normalizeEntityDates(rows[0] as InjuryEntity);

    await this.auditAppend({
      actor: input.closed_by && input.closed_by !== "system" ? "md" : "system",
      actor_id: input.closed_by ?? undefined,
      entity_type: "injury_thread",
      entity_id: input.entity_id,
      action: "thread_closed",
      before: entity,
      after: closed,
      payload: { outcome, actual_return_date: actualIso, accuracy_record: accuracy },
    });

    return closed;
  }

  async getThread(
    entityId: string,
  ): Promise<{ entity: InjuryEntity; updates: InjuryUpdate[] } | null> {
    const entity = await this.getEntity(entityId);
    if (!entity) return null;
    const updates = await this.listInjuryUpdates(entityId);
    return { entity, updates };
  }

  async listThreads(input: {
    status?: EntityStatus;
    needs_date_review?: boolean;
    limit?: number;
  }): Promise<ThreadListItem[]> {
    const status = input.status ?? null;
    const needsReview = input.needs_date_review ?? null;
    const limit = input.limit ?? 100;
    const rows = await this.sql`
      SELECT e.id, e.player_id, e.body_part, e.laterality, e.injury_type, e.status,
             e.injury_date, e.injury_date_confidence, e.surgery_date, e.surgery_confirmed,
             e.needs_date_review, e.otm_projection, e.accuracy_record,
             e.actual_return_date, e.returned_at, e.closed_at,
             e.first_reported_at, e.last_updated_at,
             p.full_name AS athlete_name, p.sport AS sport,
             t.display_name AS team_name
      FROM injury_entities e
      JOIN players p ON p.id = e.player_id
      LEFT JOIN teams t ON t.id = p.current_team_id
      WHERE (${status}::text IS NULL OR e.status = ${status})
        AND (${needsReview}::boolean IS NULL OR e.needs_date_review = ${needsReview})
      ORDER BY e.last_updated_at DESC
      LIMIT ${limit}
    `;
    return (rows as ThreadListItem[]).map(normalizeThreadListItem);
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
    const kind = input.candidate_kind ?? "NEW_POST";
    if (kind === "RETURN_WATCH_UPDATE" && !input.target_desk_post_id) {
      throw new McpToolError(
        "target_desk_post_id is required for candidate_kind RETURN_WATCH_UPDATE",
        "Look up the entity's PUBLISHED desk_post (web_get_published_desk_post_for_entity) and pass its id.",
      );
    }
    if (kind === "NEW_POST" && input.target_desk_post_id) {
      throw new McpToolError(
        "target_desk_post_id must be omitted for candidate_kind NEW_POST",
        "Only RETURN_WATCH_UPDATE candidates target an existing desk_post.",
      );
    }
    const reasons = input.reasons !== undefined ? JSON.stringify(input.reasons) : null;
    const rows = await this.sql`
      INSERT INTO desk_candidates (
        entity_id, source_post_id, promotion_score, reasons, status,
        candidate_kind, target_desk_post_id
      ) VALUES (
        ${input.entity_id}, ${input.source_post_id ?? null},
        ${input.promotion_score}, ${reasons}, 'PROPOSED',
        ${kind}, ${input.target_desk_post_id ?? null}
      )
      ON CONFLICT (entity_id) WHERE status = 'PROPOSED'
      DO UPDATE SET
        source_post_id = EXCLUDED.source_post_id,
        promotion_score = EXCLUDED.promotion_score,
        reasons = EXCLUDED.reasons,
        candidate_kind = EXCLUDED.candidate_kind,
        target_desk_post_id = EXCLUDED.target_desk_post_id,
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
        candidate_kind: kind,
        target_desk_post_id: input.target_desk_post_id ?? null,
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

  // ── Auth / identity (Phase 2 foundation) ──────────────────────────────
  // getUser is the role re-derive primitive: the future desk_publish gate looks
  // up the reviewer's id here and trusts the DB's role, not the caller's claim.
  async getUser(id: string): Promise<User | null> {
    const rows = await this.sql`
      SELECT id, email, role, name, created_at
      FROM users
      WHERE id = ${id}
    `;
    return rows.length > 0 ? (rows[0] as User) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const rows = await this.sql`
      SELECT id, email, role, name, created_at
      FROM users
      WHERE email_lower = ${email.toLowerCase()}
    `;
    return rows.length > 0 ? (rows[0] as User) : null;
  }

  // Idempotent on email (case-insensitive). Used to seed/maintain identities;
  // the NextAuth adapter does NOT mint users from the client (single-MD model),
  // but this exists for explicit administrative provisioning. Audited.
  async upsertUser(input: UpsertUserInput): Promise<User> {
    const rows = await this.sql`
      INSERT INTO users (email, role, name)
      VALUES (${input.email}, ${input.role}, ${input.name ?? null})
      ON CONFLICT (email) DO UPDATE SET
        role = EXCLUDED.role,
        name = COALESCE(EXCLUDED.name, users.name)
      RETURNING id, email, role, name, created_at
    `;
    const user = rows[0] as User;
    await this.auditAppend({
      actor: "system",
      actor_id: "auth-provisioning",
      entity_type: "user",
      entity_id: user.id,
      action: "upsert_user",
      payload: { email: user.email, role: user.role },
    });
    return user;
  }

  async createVerificationToken(
    input: CreateVerificationTokenInput,
  ): Promise<VerificationToken> {
    const rows = await this.sql`
      INSERT INTO verification_token (identifier, token, expires)
      VALUES (${input.identifier}, ${input.token}, ${input.expires})
      RETURNING identifier, token, expires
    `;
    return rows[0] as VerificationToken;
  }

  // Atomic delete-on-read: a magic-link token is single-use, so consuming it is
  // a DELETE ... RETURNING. Returns null if the token was already used or never
  // existed. NEVER split into select-then-delete (replay window).
  async useVerificationToken(
    identifier: string,
    token: string,
  ): Promise<VerificationToken | null> {
    const rows = await this.sql`
      DELETE FROM verification_token
      WHERE identifier = ${identifier} AND token = ${token}
      RETURNING identifier, token, expires
    `;
    return rows.length > 0 ? (rows[0] as VerificationToken) : null;
  }

  // ── Desk posts (Phase 2C) ─────────────────────────────────────────────
  // content_hash is deskContentHash(title, sections, meta, body) EVERYWHERE
  // (create/update/attest/publish) so the gate's equality check is meaningful.
  // Route every hash through that one helper — hashing the body alone would
  // leave `meta` (faqs, conflict_flag, …) editable after attestation, which
  // silently defeats the gate. See desk-sections.ts for the legacy fallback.
  private deskSlugify(title: string): string {
    return slugify(title, 200, "injury-desk-post");
  }

  private resolveUniqueDeskSlug(baseSlug: string): Promise<string> {
    return this.resolveUniqueSlugWith(
      baseSlug,
      async (slug) => (await this.sql`SELECT id FROM desk_posts WHERE slug = ${slug}`).length > 0,
    );
  }

  // Create a DRAFT desk_post from an ACCEPTED candidate. Writes the v1 version
  // row and flips the candidate ACCEPTED → PROMOTED (its terminal state).
  async createDraft(input: CreateDraftInput): Promise<DeskPost> {
    const candRows = await this.sql`
      SELECT id, entity_id, status FROM desk_candidates WHERE id = ${input.candidate_id}
    `;
    if (candRows.length === 0) {
      throw new McpToolError(
        `Candidate ${input.candidate_id} not found`,
        "Use web_list_candidates to find a valid candidate id.",
      );
    }
    const candidate = candRows[0] as { id: string; entity_id: string; status: string };
    if (candidate.status !== "ACCEPTED") {
      throw new McpToolError(
        `Candidate ${input.candidate_id} is ${candidate.status}, not ACCEPTED`,
        "Only an ACCEPTED candidate can be drafted into a desk post. Accept it first via web_decide_candidate.",
      );
    }

    const slug = await this.resolveUniqueDeskSlug(this.deskSlugify(input.title));
    const sections = normalizeSections(input.sections);
    const meta = normalizeMeta(input.meta);
    const markdownBody = serializeSections(sections, meta);
    const contentHash = deskContentHash(input.title, sections, meta, markdownBody);
    const draftJson = input.draft_json !== undefined ? JSON.stringify(input.draft_json) : null;
    const sourceAttribution =
      input.source_attribution !== undefined ? JSON.stringify(input.source_attribution) : null;
    const sectionsJson = JSON.stringify(sections);
    const metaJson = JSON.stringify(meta);

    const postRows = await this.sql`
      INSERT INTO desk_posts (
        candidate_id, entity_id, slug, title, markdown_body, sections, meta, draft_json,
        status, version, author_id, content_hash, source_attribution, disclaimer_present
      ) VALUES (
        ${input.candidate_id}, ${candidate.entity_id}, ${slug}, ${input.title},
        ${markdownBody}, ${sectionsJson}, ${metaJson}, ${draftJson}, 'DRAFT', 1, ${input.author_id},
        ${contentHash}, ${sourceAttribution}, ${input.disclaimer_present ?? false}
      )
      RETURNING *
    `;
    const post = postRows[0] as DeskPost;

    await this.sql`
      INSERT INTO desk_post_versions (
        desk_post_id, version, markdown_body, sections, meta, draft_json, content_hash, edited_by, edit_diff
      ) VALUES (
        ${post.id}, 1, ${markdownBody}, ${sectionsJson}, ${metaJson}, ${draftJson}, ${contentHash},
        ${input.author_id}, ${null}
      )
    `;

    await this.sql`
      UPDATE desk_candidates
      SET status = 'PROMOTED', decided_at = NOW(), updated_at = NOW()
      WHERE id = ${input.candidate_id} AND status = 'ACCEPTED'
    `;

    await this.auditAppend({
      actor: "md",
      actor_id: input.author_id,
      entity_type: "desk_post",
      entity_id: post.id,
      action: "create_draft",
      payload: { candidate_id: input.candidate_id, entity_id: candidate.entity_id, slug },
    });
    return post;
  }

  // Edit a DRAFT or READY post. Writes a new version row on every save. Editing a
  // READY post reverts it to DRAFT — the prior attestation is now stale, and the
  // UI should reflect that (the publish gate's hash compare catches it regardless).
  async updateDraft(input: UpdateDraftInput): Promise<DeskPost> {
    const current = await this.sql`SELECT * FROM desk_posts WHERE id = ${input.desk_post_id}`;
    if (current.length === 0) {
      throw new McpToolError(
        `Desk post ${input.desk_post_id} not found`,
        "Use desk_list to find a valid desk post id.",
      );
    }
    const prev = current[0] as DeskPost;
    if (prev.status !== "DRAFT" && prev.status !== "READY") {
      throw new McpToolError(
        `Desk post ${input.desk_post_id} is ${prev.status} and cannot be edited`,
        "Only DRAFT or READY posts can be edited.",
      );
    }

    const newVersion = prev.version + 1;
    // Merge partial section edits onto what is stored — the editor autosaves the
    // section the MD is typing in, not all seven. A legacy row (sections NULL,
    // migration 016) normalizes to seven empty strings, so the first save after
    // the migration starts a real section set rather than throwing.
    const sections = normalizeSections({
      ...normalizeSections(prev.sections),
      ...(input.sections ?? {}),
    });
    const meta = input.meta !== undefined ? normalizeMeta(input.meta) : normalizeMeta(prev.meta);
    const title = input.title ?? prev.title;
    const markdownBody = serializeSections(sections, meta);
    const contentHash = deskContentHash(title, sections, meta, markdownBody);
    const newStatus: DeskPostStatus = prev.status === "READY" ? "DRAFT" : prev.status;
    const draftJson = input.draft_json !== undefined ? JSON.stringify(input.draft_json) : null;
    const sourceAttribution =
      input.source_attribution !== undefined ? JSON.stringify(input.source_attribution) : null;
    const editDiff = input.edit_diff !== undefined ? JSON.stringify(input.edit_diff) : null;
    const sectionsJson = JSON.stringify(sections);
    const metaJson = JSON.stringify(meta);

    const updated = await this.sql`
      UPDATE desk_posts SET
        title = ${title},
        markdown_body = ${markdownBody},
        sections = ${sectionsJson},
        meta = ${metaJson},
        draft_json = COALESCE(${draftJson}, draft_json),
        source_attribution = COALESCE(${sourceAttribution}, source_attribution),
        disclaimer_present = COALESCE(${input.disclaimer_present ?? null}, disclaimer_present),
        content_hash = ${contentHash},
        version = ${newVersion},
        status = ${newStatus},
        updated_at = NOW()
      WHERE id = ${input.desk_post_id} AND status = ${prev.status} AND version = ${prev.version}
      RETURNING *
    `;
    // Optimistic lock: if the row moved (e.g. a concurrent publish/edit) between
    // the read above and this write, the guarded UPDATE matches nothing rather
    // than silently mutating a now-PUBLISHED post back to DRAFT.
    if (updated.length === 0) {
      throw new McpToolError(
        `Desk post ${input.desk_post_id} changed concurrently`,
        "The post was modified since it was read. Re-fetch it with desk_get and retry the edit.",
      );
    }
    const post = updated[0] as DeskPost;

    await this.sql`
      INSERT INTO desk_post_versions (
        desk_post_id, version, markdown_body, sections, meta, draft_json, content_hash, edited_by, edit_diff
      ) VALUES (
        ${post.id}, ${newVersion}, ${markdownBody}, ${sectionsJson}, ${metaJson}, ${draftJson},
        ${contentHash}, ${input.edited_by}, ${editDiff}
      )
    `;

    await this.auditAppend({
      actor: "md",
      actor_id: input.edited_by,
      entity_type: "desk_post",
      entity_id: post.id,
      action: "update_draft",
      before: prev.markdown_body,
      after: markdownBody,
      payload: { version: newVersion, reverted_to_draft: newStatus !== prev.status },
    });
    return post;
  }

  // Read-only lint of the current stored body + sections. Backs desk_lint.
  async lintDeskPostById(deskPostId: string): ReturnType<typeof lintDeskPost> {
    const rows = await this.sql`SELECT * FROM desk_posts WHERE id = ${deskPostId}`;
    if (rows.length === 0) {
      throw new McpToolError(
        `Desk post ${deskPostId} not found`,
        "Use desk_list to find a valid desk post id.",
      );
    }
    const post = rows[0] as DeskPost;
    return await lintDeskPost({
      title: post.title,
      markdown_body: post.markdown_body,
      sections: post.sections,
      meta: post.meta,
      draft_json: post.draft_json,
      source_attribution: post.source_attribution,
      disclaimer_present: post.disclaimer_present,
    });
  }

  // Physician attestation. Re-derives role from the DB (never trusts the caller)
  // and refuses unless role === 'md' AND all three review confirmations are true.
  // Snapshots content_hash of the CURRENT body, records the attestation, points
  // the post at it, and moves the post to READY.
  async attestDeskPost(input: AttestInput): Promise<DeskAttestation> {
    const user = await this.getUser(input.reviewer_user_id);

    const postRows = await this.sql`SELECT * FROM desk_posts WHERE id = ${input.desk_post_id}`;
    if (postRows.length === 0) {
      throw new McpToolError(
        `Desk post ${input.desk_post_id} not found`,
        "Use desk_list to find a valid desk post id.",
      );
    }
    const post = postRows[0] as DeskPost;
    // Role (re-derived from DB), the three confirmations, and attestable status.
    assertCanAttest(user, input, post);

    // Must match evaluatePublishGate's recomputation exactly, or the gate can
    // never pass. Both go through deskContentHash.
    const contentHash = deskContentHash(post.title, post.sections, post.meta, post.markdown_body);
    const attRows = await this.sql`
      INSERT INTO desk_attestations (
        desk_post_id, reviewer_user_id, reviewed_source_reports,
        edited_for_accuracy, framing_confirmed, content_hash, ip
      ) VALUES (
        ${input.desk_post_id}, ${input.reviewer_user_id}, ${input.reviewed_source_reports},
        ${input.edited_for_accuracy}, ${input.framing_confirmed}, ${contentHash}, ${input.ip ?? null}
      )
      RETURNING *
    `;
    const attestation = attRows[0] as DeskAttestation;

    // Status-guarded so a publish/retract landing between the read above and
    // this write can't demote a live post back to READY with a fresh attestation.
    const moved = await this.sql`
      UPDATE desk_posts
      SET attestation_id = ${attestation.id}, reviewed_by = ${input.reviewer_user_id},
          status = 'READY', updated_at = NOW()
      WHERE id = ${input.desk_post_id} AND status IN ('DRAFT', 'READY')
      RETURNING id
    `;
    if (moved.length === 0) {
      throw new McpToolError(
        `Desk post ${input.desk_post_id} changed status during attestation`,
        "The post left DRAFT/READY since it was read. Re-fetch it with desk_get and retry.",
      );
    }

    await this.auditAppend({
      actor: "md",
      actor_id: input.reviewer_user_id,
      entity_type: "desk_post",
      entity_id: post.id,
      action: "attest",
      payload: { attestation_id: attestation.id, content_hash: contentHash },
    });
    return attestation;
  }

  // THE PUBLISH GATE — the medico-legal defensibility backbone. A blocked publish
  // is a SUCCESSFUL result with published:false (frontend maps to 422); only a
  // missing post or wrong status throws. Passes iff ALL hold:
  //   • DB-derived role of reviewer === 'md' (re-derived here, never trusted)
  //   • latest attestation's content_hash === hashPayload(current body)
  //   • linter returns zero blockers
  async publishDeskPost(deskPostId: string, reviewerUserId: string): Promise<PublishResult> {
    const postRows = await this.sql`SELECT * FROM desk_posts WHERE id = ${deskPostId}`;
    if (postRows.length === 0) {
      throw new McpToolError(
        `Desk post ${deskPostId} not found`,
        "Use desk_list to find a valid desk post id.",
      );
    }
    const post = postRows[0] as DeskPost;
    if (post.status !== "READY") {
      throw new McpToolError(
        `Desk post ${deskPostId} is ${post.status}, not READY`,
        "Attest the post (desk_attest) before publishing.",
      );
    }

    const user = await this.getUser(reviewerUserId);

    // Use the attestation the attest flow explicitly pointed the post at — the
    // deterministic source of truth — not a nondeterministic latest-by-timestamp.
    const attRows = post.attestation_id
      ? await this.sql`SELECT * FROM desk_attestations WHERE id = ${post.attestation_id}`
      : [];
    const latest = attRows.length > 0 ? (attRows[0] as DeskAttestation) : null;

    const { blockers } = await lintDeskPost({
      title: post.title,
      markdown_body: post.markdown_body,
      sections: post.sections,
      meta: post.meta,
      draft_json: post.draft_json,
      source_attribution: post.source_attribution,
      disclaimer_present: post.disclaimer_present,
    });

    const gate = evaluatePublishGate(post, user, latest, blockers);

    if (!gate.passed) {
      await this.auditAppend({
        actor: "md",
        actor_id: reviewerUserId,
        entity_type: "desk_post",
        entity_id: post.id,
        action: "publish_blocked",
        payload: {
          role_ok: gate.role_ok,
          hash_match: gate.hash_match,
          blocker_count: blockers.length,
          reasons: gate.reasons,
        },
      });
      return { published: false, gate, post: null };
    }

    const updated = await this.sql`
      UPDATE desk_posts
      SET status = 'PUBLISHED', published_at = NOW(), reviewed_by = ${reviewerUserId}, updated_at = NOW()
      WHERE id = ${deskPostId} AND status = 'READY'
      RETURNING *
    `;
    // If the row left READY between the gate check and this write, the guarded
    // UPDATE matches nothing. Report a blocked publish (with a concurrency
    // reason) rather than a false published:true / undefined post — the audit
    // trail must never record a publish that did not happen.
    if (updated.length === 0) {
      const concurrentReason = "post status changed during publish (concurrent modification)";
      const blockedGate: PublishGate = {
        ...gate,
        passed: false,
        reasons: [...gate.reasons, concurrentReason],
      };
      await this.auditAppend({
        actor: "md",
        actor_id: reviewerUserId,
        entity_type: "desk_post",
        entity_id: post.id,
        action: "publish_blocked",
        payload: { role_ok: gate.role_ok, hash_match: gate.hash_match, reasons: blockedGate.reasons },
      });
      return { published: false, gate: blockedGate, post: null };
    }
    const publishedPost = updated[0] as DeskPost;
    await this.refreshDraftJson(publishedPost);

    await this.auditAppend({
      actor: "md",
      actor_id: reviewerUserId,
      entity_type: "desk_post",
      entity_id: post.id,
      action: "publish",
      payload: {
        attestation_id: latest?.id ?? null,
        content_hash: deskContentHash(post.title, post.sections, post.meta, post.markdown_body),
        slug: post.slug,
      },
    });
    return { published: true, gate, post: publishedPost };
  }

  // Retract a PUBLISHED post. MD-only (role re-derived). Refreshes draft_json so
  // its _sideline.status flips to RETRACTED — that snapshot is what the frontend
  // serves as {slug}.retracted.json, which the kpjmd builder turns into a
  // tombstone page at the same URL.
  async retractDeskPost(deskPostId: string, reviewerUserId: string): Promise<DeskPost> {
    const user = await this.getUser(reviewerUserId);
    if (!user || user.role !== "md") {
      throw new McpToolError(
        `Reviewer ${reviewerUserId} is not an MD`,
        "Only an MD identity can retract a desk post.",
      );
    }
    const rows = await this.sql`
      UPDATE desk_posts
      SET status = 'RETRACTED', updated_at = NOW()
      WHERE id = ${deskPostId} AND status = 'PUBLISHED'
      RETURNING *
    `;
    if (rows.length === 0) {
      throw new McpToolError(
        `Desk post ${deskPostId} not found or not PUBLISHED`,
        "Only a PUBLISHED post can be retracted.",
      );
    }
    const post = rows[0] as DeskPost;
    // Without this the retracted post's draft_json keeps reporting PUBLISHED
    // forever: appends are the only other refresh trigger, and they require
    // PUBLISHED status, so a retracted post can never refresh on its own.
    await this.refreshDraftJson(post);
    await this.auditAppend({
      actor: "md",
      actor_id: reviewerUserId,
      entity_type: "desk_post",
      entity_id: post.id,
      action: "retract",
      payload: { slug: post.slug },
    });
    return post;
  }

  // Confirm a desk post is actually live on kpjmd.com and record it.
  //
  // The fetch and the write live together here ON PURPOSE. If the frontend
  // fetched the page and then called a "record it" tool, that tool would be
  // callable directly with a fabricated result — the confirmation would be worth
  // no more than the checkbox it replaces. Doing both server-side means
  // kpjmd_published_at can only ever be set by a verification that really ran.
  //
  // Idempotent and re-runnable: a later edit or Return Watch append moves
  // content_hash, so re-confirming after re-deploying is the intended flow.
  async confirmKpjmdLive(deskPostId: string, reviewerUserId: string): Promise<KpjmdLiveResult> {
    const user = await this.getUser(reviewerUserId);
    if (!user || user.role !== "md") {
      throw new McpToolError(
        `Reviewer ${reviewerUserId} is not an MD`,
        "Only an MD identity can confirm a kpjmd.com publish.",
      );
    }
    const rows = await this.sql`SELECT * FROM desk_posts WHERE id = ${deskPostId}`;
    if (rows.length === 0) {
      throw new McpToolError(
        `Desk post ${deskPostId} not found`,
        "Use desk_list to find a valid desk post id.",
      );
    }
    const post = rows[0] as DeskPost;
    if (post.status !== "PUBLISHED") {
      throw new McpToolError(
        `Desk post ${deskPostId} is ${post.status}, not PUBLISHED`,
        "Publish the post on SidelineIQ before confirming it live on kpjmd.com.",
      );
    }

    const check = await checkKpjmdLive(post.slug, post.content_hash);

    // A failed check changes nothing — no partial state, no optimistic write.
    if (check.ok) {
      await this.sql`
        UPDATE desk_posts SET
          kpjmd_published_at = NOW(),
          kpjmd_url = ${check.url},
          kpjmd_content_hash = ${check.expected_content_hash},
          updated_at = NOW()
        WHERE id = ${deskPostId}
      `;
    }

    await this.auditAppend({
      actor: "md",
      actor_id: reviewerUserId,
      entity_type: "desk_post",
      entity_id: post.id,
      action: check.ok ? "confirm_kpjmd_live" : "confirm_kpjmd_live_failed",
      payload: {
        slug: post.slug,
        url: check.url,
        http_status: check.http_status,
        live_content_hash: check.live_content_hash,
        expected_content_hash: check.expected_content_hash,
        reasons: check.reasons,
      },
    });

    const after = await this.sql`SELECT * FROM desk_posts WHERE id = ${deskPostId}`;
    return { check, post: after[0] as DeskPost };
  }

  // Append a dated Return Watch follow-up to a PUBLISHED post. Identity→gate
  // pattern cloned from retractDeskPost (role re-derived from users, never
  // trusted from the caller) — lower-stakes than the three-part attestation
  // gate, so it does not go through assertCanAttest/evaluatePublishGate.
  async appendDeskPostUpdate(input: AppendUpdateInput): Promise<DeskPostUpdate> {
    const user = await this.getUser(input.author_id);
    if (!user || user.role !== "md") {
      throw new McpToolError(
        `Author ${input.author_id} is not an MD`,
        "Only an MD identity can append a desk post update.",
      );
    }
    const postRows = await this.sql`SELECT * FROM desk_posts WHERE id = ${input.desk_post_id}`;
    if (postRows.length === 0) {
      throw new McpToolError(
        `Desk post ${input.desk_post_id} not found`,
        "Use desk_list to find a valid desk post id.",
      );
    }
    const post = postRows[0] as DeskPost;
    if (post.status !== "PUBLISHED") {
      throw new McpToolError(
        `Desk post ${input.desk_post_id} is ${post.status}, not PUBLISHED`,
        "Updates can only be appended to a PUBLISHED post.",
      );
    }

    const contentHash = hashPayload(input.markdown_body);
    const rows = await this.sql`
      INSERT INTO desk_post_updates (
        desk_post_id, headline, markdown_body, occurred_at, author_id, content_hash
      ) VALUES (
        ${input.desk_post_id}, ${input.headline}, ${input.markdown_body},
        ${input.occurred_at}, ${input.author_id}, ${contentHash}
      )
      RETURNING *
    `;
    const update = rows[0] as DeskPostUpdate;

    await this.refreshDraftJson(post);

    if (input.candidate_id) {
      await this.sql`
        UPDATE desk_candidates
        SET status = 'PROMOTED', decided_at = COALESCE(decided_at, NOW()), updated_at = NOW()
        WHERE id = ${input.candidate_id} AND candidate_kind = 'RETURN_WATCH_UPDATE'
          AND target_desk_post_id = ${input.desk_post_id} AND status IN ('ACCEPTED', 'PROPOSED')
      `;
    }

    await this.auditAppend({
      actor: "md",
      actor_id: input.author_id,
      entity_type: "desk_post_update",
      entity_id: update.id,
      action: "append_update",
      payload: { desk_post_id: input.desk_post_id, content_hash: contentHash, candidate_id: input.candidate_id ?? null },
    });
    return update;
  }

  async listDeskPostUpdates(deskPostId: string): Promise<DeskPostUpdate[]> {
    const rows = await this.sql`
      SELECT * FROM desk_post_updates WHERE desk_post_id = ${deskPostId} ORDER BY occurred_at DESC
    `;
    return rows as DeskPostUpdate[];
  }

  async listDeskPosts(status?: DeskPostStatus, limit = 100): Promise<DeskPostListItem[]> {
    const base = `
      SELECT
        d.*,
        p.full_name   AS athlete_name,
        e.injury_type AS injury_type,
        e.body_part   AS body_part,
        e.laterality  AS laterality,
        p.sport       AS sport
      FROM desk_posts d
      JOIN injury_entities e ON e.id = d.entity_id
      LEFT JOIN players p    ON p.id = e.player_id
    `;
    const rows = status
      ? await this.sql(
          `${base} WHERE d.status = $1 ORDER BY d.updated_at DESC LIMIT $2`,
          [status, limit],
        )
      : await this.sql(`${base} ORDER BY d.updated_at DESC LIMIT $1`, [limit]);
    return rows as DeskPostListItem[];
  }

  async getDeskPost(deskPostId: string): Promise<DeskPostDetail> {
    const postRows = await this.sql`SELECT * FROM desk_posts WHERE id = ${deskPostId}`;
    if (postRows.length === 0) {
      throw new McpToolError(
        `Desk post ${deskPostId} not found`,
        "Use desk_list to find a valid desk post id.",
      );
    }
    const post = postRows[0] as DeskPost;
    const attestations = await this.sql`
      SELECT * FROM desk_attestations
      WHERE desk_post_id = ${deskPostId}
      ORDER BY timestamp DESC
    `;
    return { post, attestations: attestations as DeskAttestation[] };
  }
}
