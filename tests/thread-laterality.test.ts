import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database
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

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
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
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

const entity = {
  id: "770e8400-e29b-41d4-a716-446655440002",
  player_id: "880e8400-e29b-41d4-a716-446655440003",
  body_part: "wrist",
  laterality: "RIGHT",
  injury_type: "Wrist surgery",
  status: "ACTIVE",
  canonical_post_id: "550e8400-e29b-41d4-a716-446655440000",
  first_reported_at: "2026-07-07T00:00:00Z",
  last_updated_at: "2026-07-14T00:00:00Z",
  actual_return_date: null,
};

function callAt(index: number): { text: string; values: unknown[] } {
  const call = mockSql.mock.calls[index] as [string[], ...unknown[]];
  const [strings, ...values] = call;
  return { text: strings.join("?"), values };
}

async function correct(args: Record<string, unknown>) {
  const server = createTestServer();
  const tool = getTool(server, "web_thread_correct_laterality");
  return (await tool.handler(args, {})) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
}

const VALID = {
  entity_id: entity.id,
  laterality: "LEFT",
  corrected_by: "fix-injury-laterality",
  actor: "automation",
  reason: "wrist side corrected from RIGHT to LEFT",
};

/**
 * web_thread_correct_laterality — the only writer of a clinical attribute on an
 * existing entity.
 *
 * Until this tool existed, laterality/body_part/injury_type were INSERT-only:
 * fix-injury-laterality.ts's --fix-entity path called web_apply_correction with
 * `{entity_id, field:'laterality'}`, which that tool does not accept on any of
 * three counts (it targets injury_posts, post_id is required, and laterality is
 * not in its field enum). The call was rejected every time and the script never
 * checked isError, so entity-level laterality has never once been corrected.
 *
 * The consequence is not cosmetic. The entity's laterality is read back into
 * every follow-up's prompt as thread context and is half the
 * (player_id, body_part, laterality) dedup key, so a wrong side both propagates
 * into published prose and makes every CORRECT later report look like a
 * laterality_thread_mismatch for the thread's whole 21-day window.
 */
describe("web_thread_correct_laterality", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("writes the new side and audits the old one", async () => {
    mockSql
      .mockResolvedValueOnce([entity]) // getEntity
      .mockResolvedValueOnce([{ ...entity, laterality: "LEFT" }]) // UPDATE
      .mockResolvedValueOnce([{ id: "audit-1" }]); // auditAppend

    const result = await correct(VALID);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.entity.laterality).toBe("LEFT");
    expect(data.changed).toBe(true);
    expect(data.previous_laterality).toBe("RIGHT");

    const update = callAt(1);
    expect(update.text).toMatch(/UPDATE injury_entities SET/);
    expect(update.values).toContain("LEFT");

    // before/after reach audit_log only as hashes, so the readable diff has to
    // be bound into the payload or the trail cannot answer what changed.
    const audit = callAt(2);
    expect(audit.values).toContain("thread_laterality_corrected");
    const payload = audit.values.find(
      (v) => typeof v === "string" && v.includes("previous_laterality"),
    ) as string;
    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload);
    expect(parsed.previous_laterality).toBe("RIGHT");
    expect(parsed.new_laterality).toBe("LEFT");
    expect(parsed.reason).toBe(VALID.reason);
    expect(parsed.body_part).toBe("wrist");
  });

  // last_updated_at drives web_find_matching_entity's 21-day recency window.
  // A correction is bookkeeping, not new injury activity: bumping it would
  // silently extend the window in which this thread absorbs new reports.
  it("does not touch last_updated_at", async () => {
    mockSql
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([{ ...entity, laterality: "LEFT" }])
      .mockResolvedValueOnce([{ id: "audit-1" }]);

    await correct(VALID);

    const update = callAt(1);
    expect(update.text).not.toMatch(/last_updated_at/);
    expect(update.text).toMatch(/updated_at = NOW\(\)/);
  });

  // A repair script re-run must not manufacture a second audit row claiming a
  // change that did not happen.
  it("writes nothing when the stored side already matches", async () => {
    mockSql.mockResolvedValueOnce([{ ...entity, laterality: "LEFT" }]);

    const result = await correct(VALID);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.changed).toBe(false);
    expect(data.previous_laterality).toBe("LEFT");
    // getEntity only — no UPDATE, no audit row.
    expect(mockSql.mock.calls).toHaveLength(1);
  });

  // A VOID thread was retracted as never having described a real injury. There
  // is no side to correct, and re-writing one invites it back into reasoning
  // that correctly excludes VOID everywhere else.
  it("refuses a VOID thread", async () => {
    mockSql.mockResolvedValueOnce([{ ...entity, status: "VOID" }]);

    const result = await correct(VALID);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/VOID/);
    expect(mockSql.mock.calls).toHaveLength(1);
  });

  it("refuses an unknown entity", async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await correct(VALID);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
    expect(mockSql.mock.calls).toHaveLength(1);
  });

  // actor decides how the row reads in the audit trail: a script correcting a
  // batch is not a physician's judgement and must not be recorded as one.
  it("records an automation correction as automation, and defaults to md", async () => {
    mockSql
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([{ ...entity, laterality: "LEFT" }])
      .mockResolvedValueOnce([{ id: "audit-1" }]);
    await correct(VALID);
    expect(callAt(2).values).toContain("automation");

    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([{ ...entity, laterality: "LEFT" }])
      .mockResolvedValueOnce([{ id: "audit-1" }]);
    const { actor: _omitted, ...noActor } = VALID;
    await correct(noActor);
    expect(callAt(2).values).toContain("md");
  });
});
