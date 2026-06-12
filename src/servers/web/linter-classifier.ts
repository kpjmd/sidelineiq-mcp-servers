// Haiku framing classifier — the async, network-touching half of the Tier 2
// content linter, isolated behind this module so it can be mocked in tests
// (vi.mock("./linter-classifier.js")) exactly like the database seam. linter.ts
// calls classifierConfigured() first and skips the call when no key is set, so
// the deterministic regex rules never depend on the network.
//
// Scope: this classifier judges *framing*, not clinical correctness. It extends
// the regex rules on the two checks regex can't do well:
//   • diagnosis_as_fact — paraphrased diagnosis stated as established fact about
//     the named individual (catches what the verb+structure regex misses, and
//     stays quiet when the claim is properly hedged / attributed to a source).
//   • non_public_scan_detail — MRI/imaging readings asserted as fact that aren't
//     attributable to the cited public reporting.
//
// Mirrors the agents repo classifier pattern: a single forced tool call to a
// small pinned Haiku model, parse the tool_use block. Throws on any API or
// shape error — linter.ts catches and fails OPEN with a visible warning.

import Anthropic from "@anthropic-ai/sdk";
import type { LintDeskPostInput, LintFinding, LintSeverity } from "./linter.js";

// Pinned dated snapshot (matches the agents repo's classifier.ts) so a
// defensibility-gating classifier's behavior can't drift under a floating alias.
const MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// True when the classifier can run. linter.ts uses this to decide between
// running the Haiku pass and emitting the fail-open `classifier_unavailable`
// warning — without a key we never construct a client or make a request.
export function classifierConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM_PROMPT = `You are a compliance reviewer for an injury-analysis desk. A board-certified \
physician publishes general educational commentary about professional athletes' injuries, based \
ONLY on public reporting. The physician has never examined these athletes.

You judge FRAMING, not clinical accuracy. Report a finding only when the body crosses one of these lines:

1. diagnosis_as_fact (severity: blocker)
   The body states a specific injury or diagnosis as established fact about the named individual, \
as if the physician personally determined it — e.g. "He tore his ACL", "She has a torn labrum". \
Do NOT flag when the claim is hedged or attributed to public reporting — e.g. "reportedly tore", \
"according to ESPN", "the team announced", "sources say", "is believed to have". General educational \
statements about an injury TYPE (not asserted of this individual as fact) are fine.

2. non_public_scan_detail (severity: blocker; use warning if genuinely unsure)
   The body asserts MRI / CT / imaging / scan READINGS as fact that are not attributable to the cited \
public reporting — i.e. the physician appears to be inventing or asserting private medical findings. \
If the imaging detail is clearly quoted from or attributed to a public source, do NOT flag it.

Quote the exact offending phrase from the body. If the body is clean, return an empty findings array. \
Be conservative: when in doubt, do not flag, or use warning severity.`;

const TOOL = {
  name: "flag_framing_violations",
  description: "Report Tier 2 framing violations found in the desk post body.",
  input_schema: {
    type: "object" as const,
    properties: {
      findings: {
        type: "array",
        description: "Framing violations; empty if the body is clean.",
        items: {
          type: "object",
          properties: {
            code: {
              type: "string",
              enum: ["diagnosis_as_fact", "non_public_scan_detail"],
            },
            severity: { type: "string", enum: ["blocker", "warning"] },
            message: {
              type: "string",
              description: "One sentence explaining the violation for the reviewing MD.",
            },
            quote: {
              type: "string",
              description: "The exact phrase from the body that triggered the finding.",
            },
          },
          required: ["code", "severity", "message", "quote"],
        },
      },
    },
    required: ["findings"],
  },
};

interface RawFinding {
  code?: unknown;
  severity?: unknown;
  message?: unknown;
  quote?: unknown;
}

// Run the Haiku framing pass. Returns the findings (possibly empty).
// THROWS on API error or an unparseable response — the caller (linter.ts) treats
// any throw as fail-open and records a `classifier_unavailable` warning instead.
export async function classifyDeskPost(input: LintDeskPostInput): Promise<LintFinding[]> {
  const sourceContext =
    input.source_attribution != null
      ? `\n\nCited sources (JSON):\n${JSON.stringify(input.source_attribution)}`
      : "\n\n(No structured source attribution provided.)";

  const userMessage =
    `Title: ${input.title}\n\nBody:\n${input.markdown_body}${sourceContext}\n\n` +
    `Review the body against the two framing rules and report any findings.`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 768,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Framing classifier did not return a tool_use block");
  }

  const raw = (toolUse.input as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) {
    throw new Error("Framing classifier returned a malformed findings array");
  }

  const findings: LintFinding[] = [];
  for (const item of raw as RawFinding[]) {
    const code = String(item.code ?? "").trim();
    const message = String(item.message ?? "").trim();
    const quote = typeof item.quote === "string" ? item.quote : "";
    if (!code || !message) continue;
    const severity: LintSeverity = item.severity === "warning" ? "warning" : "blocker";

    const finding: LintFinding = { code, message, severity };
    // Best-effort span from the quoted phrase so the dashboard can highlight it.
    if (quote) {
      const start = input.markdown_body.indexOf(quote);
      if (start >= 0) finding.span = { start, end: start + quote.length };
    }
    findings.push(finding);
  }
  return findings;
}
