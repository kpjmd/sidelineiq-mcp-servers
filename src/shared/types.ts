export type Sport = "NFL" | "NBA" | "PREMIER_LEAGUE" | "UFC" | "OTHER";

export type InjurySeverity = "MINOR" | "MODERATE" | "SEVERE" | "UNKNOWN";

export type ContentType = "BREAKING" | "TRACKING" | "DEEP_DIVE";

export type PostStatus = "PUBLISHED" | "PENDING_REVIEW" | "DRAFT";

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
  created_at: string;
  updated_at: string;
}
