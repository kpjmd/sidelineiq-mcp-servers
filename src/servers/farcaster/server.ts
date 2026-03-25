import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLogger } from "../../shared/logger.js";
import { registerFarcasterTools } from "./tools.js";
import { fileURLToPath } from "node:url";

const logger = createLogger("farcaster");

export function createFarcasterServer(): { app: express.Express; port: number } {
  const port = parseInt(process.env.PORT_FARCASTER || "3101", 10);

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const mcpServer = new McpServer(
        { name: "sidelineiq-farcaster", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      registerFarcasterTools(mcpServer);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("Failed to handle MCP request", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "farcaster", port });
  });

  return { app, port };
}

// Self-start when run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, port } = createFarcasterServer();
  app.listen(port, "0.0.0.0", () => {
    logger.info(`Farcaster MCP server listening on port ${port}`);
  });
}
