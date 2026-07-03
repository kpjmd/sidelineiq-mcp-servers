import { createHash, timingSafeEqual } from "node:crypto";
import type express from "express";
import { createLogger } from "./logger.js";

const logger = createLogger("auth");

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Gates /mcp against MCP_AUTH_SECRET. Fails closed if the secret isn't
 * configured — an unset secret must never silently allow all traffic.
 * Compares fixed-length digests (not the raw token) so a length mismatch
 * can't short-circuit timingSafeEqual and leak the secret's length.
 */
export function requireMcpAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const expected = process.env.MCP_AUTH_SECRET;
  if (!expected) {
    logger.error("MCP_AUTH_SECRET not configured — refusing /mcp request");
    res.status(503).json({ error: "MCP auth not configured" });
    return;
  }

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!timingSafeEqual(digest(token), digest(expected))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
