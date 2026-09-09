import { describe, it, expect, vi, beforeEach } from "vitest";

// A human's injury_date outranks a machine's re-derivation.
//
// updateThreadDates' UPDATE is COALESCE(param, column) — param FIRST, so
// anything a caller supplies OVERWRITES what is stored. The agents poller calls
// it on every cycle that reaches resolveThreadAndDates, carrying a freshly
// resolved date, so an MD's hand correction was reverted on the next
// pass-through cycle. Thread 83951acd took four corrections and four reverts in
// three days, one of them seven minutes after the edit, flipping 2025-12-14
// back to 2024-12-14 and re-anchoring the projected return into the past.
//
// These assert on the VALUES BOUND to the UPDATE rather than on a return value,
// because the whole guarantee is which parameter reaches that COALESCE.
//
// FAILS-ON-OLD marks the tests that pass the opposite way against pre-fix code
// (the date was bound and overwrote). FAIL-CLOSED marks the ones that pass in
// both directions and exist to pin that normal operation is untouched.

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

const ENTITY = "5768e69a-a198-4542-aa5c-e67294f0bb5d";
const MD_DATE = "2025-12-14";
const MACHINE_DATE = "2024-12-14"; // exactly one year off, as observed live

function stmt(call: unknown[]): string {
  const first = call[0];
  return (Array.isArray(first) ? first.join(" ? ") : String(first))
    .replace(/\s+/g, " ")
    .trim();
}

/** The parameters bound to the injury_entities UPDATE, in order. */
function entityUpdateParams(): unknown[] {
  const call = mockSql.mock.calls.find((c) =>
    /UPDATE injury_entities SET/i.test(stmt(c)),
  );
  if (!call) throw new Error("no injury_entities UPDATE was issued");
  return call.slice(1);
}

/** injury_date is the FIRST bound parameter of that UPDATE. */
function boundInjuryDate(): unknown {
  return entityUpdateParams()[0];
}

function auditActions(): string[] {
  return mockSql.mock.calls
    .filter((c) => /INSERT INTO audit_log/i.test(stmt(c)))
    .flatMap((c) => c.slice(1).filter((v) => typeof v === "string"))
    .filter((v) => typeof v === "string" && /^[a-z_]+$/.test(v as string)) as string[];
}

function storedEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTITY,
    injury_date: MD_DATE,
    injury_date_confidence: "confirmed",
    surgery_date: null,
    surgery_confirmed: true,
    date_resolution_sources: [{ stage: "md_manual" }],
    otm_projection: { min_weeks: 39, max_weeks: 52 },
    canonical_post_id: null,
    needs_date_review: false,
    ...overrides,
  };
}

/** getEntity SELECT → UPDATE ... RETURNING * → any audit inserts. */
function stubEntity(overrides: Record<string, unknown> = {}) {
  const row = storedEntity(overrides);
  mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
    if (/UPDATE injury_entities SET/i.test(text)) return [row];
    if (/SELECT \* FROM injury_entities/i.test(text)) return [row];
    return [];
  });
}

/** What the agents poller sends every cycle: a re-derived date, no updated_by. */
const SYSTEM_WRITE = {
  entity_id: ENTITY,
  injury_date: MACHINE_DATE,
  injury_date_confidence: "probable",
  date_resolution_sources: [{ stage: "web_search" }],
  needs_date_review: false,
};

beforeEach(() => {
  mockSql.mockReset();
});

describe("a system write cannot overwrite an MD's date", () => {
  it("FAILS-ON-OLD: binds NULL for injury_date, so COALESCE keeps the stored value", async () => {
    stubEntity();
    await tool("web_thread_update_dates").handler(SYSTEM_WRITE, {});
    // Pre-fix this bound "2024-12-14" and the COALESCE overwrote the MD's date.
    expect(boundInjuryDate()).toBeNull();
  });

  it("FAILS-ON-OLD: also refuses the confidence, provenance and review flag", async () => {
    stubEntity();
    await tool("web_thread_update_dates").handler(SYSTEM_WRITE, {});
    const params = entityUpdateParams();
    expect(params[0]).toBeNull(); // injury_date
    expect(params[1]).toBeNull(); // injury_date_confidence
    expect(params[4]).toBeNull(); // date_resolution_sources — keeps md_manual
    // Re-flagging an MD-answered thread for review is the same override.
    expect(params.some((p) => p === true)).toBe(false);
  });

  it("FAILS-ON-OLD: does not re-anchor the projection to the refused date", async () => {
    // The revert's worst effect: projected_return_date followed the date back
    // to 2025-10-28, a projected return in the past.
    stubEntity();
    await tool("web_thread_update_dates").handler(SYSTEM_WRITE, {});
    expect(auditActions()).not.toContain("otm_projection_reanchored");
  });

  it("records the refusal, because the silence is what made this expensive to find", async () => {
    stubEntity();
    await tool("web_thread_update_dates").handler(SYSTEM_WRITE, {});
    expect(auditActions()).toContain("md_date_write_refused");
  });

  it("stays quiet when the machine re-derived the SAME date", async () => {
    stubEntity();
    await tool("web_thread_update_dates").handler(
      { ...SYSTEM_WRITE, injury_date: MD_DATE },
      {},
    );
    expect(auditActions()).not.toContain("md_date_write_refused");
  });

  it('treats an explicit updated_by "system" the same as none', async () => {
    stubEntity();
    await tool("web_thread_update_dates").handler(
      { ...SYSTEM_WRITE, updated_by: "system" },
      {},
    );
    expect(boundInjuryDate()).toBeNull();
  });
});

describe("what the guard deliberately does not block", () => {
  it("FAIL-CLOSED: an MD can always correct their own correction", async () => {
    stubEntity();
    await tool("web_thread_update_dates").handler(
      {
        entity_id: ENTITY,
        injury_date: "2025-12-20",
        injury_date_confidence: "confirmed",
        date_resolution_sources: [{ stage: "md_manual" }],
        updated_by: "md-user-1",
      },
      {},
    );
    expect(boundInjuryDate()).toBe("2025-12-20");
  });

  it("FAIL-CLOSED: normal machine resolution is untouched when no MD has ruled", async () => {
    // The overwhelmingly common path — the poller establishing a date on a
    // thread nobody has hand-corrected. This must behave exactly as before.
    stubEntity({
      date_resolution_sources: [{ stage: "web_search" }],
      injury_date: MACHINE_DATE,
    });
    await tool("web_thread_update_dates").handler(
      { ...SYSTEM_WRITE, injury_date: "2026-09-08" },
      {},
    );
    expect(boundInjuryDate()).toBe("2026-09-08");
  });

  it("FAIL-CLOSED: a thread with no provenance recorded is still machine-writable", async () => {
    stubEntity({ date_resolution_sources: null, injury_date: null });
    await tool("web_thread_update_dates").handler(SYSTEM_WRITE, {});
    expect(boundInjuryDate()).toBe(MACHINE_DATE);
  });

  it("FAIL-CLOSED: canonical_post_id backfill still works on an MD-held thread", async () => {
    // Bookkeeping, not the date decision — maintainEntity must keep working.
    stubEntity();
    await tool("web_thread_update_dates").handler(
      { entity_id: ENTITY, canonical_post_id: "550e8400-e29b-41d4-a716-446655440000" },
      {},
    );
    expect(entityUpdateParams()).toContain("550e8400-e29b-41d4-a716-446655440000");
  });
});
