// ── Pure business logic extracted from client.ts for unit testability ───
//
// These functions hold the decision logic that is most worth testing in
// isolation — the publish gate (medico-legal backbone), the injury-thread
// accuracy math (where the 15bb517 Date bug lived), attest preconditions, and
// slug generation. They take plain values and return plain values / throw
// McpToolError; no DB, no network. The DB access methods in client.ts call
// these after fetching rows.

import { McpToolError } from "../../shared/errors.js";
import { hashPayload } from "../../shared/hash.js";
import { deskContentHash } from "./desk-sections.js";
import { toIsoDate, daysBetween, addWeeks } from "./date-utils.js";
import type { LintFinding } from "./linter.js";
import type {
  AccuracyRecord,
  AttestInput,
  CtaClickRow,
  CtaClickSummary,
  CtaLink,
  DeskAttestation,
  DeskPost,
  PublishGate,
  UnscoreableReason,
  User,
} from "./client.js";

// ── Publish gate ───────────────────────────────────────────────────────
// The pure core of publishDeskPost: given the post, the DB-derived reviewer,
// the pointed-at attestation, and the linter's blockers, decide passed + why.
// Re-derives the current content hash so an edit after attestation is always
// caught. Never trusts a caller-supplied role.
export function evaluatePublishGate(
  post: Pick<DeskPost, "title" | "markdown_body" | "sections" | "meta">,
  user: User | null,
  attestation: DeskAttestation | null,
  blockers: LintFinding[],
): PublishGate {
  const role_ok = !!user && user.role === "md";
  // Covers title + sections + meta, not the prose alone — an MD who attests and
  // then edits faqs or conflict_flag must fail this check, or unattested content
  // reaches kpjmd.com. attestDeskPost snapshots via the identical function.
  const currentHash = deskContentHash(post.title, post.sections, post.meta, post.markdown_body);
  const hash_match = !!attestation && attestation.content_hash === currentHash;

  const reasons: string[] = [];
  if (!role_ok) reasons.push("reviewer is not an MD");
  if (!attestation) reasons.push("no attestation found");
  else if (!hash_match) reasons.push("post edited after attestation (content hash mismatch)");
  for (const b of blockers) reasons.push(`${b.code}: ${b.message}`);

  const passed = role_ok && hash_match && blockers.length === 0;
  return { role_ok, hash_match, blockers, passed, reasons };
}

// ── Injury-thread accuracy math ────────────────────────────────────────
// Resolve the actual return date to a plain 'YYYY-MM-DD' string. input wins
// (a tool-supplied string); otherwise fall back to the entity's stored value
// (which comes off the driver as a Date). null when neither is present.
export function resolveActualIso(
  entity: Pick<import("./client.js").InjuryEntity, "actual_return_date">,
  inputActual?: string,
): string | null {
  if (inputActual) return toIsoDate(inputActual);
  if (entity.actual_return_date != null) return toIsoDate(entity.actual_return_date);
  return null;
}

// ── Which window is scored (pre-registration Amendment 1, A1.1/A1.2) ────
// The thread's stored otm_projection is NOT the scored window. Every later
// post rewrote it, of any status — Robinson's came from a post a physician
// later rejected, and Pierce's 10-16w was replaced five months on by 0-6w —
// so it is a display value only. The scored window is the earliest-created
// PUBLISHED post on the thread that carries an estimate, read at close.

/** One PUBLISHED post linked to a thread, as the scorer sees it. */
export interface PublishedWindowRow {
  id: string;
  return_to_play_min_weeks: number | string | null;
  return_to_play_max_weeks: number | string | null;
  // DECIMAL(4,3) arrives from the driver as a string ("0.880").
  rtp_confidence: number | string | null;
  created_at: string | Date;
}

export interface ScoredWindow {
  post_id: string;
  min_weeks: number;
  max_weeks: number;
}

const asNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Does this post state an RTP estimate at all? SKILL.md forbids one for
 * CONCUSSION and SYSTEMIC events, and those posts still publish — carrying
 * 0/0 weeks and rtp_confidence 0 by instruction. That is "we decline to
 * estimate", not "back in zero weeks", and scoring it grades a claim nobody
 * made. A zero FLOOR with a real ceiling (0-2w, "may not miss a game") is an
 * estimate and is kept.
 */
export function carriesEstimate(row: PublishedWindowRow): boolean {
  const conf = asNumber(row.rtp_confidence);
  const min = asNumber(row.return_to_play_min_weeks);
  const max = asNumber(row.return_to_play_max_weeks);
  return conf !== null && conf > 0 && min !== null && max !== null && min >= 0 && max >= 1 && max >= min;
}

/**
 * The first estimate that reached an audience. Rows need not be pre-sorted
 * or pre-filtered by status — the caller's SQL should do both, but a forecast
 * scored against the wrong post is the failure this exists to prevent, so the
 * order is re-imposed here rather than trusted.
 */
export function pickScoredWindow(
  rows: Array<PublishedWindowRow & { status?: string }>,
): ScoredWindow | null {
  const eligible = rows
    .filter((r) => (r.status === undefined || r.status === "PUBLISHED") && carriesEstimate(r))
    .sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return ta !== tb ? ta - tb : String(a.id).localeCompare(String(b.id));
    });
  const first = eligible[0];
  if (!first) return null;
  return {
    post_id: first.id,
    min_weeks: asNumber(first.return_to_play_min_weeks)!,
    max_weeks: asNumber(first.return_to_play_max_weeks)!,
  };
}

// Compute the frozen accuracy_record for a close. Pure: dates may be Date
// objects or strings (see toIsoDate).
//
// It ALWAYS returns a record, where it once returned null for a thread with no
// window. A null accuracy_record and a record that says `scoreable: false,
// unscoreable_reason: 'no_projection'` describe the same thread, but only the
// second one is legible to a reader counting an accuracy number. Callers that
// must write nothing at all — VOID — decide that themselves; see closeThread.
//
// `scoreable` is "within_range could be computed AND means something".
// error_days may be null on a scoreable record: the secondary median-signed-
// error metric carries its own n for exactly that reason.
//
// `censored` (Amendment 1, A1.3): the return was the returning team's first
// regular-season game after injury_date, so it proves only that recovery
// happened ON OR BEFORE that date. A censored return before the window's floor
// is still a provable miss and is scored; one on or after the floor says
// nothing and is `calendar_censored`. `undefined` means the closer could not
// say (an MD's hand close) and is recorded as null — not as "not censored".
export function computeAccuracyRecord(
  entity: Pick<import("./client.js").InjuryEntity, "injury_date">,
  actualIso: string | null,
  opts: { window: ScoredWindow | null; censored?: boolean },
): AccuracyRecord {
  const win = opts.window;
  const censored = opts.censored ?? null;
  if (!win) {
    return {
      projected_return_date: null,
      actual_return_date: actualIso,
      error_days: null,
      within_range: null,
      otm_min_weeks: null,
      otm_max_weeks: null,
      scored_post_id: null,
      censored,
      scoreable: false,
      unscoreable_reason: "no_projection",
    };
  }

  const injury = entity.injury_date != null ? toIsoDate(entity.injury_date) : null;
  // Computed from the scored window, never read from otm_projection: the
  // stored projected_return_date belongs to whichever post wrote last.
  const projected = injury ? addWeeks(injury, (win.min_weeks + win.max_weeks) / 2) : null;
  let errorDays = actualIso && projected ? daysBetween(projected, actualIso) : null;

  let withinRange: boolean | null = null;
  let censoredOut = false;
  if (actualIso && injury) {
    const minReturn = addWeeks(injury, win.min_weeks);
    const maxReturn = addWeeks(injury, win.max_weeks);
    withinRange = actualIso >= minReturn && actualIso <= maxReturn;
    if (censored === true && actualIso >= minReturn) {
      censoredOut = true;
      withinRange = null;
      errorDays = null;
    }
  }

  // Precedence matters only for the label, not the verdict: a record missing
  // an input is reported by the one a human would fix first.
  const unscoreableReason: UnscoreableReason | null = censoredOut
    ? "calendar_censored"
    : withinRange !== null
      ? null
      : actualIso == null
        ? "no_actual_return_date"
        : "no_injury_date";

  return {
    projected_return_date: projected,
    actual_return_date: actualIso,
    error_days: errorDays,
    within_range: withinRange,
    otm_min_weeks: win.min_weeks,
    otm_max_weeks: win.max_weeks,
    scored_post_id: win.post_id,
    censored,
    scoreable: unscoreableReason === null,
    ...(unscoreableReason ? { unscoreable_reason: unscoreableReason } : {}),
  };
}

// ── Attest preconditions ───────────────────────────────────────────────
// Throws McpToolError unless the reviewer is a DB-derived MD, all three review
// confirmations are true, and the post is in an attestable status. Pure guard;
// the caller has already fetched the user and post.
export function assertCanAttest(
  user: User | null,
  input: Pick<
    AttestInput,
    "reviewer_user_id" | "reviewed_source_reports" | "edited_for_accuracy" | "framing_confirmed"
  >,
  post: Pick<DeskPost, "id" | "status">,
): void {
  if (!user) {
    throw new McpToolError(
      `Reviewer ${input.reviewer_user_id} not found`,
      "reviewer_user_id must be a known users.id (a UUID = session.user.id).",
    );
  }
  if (user.role !== "md") {
    throw new McpToolError(
      `Reviewer ${input.reviewer_user_id} has role '${user.role}', not 'md'`,
      "Only an MD identity can attest a desk post.",
    );
  }
  if (!input.reviewed_source_reports || !input.edited_for_accuracy || !input.framing_confirmed) {
    throw new McpToolError(
      "Cannot attest without confirming all three review steps",
      "reviewed_source_reports, edited_for_accuracy, and framing_confirmed must all be true.",
    );
  }
  if (post.status !== "DRAFT" && post.status !== "READY") {
    throw new McpToolError(
      `Desk post ${post.id} is ${post.status} and cannot be attested`,
      "Only DRAFT or READY posts can be attested.",
    );
  }
}

// ── Slugs ──────────────────────────────────────────────────────────────
// Lowercase, strip non-alphanumerics, collapse whitespace/dashes, trim, cap
// length. Shared by injury-post and desk-post slug generation.
export function slugify(raw: string, maxLen = 200, fallback = ""): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
  return slug || fallback;
}

// ── CTA click summary ──────────────────────────────────────────────────
// Totals for the admin Metrics tab. Pure, so the arithmetic is testable
// without a database. `by_link` always carries both keys: a link with no rows
// is a genuine zero here — the row set is complete for the window, unlike a
// failed follower read, which writes no row at all.
export function summarizeCtaClicks(rows: CtaClickRow[]): CtaClickSummary {
  const byLink: Record<CtaLink, number> = { cta: 0, byline: 0 };
  const byPost = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const clicks = Number(row.clicks);
    total += clicks;
    byLink[row.link] += clicks;
    byPost.set(row.post_slug, (byPost.get(row.post_slug) ?? 0) + clicks);
  }
  return {
    rows,
    total,
    by_link: byLink,
    by_post: [...byPost.entries()]
      .map(([post_slug, clicks]) => ({ post_slug, clicks }))
      .sort((a, b) => b.clicks - a.clicks || a.post_slug.localeCompare(b.post_slug)),
  };
}
