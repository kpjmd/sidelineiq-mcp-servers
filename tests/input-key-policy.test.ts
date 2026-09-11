import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));
vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: vi.fn(() => false),
  classifyDeskPost: vi.fn(),
}));
vi.mock("../src/servers/farcaster/client.js", () => ({
  NeynarClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../src/servers/twitter/client.js", () => ({
  TwitterClient: vi.fn().mockImplementation(() => ({})),
}));
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
vi.stubEnv("NEYNAR_API_KEY", "test-key");
vi.stubEnv("NEYNAR_SIGNER_UUID", "test-signer");
vi.stubEnv("TWITTER_API_KEY", "test-key");
vi.stubEnv("TWITTER_API_SECRET", "test-secret");
vi.stubEnv("TWITTER_ACCESS_TOKEN", "test-token");
vi.stubEnv("TWITTER_ACCESS_TOKEN_SECRET", "test-token-secret");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { registerFarcasterTools } from "../src/servers/farcaster/tools.js";
import { registerTwitterTools } from "../src/servers/twitter/tools.js";
import {
  withInputKeyPolicy,
  unknownKeyMode,
  type UnknownKeyMode,
} from "../src/shared/input-key-policy.js";

/**
 * Every test here goes through a real Client over an in-memory transport, so
 * tools/call reaches McpServer.validateToolInput exactly as production does.
 * The suite's usual `getTool(...).handler(args)` calls the raw callback and
 * never runs zod at all — which is why a stripped key was invisible to it.
 */

const REGISTRARS: Record<string, (s: McpServer) => void> = {
  web: registerWebTools,
  farcaster: registerFarcasterTools,
  twitter: registerTwitterTools,
};

async function connect(register: (s: McpServer) => void, mode: UnknownKeyMode): Promise<Client> {
  const server = new McpServer({ name: "t", version: "1.0.0" }, { capabilities: { tools: {} } });
  register(withInputKeyPolicy(server, mode));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t-client", version: "1.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
async function call(mode: UnknownKeyMode, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const client = await connect(registerWebTools, mode);
  return (await client.callTool({ name, arguments: args })) as CallResult;
}
const isInputRejection = (r: CallResult) =>
  r.isError === true && r.content[0].text.includes("Input validation error");

const VALID_CREATE = {
  athlete_name: "A.J. Brown",
  sport: "NFL",
  team: "New England Patriots",
  injury_type: "High ankle sprain",
  injury_severity: "MODERATE",
  content_type: "BREAKING",
  headline: "A.J. Brown Listed Questionable",
  clinical_summary: "Right high ankle sprain.",
  return_to_play_estimate: {
    min_weeks: 4,
    max_weeks: 20,
    probability_week_2: 0.05,
    probability_week_4: 0.25,
    probability_week_8: 0.65,
    confidence: 0.55,
  },
  md_review_confidence: 0.72,
};

beforeEach(() => {
  mockSql.mockReset();
  // Slug probe, then the create's RETURNING row; list/count calls get [].
  mockSql.mockImplementation(async (strings: string[] | string) => {
    const sql = Array.isArray(strings) ? strings.join("$") : String(strings);
    if (sql.includes("INSERT INTO injury_posts")) {
      return [{ id: "p1", slug: "s", created_at: "t", status: "PUBLISHED", md_review_filed: false }];
    }
    if (/count\(/i.test(sql)) return [{ total: "0" }];
    return [];
  });
});

describe("tools/list is byte-identical under strict and strip", () => {
  // zod-to-json-schema already rendered "strip" as additionalProperties:false,
  // so strict changes what the server ENFORCES and nothing it ADVERTISES. Any
  // diff here means a description or a type was lost in the rebuild.
  for (const [serverName, register] of Object.entries(REGISTRARS)) {
    it(serverName, async () => {
      const [strict, strip] = await Promise.all([
        connect(register, "strict").then((c) => c.listTools()),
        connect(register, "strip").then((c) => c.listTools()),
      ]);
      expect(strict.tools.length).toBeGreaterThan(0);
      expect(JSON.stringify(strict)).toBe(JSON.stringify(strip));
    });
  }

  it("covers all 71 tools", async () => {
    const counts = await Promise.all(
      Object.values(REGISTRARS).map((r) => connect(r, "strict").then((c) => c.listTools())),
    );
    expect(counts.reduce((n, l) => n + l.tools.length, 0)).toBe(71);
  });
});

describe("strict rejects an undeclared key at any depth", () => {
  it("top level — the md_review_confidence bug, as it was sent", async () => {
    const strict = await call("strict", "web_create_injury_post", { ...VALID_CREATE, confidence: 0.72 });
    expect(isInputRejection(strict)).toBe(true);
    expect(strict.content[0].text).toMatch(/Unrecognized key.*confidence/s);

    // The old behaviour, for contrast: the same call SUCCEEDS and the key is gone.
    const strip = await call("strip", "web_create_injury_post", { ...VALID_CREATE, confidence: 0.72 });
    expect(strip.isError).toBeUndefined();
  });

  it("nested — inside return_to_play_estimate", async () => {
    const r = await call("strict", "web_create_injury_post", {
      ...VALID_CREATE,
      return_to_play_estimate: { ...VALID_CREATE.return_to_play_estimate, rationale: "x" },
    });
    expect(isInputRejection(r)).toBe(true);
    expect(r.content[0].text).toMatch(/rationale/);
  });

  it("inside an array element", async () => {
    const r = await call("strict", "web_thread_update_dates", {
      entity_id: "550e8400-e29b-41d4-a716-446655440000",
      date_resolution_sources: [{ stage: "api", url: "https://example.com", snippet: "x" }],
    });
    expect(isInputRejection(r)).toBe(true);
    expect(r.content[0].text).toMatch(/snippet/);
  });

  it("inside web_update_injury_post's `updates` — a stripped update was a silent no-op", async () => {
    const r = await call("strict", "web_update_injury_post", {
      post_id: "550e8400-e29b-41d4-a716-446655440000",
      updates: { md_review_confidence: 0.5 },
      update_reason: "x",
    });
    expect(isInputRejection(r)).toBe(true);
  });
});

describe("strict leaves the rest of the contract alone", () => {
  it("accepts a fully declared call", async () => {
    const r = await call("strict", "web_create_injury_post", VALID_CREATE);
    expect(r.isError).toBeUndefined();
  });

  it("keeps open-by-design fields open (z.record / z.unknown)", async () => {
    const r = await call("strict", "web_audit_append", {
      actor: "automation",
      entity_type: "injury_post",
      action: "test",
      payload: { anything: 1, nested: { at: "all" } },
      before: { whatever: true },
    });
    expect(isInputRejection(r)).toBe(false);
  });

  it("still applies defaults — a strict rebuild must not drop ZodDefault", async () => {
    await call("strict", "web_list_posts", {});
    const listCall = mockSql.mock.calls.find(([s]) =>
      (Array.isArray(s) ? s.join("$") : String(s)).includes("LIMIT"),
    );
    expect(listCall).toBeDefined();
    // listPosts binds (query, [...filters, limit, offset]): the default limit
    // of 20 and offset of 0 must survive the rebuild.
    expect(listCall![1]).toEqual([20, 0]);
  });
});

describe("the lever", () => {
  it("defaults to strict, and only an explicit 'strip' reopens it", () => {
    expect(unknownKeyMode({})).toBe("strict");
    expect(unknownKeyMode({ MCP_UNKNOWN_KEYS: "strip" })).toBe("strip");
    expect(unknownKeyMode({ MCP_UNKNOWN_KEYS: " STRIP " })).toBe("strip");
    // A typo must not silently reopen the hole.
    expect(unknownKeyMode({ MCP_UNKNOWN_KEYS: "stirp" })).toBe("strict");
    expect(unknownKeyMode({ MCP_UNKNOWN_KEYS: "off" })).toBe("strict");
  });
});
