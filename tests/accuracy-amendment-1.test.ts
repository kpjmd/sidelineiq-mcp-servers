/**
 * Pre-registration Amendment 1 (agents docs/accuracy-preregistration.md).
 *
 * A1.1 — the scored window is the FIRST PUBLISHED post's estimate, read at
 *        close. otm_projection is whatever post wrote last, of any status:
 *        Robinson's came from a later-REJECTED post, Pierce's 10-16w was
 *        replaced five months on by 0-6w.
 * A1.2 — 0/0 with rtp_confidence 0 is the concussion/systemic "no estimate"
 *        signature, not a window.
 * A1.3 — a calendar-censored return is scored only when it falls before the
 *        window's floor; otherwise it is calendar_censored.
 *
 * FAILS-ON-OLD: computeAccuracyRecord read entity.otm_projection and had no
 * censoring input; web_thread_close declared no return_censored, so strict
 * input rejected the whole call.
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
import {
  carriesEstimate,
  computeAccuracyRecord,
  pickScoredWindow,
  type PublishedWindowRow,
  type ScoredWindow,
} from "../src/servers/web/service.js";
import type { InjuryEntity } from "../src/servers/web/client.js";

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  inputSchema: { parse: (v: unknown) => Record<string, unknown>; safeParse: (v: unknown) => { success: boolean } };
}

function tool(name: string): RegisteredTool {
  const server = new McpServer({ name: "test-web", version: "1.0.0" }, { capabilities: { tools: {} } });
  registerWebTools(server);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  return tools[name]!;
}

const row = (over: Partial<PublishedWindowRow> & { status?: string }): PublishedWindowRow & { status?: string } => ({
  id: "p",
  return_to_play_min_weeks: 2,
  return_to_play_max_weeks: 6,
  rtp_confidence: "0.700",
  created_at: "2026-08-01T00:00:00Z",
  ...over,
});

beforeEach(() => mockSql.mockReset());

describe("A1.2 — carriesEstimate", () => {
  it("rejects the concussion no-estimate signature (Robinson, 0/0 at confidence 0)", () => {
    expect(
      carriesEstimate(row({ return_to_play_min_weeks: 0, return_to_play_max_weeks: 0, rtp_confidence: "0.000" })),
    ).toBe(false);
  });

  it("rejects confidence 0 even when weeks were filled in, and a zero ceiling at any confidence", () => {
    expect(carriesEstimate(row({ rtp_confidence: 0 }))).toBe(false);
    expect(carriesEstimate(row({ return_to_play_min_weeks: 0, return_to_play_max_weeks: 0 }))).toBe(false);
    expect(carriesEstimate(row({ rtp_confidence: null }))).toBe(false);
    expect(carriesEstimate(row({ return_to_play_max_weeks: null }))).toBe(false);
  });

  it("keeps a zero FLOOR with a real ceiling (Vaki, nasal fracture 0-2w)", () => {
    expect(carriesEstimate(row({ return_to_play_min_weeks: 0, return_to_play_max_weeks: 2, rtp_confidence: "0.820" }))).toBe(true);
  });
});

describe("A1.1 — pickScoredWindow", () => {
  it("takes the EARLIEST published estimate, not the latest (Pierce)", () => {
    const w = pickScoredWindow([
      row({ id: "aug", return_to_play_min_weeks: 0, return_to_play_max_weeks: 6, created_at: "2026-08-18T00:17:42Z" }),
      row({ id: "apr", return_to_play_min_weeks: 10, return_to_play_max_weeks: 16, created_at: "2026-04-20T20:17:40Z" }),
    ]);
    expect(w).toEqual({ post_id: "apr", min_weeks: 10, max_weeks: 16 });
  });

  it("skips a no-estimate post and a non-published post rather than stopping at them", () => {
    const w = pickScoredWindow([
      row({ id: "rejected", status: "REJECTED", created_at: "2026-08-01T00:00:00Z" }),
      row({ id: "concussion", return_to_play_min_weeks: 0, return_to_play_max_weeks: 0, rtp_confidence: "0", created_at: "2026-08-02T00:00:00Z" }),
      row({ id: "real", return_to_play_min_weeks: "1", return_to_play_max_weeks: "3", created_at: "2026-08-03T00:00:00Z" }),
    ]);
    expect(w).toEqual({ post_id: "real", min_weeks: 1, max_weeks: 3 });
  });

  it("returns null when nothing qualifies", () => {
    expect(pickScoredWindow([])).toBeNull();
    expect(pickScoredWindow([row({ rtp_confidence: "0.000", return_to_play_min_weeks: 0, return_to_play_max_weeks: 0 })])).toBeNull();
  });
});

describe("A1.3 — the interval rule", () => {
  // injury 2026-08-01; floor 2026-08-29 (4w); ceiling 2026-09-26 (8w).
  const entity = { injury_date: "2026-08-01" } as unknown as InjuryEntity;
  const window: ScoredWindow = { post_id: "p1", min_weeks: 4, max_weeks: 8 };

  it("scores a censored return that came BEFORE the floor as a miss", () => {
    const rec = computeAccuracyRecord(entity, "2026-08-20", { window, censored: true });
    expect(rec.scoreable).toBe(true);
    expect(rec.within_range).toBe(false);
    expect(rec.censored).toBe(true);
    expect(rec.error_days).not.toBeNull();
  });

  it("makes a censored return on or after the floor calendar_censored, with no verdict and no error", () => {
    for (const actual of ["2026-08-29", "2026-09-13", "2026-12-01"]) {
      const rec = computeAccuracyRecord(entity, actual, { window, censored: true });
      expect(rec.scoreable).toBe(false);
      expect(rec.unscoreable_reason).toBe("calendar_censored");
      expect(rec.within_range).toBeNull();
      expect(rec.error_days).toBeNull();
      expect(rec.censored).toBe(true);
    }
  });

  it("scores an uncensored return normally, and records unknown censoring as null", () => {
    const off = computeAccuracyRecord(entity, "2026-09-13", { window, censored: false });
    expect(off.within_range).toBe(true);
    expect(off.censored).toBe(false);
    const unknown = computeAccuracyRecord(entity, "2026-09-13", { window });
    expect(unknown.within_range).toBe(true);
    expect(unknown.censored).toBeNull();
  });

  it("does not let censoring outrank a missing projection", () => {
    const rec = computeAccuracyRecord(entity, "2026-09-13", { window: null, censored: true });
    expect(rec.unscoreable_reason).toBe("no_projection");
  });
});

describe("web_thread_close — return_censored", () => {
  const ENTITY_ID = "770e8400-e29b-41d4-a716-446655440002";

  it("is declared, so strict input accepts it and rejects a non-boolean", () => {
    const schema = tool("web_thread_close").inputSchema;
    const parsed = schema.parse({ entity_id: ENTITY_ID, actual_return_date: "2026-09-13", return_censored: true });
    expect(parsed.return_censored).toBe(true);
    expect(schema.safeParse({ entity_id: ENTITY_ID, return_censored: "yes" }).success).toBe(false);
  });

  it("reaches the stored record through the tool", async () => {
    const entity = {
      id: ENTITY_ID,
      player_id: "p",
      status: "ACTIVE",
      injury_date: "2026-08-01",
      actual_return_date: null,
      return_source: null,
      otm_projection: null,
    };
    mockSql
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([row({ id: "first", return_to_play_min_weeks: 4, return_to_play_max_weeks: 8, status: "PUBLISHED" })])
      .mockResolvedValueOnce([{ ...entity, status: "RESOLVED" }])
      .mockResolvedValueOnce([{ id: "audit-1" }]);

    const t = tool("web_thread_close");
    const args = t.inputSchema.parse({
      entity_id: ENTITY_ID,
      actual_return_date: "2026-09-13",
      closed_by: "system",
      return_censored: true,
    });
    await t.handler(args, {});

    const [, ...values] = mockSql.mock.calls[2] as [string[], ...unknown[]];
    const written = values.find((v) => typeof v === "string" && v.includes("unscoreable_reason")) as string;
    const rec = JSON.parse(written);
    expect(rec.unscoreable_reason).toBe("calendar_censored");
    expect(rec.scored_post_id).toBe("first");
    // otm_projection is null on this thread and the record still has a window:
    // the stored projection is no longer what is scored.
    expect(rec.otm_min_weeks).toBe(4);
  });
});

describe("web_list_threads — scored_window", () => {
  it("derives scored_window from the published rows and does not leak them", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([
        {
          id: "e1",
          status: "ACTIVE",
          injury_date: "2026-08-01",
          otm_projection: { min_weeks: 0, max_weeks: 0 },
          published_windows: [
            row({ id: "concussion", status: "PUBLISHED", return_to_play_min_weeks: 0, return_to_play_max_weeks: 0, rtp_confidence: 0 }),
          ],
        },
        {
          id: "e2",
          status: "ACTIVE",
          injury_date: "2026-08-01",
          otm_projection: null,
          published_windows: [row({ id: "w", status: "PUBLISHED" })],
        },
        { id: "e3", status: "ACTIVE", injury_date: null, otm_projection: null, published_windows: null },
      ]);
    const res = (await tool("web_list_threads").handler({ limit: 100, offset: 0 }, {})) as {
      content: Array<{ text: string }>;
    };
    const { threads } = JSON.parse(res.content[0].text);
    expect(threads[0].scored_window).toBeNull();
    expect(threads[1].scored_window).toEqual({ post_id: "w", min_weeks: 2, max_weeks: 6 });
    expect(threads[2].scored_window).toBeNull();
    for (const t of threads) expect(t).not.toHaveProperty("published_windows");
    const pageSql = (mockSql.mock.calls[1][0] as string[]).join("?");
    expect(pageSql).toMatch(/LEFT JOIN LATERAL/);
    expect(pageSql).toMatch(/ip\.status = 'PUBLISHED'/);
  });
});
