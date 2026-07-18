// The kpjmd.com JSON handoff contract (Phase 3). A DeskHandoffV1 is the pure,
// serializable shape a PUBLISHED desk_post assembles into for the (still
// unbuilt) "Download approved JSON" flow — persisted into desk_posts.draft_json
// so it stays available without recomputing on read.
//
// schema_version is versioned from day one specifically so `updates[]`
// (Return Watch follow-ups, see migration 015) never has to be retrofitted
// into an existing unversioned contract — any future breaking change bumps
// this number instead.

import { TIER2_DISCLAIMER } from "./disclaimer.js";
import type { DeskPost } from "./client.js";

export interface DeskHandoffUpdate {
  id: string;
  headline: string;
  markdown_body: string;
  occurred_at: string;
  published_at: string;
}

export interface DeskHandoffV1 {
  schema_version: 1;
  desk_post_id: string;
  slug: string;
  title: string;
  markdown_body: string;
  athlete_name: string | null;
  sport: string | null;
  entity_id: string;
  status: "PUBLISHED" | "RETRACTED";
  published_at: string | null;
  disclaimer: string;
  source_attribution: unknown;
  updates: DeskHandoffUpdate[];
}

export interface DeskHandoffUpdateSource {
  id: string;
  headline: string;
  markdown_body: string;
  occurred_at: string;
  created_at: string;
}

export function assembleDeskHandoff(
  post: DeskPost,
  athleteName: string | null,
  sport: string | null,
  updates: DeskHandoffUpdateSource[],
): DeskHandoffV1 {
  return {
    schema_version: 1,
    desk_post_id: post.id,
    slug: post.slug,
    title: post.title,
    markdown_body: post.markdown_body,
    athlete_name: athleteName,
    sport,
    entity_id: post.entity_id,
    status: post.status === "RETRACTED" ? "RETRACTED" : "PUBLISHED",
    published_at: post.published_at,
    disclaimer: TIER2_DISCLAIMER,
    source_attribution: post.source_attribution,
    updates: updates
      .slice()
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map((u) => ({
        id: u.id,
        headline: u.headline,
        markdown_body: u.markdown_body,
        occurred_at: u.occurred_at,
        published_at: u.created_at,
      })),
  };
}
