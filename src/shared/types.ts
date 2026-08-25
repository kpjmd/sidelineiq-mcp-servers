export type Sport = "NFL" | "NBA" | "PREMIER_LEAGUE" | "UFC" | "OTHER";

export type InjurySeverity = "MINOR" | "MODERATE" | "SEVERE" | "UNKNOWN";

export type ContentType = "BREAKING" | "TRACKING" | "DEEP_DIVE" | "CONFLICT_FLAG";

export type PostStatus =
  | "PUBLISHED"
  | "PENDING_REVIEW"
  | "DRAFT"
  | "REJECTED"
  | "SUPERSEDED";

/**
 * The two statuses that mean "this row never reached an audience and is not a
 * live queue item" — an MD said no, or a later post published in its place.
 *
 * They are grouped because every reader treats them identically: exclude them.
 * Readers that answer "did we cover this?" or "is this awaiting review?" are
 * equality allowlists and already ignore anything they do not name; readers
 * with no status predicate at all must exclude this set explicitly.
 *
 * REJECTED implies the post never published, and therefore never carries a
 * farcaster_hash or twitter_id — rejectPost only ever transitions
 * PENDING_REVIEW → REJECTED. Callers depend on that invariant.
 */
export const RETIRED_POST_STATUSES = ["REJECTED", "SUPERSEDED"] as const;

export type RetiredPostStatus = (typeof RETIRED_POST_STATUSES)[number];

export function isRetiredPostStatus(status: string | null | undefined): boolean {
  return status === "REJECTED" || status === "SUPERSEDED";
}

/** SUPERSEDED closes a review row that no MD ever judged. See migration 021. */
export type MdReviewStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export interface ReturnToPlayEstimate {
  min_weeks: number;
  max_weeks: number;
  probability_week_2: number;
  probability_week_4: number;
  probability_week_8: number;
  confidence: number;
}

export interface InjuryPost {
  id: string;
  athlete_name: string;
  sport: Sport;
  team: string;
  injury_type: string;
  injury_severity: InjurySeverity;
  content_type: ContentType;
  headline: string;
  clinical_summary: string;
  return_to_play_min_weeks: number | null;
  return_to_play_max_weeks: number | null;
  rtp_probability_week_2: number | null;
  rtp_probability_week_4: number | null;
  rtp_probability_week_8: number | null;
  rtp_confidence: number | null;
  farcaster_hash: string | null;
  twitter_id: string | null;
  source_url: string | null;
  status: PostStatus;
  md_review_required: boolean;
  md_review_reason: string | null;
  md_review_confidence: number | null;
  version: number;
  parent_post_id: string | null;
  slug: string | null;
  conflict_reason: string | null;
  team_timeline_weeks: number | null;
  injury_date: string | null;
  /** Set when status is REJECTED or SUPERSEDED. See migration 021. */
  retired_at: string | null;
  retirement_reason: string | null;
  /** The post that published instead. SUPERSEDED rows only. */
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RejectPostInput {
  /** Exactly one of post_id / review_id. */
  post_id?: string;
  review_id?: string;
  reason?: string;
  rejected_by: string;
}

export interface RejectPostResult {
  post_id: string;
  review_id: string | null;
  /**
   * False when the post was not PENDING_REVIEW — an already-live post whose
   * review row was created with preserve_status. The review is still closed;
   * the post is deliberately left alone. Callers must surface this rather than
   * report a retraction that did not happen.
   */
  post_updated: boolean;
  post_status: PostStatus;
  review_status: MdReviewStatus | null;
  entity_links_cleared: { canonical: number; updates: number };
}

export interface SupersedePostsInput {
  post_ids: string[];
  superseded_by: string;
  reason: string;
}

export interface SupersedePostsResult {
  superseded: string[];
  /** Ids that were not PENDING_REVIEW, with the status that blocked them. */
  skipped: Array<{ post_id: string; status: PostStatus }>;
}

export interface MdReview {
  id: string;
  post_id: string;
  reason: string;
  status: MdReviewStatus;
  reviewer_notes: string | null;
  created_at: string;
  reviewed_at: string | null;
  // Joined fields from injury_posts (present in list queries)
  athlete_name?: string;
  sport?: Sport;
  headline?: string;
  slug?: string;
  /** Joined: the post that published instead, for SUPERSEDED rows. */
  superseded_by?: string | null;
  superseding_slug?: string | null;
}
