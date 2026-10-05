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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { withInputKeyPolicy } from "../src/shared/input-key-policy.js";
import { ledgerRowHash } from "../src/servers/web/ledger-hash.js";

/**
 * The ledger tools, driven the way production drives them: every call goes
 * through `tool.inputSchema.parse()` (or a real Client over InMemoryTransport
 * for the strict-key case), then the handler, with the SQL calls queued on
 * mockSql in the order the client issues them and inspected afterwards.
 *
 * What these pin:
 *  - publish re-derives the role and a non-MD is BLOCKED (a successful call
 *    with published:false), with no publish UPDATE issued;
 *  - a passing publish runs the entry-id CTE, writes row_hash from the stored
 *    row, opens five resolutions and audits who confirmed;
 *  - the ingest's propose writes a proposal row only;
 *  - confirm is one data-modifying CTE touching proposal and resolution;
 *  - an undeclared key is rejected whole under the strict policy.
 */

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

function makeServer(): McpServer {
  const server = new McpServer({ name: "t", version: "1.0.0" }, { capabilities: { tools: {} } });
  registerWebTools(server);
  return server;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

async function callParsed(server: McpServer, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = getTool(server, name);
  const parsed = tool.inputSchema.parse(args);
  const result = (await tool.handler(parsed, {})) as ToolResult;
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

const sqlText = (call: unknown[]): string => {
  const strings = call[0];
  return Array.isArray(strings) ? strings.join("$") : String(strings);
};
const issued = () => mockSql.mock.calls.map(sqlText);

const MD_ID = "11111111-1111-4111-8111-111111111111";
const EDITOR_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const mdUser = { id: MD_ID, email: "md@x.com", role: "md", name: "Dr. K. P. Johnson", created_at: "2026-01-01T00:00:00Z" };
const editorUser = { ...mdUser, id: EDITOR_ID, role: "editor" };

const DRAFT_ROW = {
  id: DRAFT_ID,
  status: "draft",
  entry_id: null,
  version: 1,
  published_at: null,
  trigger: null,
  player: "Example Player",
  team: "BUF",
  position: "WR",
  injury_date: new Date("2026-10-04T00:00:00.000Z"),
  reported_injury: "Grade 2 hamstring strain",
  source_tier: "B",
  source_urls: ["https://x.com/example/status/1"],
  mechanism: "Non-contact. Acceleration out of a cut. Q3 2:14.",
  base_rate_row: "hamstring_strain",
  base_rate_strength: "moderate",
  f1_ir: "0.1800",
  f2_next: "0.1200",
  f3_4wk: "0.6100",
  f4_point: 3,
  f4_low: 2,
  f4_high: 5,
  f5_reinjury: "0.2200",
  season_ending: false,
  what_moves_this: "An IR designation, or a limited practice by Thursday.",
  tier: 1,
  row_hash: null,
  confirmed_by: null,
  confirmed_at: null,
  commit_sha: null,
  commit_url: null,
  x_post_id: null,
  x_self_reply_id: null,
  farcaster_hash: null,
  reply_to_url: null,
  espn_athlete_id: null,
  gsis_id: null,
  pfr_id: null,
  nflverse_team: "BUF",
  season: 2026,
  player_id: null,
  entity_id: null,
  created_by: MD_ID,
  created_at: new Date("2026-10-04T20:00:00.000Z"),
  updated_at: new Date("2026-10-04T20:00:00.000Z"),
};

const PUBLISHED_AT = new Date("2026-10-06T18:04:05.123Z");
const PUBLISHED_ROW = {
  ...DRAFT_ROW,
  status: "published",
  entry_id: "PT-2026-001",
  published_at: PUBLISHED_AT,
  confirmed_by: MD_ID,
  confirmed_at: PUBLISHED_AT,
};

const auditRow = { id: "a1", ts: "t" };

beforeEach(() => {
  mockSql.mockReset();
});

describe("web_publish_ledger_forecast", () => {
  it("blocks a non-MD with published:false and issues no publish statement", async () => {
    const server = makeServer();
    mockSql
      .mockResolvedValueOnce([DRAFT_ROW]) // SELECT draft
      .mockResolvedValueOnce([editorUser]) // getUser
      .mockResolvedValueOnce([auditRow]); // audit publish_blocked
    const result = (await callParsed(server, "web_publish_ledger_forecast", { draft_id: DRAFT_ID, reviewer_user_id: EDITOR_ID })) as {
      published: boolean;
      gate: { role_ok: boolean; reasons: string[] };
    };
    expect(result.published).toBe(false);
    expect(result.gate.role_ok).toBe(false);
    expect(result.gate.reasons).toContain("reviewer is not an MD");
    const sql = issued();
    expect(sql.some((s) => s.includes("UPDATE ledger_forecasts"))).toBe(false);
    expect(sql.some((s) => s.includes("INSERT INTO audit_log"))).toBe(true);
    expect(mockSql.mock.calls[2][1]).toBe("system"); // actor for a non-MD caller
  });

  it("for an MD: allocates the entry id in the publish CTE, writes the hash of the STORED row once, opens five resolutions, audits the confirmer", async () => {
    const server = makeServer();
    const expectedHash = ledgerRowHash({ ...PUBLISHED_ROW, trigger: null } as never);
    mockSql
      .mockResolvedValueOnce([DRAFT_ROW]) // SELECT draft
      .mockResolvedValueOnce([mdUser]) // getUser
      .mockResolvedValueOnce([PUBLISHED_ROW]) // publish CTE RETURNING
      .mockResolvedValueOnce([{ ...PUBLISHED_ROW, row_hash: expectedHash }]) // hash write RETURNING
      .mockResolvedValueOnce([]) // open F1
      .mockResolvedValueOnce([]) // F2
      .mockResolvedValueOnce([]) // F3
      .mockResolvedValueOnce([]) // F4
      .mockResolvedValueOnce([]) // F5
      .mockResolvedValueOnce(["F1", "F2", "F3", "F4", "F5"].map((f) => ({ id: `r-${f}`, entry_id: "PT-2026-001", field: f, status: "open" }))) // SELECT resolutions
      .mockResolvedValueOnce([auditRow]); // audit publish

    const result = (await callParsed(server, "web_publish_ledger_forecast", { draft_id: DRAFT_ID, reviewer_user_id: MD_ID })) as {
      published: boolean;
      forecast: { entry_id: string; row_hash: string; status: string };
      resolutions: { field: string; status: string }[];
    };
    expect(result.published).toBe(true);
    expect(result.forecast.entry_id).toBe("PT-2026-001");
    expect(result.forecast.row_hash).toBe(expectedHash);
    expect(result.resolutions.map((r) => r.field)).toEqual(["F1", "F2", "F3", "F4", "F5"]);

    const sql = issued();
    const publish = sql[2];
    expect(publish).toContain("INSERT INTO ledger_entry_sequence");
    expect(publish).toContain("date_trunc('milliseconds', NOW())");
    expect(publish).toContain("lpad(seq.n::text, 3, '0')");
    expect(publish).toContain("status = 'draft' AND f.entry_id IS NULL");
    const hashWrite = sql[3];
    expect(hashWrite).toContain("SET row_hash =");
    expect(hashWrite).toContain("row_hash IS NULL");
    expect(mockSql.mock.calls[3][1]).toBe(expectedHash);
    expect(sql.filter((s) => s.includes("INSERT INTO ledger_resolutions")).length).toBe(5);
    const audit = mockSql.mock.calls[sql.length - 1];
    expect(audit[1]).toBe("md");
    expect(audit[2]).toBe(MD_ID);
    const payload = JSON.parse(audit[audit.length - 1] as string);
    expect(payload).toMatchObject({ entry_id: "PT-2026-001", version: 1, row_hash: expectedHash, confirmed_by: MD_ID });
  });

  it("publishes a revision WITHOUT touching the sequence, and refuses to move a locked field", async () => {
    const server = makeServer();
    const prev = { ...PUBLISHED_ROW, row_hash: "x".repeat(64) };
    const revDraft = { ...DRAFT_ROW, entry_id: "PT-2026-001", version: 2, trigger: "Placed on IR (2026-10-07)", f1_ir: "1.0000" };
    mockSql
      .mockResolvedValueOnce([revDraft]) // SELECT draft
      .mockResolvedValueOnce([mdUser]) // getUser
      .mockResolvedValueOnce([prev]) // previous published
      .mockResolvedValueOnce([{ id: "r1", entry_id: "PT-2026-001", field: "F1", status: "resolved" }]) // resolutions
      .mockResolvedValueOnce([auditRow]); // audit blocked
    const blocked = (await callParsed(server, "web_publish_ledger_forecast", { draft_id: DRAFT_ID, reviewer_user_id: MD_ID })) as {
      published: boolean;
      gate: { reasons: string[] };
    };
    expect(blocked.published).toBe(false);
    expect(blocked.gate.reasons).toEqual(["F1 is resolved and may not change in a revision"]);

    mockSql.mockReset();
    const okDraft = { ...revDraft, f1_ir: prev.f1_ir, f2_next: "0.0000" };
    const published = { ...okDraft, status: "published", published_at: new Date("2026-10-08T14:30:00.000Z"), confirmed_by: MD_ID, confirmed_at: new Date() };
    mockSql
      .mockResolvedValueOnce([okDraft])
      .mockResolvedValueOnce([mdUser])
      .mockResolvedValueOnce([prev])
      .mockResolvedValueOnce([{ id: "r1", entry_id: "PT-2026-001", field: "F1", status: "resolved" }])
      .mockResolvedValueOnce([published]) // plain UPDATE
      .mockResolvedValueOnce([{ ...published, row_hash: "h" }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([auditRow]);
    const result = (await callParsed(server, "web_publish_ledger_forecast", { draft_id: DRAFT_ID, reviewer_user_id: MD_ID })) as { published: boolean };
    expect(result.published).toBe(true);
    const publish = issued()[4];
    expect(publish).not.toContain("ledger_entry_sequence");
    expect(publish).toContain("status = 'published'");
  });
});

describe("web_propose_ledger_resolution and web_decide_ledger_proposal", () => {
  it("the ingest writes a proposal row and nothing else", async () => {
    const server = makeServer();
    mockSql
      .mockResolvedValueOnce([{ status: "open" }]) // resolution status
      .mockResolvedValueOnce([]) // no identical pending proposal
      .mockResolvedValueOnce([{ id: "p1", entry_id: "PT-2026-001", field: "F2", proposed_status: "resolved", proposed_outcome: "0", decision: "pending" }])
      .mockResolvedValueOnce([auditRow]);
    const result = (await callParsed(server, "web_propose_ledger_resolution", {
      entry_id: "PT-2026-001",
      field: "F2",
      proposed_status: "resolved",
      proposed_outcome: 0,
      outcome_date: "2026-10-11",
      freeze_at: "2026-10-11T17:00:00.000Z",
      evidence_url: "https://www.pro-football-reference.com/boxscores/202610110buf.htm",
      evidence: { game_ids: ["2026_05_OPP_BUF"], note: "0 snaps" },
    })) as { status: string; proposal: { id: string } };
    expect(result.status).toBe("created");
    const sql = issued();
    expect(sql.some((s) => s.includes("INSERT INTO ledger_resolution_proposals"))).toBe(true);
    expect(sql.some((s) => s.includes("UPDATE ledger_resolutions"))).toBe(false);
    expect(mockSql.mock.calls[3][1]).toBe("system");
  });

  it("a locked field takes no proposal; an identical pending proposal is returned, not duplicated", async () => {
    const server = makeServer();
    mockSql.mockResolvedValueOnce([{ status: "resolved" }]);
    const locked = (await callParsed(server, "web_propose_ledger_resolution", { entry_id: "PT-2026-001", field: "F2", proposed_status: "void", void_reason: "traded" })) as { status: string };
    expect(locked.status).toBe("field_locked");
    expect(issued()).toHaveLength(1);

    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([{ status: "open" }]).mockResolvedValueOnce([{ id: "p-existing", decision: "pending" }]);
    const dup = (await callParsed(server, "web_propose_ledger_resolution", { entry_id: "PT-2026-001", field: "F2", proposed_status: "void", void_reason: "traded" })) as { status: string; proposal: { id: string } };
    expect(dup.status).toBe("duplicate");
    expect(dup.proposal.id).toBe("p-existing");
  });

  it("confirm requires an MD and runs one CTE over proposal and resolution", async () => {
    const server = makeServer();
    mockSql.mockResolvedValueOnce([editorUser]);
    await expect(callParsed(server, "web_decide_ledger_proposal", { proposal_id: DRAFT_ID, reviewer_user_id: EDITOR_ID, decision: "confirmed" })).rejects.toThrow(/requires an MD/);
    expect(issued()).toHaveLength(1);

    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([mdUser])
      .mockResolvedValueOnce([{ proposal: { id: "p1", entry_id: "PT-2026-001", field: "F2", proposed_status: "resolved", proposed_outcome: "0", void_reason: null }, resolution: { id: "r2", entry_id: "PT-2026-001", field: "F2", status: "resolved", outcome: "0" } }])
      .mockResolvedValueOnce([auditRow]);
    const result = (await callParsed(server, "web_decide_ledger_proposal", { proposal_id: DRAFT_ID, reviewer_user_id: MD_ID, decision: "confirmed", note: "PFR confirms 0 snaps" })) as {
      resolution: { status: string };
    };
    expect(result.resolution.status).toBe("resolved");
    const cte = issued()[1];
    expect(cte).toContain("UPDATE ledger_resolution_proposals");
    expect(cte).toContain("UPDATE ledger_resolutions");
    expect(cte).toContain("x.status = 'open'");
    expect(cte).toContain("res.status = 'open'");
    const audit = mockSql.mock.calls[2];
    expect(audit[1]).toBe("md");
    expect(audit[2]).toBe(MD_ID);
  });

  it("confirm on a locked field is an error, not a silent no-op", async () => {
    const server = makeServer();
    mockSql.mockResolvedValueOnce([mdUser]).mockResolvedValueOnce([{ proposal: null, resolution: null }]);
    await expect(callParsed(server, "web_decide_ledger_proposal", { proposal_id: DRAFT_ID, reviewer_user_id: MD_ID, decision: "confirmed" })).rejects.toThrow(/not pending, or its field is no longer open/);
  });
});

describe("web_record_ledger_provenance", () => {
  it("writes with COALESCE so the first value sticks, and audits as system", async () => {
    const server = makeServer();
    mockSql.mockResolvedValueOnce([{ ...PUBLISHED_ROW, commit_sha: "abc1234", x_post_id: "1" }]).mockResolvedValueOnce([auditRow]);
    await callParsed(server, "web_record_ledger_provenance", { forecast_id: DRAFT_ID, commit_sha: "abc1234", commit_url: "https://github.com/kpjmd/paratros-ledger/commit/abc1234", x_post_id: "1" });
    const sql = issued()[0];
    expect(sql).toContain("commit_sha = COALESCE(commit_sha,");
    expect(sql).toContain("status = 'published'");
    expect(mockSql.mock.calls[1][1]).toBe("system");
  });
});

describe("web_record_ledger_correction, web_propose_reply, web_decide_reply", () => {
  it("a correction is an insert by an MD, never an update of a forecast", async () => {
    const server = makeServer();
    mockSql.mockResolvedValueOnce([mdUser]).mockResolvedValueOnce([{ id: "c1", entry_id: "PT-2026-001", field: "player", old_value: "A", new_value: "B", note: "wrong spelling" }]).mockResolvedValueOnce([auditRow]);
    await callParsed(server, "web_record_ledger_correction", { entry_id: "PT-2026-001", field: "player", old_value: "A", new_value: "B", note: "wrong spelling", corrected_by: MD_ID });
    const sql = issued();
    expect(sql[1]).toContain("INSERT INTO ledger_corrections");
    expect(sql.some((s) => s.includes("UPDATE ledger_forecasts"))).toBe(false);
  });

  it("a reply proposal posts nothing and a posted decision needs the platform id", async () => {
    const server = makeServer();
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "rp1", platform: "x", mention_id: "m1", decision: "pending" }]).mockResolvedValueOnce([auditRow]);
    const proposed = (await callParsed(server, "web_propose_reply", { platform: "x", mention_id: "m1", proposed_text: "Reference-class estimate: 2–4 games." })) as { status: string };
    expect(proposed.status).toBe("created");
    expect(mockSql.mock.calls[2][1]).toBe("agent");

    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mdUser]);
    await expect(callParsed(server, "web_decide_reply", { proposal_id: DRAFT_ID, reviewer_user_id: MD_ID, decision: "posted" })).rejects.toThrow(/posted_id/);
  });
});

describe("strict input policy covers the ledger tools", () => {
  it("rejects an undeclared key on web_publish_ledger_forecast whole", async () => {
    const server = new McpServer({ name: "t", version: "1.0.0" }, { capabilities: { tools: {} } });
    registerWebTools(withInputKeyPolicy(server, "strict"));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t-client", version: "1.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const r = (await client.callTool({ name: "web_publish_ledger_forecast", arguments: { draft_id: DRAFT_ID, reviewer_user_id: MD_ID, role: "md" } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Input validation error");
    expect(issued()).toHaveLength(0);
  });

  it("the draft schema refuses a probability above 1 and an F5 null is allowed", () => {
    const server = makeServer();
    const schema = getTool(server, "web_create_ledger_draft").inputSchema;
    const base = {
      ...Object.fromEntries(Object.entries(DRAFT_ROW).filter(([k]) => ["player", "team", "position", "reported_injury", "source_tier", "source_urls", "mechanism", "base_rate_row", "base_rate_strength", "f4_point", "f4_low", "f4_high", "season_ending", "what_moves_this", "tier"].includes(k))),
      injury_date: "2026-10-04",
      f1_ir: 0.18,
      f2_next: 0.12,
      f3_4wk: 0.61,
      f5_reinjury: null,
      created_by: MD_ID,
    };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, f1_ir: 1.2 }).success).toBe(false);
    expect(schema.safeParse({ ...base, tier: 3 }).success).toBe(false);
  });
});
