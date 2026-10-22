// Pure rules for correcting a PUBLISHED desk post's sections and prose meta
// (desk_correct_published / correctDeskPostContent in client.ts). Kept apart
// from client.ts so the size cap and the lint comparison are testable without a
// database.
//
// A correction is a SMALL fix under a fresh attestation, never a rewrite: every
// changed field is measured by character edit distance and the whole correction
// is refused above the cap. Anything larger is a retraction and a new post.

import type { LintFinding } from "./linter.js";
import {
  SECTION_KEYS,
  normalizeMeta,
  normalizeSections,
  type DeskMeta,
  type DeskSections,
} from "./desk-sections.js";

// Per changed field, and summed over the whole correction. A typo, a misstated
// number or a wrong word passes; a rewritten paragraph does not.
export const MAX_FIELD_EDIT_DISTANCE = 150;
export const MAX_TOTAL_EDIT_DISTANCE = 300;

// The meta keys a correction may touch: reader-facing prose only. Structural
// keys (player, related_slugs, relevant_tool, conflict_flag, anatomy_diagram)
// change what the page links to or claims, not how a sentence reads. The title
// has its own tool, desk_correct_title.
export const CORRECTABLE_META_KEYS = [
  "short_title",
  "meta_description",
  "treatment_heading",
  "anatomy_diagram_alt",
  "faqs",
] as const;

export type CorrectableMetaKey = (typeof CORRECTABLE_META_KEYS)[number];
export type CorrectableMeta = Pick<DeskMeta, CorrectableMetaKey>;

// The codes the Haiku framing classifier can emit (linter-classifier.ts). It is
// nondeterministic, so one of these on the corrected post refuses the
// correction only when the SAME code was absent from the published post linted
// in the same call. Every other blocker is deterministic and always refuses.
export const CLASSIFIER_BLOCKER_CODES: ReadonlySet<string> = new Set([
  "diagnosis_as_fact",
  "non_public_scan_detail",
]);

export interface FieldChange {
  from: string;
  to: string;
  distance: number;
}

// Keyed by field path: "sections.treatment", "meta.meta_description",
// "meta.faqs[0].a". This is the readable diff the audit row and the
// desk_post_versions row carry.
export type CorrectionDiff = Record<string, FieldChange>;

export interface MergedCorrection {
  sections: DeskSections;
  meta: DeskMeta;
  diff: CorrectionDiff;
  total_distance: number;
}

// Levenshtein distance after trimming the common prefix and suffix, so a typo in
// a long section costs only the differing middle.
export function editDistance(a: string, b: string): number {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const s = a.slice(start, endA);
  const t = b.slice(start, endB);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prev = new Uint32Array(t.length + 1);
  let curr = new Uint32Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

function record(diff: CorrectionDiff, path: string, from: string | undefined, to: string | undefined): void {
  const f = from ?? "";
  const t = to ?? "";
  if (f === t) return;
  diff[path] = { from: f, to: t, distance: editDistance(f, t) };
}

// Merge a partial correction onto the stored post and diff it. Throws a plain
// Error with a reader-facing message when the shape is not a correction (an FAQ
// added or removed); the caller wraps it in McpToolError.
export function mergeCorrection(
  storedSections: unknown,
  storedMeta: unknown,
  sectionEdits: Partial<DeskSections> | undefined,
  metaEdits: CorrectableMeta | undefined,
): MergedCorrection {
  const prevSections = normalizeSections(storedSections);
  const prevMeta = normalizeMeta(storedMeta);
  const sections = normalizeSections({ ...prevSections, ...(sectionEdits ?? {}) });
  const meta: DeskMeta = { ...prevMeta };
  const diff: CorrectionDiff = {};

  for (const key of SECTION_KEYS) {
    record(diff, `sections.${key}`, prevSections[key], sections[key]);
  }

  for (const key of CORRECTABLE_META_KEYS) {
    if (!metaEdits || metaEdits[key] === undefined) continue;
    if (key === "faqs") {
      const before = prevMeta.faqs ?? [];
      const after = metaEdits.faqs ?? [];
      if (after.length !== before.length) {
        throw new Error(
          `A correction keeps the same number of FAQs (${before.length}); adding or removing one is not a correction.`,
        );
      }
      after.forEach((faq, i) => {
        record(diff, `meta.faqs[${i}].q`, before[i].q, faq.q);
        record(diff, `meta.faqs[${i}].a`, before[i].a, faq.a);
      });
      meta.faqs = after.map((f) => ({ q: f.q, a: f.a }));
    } else {
      record(diff, `meta.${key}`, prevMeta[key], metaEdits[key]);
      meta[key] = metaEdits[key];
    }
  }

  const total = Object.values(diff).reduce((n, c) => n + c.distance, 0);
  return { sections, meta, diff, total_distance: total };
}

// Human-readable refusals for an over-cap correction; empty when within cap.
export function sizeCapViolations(diff: CorrectionDiff, total: number): string[] {
  const out: string[] = [];
  for (const [path, change] of Object.entries(diff)) {
    if (change.distance > MAX_FIELD_EDIT_DISTANCE) {
      out.push(`${path} changes ${change.distance} characters (max ${MAX_FIELD_EDIT_DISTANCE})`);
    }
  }
  if (total > MAX_TOTAL_EDIT_DISTANCE) {
    out.push(`the correction changes ${total} characters in total (max ${MAX_TOTAL_EDIT_DISTANCE})`);
  }
  return out;
}

// The blockers that refuse a correction: every deterministic blocker on the
// corrected post, plus any classifier blocker whose code the published post did
// not already carry in the same call.
export function refusingBlockers(before: LintFinding[], after: LintFinding[]): LintFinding[] {
  const priorCodes = new Set(before.map((f) => f.code));
  return after.filter((f) => !CLASSIFIER_BLOCKER_CODES.has(f.code) || !priorCodes.has(f.code));
}
