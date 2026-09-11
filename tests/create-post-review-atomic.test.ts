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
 * A post routed to physician review must never be PUBLISHED — not even between
 * two calls.
 *
 * `status` was undeclared on web_create_injury_post, so zod stripped it and
 * every row landed at the DDL default PUBLISHED. The agent then called
 * web_flag_for_md_review to flip it, inside a try/catch that only logged. If
 * that second call failed, the post sat PUBLISHED: on the homepage, the feed,
 * the sitemap — and in the agent's ApprovalSync sweep, which re-casts every
 * hashless PUBLISHED row to Farcaster and X and whose default allowlist is
 * DEEP_DIVE, the one type that ALWAYS routes to review.
 *
 * The create now carries the review question with it and files the md_reviews
 * row in the same statement. Everything here goes through
 * `tool.inputSchema.parse()` first: the raw handler never sees zod, so a
 * stripped key is invisible to a test that calls it directly — which is how
 * this and md_review_confidence both survived a green suite.
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

async function callValidated(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; data: Record<string, unknown> }> {
  const tool = getTool(createTestServer(), name);
  const result = (await tool.handler(
    tool.inputSchema.parse(args) as Record<string, unknown>,
    {},
  )) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError, data: JSON.parse(result.content[0].text) };
}

/** Shaped after the agent's formatForWeb output on the review path. */
const REVIEW_CREATE = {
  athlete_name: "Tua Tagovailoa",
  sport: "NFL",
  team: "Atlanta Falcons",
  injury_type: "Oblique strain, grade unconfirmed — INFERRED",
  injury_severity: "MINOR",
  content_type: "DEEP_DIVE",
  headline: "Tua Tagovailoa Questionable with Oblique Soreness",
  clinical_summary: "Oblique soreness reported after practice.",
  return_to_play_estimate: {
    min_weeks: 1,
    max_weeks: 4,
    probability_week_2: 0.4,
    probability_week_4: 0.8,
    probability_week_8: 0.95,
    confidence: 0.55,
  },
  md_review_required: true,
  md_review_confidence: 0.62,
  status: "PENDING_REVIEW",
  md_review_reason: "DEEP_DIVE content always requires MD review",
} as const;

/** The CTE arrives at mockSql as one tagged-template call: (strings, ...values). */
function createCall(): { sql: string; cols: string[]; values: unknown[] } {
  const calls = mockSql.mock.calls.filter(([s]) =>
    (s as string[])[0].includes("INSERT INTO injury_posts"),
  );
  expect(calls).toHaveLength(1);
  const [strings, ...values] = calls[0] as [string[], ...unknown[]];
  const cols = strings[0]
    .split("INSERT INTO injury_posts (")[1]
    .split(")")[0]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return { sql: strings.join("$"), cols, values };
}

function rowFor(values: unknown[], cols: string[], filed: boolean) {
  return {
    id: "3336ba29-ac18-46d1-a788-717942ad3d5e",
    slug: "tua-tagovailoa-oblique-strain-2026-09-11",
    created_at: "2026-09-11T12:00:00.000Z",
    status: values[cols.indexOf("status")],
    md_review_filed: filed,
  };
}

describe("web_create_injury_post accepts the review question", () => {
  const schema = () => getTool(createTestServer(), "web_create_injury_post").inputSchema;

  it("keeps status and md_review_reason through zod", () => {
    const parsed = schema().parse(REVIEW_CREATE) as Record<string, unknown>;
    // Pre-fix both keys are silently absent: the row lands PUBLISHED.
    expect(parsed).toHaveProperty("status", "PENDING_REVIEW");
    expect(parsed).toHaveProperty("md_review_reason", REVIEW_CREATE.md_review_reason);
  });

  it("cannot create a retired or unknown status", () => {
    for (const status of ["REJECTED", "SUPERSEDED", "DRAFT", "LIVE"]) {
      expect(() => schema().parse({ ...REVIEW_CREATE, status })).toThrow();
    }
  });

  it("rejects an empty reason rather than filing a blank queue item", () => {
    expect(() => schema().parse({ ...REVIEW_CREATE, md_review_reason: "" })).toThrow();
  });
});

describe("createPost files the review in the same statement", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockImplementation(async (strings: string[], ...values: unknown[]) => {
      const sql = strings.join("$");
      if (sql.includes("SELECT id FROM injury_posts WHERE slug")) return [];
      if (sql.includes("INSERT INTO injury_posts")) {
        const cols = strings[0]
          .split("INSERT INTO injury_posts (")[1]
          .split(")")[0]
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const status = values[cols.indexOf("status")];
        const reason = values[cols.indexOf("md_review_reason")];
        return [rowFor(values, cols, status === "PENDING_REVIEW" && reason !== null)];
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    });
  });

  it("binds PENDING_REVIEW and the reason at their own columns", async () => {
    const { isError, data } = await callValidated("web_create_injury_post", REVIEW_CREATE);
    expect(isError).toBeUndefined();

    const { cols, values } = createCall();
    expect(cols).toHaveLength(values.length);
    expect(values[cols.indexOf("status")]).toBe("PENDING_REVIEW");
    expect(values[cols.indexOf("md_review_reason")]).toBe(REVIEW_CREATE.md_review_reason);
    expect(values[cols.indexOf("md_review_required")]).toBe(true);
    expect(values[cols.indexOf("md_review_confidence")]).toBe(0.62);

    expect(data.status).toBe("PENDING_REVIEW");
    expect(data.md_review_filed).toBe(true);
  });

  it("writes the md_reviews row inside the SAME statement, gated on status and reason", async () => {
    await callValidated("web_create_injury_post", REVIEW_CREATE);
    const { sql } = createCall();

    // One statement, not two calls: a separate INSERT is the half-failure this
    // replaces.
    const reviewInserts = mockSql.mock.calls.filter(([s]) =>
      (s as string[]).join("$").includes("INSERT INTO md_reviews"),
    );
    expect(reviewInserts).toHaveLength(1);
    expect(sql).toMatch(/INSERT INTO md_reviews[\s\S]*FROM p/);
    expect(sql).toMatch(/p\.status = 'PENDING_REVIEW' AND p\.md_review_reason IS NOT NULL/);
    expect(sql).toMatch(/md_review_filed/);
  });

  it("defaults to PUBLISHED and files nothing when status is omitted", async () => {
    const { status: _s, md_review_reason: _r, ...published } = REVIEW_CREATE;
    const { data } = await callValidated("web_create_injury_post", {
      ...published,
      md_review_required: false,
    });

    const { cols, values } = createCall();
    // The DDL default, bound explicitly — `undefined` is a bind error, not NULL.
    expect(values[cols.indexOf("status")]).toBe("PUBLISHED");
    expect(values[cols.indexOf("md_review_reason")]).toBeNull();
    expect(data.status).toBe("PUBLISHED");
    expect(data.md_review_filed).toBe(false);
  });

  it("still lands PENDING_REVIEW without a reason, and says it filed nothing", async () => {
    // What an agent that predates this change sends mid-deploy. Rejecting it
    // would kill every review-routed create in the mcp-first window; accepting
    // it lands non-public, and that agent's own flag call files the row.
    const { md_review_reason: _r, ...noReason } = REVIEW_CREATE;
    const { isError, data } = await callValidated("web_create_injury_post", noReason);

    expect(isError).toBeUndefined();
    const { cols, values } = createCall();
    expect(values[cols.indexOf("status")]).toBe("PENDING_REVIEW");
    expect(values[cols.indexOf("md_review_reason")]).toBeNull();
    expect(data.md_review_filed).toBe(false);
  });

  it("echoes md_review_filed as a strict boolean", async () => {
    // The agent skips its flag call only on `=== true`. A driver that returned
    // the EXISTS column as a string or null must read as "not filed".
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "x", slug: "s", created_at: "t", status: "PENDING_REVIEW", md_review_filed: "t" }]);
    const { data } = await callValidated("web_create_injury_post", REVIEW_CREATE);
    expect(data.md_review_filed).toBe(false);
  });
});

describe("web_flag_for_md_review keeps a stored confidence it was not given", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([{ id: "3336ba29-ac18-46d1-a788-717942ad3d5e", status: "PUBLISHED", updated_at: "t" }])
      .mockResolvedValueOnce([]);
  });

  const FLAG = {
    post_id: "3336ba29-ac18-46d1-a788-717942ad3d5e",
    reason: "legacy_sweep:laterality_inconsistent",
    flagged_by: "legacy-fact-sweep",
    preserve_status: true,
  };

  function updateCall(): { sql: string; values: unknown[] } {
    const call = mockSql.mock.calls.find(([s]) =>
      (s as string[]).join("$").includes("UPDATE injury_posts"),
    ) as [string[], ...unknown[]];
    return { sql: call[0].join("$"), values: call.slice(1) };
  }

  it("accepts a flag with no confidence_score", () => {
    // Pre-fix confidence_score is required, so the repair scripts had to
    // invent one (0.5, 1) — and it overwrote the model's real number.
    const tool = getTool(createTestServer(), "web_flag_for_md_review");
    expect(() => tool.inputSchema.parse(FLAG)).not.toThrow();
  });

  for (const preserve_status of [true, false]) {
    it(`COALESCEs onto the stored value (preserve_status=${preserve_status})`, async () => {
      await callValidated("web_flag_for_md_review", { ...FLAG, preserve_status });
      const { sql, values } = updateCall();
      expect(sql).toMatch(/md_review_confidence = COALESCE\(\$, md_review_confidence\)/);
      // Omitted binds SQL NULL, so COALESCE keeps the column — including a
      // historical NULL, which must stay NULL rather than become a sentinel.
      expect(values).toContain(null);
    });

    it(`still lets a caller with a number win (preserve_status=${preserve_status})`, async () => {
      await callValidated("web_flag_for_md_review", {
        ...FLAG,
        preserve_status,
        confidence_score: 0.62,
      });
      const { values } = updateCall();
      expect(values).toContain(0.62);
      expect(values).not.toContain(null);
    });
  }
});
