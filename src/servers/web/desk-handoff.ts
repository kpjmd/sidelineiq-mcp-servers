// The kpjmd.com JSON handoff contract (Phase 3).
//
// A DeskHandoffV2 IS kpjmd.com's content/injury-desk/published/{slug}.json.
// There is deliberately no transform step on either side: the MD downloads this
// object from /desk and drops the file straight into the kpjmd content dir,
// where build-injury-desk.js renders it. That means the field NAMES here are not
// ours to choose — they are whatever validatePost() and the post template in
// KPJMD-website/scripts/ already read.
//
// V1 → V2, the reason for the bump: V1 carried a single flowing `markdown_body`,
// because that was all desk_posts stored. kpjmd's builder cannot consume a
// flowing body — it requires seven named prose sections and renders each through
// textToHtmlParagraphs(). Migration 016 made SidelineIQ the structured author;
// this contract is the payoff.
//
// Extra keys (`schema_version`, `_sideline`) are safe: kpjmd's validatePost
// checks a required-field list and ignores anything it does not recognize.

import { TIER2_DISCLAIMER } from "./disclaimer.js";
import { SECTION_KEYS, normalizeMeta, normalizeSections } from "./desk-sections.js";
import type { DeskConflictFlag, DeskFaq } from "./desk-sections.js";
import type { DeskPost } from "./client.js";

// A Return Watch follow-up, projected for kpjmd. `markdown_body` is renamed to
// `body` because — like the seven sections — kpjmd escapes it and does not parse
// markdown; keeping the old name would imply a rendering that does not happen.
export interface DeskHandoffUpdate {
  headline: string;
  body: string;
  occurred_at: string;
}

// Provenance kpjmd does not render but the round-trip needs. Underscore-prefixed
// to signal "not content" — matching kpjmd's own `_degraded` sidecar convention.
export interface DeskHandoffProvenance {
  desk_post_id: string;
  entity_id: string;
  // What confirm-live asserts against the x-sideline-content-hash meta tag the
  // builder emits, so a stale deploy cannot be mistaken for a successful one.
  content_hash: string;
  status: "PUBLISHED" | "RETRACTED";
  disclaimer: string;
  source_attribution: unknown;
  retracted_at?: string;
}

export interface DeskHandoffV2 {
  schema_version: 2;

  // Required by kpjmd's validatePost.
  slug: string;
  headline: string;
  league: string;
  injury_type: string;
  published_date: string;
  snapshot: string;
  what_happened: string;
  anatomy: string;
  treatment: string;
  timeline: string;
  bridge: string;
  dr_take: string;

  // Optional, MD-authored in /desk.
  short_title?: string;
  player?: string;
  meta_description?: string;
  modified_date?: string;
  treatment_heading?: string;
  conflict_flag?: DeskConflictFlag & { sideline_slug: string };
  relevant_tool?: string;
  faqs?: DeskFaq[];
  related_slugs?: string[];
  updates?: DeskHandoffUpdate[];

  _sideline: DeskHandoffProvenance;
}

export interface DeskHandoffUpdateSource {
  id: string;
  headline: string;
  markdown_body: string;
  occurred_at: string;
  created_at: string;
}

// kpjmd's published_date / modified_date are plain 'YYYY-MM-DD'.
function toDateOnly(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Drop undefined/empty optionals rather than emitting them as null: kpjmd's
// validatePost treats `null` and `''` as missing for required fields, and an
// explicit empty optional would render an empty element rather than being
// omitted from the page.
function putIf<T>(target: Record<string, unknown>, key: string, value: T | null | undefined): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" && value.trim() === "") return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

export function assembleDeskHandoff(
  post: DeskPost,
  athleteName: string | null,
  sport: string | null,
  updates: DeskHandoffUpdateSource[],
  injuryType: string | null,
): DeskHandoffV2 {
  const sections = normalizeSections(post.sections);
  const meta = normalizeMeta(post.meta);
  const retracted = post.status === "RETRACTED";

  // Newest first — kpjmd renders the Return Watch block reverse-chronologically,
  // the opposite of V1's ascending order.
  const projected = updates
    .slice()
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .map((u) => ({ headline: u.headline, body: u.markdown_body, occurred_at: u.occurred_at }));

  const out: Record<string, unknown> = {
    schema_version: 2,
    slug: post.slug,
    headline: post.title,
    // kpjmd's `league` is the same value SidelineIQ stores as the player's sport
    // ("NBA", "NFL"). Falling back to '' rather than omitting keeps the failure
    // visible as a builder validation error instead of a silently absent field.
    league: sport ?? "",
    injury_type: injuryType ?? "",
    published_date: toDateOnly(post.published_at) ?? toDateOnly(post.created_at) ?? "",
  };

  for (const key of SECTION_KEYS) out[key] = sections[key];

  // player defaults to the athlete joined off the entity; meta.player overrides.
  putIf(out, "player", meta.player ?? athleteName);
  putIf(out, "short_title", meta.short_title);
  putIf(out, "meta_description", meta.meta_description);
  putIf(out, "treatment_heading", meta.treatment_heading);
  putIf(out, "relevant_tool", meta.relevant_tool);
  putIf(out, "faqs", meta.faqs);
  putIf(out, "related_slugs", meta.related_slugs);
  putIf(out, "anatomy_diagram", meta.anatomy_diagram);
  putIf(out, "anatomy_diagram_alt", meta.anatomy_diagram_alt);
  putIf(out, "updates", projected);

  // The newest follow-up is what "Updated <date>" and the JSON-LD dateModified
  // should reflect; without updates there is nothing to modify.
  putIf(out, "modified_date", projected.length > 0 ? toDateOnly(projected[0].occurred_at) : null);

  // sideline_slug is always populated: the builder warns without it, and it is
  // what drives the isBasedOn JSON-LD link back to the SidelineIQ post.
  if (meta.conflict_flag) {
    out.conflict_flag = { ...meta.conflict_flag, sideline_slug: post.slug };
  }

  const provenance: DeskHandoffProvenance = {
    desk_post_id: post.id,
    entity_id: post.entity_id,
    content_hash: post.content_hash,
    status: retracted ? "RETRACTED" : "PUBLISHED",
    disclaimer: TIER2_DISCLAIMER,
    source_attribution: post.source_attribution,
  };
  if (retracted) provenance.retracted_at = post.updated_at;
  out._sideline = provenance;

  return out as unknown as DeskHandoffV2;
}
