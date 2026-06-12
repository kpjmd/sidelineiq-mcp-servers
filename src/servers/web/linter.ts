// Tier 2 content linter — typed seam.
//
// Phase 2C ships the INTERFACE only: a no-op that returns zero findings. The
// real classifier (regex banned-phrase scan + small Haiku pass — diagnosis-as-
// fact, career-prognosis, non-public scan detail, missing disclaimer, missing
// source attribution) is Phase 2D, which fills in the body of lintDeskPost.
//
// The publish gate (desk_publish, in client.ts) already consumes this today:
// it refuses to publish when result.blockers.length > 0. Wiring the seam now
// means 2D is a drop-in body change with no gate/tool churn.

export type LintSeverity = "warning" | "blocker";

export interface LintSpan {
  start: number;
  end: number;
}

// One shared, severity-discriminated finding type so 2D can push into either
// the warnings or blockers array with a single shape. Only blockers gate publish.
export interface LintFinding {
  code: string;
  message: string;
  severity: LintSeverity;
  span?: LintSpan;
}

export interface LintDeskPostInput {
  title: string;
  markdown_body: string;
  draft_json?: unknown;
  source_attribution?: unknown;
  disclaimer_present?: boolean;
}

export interface LintResult {
  warnings: LintFinding[];
  blockers: LintFinding[];
}

// 2C stub: a typed no-op. 2D replaces the body; the signature is the contract.
export function lintDeskPost(_input: LintDeskPostInput): LintResult {
  return { warnings: [], blockers: [] };
}
