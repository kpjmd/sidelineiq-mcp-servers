import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Unknown input keys are an ERROR, not a silent drop.
 *
 * Every tool registers a raw zod shape, which the SDK wraps in a plain
 * `z.object` — and `z.object` STRIPS keys it does not declare and returns
 * success. Meanwhile tools/list advertised `additionalProperties: false` on
 * every object the whole time (zod-to-json-schema renders "strip" that way),
 * so the contract a client could read said "rejected" while the server said
 * "fine" and threw the field away. That mismatch cost the agent the model's
 * post-level confidence on 183 rows (a flat `confidence` key), and made
 * `status` on web_create_injury_post a no-op for months.
 *
 * `strict` makes runtime match the advertised contract: an undeclared key, at
 * any depth, fails the call with the SDK's normal InvalidParams result.
 * `strip` restores the old behaviour without a deploy.
 *
 * Read per registration, and a new McpServer is built per request, so the env
 * var takes effect on the next request after it changes.
 */
export type UnknownKeyMode = "strict" | "strip";

export function unknownKeyMode(env: NodeJS.ProcessEnv = process.env): UnknownKeyMode {
  // Anything but an explicit "strip" is strict: a typo in the lever must not
  // silently reopen the hole it exists to close.
  return env.MCP_UNKNOWN_KEYS?.trim().toLowerCase() === "strip" ? "strip" : "strict";
}

/**
 * Rebuild a schema with every ZodObject in it set to reject unknown keys.
 *
 * Wrappers are rebuilt from their own `_def` rather than re-chained
 * (`inner.optional()`), because `.describe()` text lives on the wrapper's def
 * and re-chaining would drop it — the descriptions are what the model reads.
 * `z.record` and `z.unknown` are left alone: `payload`, `raw_payload`,
 * `before` and `after` are open by design.
 */
export function deepStrict(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as z.ZodRawShape;
    const strictShape: z.ZodRawShape = {};
    for (const [key, field] of Object.entries(shape)) strictShape[key] = deepStrict(field);
    return new z.ZodObject({ ...schema._def, shape: () => strictShape, unknownKeys: "strict" });
  }
  if (schema instanceof z.ZodOptional) {
    return new z.ZodOptional({ ...schema._def, innerType: deepStrict(schema._def.innerType) });
  }
  if (schema instanceof z.ZodNullable) {
    return new z.ZodNullable({ ...schema._def, innerType: deepStrict(schema._def.innerType) });
  }
  if (schema instanceof z.ZodDefault) {
    return new z.ZodDefault({ ...schema._def, innerType: deepStrict(schema._def.innerType) });
  }
  if (schema instanceof z.ZodArray) {
    return new z.ZodArray({ ...schema._def, type: deepStrict(schema._def.type) });
  }
  if (schema instanceof z.ZodEffects) {
    return new z.ZodEffects({ ...schema._def, schema: deepStrict(schema._def.schema) });
  }
  return schema;
}

interface RegisteredToolLike {
  inputSchema?: unknown;
}

/**
 * Apply the policy to every tool registered through this server.
 *
 * NEVER pass a prebuilt `z.object(...).strict()` to `server.tool()` instead:
 * the SDK's tool() only recognises a RAW shape in that position, and treats
 * any other object — a ZodObject included — as the tool's ANNOTATIONS. The tool
 * would register with no input schema at all. So this lets the SDK build the
 * RegisteredTool from the raw shape as usual, then swaps its `inputSchema`,
 * which is the field both tools/list and validateToolInput read.
 */
export function withInputKeyPolicy(server: McpServer, mode: UnknownKeyMode = unknownKeyMode()): McpServer {
  if (mode === "strip") return server;
  const original = server.tool.bind(server) as (...args: unknown[]) => RegisteredToolLike;
  (server as unknown as { tool: (...args: unknown[]) => RegisteredToolLike }).tool = (...args: unknown[]) => {
    const registered = original(...args);
    if (registered.inputSchema instanceof z.ZodType) {
      registered.inputSchema = deepStrict(registered.inputSchema);
    }
    return registered;
  };
  return server;
}
