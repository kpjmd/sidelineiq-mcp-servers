import "dotenv/config";
import { createFarcasterServer } from "./servers/farcaster/server.js";
import { createTwitterServer } from "./servers/twitter/server.js";
import { createWebServer } from "./servers/web/server.js";
import { createLogger } from "./shared/logger.js";

const logger = createLogger("main");

const servers = [
  createFarcasterServer(),
  createTwitterServer(),
  createWebServer(),
];

for (const { app, port } of servers) {
  app.listen(port, "0.0.0.0", () => {
    logger.info(`Server started on port ${port}`);
  });
}

logger.info("All MCP servers started", {
  ports: servers.map((s) => s.port),
});
