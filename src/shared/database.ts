import { neon } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { McpToolError } from "./errors.js";

let sql: NeonQueryFunction<false, false> | null = null;

export function getDatabase(): NeonQueryFunction<false, false> {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new McpToolError(
        "DATABASE_URL not configured",
        "Set DATABASE_URL in your .env file or Railway environment variables.",
      );
    }
    sql = neon(url);
  }
  return sql;
}
