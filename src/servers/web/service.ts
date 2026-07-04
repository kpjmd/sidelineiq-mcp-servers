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
import { toIsoDate, daysBetween, addWeeks } from "./date-utils.js";
import type { LintFinding } from "./linter.js";
import type {
  AccuracyRecord,
  AttestInput,
  DeskAttestation,
  DeskPost,
  OtmProjection,
  PublishGate,
  User,
} from "./client.js";

// ── Publish gate ───────────────────────────────────────────────────────
// The pure core of publishDeskPost: given the post, the DB-derived reviewer,
// the pointed-at attestation, and the linter's blockers, decide passed + why.
// Re-derives the current content hash from the body so an edit after attestation
// is always caught. Never trusts a caller-supplied role.
export function evaluatePublishGate(
  post: Pick<DeskPost, "markdown_body">,
  user: User | null,
  attestation: DeskAttestation | null,
  blockers: LintFinding[],
): PublishGate {
  const role_ok = !!user && user.role === "md";
  const currentHash = hashPayload(post.markdown_body);
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

// Compute the frozen accuracy_record from the entity's otm_projection vs the
// resolved actual return. Returns null when there is no projection to score
// against. Pure: all inputs may be Date objects or strings (see toIsoDate).
export function computeAccuracyRecord(
  entity: Pick<import("./client.js").InjuryEntity, "otm_projection" | "injury_date">,
  actualIso: string | null,
): AccuracyRecord | null {
  const proj: OtmProjection | null = entity.otm_projection;
  if (!proj) return null;

  const projected = proj.projected_return_date ? toIsoDate(proj.projected_return_date) : null;
  const errorDays = actualIso && projected ? daysBetween(projected, actualIso) : null;

  let withinRange: boolean | null = null;
  if (actualIso && entity.injury_date != null) {
    const minReturn = addWeeks(entity.injury_date, proj.min_weeks);
    const maxReturn = addWeeks(entity.injury_date, proj.max_weeks);
    withinRange = actualIso >= minReturn && actualIso <= maxReturn;
  }

  return {
    projected_return_date: projected,
    actual_return_date: actualIso,
    error_days: errorDays,
    within_range: withinRange,
    otm_min_weeks: proj.min_weeks ?? null,
    otm_max_weeks: proj.max_weeks ?? null,
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
