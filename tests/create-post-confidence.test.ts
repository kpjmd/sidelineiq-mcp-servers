import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));
vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: vi.fn(() => false),
  classifyDeskPost: vi.fn(),
}));
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWebTools } from "../src/servers/web/tools.js";

/**
 * md_review_confidence was NULL on every post that published WITHOUT routing to
 * MD review — 183 of 472 live PUBLISHED rows, and every one of them on the
 * auto-publish path. The agent had always sent the number: formatForWeb emitted
 * a flat `confidence` key, web_create_injury_post's zod object did not declare
 * it, and `z.object` strips unknown keys by default. The tool returned success.
 * The only writer was flagForMdReview, so the column recorded "the gate fired",
 * not "a confidence was emitted".
 *
 * WHY THE OLD SUITE COULD NOT SEE IT. Every test in web.test.ts calls
 * `getTool(server, name).handler(args, {})` directly. In SDK 1.27.1 that handler
 * is the RAW callback — zod runs in McpServer.validateToolInput, which is only
 * reached on the tools/call request path. So the existing pattern hands the
 * handler an object zod never touched, and a stripped field is structurally
 * invisible to it. That is how 183 posts happened against a green suite.
 *
 * Everything below therefore goes through `tool.inputSchema.parse()` first.
 */

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "test-web", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerWebTools(server);
  return server;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

/** Validate the way the transport does, THEN dispatch. */
async function callValidated(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = getTool(server, name);
  return tool.handler(
    tool.inputSchema.parse(args) as Record<string, unknown>,
    {},
  );
}

/**
 * Shaped after a real emit — a live auto-published row (7768b9e0, A.J. Brown,
 * BREAKING/MODERATE, 2026-09-10) whose log line printed 0.72 while the column
 * stayed NULL. The two confidences are DIFFERENT numbers on purpose: equal
 * values would let a positional mix-up pass.
 */
const VALID_CREATE = {
  athlete_name: "A.J. Brown",
  sport: "NFL",
  team: "New England Patriots",
  injury_type: "High ankle sprain (syndesmosis), Grade unknown",
  injury_severity: "MODERATE",
  content_type: "BREAKING",
  headline: "A.J. Brown Listed Questionable After Right High Ankle Sprain",
  clinical_summary: "A.J. Brown suffered a right high ankle sprain post-game.",
  return_to_play_estimate: {
    min_weeks: 4,
    max_weeks: 20,
    probability_week_2: 0.05,
    probability_week_4: 0.25,
    probability_week_8: 0.65,
    confidence: 0.55,
  },
  source_url: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
  md_review_required: false,
  md_review_confidence: 0.72,
} as const;

/** The tagged template arrives at mockSql as (strings, ...values). */
function insertCall(): { cols: string[]; values: unknown[] } {
  const call = mockSql.mock.calls.find(([s]) =>
    (s as string[])[0].includes("INSERT INTO injury_posts"),
  ) as [string[], ...unknown[]] | undefined;
  if (!call) throw new Error("no INSERT INTO injury_posts call");
  const [strings, ...values] = call;
  // Anchor on the INSERT itself, not the first "(" — createPost is a CTE now
  // (`WITH p AS (INSERT INTO injury_posts (...`).
  const cols = strings[0]
    .split("INSERT INTO injury_posts (")[1]
    .split(")")[0]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return { cols, values };
}

describe("web_create_injury_post persists md_review_confidence", () => {
  beforeEach(() => {
    mockSql.mockReset();
    // resolveUniqueSlug probes for collisions, then the INSERT returns a row.
    mockSql.mockResolvedValue([]);
  });

  it("declares md_review_confidence, so zod stops stripping it", () => {
    const tool = getTool(createTestServer(), "web_create_injury_post");
    const parsed = tool.inputSchema.parse(VALID_CREATE) as Record<string, unknown>;

    // Pre-fix this key is silently absent — the whole bug in one assertion.
    expect(parsed).toHaveProperty("md_review_confidence", 0.72);
  });

  it("rejects a value outside 0..1", () => {
    const tool = getTool(createTestServer(), "web_create_injury_post");
    // md_review_confidence is DECIMAL(4,3) with NO check constraint, so the
    // column would happily store 9.999. zod is the only range enforcement, and
    // this is the fail-OPEN direction: needsMDReview asks `confidence <
    // threshold`, which is false for anything above 1, so an out-of-range value
    // publishes without review.
    expect(() =>
      tool.inputSchema.parse({ ...VALID_CREATE, md_review_confidence: 1.4 }),
    ).toThrow();
    expect(() =>
      tool.inputSchema.parse({ ...VALID_CREATE, md_review_confidence: -0.1 }),
    ).toThrow();
    for (const v of [0, 1]) {
      expect(
        tool.inputSchema.parse({ ...VALID_CREATE, md_review_confidence: v }),
      ).toHaveProperty("md_review_confidence", v);
    }
  });

  it("binds the value at the column's own position in the INSERT", async () => {
    const server = createTestServer();
    await callValidated(server, "web_create_injury_post", VALID_CREATE);

    const { cols, values } = insertCall();
    const i = cols.indexOf("md_review_confidence");

    // The column list and the VALUES list are two hand-maintained parallel
    // lists. Asserting positionally rather than "the SQL mentions the column
    // AND 0.72 appears somewhere in the values" is what catches them drifting.
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cols).toHaveLength(values.length);
    expect(values[i]).toBe(0.72);

    // And it did not land on the sibling: rtp_confidence is a different
    // judgement and a different number.
    expect(values[cols.indexOf("rtp_confidence")]).toBe(0.55);
  });

  it("binds null, not undefined, when the field is omitted", async () => {
    const server = createTestServer();
    const { md_review_confidence: _omitted, ...withoutIt } = VALID_CREATE;
    await callValidated(server, "web_create_injury_post", withoutIt);

    const { cols, values } = insertCall();
    // `undefined` reaches the driver as a bind error, not as SQL NULL.
    expect(values[cols.indexOf("md_review_confidence")]).toBeNull();
  });
});

describe("the two confidence fields stay distinguishable", () => {
  const tool = () => getTool(createTestServer(), "web_create_injury_post");
  const desc = (schema: z.ZodTypeAny): string =>
    (schema as unknown as { description?: string }).description ?? "";

  const postField = () => tool().inputSchema.shape.md_review_confidence;
  const rtpField = () => {
    const rtp = tool().inputSchema.shape.return_to_play_estimate;
    return (rtp as unknown as z.ZodObject<z.ZodRawShape>).shape.confidence;
  };

  it("describes both", () => {
    // PR #30: return_to_play.confidence was a bare number with no description
    // at all, and across 439 stored posts it collapsed onto one modal value
    // while the two confidences came back byte-identical. This repo's copy of
    // that schema had never been described either.
    expect(desc(postField())).toBeTruthy();
    expect(desc(rtpField())).toBeTruthy();
  });

  it("describes them differently", () => {
    // If the descriptions converge, so will the numbers.
    expect(desc(postField())).not.toBe(desc(rtpField()));
  });

  it("tells the model the two are distinct judgements", () => {
    for (const d of [desc(postField()), desc(rtpField())]) {
      expect(d).toMatch(/DIFFERENT judgement/);
      expect(d).toMatch(/copied into the other/);
    }
  });

  it("states the consequence without hard-coding a threshold", () => {
    // The enforced threshold is an env var (0.70 in production, 0.75 in code).
    // Four sources already disagreed about the number; a tool schema must not
    // become a fifth. State the consequence, never the value.
    const d = desc(postField());
    expect(d).toMatch(/review/i);
    expect(d).not.toMatch(/[Bb]elow \d*\.?\d+/);
  });

  it("anchors the RTP week bounds to the TOTAL clock", () => {
    // team_timeline_weeks is REMAINING; min_weeks/max_weeks are TOTAL from
    // injury_date. Six sites once subtracted one from the other.
    const shape = (
      tool().inputSchema.shape.return_to_play_estimate as unknown as z.ZodObject<z.ZodRawShape>
    ).shape;
    for (const f of ["min_weeks", "max_weeks"]) {
      expect(desc(shape[f])).toMatch(/TOTAL/);
    }
    expect(desc(shape.min_weeks)).toMatch(/injury_date/);
  });
});
