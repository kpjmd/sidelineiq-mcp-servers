import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

// Baseline instrumentation (024_metrics.sql): the two profile-stats reads, the
// four metric/click tools, and the click summary. The social clients are NOT
// mocked at the class level — they are exercised against RECORDED responses
// (tests/fixtures/neynar-user-bulk.json, x-users-me.json, captured from the
// production accounts 2026-09-13), because a hand-written fixture is exactly
// how this repo's shape bugs have survived before.

const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));
vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: vi.fn(() => false),
  classifyDeskPost: vi.fn(),
}));

const mockMe = vi.fn();
vi.mock("twitter-api-v2", () => ({
  TwitterApi: vi.fn().mockImplementation(() => ({ v2: { me: mockMe } })),
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
import { NeynarClient } from "../src/servers/farcaster/client.js";
import { TwitterClient } from "../src/servers/twitter/client.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { withInputKeyPolicy } from "../src/shared/input-key-policy.js";
import { summarizeCtaClicks } from "../src/servers/web/service.js";
import { McpToolError } from "../src/shared/errors.js";

const neynarFixture = JSON.parse(
  readFileSync(new URL("./fixtures/neynar-user-bulk.json", import.meta.url), "utf8"),
);
const xFixture = JSON.parse(
  readFileSync(new URL("./fixtures/x-users-me.json", import.meta.url), "utf8"),
);
const FIXTURE_FID = String(neynarFixture.users[0].fid);

const mockFetch = vi.fn();
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("SIDELINEIQ_FARCASTER_FID", FIXTURE_FID);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NeynarClient.getProfileStats", () => {
  it("reads the recorded /user/bulk response", async () => {
    mockFetch.mockResolvedValue(jsonResponse(neynarFixture));

    const stats = await new NeynarClient().getProfileStats();

    expect(stats).toEqual({
      fid: neynarFixture.users[0].fid,
      username: neynarFixture.users[0].username,
      follower_count: neynarFixture.users[0].follower_count,
      following_count: neynarFixture.users[0].following_count,
    });
    const url = new URL(String(mockFetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/v2/farcaster/user/bulk");
    expect(url.searchParams.get("fids")).toBe(FIXTURE_FID);
  });

  it("throws when the FID env var is missing, without calling Neynar", async () => {
    vi.stubEnv("SIDELINEIQ_FARCASTER_FID", "");
    await expect(new NeynarClient().getProfileStats()).rejects.toThrow(McpToolError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws on a non-numeric FID", async () => {
    vi.stubEnv("SIDELINEIQ_FARCASTER_FID", "sidelineiq");
    await expect(new NeynarClient().getProfileStats()).rejects.toThrow(/positive integer/);
  });

  it("throws rather than returning 0 when the count is missing", async () => {
    const user = { ...neynarFixture.users[0] };
    delete user.follower_count;
    mockFetch.mockResolvedValue(jsonResponse({ users: [user] }));
    await expect(new NeynarClient().getProfileStats()).rejects.toThrow(/non-numeric/);
  });

  it("throws when Neynar returns a different user", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ users: [{ ...neynarFixture.users[0], fid: 1 }] }),
    );
    await expect(new NeynarClient().getProfileStats()).rejects.toThrow(/no user/);
  });

  it("surfaces a rate limit as an error", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: "slow down" }, 429));
    await expect(new NeynarClient().getProfileStats()).rejects.toThrow(/rate limit/);
  });
});

describe("TwitterClient.getProfileStats", () => {
  it("reads the recorded users/me response", async () => {
    mockMe.mockResolvedValue(xFixture);

    const stats = await new TwitterClient().getProfileStats();

    expect(stats).toEqual({
      id: xFixture.data.id,
      username: xFixture.data.username,
      followers_count: xFixture.data.public_metrics.followers_count,
      following_count: xFixture.data.public_metrics.following_count,
      tweet_count: xFixture.data.public_metrics.tweet_count,
    });
    expect(mockMe).toHaveBeenCalledWith({ "user.fields": ["public_metrics"] });
  });

  it("throws rather than returning 0 when public_metrics is absent", async () => {
    const { public_metrics: _omit, ...data } = xFixture.data;
    mockMe.mockResolvedValue({ data });
    await expect(new TwitterClient().getProfileStats()).rejects.toThrow(/public_metrics/);
  });

  it("maps a 429 through the shared Twitter error handler", async () => {
    mockMe.mockRejectedValue(Object.assign(new Error("Too Many Requests"), { code: 429 }));
    await expect(new TwitterClient().getProfileStats()).rejects.toThrow(/rate limit/);
  });
});

// ── Web tools, through a real Client so zod and the strict key policy run ──
async function callWeb(name: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: "t", version: "1.0.0" }, { capabilities: { tools: {} } });
  registerWebTools(withInputKeyPolicy(server, "strict"));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t-client", version: "1.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

function sqlCalls(fragment: string) {
  return mockSql.mock.calls.filter(([strings]) =>
    Array.isArray(strings) ? strings.join("$").includes(fragment) : false,
  );
}

describe("web_record_metric_snapshot", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([
      { metric: "x_followers", day: "2026-09-13", value: 11, source: "x_api", detail: null, recorded_at: "t" },
    ]);
  });

  it("upserts a valid reading", async () => {
    const result = await callWeb("web_record_metric_snapshot", {
      metric: "x_followers",
      value: 11,
      source: "x_api",
    });
    expect(result.isError).toBeUndefined();
    const [call] = sqlCalls("INSERT INTO metric_snapshots");
    expect(call).toBeDefined();
    expect(call[0].join("$")).toContain("ON CONFLICT (metric, day) DO UPDATE");
    expect(call.slice(1)).toContain(11);
  });

  it.each([
    ["an unknown metric", { metric: "x_follower", value: 1, source: "x_api" }],
    ["a negative value", { metric: "x_followers", value: -1, source: "x_api" }],
    ["a fractional value", { metric: "x_followers", value: 1.5, source: "x_api" }],
    ["an unknown source", { metric: "x_followers", value: 1, source: "guess" }],
    ["a malformed day", { metric: "x_followers", value: 1, source: "x_api", day: "2026-09" }],
    ["an undeclared key", { metric: "x_followers", value: 1, source: "x_api", confidence: 1 }],
  ])("rejects %s without touching the database", async (_label, args) => {
    const result = await callWeb("web_record_metric_snapshot", args);
    expect(result.isError).toBe(true);
    expect(sqlCalls("metric_snapshots")).toHaveLength(0);
  });
});

describe("web_increment_cta_click", () => {
  beforeEach(() => mockSql.mockReset());

  it("counts only a click on an existing PUBLISHED post", async () => {
    mockSql.mockResolvedValue([{ clicks: 1 }]);
    const result = await callWeb("web_increment_cta_click", {
      post_slug: "acl-tears-2026-09-13",
      link: "cta",
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ counted: true });
    const [call] = sqlCalls("INSERT INTO cta_click_daily");
    const text = call[0].join("$");
    expect(text).toContain("WHERE EXISTS");
    expect(text).toContain("status = 'PUBLISHED'");
    expect(text).toContain("clicks = cta_click_daily.clicks + 1");
  });

  it("reports counted=false when no published post matched", async () => {
    mockSql.mockResolvedValue([]);
    const result = await callWeb("web_increment_cta_click", {
      post_slug: "no-such-post",
      link: "byline",
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ counted: false });
  });

  it.each([
    ["an uppercase slug", { post_slug: "ACL-Tears", link: "cta" }],
    ["a path in the slug", { post_slug: "../admin", link: "cta" }],
    ["an unknown link", { post_slug: "acl-tears", link: "footer" }],
    ["an undeclared key", { post_slug: "acl-tears", link: "cta", ip: "1.2.3.4" }],
  ])("rejects %s", async (_label, args) => {
    const result = await callWeb("web_increment_cta_click", args);
    expect(result.isError).toBe(true);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe("summarizeCtaClicks", () => {
  it("totals by link and by post, busiest post first", () => {
    const summary = summarizeCtaClicks([
      { day: "2026-09-13", post_slug: "acl", link: "cta", clicks: 2 },
      { day: "2026-09-13", post_slug: "acl", link: "byline", clicks: 1 },
      { day: "2026-09-14", post_slug: "hamstring", link: "cta", clicks: 4 },
    ]);
    expect(summary.total).toBe(7);
    expect(summary.by_link).toEqual({ cta: 6, byline: 1 });
    expect(summary.by_post).toEqual([
      { post_slug: "hamstring", clicks: 4 },
      { post_slug: "acl", clicks: 3 },
    ]);
  });

  it("carries both link keys when there are no rows", () => {
    expect(summarizeCtaClicks([])).toEqual({ rows: [], total: 0, by_link: { cta: 0, byline: 0 }, by_post: [] });
  });
});
