import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// listThreads must project date_resolution_sources and canonical_post_id.
//
// Without date_resolution_sources the md_manual half of the agents' settled-date
// predicate is invisible from a list call, so every consumer that needs it — the
// date-resolution dry run, the backfill-shell sweep — had to fan out to one
// web_thread_get PER THREAD (268 reads for a four-call question).
//
// Both columns already exist (migrations 009 and 014); this is a SELECT change,
// not a schema change.
//
// FAILS-ON-OLD: revert the SELECT in listThreads and `selects both columns` fails.
// FAIL-CLOSED both ways: `leaves JSONB and UUID untouched` fails if either column
// is ever added to ENTITY_DATE_FIELDS (toIsoDate would corrupt a JSONB array) AND
// fails if injury_date stops being normalized.

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
import { normalizeThreadListItem } from "../src/servers/web/date-utils.js";
import type { ThreadListItem } from "../src/servers/web/client.js";

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

interface Fixture {
  entity: Record<string, unknown>;
  list_row: Record<string, unknown>;
  adds_over_pre_widening_list_row: string[];
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/thread-list-row.json"), "utf-8"),
) as Fixture;

describe("web_list_threads column projection", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  it("selects date_resolution_sources and canonical_post_id", async () => {
    await tool("web_list_threads").handler({ status: "ACTIVE", limit: 100 }, {});
    const call = mockSql.mock.calls.find((c) => /FROM injury_entities e/i.test(stmt(c)));
    expect(call, "no injury_entities SELECT was issued").toBeDefined();
    const sql = stmt(call as unknown[]);
    expect(sql).toContain("e.date_resolution_sources");
    expect(sql).toContain("e.canonical_post_id");
  });

  it("returns both fields on the row it hands back", async () => {
    // The recorded SELECT * row, minus the two columns listThreads deliberately
    // does not project.
    const row = { ...fixture.entity };
    delete row.created_at;
    delete row.updated_at;
    mockSql.mockResolvedValue([row]);

    const res = (await tool("web_list_threads").handler(
      { status: "ACTIVE", limit: 100 },
      {},
    )) as { content: Array<{ text: string }> };
    const { threads } = JSON.parse(res.content[0].text) as { threads: ThreadListItem[] };

    expect(threads).toHaveLength(1);
    expect("date_resolution_sources" in threads[0]).toBe(true);
    expect(threads[0].date_resolution_sources).toEqual(
      fixture.entity.date_resolution_sources,
    );
    expect(threads[0].canonical_post_id).toBe(fixture.entity.canonical_post_id);
  });

  it("the fixture pins exactly which keys the widening adds", () => {
    // Guards against widening the SELECT further by accident: created_at and
    // updated_at are the other two columns SELECT * carries and they stay out.
    expect(fixture.adds_over_pre_widening_list_row).toEqual([
      "canonical_post_id",
      "created_at",
      "date_resolution_sources",
      "updated_at",
    ]);
  });

  it("leaves the JSONB and UUID columns untouched through normalizeThreadListItem", () => {
    // The neon driver hands back DATE columns as Date objects; the recorded wire
    // payload is already normalized, so re-hydrate the one field under test.
    const raw = {
      ...fixture.entity,
      injury_date: new Date(`${fixture.entity.injury_date as string}T00:00:00Z`),
    } as unknown as ThreadListItem;

    const out = normalizeThreadListItem(raw);

    expect(out.injury_date).toBe(fixture.entity.injury_date);
    // Deep equality, not identity: this is what fails if date_resolution_sources
    // is ever added to ENTITY_DATE_FIELDS and run through toIsoDate.
    expect(out.date_resolution_sources).toEqual(fixture.entity.date_resolution_sources);
    expect(out.canonical_post_id).toBe(fixture.entity.canonical_post_id);
  });
});
