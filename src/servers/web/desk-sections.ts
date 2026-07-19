// The seven-section structure of an Injury Desk post — the shape kpjmd.com's
// builder actually consumes.
//
// kpjmd's build-injury-desk.js requires seven named prose fields and renders
// each through textToHtmlParagraphs(): split on blank lines, wrap in <p>,
// HTML-escape. It does NOT parse markdown. That has two consequences enforced
// here and in linter.ts:
//   • sections are PLAIN TEXT — a '**bold**' typed into a textarea reaches the
//     live page as literal asterisks, so the linter blocks markdown syntax.
//   • paragraph breaks are '\n\n' and nothing else.
//
// desk_posts.markdown_body is kept as a DERIVED serialization of these sections
// (see serializeSections) rather than being dropped: it keeps desk_post_versions,
// the audit before/after diffs, and the linter's prose rules working over a
// single string, and it keeps content_hash a single scalar the publish gate can
// compare.

import { hashPayload } from "../../shared/hash.js";
import { TIER2_DISCLAIMER } from "./disclaimer.js";

// Order matters: it mirrors kpjmd's injury-desk-post.html.template so the
// editor, the preview, and the rendered page all read top-to-bottom the same.
export const SECTION_KEYS = [
  "snapshot",
  "what_happened",
  "anatomy",
  "treatment",
  "timeline",
  "bridge",
  "dr_take",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

// Editor labels and the headings used in the derived markdown_body. `treatment`
// is overridable per-post via meta.treatment_heading (kpjmd does the same, e.g.
// "The Repair" on the Tatum post).
export const SECTION_HEADINGS: Record<SectionKey, string> = {
  snapshot: "The Snapshot",
  what_happened: "What Happened",
  anatomy: "The Anatomy",
  treatment: "The Treatment",
  timeline: "The Timeline",
  bridge: "Why It Matters For You",
  dr_take: "Dr. Johnson's Take",
};

export type DeskSections = Record<SectionKey, string>;

export interface DeskConflictFlag {
  team_timeline: string;
  otm_range: string;
  rationale: string;
}

export interface DeskFaq {
  q: string;
  a: string;
}

// kpjmd's optional fields. Authored by the MD so the downloaded JSON needs no
// hand-editing before it is dropped into content/injury-desk/published/.
export interface DeskMeta {
  short_title?: string;
  player?: string;
  meta_description?: string;
  treatment_heading?: string;
  conflict_flag?: DeskConflictFlag;
  relevant_tool?: string;
  faqs?: DeskFaq[];
  related_slugs?: string[];
  anatomy_diagram?: string;
  anatomy_diagram_alt?: string;
}

// Keys of TOOL_DESTINATIONS in KPJMD-website/scripts/build-injury-desk.js. The
// builder only warns on an unknown key (the "If This Were You" CTA silently
// drops), so the linter warns too rather than blocking. Keep in sync by hand —
// the two repos do not share a package.
export const RELEVANT_TOOL_KEYS = [
  "acl",
  "achilles",
  "shoulder",
  "hamstring",
  "meniscus",
  "rotator-cuff",
  "ucl",
  "concussion",
  "ankle",
  "hip",
] as const;

// Read a JSONB column into a fully-populated DeskSections. Missing keys become
// '' rather than undefined so every consumer can treat the seven as present-
// but-possibly-empty; emptiness is the linter's business, not the reader's.
export function normalizeSections(raw: unknown): DeskSections {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const out = {} as DeskSections;
  for (const key of SECTION_KEYS) {
    // Only strings survive. kpjmd's validatePost is a presence check that does
    // not type-check, so an array here would pass validation and then throw in
    // textToHtmlParagraphs ('text.split is not a function'). Coercing to '' at
    // the boundary turns that into a lint blocker instead of a build crash.
    out[key] = typeof src[key] === "string" ? (src[key] as string) : "";
  }
  return out;
}

export function normalizeMeta(raw: unknown): DeskMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as DeskMeta;
}

// True when every required section carries prose. Legacy rows (migration 016
// left sections NULL) are false — they must be re-sectioned before publish.
export function sectionsComplete(sections: DeskSections | null): boolean {
  if (!sections) return false;
  return SECTION_KEYS.every((k) => typeof sections[k] === "string" && sections[k].trim() !== "");
}

// Render the sections into the canonical markdown_body.
//
// The Tier 2 disclaimer is APPENDED here rather than typed into a section. It
// has to be in markdown_body for linter.ts/checkDisclaimer (the medico-legal
// invariant), but it must NOT be inside a section: kpjmd's post template renders
// "The Fine Print" verbatim from TIER2_DISCLAIMER itself, so a copy in the JSON
// would print twice on the live page.
export function serializeSections(sections: DeskSections, meta: DeskMeta = {}): string {
  const parts = SECTION_KEYS.map((key) => {
    const heading =
      key === "treatment" && meta.treatment_heading?.trim()
        ? meta.treatment_heading.trim()
        : SECTION_HEADINGS[key];
    return `## ${heading}\n\n${sections[key] ?? ""}`.trimEnd();
  });
  return `${parts.join("\n\n")}\n\n---\n\n${TIER2_DISCLAIMER}\n`;
}

// The single content-hash definition for a desk post.
//
// This MUST cover meta, not just the prose. The publish gate compares the latest
// attestation's hash to the post's current hash; if meta sat outside the hash an
// MD could attest, then edit faqs or conflict_flag, then publish content that was
// never attested — silently defeating the gate.
//
// Legacy fallback: rows predating migration 016 have no sections, and their
// stored attestations hash the raw body. Hashing the body for those rows keeps
// their existing attestations valid instead of retroactively invalidating them.
export function deskContentHash(
  title: string,
  sections: DeskSections | null,
  meta: DeskMeta | null,
  markdownBody: string,
): string {
  if (!sections) return hashPayload(markdownBody);
  return hashPayload({ title, sections, meta: meta ?? {} });
}
