// Tier 2 content linter.
//
// Hybrid: deterministic regex rules (the always-on floor) + a small async Haiku
// framing classifier (linter-classifier.ts) for the nuanced cases regex can't
// judge. Returns {warnings, blockers}; the publish gate (desk_publish in
// client.ts) refuses to publish when blockers.length > 0.
//
// Rules:
//   1. diagnosis_as_fact          (blocker) — regex first pass + classifier nuance
//   2. career_prognosis           (blocker) — regex
//   3. non_public_scan_detail     (classifier blocker) / scan_detail_review (regex warning)
//   4. missing_disclaimer         (blocker) — body must carry the canonical Tier 2 footer
//   5. missing_source_attribution (blocker) — factual body needs a link/<cite> or structured sources
//
// Fail-open: the regex rules ALWAYS apply. If the classifier errors or no
// ANTHROPIC_API_KEY is set, no classifier blocker is added and a visible
// `classifier_unavailable` warning is emitted — an Anthropic outage must not
// freeze physician publishes, and MD attestation remains a required gate step.

import { DISCLAIMER_FINGERPRINT } from "./disclaimer.js";
import { classifierConfigured, classifyDeskPost } from "./linter-classifier.js";

export type LintSeverity = "warning" | "blocker";

export interface LintSpan {
  start: number;
  end: number;
}

// One shared, severity-discriminated finding type so rules can push into either
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

// ── Pure regex rules (sync, individually unit-testable, no network) ────────

const DEFINITIVE_VERB = "has|have|had|suffered|sustained|tore|torn|ruptured|fractured|dislocated|severed";
const NAMED_STRUCTURE =
  "ACL|MCL|PCL|LCL|UCL|anterior cruciate ligament|ulnar collateral ligament|labrum|labral tear|" +
  "meniscus|meniscal tear|Achilles(?: tendon)?|rotator cuff|patellar tendon|quadriceps tendon|" +
  "hamstring tear|Tommy John|Lisfranc|high ankle sprain";
const HEDGE =
  "reportedly|reported|per |according to|sources say|is said to|believed to|appears|likely|" +
  "team announced|allegedly|expected to|per report|is dealing with";

const careerRe =
  /\bcareer[-\s]?ending\b|\bnever (?:play|compete|fight|return)s? again\b|\bdone for good\b|\bend(?:ed|s|ing)? (?:his|her|their) career\b|\bout for (?:the rest of )?(?:his|her|their) career\b/i;
const structureRe = new RegExp(`\\b(?:${NAMED_STRUCTURE})\\b`, "i");
const verbRe = new RegExp(`\\b(?:${DEFINITIVE_VERB})\\b`, "i");
const hedgeRe = new RegExp(`\\b(?:${HEDGE})`, "i");
const markdownLinkRe = /\[[^\]]+\]\([^)]+\)/;
const citeRe = /<cite[\s>]/i;
const scanReadingRe =
  /\bMRI\b|\bCT scan\b|(?:imaging|scan|ultrasound)\s+(?:revealed|showed|confirmed|indicated)/i;

// Career-prognosis claims about a named individual.
export function checkCareerPrognosis(body: string): LintFinding[] {
  const m = careerRe.exec(body);
  if (!m) return [];
  return [
    {
      code: "career_prognosis",
      severity: "blocker",
      message:
        "Career-prognosis language ('career-ending', 'never play again', etc.). Tier 2 commentary may not predict an individual's career outcome.",
      span: { start: m.index, end: m.index + m[0].length },
    },
  ];
}

// Diagnosis stated as fact about the individual: a definitive verb co-occurring
// with a named structure in the same sentence, without a hedging marker. This is
// the deterministic floor; the classifier extends it to paraphrased cases.
export function checkDiagnosisAsFact(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  // Walk sentences so the verb, structure, and hedge are judged in local scope.
  const sentenceRe = /[^.!?\n]+(?:[.!?\n]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(body)) !== null) {
    const sentence = m[0];
    if (!verbRe.test(sentence)) continue;
    const sm = structureRe.exec(sentence);
    if (!sm) continue;
    if (hedgeRe.test(sentence)) continue;
    const start = m.index + sm.index;
    findings.push({
      code: "diagnosis_as_fact",
      severity: "blocker",
      message:
        "Reads as a definitive diagnosis of the individual. Attribute it to public reporting (e.g. 'reportedly', 'according to <source>') or reframe as general educational analysis.",
      span: { start, end: start + sm[0].length },
    });
  }
  return findings;
}

// The body must carry the canonical Tier 2 disclaimer. Body-authoritative: the
// caller-supplied `disclaimer_present` boolean is only a UI hint and a mis-set
// flag must not let an undisclaimered post through the gate.
export function checkDisclaimer(input: LintDeskPostInput): LintFinding[] {
  const normalized = (input.markdown_body ?? "").toLowerCase().replace(/\s+/g, " ");
  if (normalized.includes(DISCLAIMER_FINGERPRINT.toLowerCase())) return [];
  return [
    {
      code: "missing_disclaimer",
      severity: "blocker",
      message:
        "The canonical Tier 2 disclaimer is missing from the body. Append the physician-educational disclaimer footer before publishing.",
    },
  ];
}

function structuredSourcesPresent(source: unknown): boolean {
  if (source == null) return false;
  if (Array.isArray(source)) return source.length > 0;
  if (typeof source === "string") return source.trim().length > 0;
  if (typeof source === "object") return Object.keys(source as object).length > 0;
  return false;
}

// Factual commentary must attribute its claims: a markdown link or <cite> in the
// body, or a non-empty structured source_attribution field.
export function checkSourceAttribution(input: LintDeskPostInput): LintFinding[] {
  const body = input.markdown_body ?? "";
  if (markdownLinkRe.test(body) || citeRe.test(body)) return [];
  if (structuredSourcesPresent(input.source_attribution)) return [];
  return [
    {
      code: "missing_source_attribution",
      severity: "blocker",
      message:
        "No source attribution found. Cite the public reporting via a markdown link, a <cite> tag, or the source_attribution field.",
    },
  ];
}

// Cheap heads-up that imaging-reading language is present; the classifier decides
// whether it rises to a non_public_scan_detail blocker.
export function checkNonPublicDetailRegex(body: string): LintFinding[] {
  const m = scanReadingRe.exec(body);
  if (!m) return [];
  return [
    {
      code: "scan_detail_review",
      severity: "warning",
      message:
        "Body references imaging/scan findings. Confirm every such detail is attributable to public reporting, not asserted as private medical knowledge.",
      span: { start: m.index, end: m.index + m[0].length },
    },
  ];
}

function spansOverlap(a?: LintSpan, b?: LintSpan): boolean {
  // A missing span on either side is treated as overlapping, so a span-less
  // classifier finding dedupes against a same-code regex finding rather than
  // double-reporting the same conceptual issue.
  if (!a || !b) return true;
  return a.start < b.end && b.start < a.end;
}

function isDuplicate(finding: LintFinding, existing: LintFinding[]): boolean {
  return existing.some((e) => e.code === finding.code && spansOverlap(e.span, finding.span));
}

// ── Composed entry point ───────────────────────────────────────────────────

export async function lintDeskPost(input: LintDeskPostInput): Promise<LintResult> {
  const warnings: LintFinding[] = [];
  const blockers: LintFinding[] = [];
  const body = input.markdown_body ?? "";

  const route = (findings: LintFinding[]) => {
    for (const f of findings) (f.severity === "blocker" ? blockers : warnings).push(f);
  };

  // Deterministic floor — always applied.
  route(checkCareerPrognosis(body));
  route(checkDiagnosisAsFact(body));
  route(checkDisclaimer(input));
  route(checkSourceAttribution(input));
  route(checkNonPublicDetailRegex(body));

  // Probabilistic layer — blocking on success, advisory (warning) on failure.
  if (classifierConfigured()) {
    try {
      for (const f of await classifyDeskPost(input)) {
        const target = f.severity === "blocker" ? blockers : warnings;
        if (!isDuplicate(f, target)) target.push(f);
      }
    } catch {
      warnings.push({
        code: "classifier_unavailable",
        severity: "warning",
        message: "Framing classifier failed; deterministic checks still applied. Review framing manually.",
      });
    }
  } else {
    warnings.push({
      code: "classifier_unavailable",
      severity: "warning",
      message:
        "ANTHROPIC_API_KEY not set; framing classifier skipped. Deterministic checks still applied — review framing manually.",
    });
  }

  return { warnings, blockers };
}
