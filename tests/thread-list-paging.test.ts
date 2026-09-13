import { describe, it, expect, vi, beforeEach } from "vitest";

// web_list_threads used to return `{ threads }` capped at `limit` (default 100)
// with no total, no offset and no truncation signal. Every frontend caller took
// the default, so the admin lists, the date-review badge and the accuracy view
// would each have stopped at 100 rows without a word. Nothing was over 100 on
// 2026-09-13 (ACTIVE 87); the fix is argued from the silence, not the count.
//
// FAILS-ON-OLD: revert listThreads/web_list_threads and every test here fails —
// there is no OFFSET, no tiebreak, no count statement and no envelope.

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
  const server = new McpServer(
    { name: "test-web", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerWebTools(server);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const found = tools[name];
  if (!found) throw new Error(`Tool ${name} not found`);
  return found;
}

function stmt(call: unknown[]): string {
  const first = call[0];
  return (Array.isArray(first) ? first.join(" ? ") : String(first))
    .replace(/\s+/g, " ")
    .trim();
}

const isCount = (c: unknown[]) => /SELECT COUNT\(\*\)/i.test(stmt(c));

function rows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, injury_date: null }));
}

/** Answer the count statement with `total` and the page statement with `page`. */
function serve(total: number, page: number): void {
  mockSql.mockImplementation((...call: unknown[]) =>
    Promise.resolve(isCount(call) ? [{ total }] : rows(page)),
  );
}

interface Envelope {
  threads: unknown[];
  total: number;
  has_more: boolean;
  next_offset: number | null;
}

async function list(args: Record<string, unknown>): Promise<Envelope> {
  // The raw handler never runs zod, so pass the defaults zod would have applied.
  const res = (await tool("web_list_threads").handler(
    { limit: 100, offset: 0, ...args },
    {},
  )) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text) as Envelope;
}

describe("web_list_threads paging", () => {
  beforeEach(() => mockSql.mockReset());

  it("orders with an id tiebreak and binds LIMIT then OFFSET", async () => {
    serve(0, 0);
    await list({ status: "RESOLVED", limit: 50, offset: 150 });
    const page = mockSql.mock.calls.find((c) => /FROM injury_entities e/i.test(stmt(c)) && !isCount(c));
    expect(page, "no page SELECT was issued").toBeDefined();
    const sql = stmt(page as unknown[]);
    expect(sql).toContain("ORDER BY e.last_updated_at DESC, e.id DESC");
    expect(sql).toMatch(/LIMIT \? OFFSET \?$/);
    expect((page as unknown[]).slice(-2)).toEqual([50, 150]);
  });

  it("counts under the same filters as the page", async () => {
    serve(0, 0);
    await list({ status: "RETIRED", needs_date_review: true });
    const count = mockSql.mock.calls.find(isCount);
    expect(count, "no COUNT statement was issued").toBeDefined();
    const sql = stmt(count as unknown[]);
    expect(sql).toContain("e.status = ?");
    expect(sql).toContain("e.needs_date_review = ?");
    expect(count).toContain("RETIRED");
    expect(count).toContain(true);
  });

  it("reports more behind a full first page", async () => {
    serve(250, 100);
    const env = await list({});
    expect(env.threads).toHaveLength(100);
    expect(env.total).toBe(250);
    expect(env.has_more).toBe(true);
    expect(env.next_offset).toBe(100);
  });

  it("reports nothing more on the last page", async () => {
    serve(250, 50);
    const env = await list({ offset: 200 });
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeNull();
  });

  it("an exactly-full last page is still the last page", async () => {
    serve(200, 100);
    const env = await list({ offset: 100 });
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeNull();
  });

  it("never hands back its own offset behind an empty page", async () => {
    // The count and the page are two statements; a thread closing between them
    // can leave total > offset with no rows. Reporting has_more there would
    // return next_offset === offset and loop a naive caller forever.
    serve(101, 0);
    const env = await list({ offset: 100 });
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeNull();
  });

  it("advances by rows returned, not by limit", async () => {
    serve(500, 80);
    const env = await list({ limit: 100, offset: 0 });
    expect(env.next_offset).toBe(80);
  });
});
