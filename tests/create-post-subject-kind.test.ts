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
 * subject_kind (migration 023) records what a post is ABOUT, so the commercial
 * AequOs CTA can be limited to injury-TYPE-led content. The agents send it; the
 * frontend and the social formatters read it back off the stored row.
 *
 * This is the same field-lifecycle as md_review_confidence, and it fails the
 * same way if any hop drops it — so the same discipline: validate through
 * `tool.inputSchema.parse()` (the raw handler never runs zod), and assert the
 * bind POSITIONALLY against the column list.
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

describe("web_create_injury_post persists subject_kind", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  it("declares subject_kind, so zod does not strip it", () => {
    const tool = getTool(createTestServer(), "web_create_injury_post");
    for (const v of ["INJURY_TYPE", "ATHLETE"] as const) {
      expect(tool.inputSchema.parse({ ...VALID_CREATE, subject_kind: v })).toHaveProperty(
        "subject_kind",
        v,
      );
    }
  });

  it("rejects any other value — the column CHECK is the backstop, not the gate", () => {
    const tool = getTool(createTestServer(), "web_create_injury_post");
    for (const v of ["injury_type", "TOPIC", "", 1]) {
      expect(() => tool.inputSchema.parse({ ...VALID_CREATE, subject_kind: v })).toThrow();
    }
  });

  it("binds the value at the column's own position in the INSERT", async () => {
    await callValidated(createTestServer(), "web_create_injury_post", {
      ...VALID_CREATE,
      content_type: "DEEP_DIVE",
      subject_kind: "INJURY_TYPE",
    });
    const { cols, values } = insertCall();
    const i = cols.indexOf("subject_kind");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cols).toHaveLength(values.length);
    expect(values[i]).toBe("INJURY_TYPE");
    // and the parallel lists did not shift the neighbour
    expect(values[cols.indexOf("md_review_reason")]).toBeNull();
  });

  it("binds null, not undefined, when omitted — a pre-023 agent's create still lands", async () => {
    await callValidated(createTestServer(), "web_create_injury_post", VALID_CREATE);
    const { cols, values } = insertCall();
    expect(values[cols.indexOf("subject_kind")]).toBeNull();
  });

  it("describes the field, including that omission means no CTA", () => {
    const tool = getTool(createTestServer(), "web_create_injury_post");
    const desc =
      (tool.inputSchema.shape.subject_kind as unknown as { description?: string }).description ?? "";
    expect(desc).toMatch(/INJURY_TYPE/);
    expect(desc).toMatch(/NULL/);
  });
});
