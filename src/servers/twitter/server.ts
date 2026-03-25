import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLogger } from "../../shared/logger.js";
import { registerTwitterTools } from "./tools.js";
import { fileURLToPath } from "node:url";

const logger = createLogger("twitter");

export function createTwitterServer(): { app: express.Express; port: number } {
  const port = parseInt(process.env.PORT_TWITTER || "3102", 10);

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const mcpServer = new McpServer(
        { name: "sidelineiq-twitter", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      registerTwitterTools(mcpServer);

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
    res.json({ status: "ok", server: "twitter", port });
  });

  return { app, port };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, port } = createTwitterServer();
  app.listen(port, "0.0.0.0", () => {
    logger.info(`Twitter MCP server listening on port ${port}`);
  });
}
