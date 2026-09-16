/**
 * The return-date half of the "a machine never overwrites a physician" rule,
 * plus the reopen path that makes a machine close reversible.
 *
 * updateThreadDates has guarded injury_date since mcp #25 (tests/thread-date-md-guard.test.ts).
 * closeThread guarded nothing: any caller could overwrite actual_return_date,
 * close a VOID thread, or re-close a settled one. That was harmless while only
 * a person ever closed a thread, and stops being harmless the day the return
 * detector runs on a timer — a closed thread leaves ACTIVE and no feed event
 * ever visits it again, so a machine overwrite here is not self-correcting.
 *
 * FAILS-ON-OLD: every test in this file fails against the pre-025 closeThread.
 *
 * Assertions read the BOUND SQL VALUES rather than a return shape, the same way
 * tests/web.test.ts's close tests do — what reached the database is the thing
 * under test, and a handler can return a plausible object having written
 * nothing of the sort.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

function tool(name: string): RegisteredTool {
  const server = new McpServer({ name: "test-web", version: "1.0.0" }, { capabilities: { tools: {} } });
  registerWebTools(server);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const t = tools[name];
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

const ENTITY_ID = "770e8400-e29b-41d4-a716-446655440002";

const baseEntity = {
  id: ENTITY_ID,
  player_id: "880e8400-e29b-41d4-a716-446655440003",
  body_part: "achilles",
  laterality: "RIGHT",
  injury_type: "Achilles rupture",
  status: "ACTIVE",
  canonical_post_id: null,
  first_reported_at: "2026-01-02T00:00:00Z",
  last_updated_at: "2026-01-02T00:00:00Z",
  injury_date: "2026-01-01",
  actual_return_date: null,
  return_source: null,
  accuracy_record: null,
  otm_projection: { min_weeks: 26, max_weeks: 39, projected_return_date: "2026-09-01" },
};

// closeThread issues getEntity → UPDATE → auditAppend (plus one more audit
// append when it refuses a write).
function queue(entity: Record<string, unknown>, returned?: Record<string, unknown>): void {
  mockSql
    .mockResolvedValueOnce([entity])
    .mockResolvedValueOnce([returned ?? { ...entity, status: "RESOLVED" }])
    .mockResolvedValueOnce([{ id: "audit-1" }])
    .mockResolvedValueOnce([{ id: "audit-2" }]);
}

function callAt(index: number): { text: string; values: unknown[] } {
  const [strings, ...values] = mockSql.mock.calls[index] as [string[], ...unknown[]];
  return { text: strings.join("?"), values };
}

function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function errorText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

beforeEach(() => {
  mockSql.mockReset();
});

describe("closeThread — the MD's return date is not re-derived", () => {
  it("drops a system caller's date when the stored one is md, and keeps closing", async () => {
    queue({ ...baseEntity, actual_return_date: "2026-08-20", return_source: "md" });

    const result = await tool("web_thread_close").handler(
      {
        entity_id: ENTITY_ID,
        actual_return_date: "2026-08-14",
        outcome: "RESOLVED",
        closed_by: "system",
      },
      {},
    );

    expect(isErrorResult(result)).toBe(false);
    const update = callAt(1);
    // The refused date must not appear anywhere in the bound values: COALESCE
    // resolves to the STORED date, so the column is rewritten with its own value.
    expect(update.values).not.toContain("2026-08-14");
    expect(update.values).toContain("2026-08-20");
    // …and the close itself still happened. Refusing the date must not refuse
    // the outcome; a thread stuck ACTIVE forever is its own failure.
    expect(update.values).toContain("RESOLVED");
  });

  it("records the refusal as md_return_write_refused", async () => {
    queue({ ...baseEntity, actual_return_date: "2026-08-20", return_source: "md" });
    await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-14", closed_by: "system" },
      {},
    );
    const actions = mockSql.mock.calls.flatMap((c) => (c as unknown[]).slice(1));
    expect(actions).toContain("md_return_write_refused");
  });

  it("lets a named MD overwrite an md-sourced date", async () => {
    queue({ ...baseEntity, actual_return_date: "2026-08-20", return_source: "md" });
    await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-14", closed_by: "dr-johnson" },
      {},
    );
    expect(callAt(1).values).toContain("2026-08-14");
  });

  it("lets a system caller write a date when the stored source is not md", async () => {
    queue({ ...baseEntity, actual_return_date: null, return_source: null });
    await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-14", closed_by: "system" },
      {},
    );
    const update = callAt(1);
    expect(update.values).toContain("2026-08-14");
    // A system caller defaults to 'detector', which is what a later system
    // write is allowed to replace.
    expect(update.values).toContain("detector");
  });

  it("stamps 'md' for a named caller and leaves the source alone when no date is supplied", async () => {
    queue(baseEntity);
    await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-14", closed_by: "dr-johnson" },
      {},
    );
    expect(callAt(1).values).toContain("md");

    mockSql.mockReset();
    queue(baseEntity);
    await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, outcome: "RETIRED", closed_by: "dr-johnson" },
      {},
    );
    // No date in, no provenance out: COALESCE(null, return_source) keeps it.
    expect(callAt(1).values).not.toContain("md");
  });
});

describe("closeThread — refusals", () => {
  it("refuses to close a VOID thread", async () => {
    mockSql.mockResolvedValueOnce([{ ...baseEntity, status: "VOID", void_reason: "wrong athlete" }]);
    const result = await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-14", closed_by: "system" },
      {},
    );
    expect(isErrorResult(result)).toBe(true);
    expect(errorText(result)).toMatch(/VOID/);
    // Exactly one statement ran: the read. Nothing was written.
    expect(mockSql.mock.calls).toHaveLength(1);
  });

  it("refuses a system re-close of a settled thread", async () => {
    mockSql.mockResolvedValueOnce([
      { ...baseEntity, status: "RESOLVED", actual_return_date: "2026-08-20", return_source: "detector" },
    ]);
    const result = await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-20", closed_by: "system" },
      {},
    );
    expect(isErrorResult(result)).toBe(true);
    expect(errorText(result)).toMatch(/already RESOLVED/);
    expect(mockSql.mock.calls).toHaveLength(1);
  });

  it("still lets a named MD re-close a settled thread", async () => {
    queue({ ...baseEntity, status: "RESOLVED", actual_return_date: "2026-08-20", return_source: "detector" });
    const result = await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-21", closed_by: "dr-johnson" },
      {},
    );
    expect(isErrorResult(result)).toBe(false);
    expect(callAt(1).values).toContain("2026-08-21");
  });
});

describe("closeThread — accuracy_record is never erased", () => {
  it("writes an unscoreable record instead of NULL when there is no projection", async () => {
    queue({ ...baseEntity, otm_projection: null });
    await tool("web_thread_close").handler(
      { entity_id: ENTITY_ID, actual_return_date: "2026-08-14", closed_by: "system" },
      {},
    );
    const written = callAt(1).values.find(
      (v) => typeof v === "string" && v.includes("unscoreable_reason"),
    ) as string | undefined;
    expect(written).toBeDefined();
    const record = JSON.parse(written!);
    expect(record.scoreable).toBe(false);
    expect(record.unscoreable_reason).toBe("no_projection");
    // The old code bound a literal null into the accuracy_record parameter
    // here, which on a re-close erased whatever was already stored. (Not
    // asserted as "no null in values": void_reason legitimately binds null on
    // every non-VOID close.)
    const accuracyParam = callAt(1).values[callAt(1).text.split("?").findIndex((seg) => seg.trimEnd().endsWith("accuracy_record ="))];
    expect(typeof accuracyParam).toBe("string");
  });
});

describe("reopenThread", () => {
  it("returns the thread to ACTIVE and clears every column the close wrote", async () => {
    const closed = {
      ...baseEntity,
      status: "RESOLVED",
      actual_return_date: "2026-08-20",
      return_source: "detector",
      accuracy_record: { within_range: true, scoreable: true },
      returned_at: "2026-08-21T00:00:00Z",
      closed_at: "2026-08-21T00:00:00Z",
    };
    mockSql
      .mockResolvedValueOnce([closed])
      .mockResolvedValueOnce([{ ...baseEntity, status: "ACTIVE" }])
      .mockResolvedValueOnce([{ id: "audit-1" }]);

    const result = await tool("web_thread_reopen").handler(
      { entity_id: ENTITY_ID, reopened_by: "dr-johnson", reason: "wrong athlete — that was the backup" },
      {},
    );

    expect(isErrorResult(result)).toBe(false);
    const update = callAt(1);
    expect(update.text).toMatch(/status = 'ACTIVE'/);
    expect(update.text).toMatch(/actual_return_date = NULL/);
    expect(update.text).toMatch(/return_source = NULL/);
    expect(update.text).toMatch(/accuracy_record = NULL/);
    expect(update.text).toMatch(/returned_at = NULL/);
    expect(update.text).toMatch(/closed_at = NULL/);
    // last_updated_at drives web_find_matching_entity's 21-day window, and
    // reopening is our own bookkeeping, not new injury activity.
    expect(update.text).not.toMatch(/last_updated_at/);
  });

  it("refuses a VOID thread and an already-ACTIVE one", async () => {
    mockSql.mockResolvedValueOnce([{ ...baseEntity, status: "VOID" }]);
    let result = await tool("web_thread_reopen").handler(
      { entity_id: ENTITY_ID, reopened_by: "dr-johnson", reason: "x" },
      {},
    );
    expect(isErrorResult(result)).toBe(true);
    expect(errorText(result)).toMatch(/VOID/);

    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([baseEntity]);
    result = await tool("web_thread_reopen").handler(
      { entity_id: ENTITY_ID, reopened_by: "dr-johnson", reason: "x" },
      {},
    );
    expect(isErrorResult(result)).toBe(true);
    expect(errorText(result)).toMatch(/already ACTIVE/);
    expect(mockSql.mock.calls).toHaveLength(1);
  });

  it("requires a reason — the only durable record of a reversal", () => {
    const schema = (tool("web_thread_reopen") as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } })
      .inputSchema;
    expect(schema.safeParse({ entity_id: ENTITY_ID, reopened_by: "dr-johnson" }).success).toBe(false);
    expect(schema.safeParse({ entity_id: ENTITY_ID, reopened_by: "dr-johnson", reason: "" }).success).toBe(false);
    expect(
      schema.safeParse({ entity_id: ENTITY_ID, reopened_by: "dr-johnson", reason: "detected the wrong game" }).success,
    ).toBe(true);
  });
});
