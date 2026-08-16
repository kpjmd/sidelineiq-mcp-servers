import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deliberately does NOT mock the client — farcaster.test.ts covers the tool
// layer with a mocked client, which is exactly why the /notifications query
// string could be malformed for four months without a test noticing.
vi.stubEnv("NEYNAR_API_KEY", "test-key");
vi.stubEnv("NEYNAR_SIGNER_UUID", "test-signer");

import { NeynarClient } from "../src/servers/farcaster/client.js";
import { McpToolError } from "../src/shared/errors.js";

const mockFetch = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function requestedUrl(): string {
  return String(mockFetch.mock.calls[0]?.[0] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NeynarClient — /notifications query encoding", () => {
  it("sends type as repeated plural params, not a comma-joined scalar", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ notifications: [] }));

    await new NeynarClient().getNotifications(12345);

    const url = requestedUrl();
    // Neynar rejects the old shape with 400 InvalidField: "type must be an
    // array of one or more of: likes, replies, recasts, mentions, follows,
    // quotes".
    expect(url).toContain("type=mentions");
    expect(url).toContain("type=replies");
    expect(url).not.toContain("mention%2Creply");
    expect(url).not.toContain("type=mention&");

    const params = new URL(url).searchParams;
    expect(params.getAll("type")).toEqual(["mentions", "replies"]);
    expect(params.get("fid")).toBe("12345");
    expect(params.get("limit")).toBe("25");
  });

  it("still sets scalar params exactly once", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ notifications: [] }));

    await new NeynarClient().getNotifications(1, "cursor-abc", 50);

    const params = new URL(requestedUrl()).searchParams;
    expect(params.getAll("limit")).toEqual(["50"]);
    expect(params.getAll("cursor")).toEqual(["cursor-abc"]);
  });

  it("accepts singular or plural type values in the response", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        notifications: [
          { type: "mentions", cast: { hash: "0x1", text: "plural mention" } },
          { type: "reply", cast: { hash: "0x2", text: "singular reply" } },
          { type: "recasts", cast: { hash: "0x3", text: "not a type we handle" } },
        ],
      }),
    );

    const result = await new NeynarClient().getNotifications(1);

    // Normalised to the singular form every consumer downstream expects.
    expect(result.notifications.map((n) => n.type)).toEqual(["mention", "reply"]);
    expect(result.notifications.map((n) => n.hash)).toEqual(["0x1", "0x2"]);
  });
});

describe("NeynarClient — error status handling", () => {
  it("returns an empty result on 429 instead of throwing", async () => {
    // Previously unreachable: the branch matched on the message containing
    // "429", but the thrown message is "Neynar API rate limit exceeded".
    mockFetch.mockResolvedValue(jsonResponse({ message: "rate limited" }, 429));

    const result = await new NeynarClient().getNotifications(1);

    expect(result.notifications).toEqual([]);
  });

  it("propagates a 400 with the status attached", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ code: "InvalidField" }, 400));

    await expect(new NeynarClient().getNotifications(1)).rejects.toMatchObject({
      status: 400,
      userMessage: "Neynar API returned status 400",
    });
  });

  it("attaches 403 to the signer-not-approved error", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: "forbidden" }, 403));

    const err = await new NeynarClient()
      .publishCast("hello")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(403);
  });
});

describe("NeynarClient — publishCast is unaffected by the params change", () => {
  it("POSTs to /cast with the signer and returns the hash", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ cast: { hash: "0xabc", timestamp: "2026-08-16T00:00:00Z" } }),
    );

    const result = await new NeynarClient().publishCast("Breaking: ACL tear");

    expect(requestedUrl()).toBe("https://api.neynar.com/v2/farcaster/cast");
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      signer_uuid: "test-signer",
      text: "Breaking: ACL tear",
    });
    expect(result.hash).toBe("0xabc");
  });
});
