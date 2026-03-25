import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the client before importing tools
const mockPublishCast = vi.fn();
const mockGetCast = vi.fn();
const mockDeleteCast = vi.fn();

vi.mock("../src/servers/farcaster/client.js", () => ({
  NeynarClient: vi.fn().mockImplementation(() => ({
    publishCast: mockPublishCast,
    getCast: mockGetCast,
    deleteCast: mockDeleteCast,
  })),
}));

// Mock env vars for client constructor
vi.stubEnv("NEYNAR_API_KEY", "test-key");
vi.stubEnv("NEYNAR_SIGNER_UUID", "test-signer");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFarcasterTools } from "../src/servers/farcaster/tools.js";

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "test-farcaster", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFarcasterTools(server);
  return server;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("Farcaster MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("farcaster_publish_cast", () => {
    it("should publish a cast successfully", async () => {
      mockPublishCast.mockResolvedValue({
        hash: "0xabc123",
        timestamp: "2026-03-24T00:00:00Z",
        url: "https://warpcast.com/~/conversations/0xabc123",
      });

      const server = createTestServer();
      const tool = getTool(server, "farcaster_publish_cast");

      const result = (await tool.handler({ text: "Breaking: Player X suffers ACL injury" }, {})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      expect(data.hash).toBe("0xabc123");
      expect(mockPublishCast).toHaveBeenCalledOnce();
    });

    it("should handle API errors gracefully", async () => {
      mockPublishCast.mockRejectedValue(new Error("Network timeout"));

      const server = createTestServer();
      const tool = getTool(server, "farcaster_publish_cast");

      const result = (await tool.handler({ text: "Test cast" }, {})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("farcaster_publish_thread", () => {
    it("should chain casts as replies", async () => {
      mockPublishCast
        .mockResolvedValueOnce({
          hash: "0xfirst",
          timestamp: "2026-03-24T00:00:00Z",
          url: "https://warpcast.com/~/conversations/0xfirst",
        })
        .mockResolvedValueOnce({
          hash: "0xsecond",
          timestamp: "2026-03-24T00:00:01Z",
          url: "https://warpcast.com/~/conversations/0xsecond",
        })
        .mockResolvedValueOnce({
          hash: "0xthird",
          timestamp: "2026-03-24T00:00:02Z",
          url: "https://warpcast.com/~/conversations/0xthird",
        });

      const server = createTestServer();
      const tool = getTool(server, "farcaster_publish_thread");

      const result = (await tool.handler(
        { casts: ["Cast 1", "Cast 2", "Cast 3"] },
        {},
      )) as { content: Array<{ text: string }> };

      const data = JSON.parse(result.content[0].text);
      expect(data.hashes).toEqual(["0xfirst", "0xsecond", "0xthird"]);
      expect(data.cast_count).toBe(3);
      expect(data.thread_url).toBe("https://warpcast.com/~/conversations/0xfirst");

      // Verify chaining: second call uses first hash as parent
      expect(mockPublishCast).toHaveBeenCalledTimes(3);
      expect(mockPublishCast.mock.calls[1][1]?.parent_cast_hash).toBe("0xfirst");
      expect(mockPublishCast.mock.calls[2][1]?.parent_cast_hash).toBe("0xsecond");
    });
  });

  describe("farcaster_get_cast", () => {
    it("should retrieve a cast by hash", async () => {
      mockGetCast.mockResolvedValue({
        hash: "0xabc123",
        text: "Test cast content",
        timestamp: "2026-03-24T00:00:00Z",
        reactions: { likes_count: 5, recasts_count: 2 },
        status: "published",
      });

      const server = createTestServer();
      const tool = getTool(server, "farcaster_get_cast");

      const result = (await tool.handler({ hash: "0xabc123" }, {})) as {
        content: Array<{ text: string }>;
      };
      const data = JSON.parse(result.content[0].text);
      expect(data.hash).toBe("0xabc123");
      expect(data.text).toBe("Test cast content");
    });
  });

  describe("farcaster_delete_cast", () => {
    it("should delete a cast by hash", async () => {
      mockDeleteCast.mockResolvedValue({
        success: true,
        deleted_hash: "0xabc123",
      });

      const server = createTestServer();
      const tool = getTool(server, "farcaster_delete_cast");

      const result = (await tool.handler({ hash: "0xabc123" }, {})) as {
        content: Array<{ text: string }>;
      };
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.deleted_hash).toBe("0xabc123");
    });
  });
});
