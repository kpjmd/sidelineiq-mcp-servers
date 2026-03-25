import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the client before importing tools
const mockPublishTweet = vi.fn();
const mockGetTweet = vi.fn();
const mockDeleteTweet = vi.fn();

vi.mock("../src/servers/twitter/client.js", () => ({
  TwitterClient: vi.fn().mockImplementation(() => ({
    publishTweet: mockPublishTweet,
    getTweet: mockGetTweet,
    deleteTweet: mockDeleteTweet,
  })),
}));

// Mock env vars
vi.stubEnv("TWITTER_API_KEY", "test-key");
vi.stubEnv("TWITTER_API_SECRET", "test-secret");
vi.stubEnv("TWITTER_ACCESS_TOKEN", "test-token");
vi.stubEnv("TWITTER_ACCESS_TOKEN_SECRET", "test-token-secret");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTwitterTools } from "../src/servers/twitter/tools.js";

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "test-twitter", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTwitterTools(server);
  return server;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("Twitter MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("twitter_publish_tweet", () => {
    it("should publish a tweet successfully", async () => {
      mockPublishTweet.mockResolvedValue({
        id: "1234567890",
        text: "Breaking: ACL injury confirmed",
        timestamp: "2026-03-24T00:00:00Z",
        url: "https://x.com/i/web/status/1234567890",
      });

      const server = createTestServer();
      const tool = getTool(server, "twitter_publish_tweet");

      const result = (await tool.handler({ text: "Breaking: ACL injury confirmed" }, {})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe("1234567890");
      expect(data.url).toContain("1234567890");
    });

    it("should handle rate limit errors", async () => {
      const err = new Error("Rate limit exceeded");
      (err as unknown as { code: number }).code = 429;
      mockPublishTweet.mockRejectedValue(err);

      const server = createTestServer();
      const tool = getTool(server, "twitter_publish_tweet");

      const result = (await tool.handler({ text: "Test tweet" }, {})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("twitter_publish_thread", () => {
    it("should chain tweets as replies", async () => {
      mockPublishTweet
        .mockResolvedValueOnce({
          id: "100",
          text: "Tweet 1",
          timestamp: "2026-03-24T00:00:00Z",
          url: "https://x.com/i/web/status/100",
        })
        .mockResolvedValueOnce({
          id: "101",
          text: "Tweet 2",
          timestamp: "2026-03-24T00:00:01Z",
          url: "https://x.com/i/web/status/101",
        });

      const server = createTestServer();
      const tool = getTool(server, "twitter_publish_thread");

      const result = (await tool.handler(
        { tweets: ["Tweet 1", "Tweet 2"] },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.ids).toEqual(["100", "101"]);
      expect(data.tweet_count).toBe(2);

      // Verify chaining
      expect(mockPublishTweet).toHaveBeenCalledTimes(2);
      expect(mockPublishTweet.mock.calls[0]).toEqual(["Tweet 1", undefined]);
      expect(mockPublishTweet.mock.calls[1]).toEqual(["Tweet 2", "100"]);
    });
  });

  describe("twitter_get_tweet", () => {
    it("should retrieve a tweet by ID", async () => {
      mockGetTweet.mockResolvedValue({
        id: "1234567890",
        text: "Test tweet",
        timestamp: "2026-03-24T00:00:00Z",
        metrics: { retweet_count: 10, reply_count: 3, like_count: 25, impression_count: 1000 },
      });

      const server = createTestServer();
      const tool = getTool(server, "twitter_get_tweet");

      const result = (await tool.handler({ id: "1234567890" }, {})) as {
        content: Array<{ text: string }>;
      };
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe("1234567890");
      expect(data.metrics.like_count).toBe(25);
    });
  });

  describe("twitter_delete_tweet", () => {
    it("should delete a tweet by ID", async () => {
      mockDeleteTweet.mockResolvedValue({
        success: true,
        deleted_id: "1234567890",
      });

      const server = createTestServer();
      const tool = getTool(server, "twitter_delete_tweet");

      const result = (await tool.handler({ id: "1234567890" }, {})) as {
        content: Array<{ text: string }>;
      };
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.deleted_id).toBe("1234567890");
    });
  });
});
