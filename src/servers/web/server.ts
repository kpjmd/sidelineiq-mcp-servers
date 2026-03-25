import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLogger } from "../../shared/logger.js";
import { registerWebTools } from "./tools.js";
import { fileURLToPath } from "node:url";

const logger = createLogger("web");

export function createWebServer(): { app: express.Express; port: number } {
  const port = parseInt(process.env.PORT_WEB || "3103", 10);

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const mcpServer = new McpServer(
        { name: "sidelineiq-web", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      registerWebTools(mcpServer);

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
    res.json({ status: "ok", server: "web", port });
  });

  return { app, port };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, port } = createWebServer();
  app.listen(port, "0.0.0.0", () => {
    logger.info(`SidelineIQ Web MCP server listening on port ${port}`);
  });
}
