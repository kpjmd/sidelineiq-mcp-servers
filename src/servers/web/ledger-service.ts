// ── Prognosis Ledger: pure decision logic ──────────────────────────────
//
// The publish gate for a forecast row and the small pure helpers around it.
// No DB, no network: ledger-client.ts fetches rows and calls these. The gate's
// shape follows evaluatePublishGate (service.ts): a blocked publish is a
// SUCCESSFUL result with passed:false and reasons the UI can render, never a
// thrown error, because the physician needs to see WHY before fixing the draft.
//
// What the gate protects (agents spec "Implementation handoff → Automation
// boundary"): the five forecast numbers, the mechanism line and a revision's
// trigger are never published without the physician's confirmation, and a
// revision can never move a field that has already resolved.

import type { User } from "./client.js";
import { ledgerRowHash, type HashableForecastRow } from "./ledger-hash.js";

export type LedgerForecastStatus = "draft" | "published";
export type LedgerFieldName = "F1" | "F2" | "F3" | "F4" | "F5";
export const LEDGER_FIELDS: readonly LedgerFieldName[] = ["F1", "F2", "F3", "F4", "F5"];
export type LedgerResolutionStatus = "open" | "resolved" | "void";
export type SourceTier = "A" | "B" | "C";
export type BaseRateStrength = "strong" | "moderate" | "thin";

/** A ledger_forecasts row as the driver returns it (NUMERIC as strings, DATE/TIMESTAMPTZ as Date). */
export interface LedgerForecast {
  id: string;
  status: LedgerForecastStatus;
  entry_id: string | null;
  version: number;
  published_at: string | Date | null;
  trigger: string | null;
  player: string;
  team: string;
  position: string;
  injury_date: string | Date;
  reported_injury: string;
  source_tier: SourceTier;
  source_urls: string[];
  mechanism: string;
  base_rate_row: string;
  base_rate_strength: BaseRateStrength;
  f1_ir: string | number;
  f2_next: string | number;
  f3_4wk: string | number;
  f4_point: number;
  f4_low: number;
  f4_high: number;
  f5_reinjury: string | number | null;
  season_ending: boolean;
  what_moves_this: string;
  tier: number;
  row_hash: string | null;
  confirmed_by: string | null;
  confirmed_at: string | Date | null;
  commit_sha: string | null;
  commit_url: string | null;
  x_post_id: string | null;
  x_self_reply_id: string | null;
  farcaster_hash: string | null;
  reply_to_url: string | null;
  espn_athlete_id: string | null;
  gsis_id: string | null;
  pfr_id: string | null;
  nflverse_team: string | null;
  season: number | null;
  player_id: string | null;
  entity_id: string | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface LedgerResolution {
  id: string;
  entry_id: string;
  field: LedgerFieldName;
  status: LedgerResolutionStatus;
  outcome: string | number | null;
  outcome_date: string | Date | null;
  resolved_at: string | Date | null;
  freeze_at: string | Date | null;
  void_reason: string | null;
  evidence_url: string | null;
  evidence: Record<string, unknown> | null;
  proposal_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | Date | null;
  created_at: string | Date;
}

export interface LedgerProposal {
  id: string;
  entry_id: string;
  field: LedgerFieldName;
  proposed_status: "resolved" | "void";
  proposed_outcome: string | number | null;
  outcome_date: string | Date | null;
  freeze_at: string | Date | null;
  void_reason: string | null;
  evidence_url: string | null;
  evidence: Record<string, unknown> | null;
  proposer: string;
  proposed_at: string | Date;
  decision: "pending" | "confirmed" | "rejected";
  decided_by: string | null;
  decided_at: string | Date | null;
  note: string | null;
}

export interface LedgerCorrection {
  id: string;
  entry_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  note: string;
  corrected_by: string;
  corrected_at: string | Date;
}

export interface LedgerBaseRate {
  row_key: string;
  injury_type: string;
  strength: BaseRateStrength;
  source_rank: number | null;
  sources: string | null;
  n: number | null;
  year_range: string | null;
  f1_ir: string | number | null;
  f2_next: string | number | null;
  f3_4wk: string | number | null;
  f5_reinjury: string | number | null;
  f4_point: number | null;
  f4_low: number | null;
  f4_high: number | null;
  notes: string | null;
  updated_by: string | null;
  updated_at: string | Date;
}

export interface ReplyProposal {
  id: string;
  platform: "x" | "farcaster";
  mention_id: string;
  mention_url: string | null;
  mention_author: string | null;
  mention_text: string | null;
  proposed_text: string;
  proposed_at: string | Date;
  /** 027: 'approved' is the physician's recorded confirmation; only the system moves approved → posted. */
  decision: "pending" | "approved" | "posted" | "discarded";
  decided_by: string | null;
  decided_at: string | Date | null;
  /** The MD's final wording at approval, when edited; the publisher posts approved_text ?? proposed_text. */
  approved_text: string | null;
  /** Set once by the publisher's claim while it posts; cleared by 'failed'. The double-post lock. */
  post_attempted_at: string | Date | null;
  post_error: string | null;
  posted_text: string | null;
  posted_id: string | null;
  note: string | null;
}

export interface LedgerPublishGate {
  role_ok: boolean;
  passed: boolean;
  reasons: string[];
}

// ── Entry ids ──────────────────────────────────────────────────────────

/** PT-YYYY-NNN, zero-padded to three digits and growing past 999 without truncation. */
export function formatEntryId(year: number, n: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new Error(`bad entry year ${year}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad entry number ${n}`);
  return `PT-${year}-${String(n).padStart(3, "0")}`;
}

export const ENTRY_ID_RE = /^PT-\d{4}-\d{3,}$/;

// ── Publish gate ───────────────────────────────────────────────────────

const toNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

function blank(v: unknown): boolean {
  return typeof v !== "string" || v.trim().length === 0;
}

/**
 * Decide whether a draft may be published by `user`. Pure.
 *
 * - role is re-derived from the users table by the caller and must be 'md';
 * - the row must still be a draft;
 * - every spec field is present; a revision (version > 1) names its trigger;
 * - probabilities in [0, 1]; F4 low ≤ point ≤ high; F5 may be null only for a
 *   concussion base-rate row (spec: F5 void by rule);
 * - a revision may not change a field that has already resolved or been voided
 *   (spec "Revision chain": copied forward unchanged and locked) — `previous`
 *   is the latest PUBLISHED version and `locked` the entry's non-open fields.
 */
export function evaluateLedgerPublishGate(
  draft: LedgerForecast,
  user: User | null,
  previous: LedgerForecast | null,
  locked: LedgerResolution[],
): LedgerPublishGate {
  const reasons: string[] = [];
  const role_ok = !!user && user.role === "md";
  if (!role_ok) reasons.push("reviewer is not an MD");

  if (draft.status !== "draft") reasons.push(`row is ${draft.status}, not a draft`);

  for (const f of ["player", "team", "position", "reported_injury", "mechanism", "what_moves_this", "base_rate_row"] as const) {
    if (blank(draft[f])) reasons.push(`${f} is required`);
  }
  if (!["A", "B", "C"].includes(draft.source_tier)) reasons.push("source_tier must be A, B or C");
  if (!["strong", "moderate", "thin"].includes(draft.base_rate_strength)) reasons.push("base_rate_strength must be strong, moderate or thin");
  if (!Array.isArray(draft.source_urls) || draft.source_urls.length === 0) reasons.push("at least one source URL is required");
  if (draft.tier !== 1 && draft.tier !== 2) reasons.push("tier must be 1 or 2");

  if (draft.version > 1 && blank(draft.trigger)) reasons.push("a revision must name its public trigger");
  if (draft.version > 1 && !previous) reasons.push("a revision needs a published previous version");
  if (draft.version > 1 && previous && draft.entry_id !== previous.entry_id) reasons.push("revision entry_id does not match the previous version");

  for (const f of ["f1_ir", "f2_next", "f3_4wk"] as const) {
    const n = toNum(draft[f]);
    if (n === null || n < 0 || n > 1) reasons.push(`${f} must be a probability in [0, 1]`);
  }
  const f5 = toNum(draft.f5_reinjury);
  if (f5 === null) {
    if (draft.base_rate_row !== "concussion") reasons.push("f5_reinjury is required unless the base-rate row is concussion");
  } else if (f5 < 0 || f5 > 1) {
    reasons.push("f5_reinjury must be a probability in [0, 1]");
  }
  if (!(Number.isInteger(draft.f4_low) && Number.isInteger(draft.f4_point) && Number.isInteger(draft.f4_high))) {
    reasons.push("f4_point, f4_low and f4_high must be integers");
  } else if (!(draft.f4_low <= draft.f4_point && draft.f4_point <= draft.f4_high)) {
    reasons.push("f4 interval must satisfy low ≤ point ≤ high");
  }

  if (previous && locked.length > 0) {
    for (const r of locked) {
      const changed = fieldChanged(r.field, draft, previous);
      if (changed) reasons.push(`${r.field} is ${r.status} and may not change in a revision`);
    }
  }

  return { role_ok, passed: reasons.length === 0, reasons };
}

function fieldChanged(field: LedgerFieldName, a: LedgerForecast, b: LedgerForecast): boolean {
  switch (field) {
    case "F1":
      return toNum(a.f1_ir) !== toNum(b.f1_ir);
    case "F2":
      return toNum(a.f2_next) !== toNum(b.f2_next);
    case "F3":
      return toNum(a.f3_4wk) !== toNum(b.f3_4wk);
    case "F5":
      return toNum(a.f5_reinjury) !== toNum(b.f5_reinjury);
    case "F4":
      return a.f4_point !== b.f4_point || a.f4_low !== b.f4_low || a.f4_high !== b.f4_high;
  }
}

/** The row_hash of a PUBLISHED row. Throws on a draft (no published_at) or a malformed row. */
export function publishedRowHash(row: LedgerForecast): string {
  if (row.status !== "published" || !row.entry_id || !row.published_at) {
    throw new Error(`ledger: cannot hash an unpublished row (${row.id})`);
  }
  const hashable: HashableForecastRow = {
    entry_id: row.entry_id,
    version: row.version,
    published_at: row.published_at,
    trigger: row.trigger,
    player: row.player,
    team: row.team,
    position: row.position,
    injury_date: row.injury_date,
    reported_injury: row.reported_injury,
    source_tier: row.source_tier,
    source_urls: row.source_urls,
    mechanism: row.mechanism,
    base_rate_row: row.base_rate_row,
    base_rate_strength: row.base_rate_strength,
    f1_ir: row.f1_ir,
    f2_next: row.f2_next,
    f3_4wk: row.f3_4wk,
    f4_point: row.f4_point,
    f4_low: row.f4_low,
    f4_high: row.f4_high,
    f5_reinjury: row.f5_reinjury,
    season_ending: row.season_ending,
    what_moves_this: row.what_moves_this,
    tier: row.tier,
  };
  return ledgerRowHash(hashable);
}

/** The resolution rows a revision must not move: anything not `open`. */
export function lockedFields(resolutions: LedgerResolution[]): LedgerResolution[] {
  return resolutions.filter((r) => r.status !== "open");
}
