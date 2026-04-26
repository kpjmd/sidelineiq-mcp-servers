import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NeynarClient } from "./client.js";
import { handleToolError, toolSuccess } from "../../shared/errors.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("farcaster-tools");

export function registerFarcasterTools(server: McpServer): void {
  const client = new NeynarClient();

  // ── farcaster_publish_cast ──────────────────────────────────────────
  server.tool(
    "farcaster_publish_cast",
    "Publish a single cast to Farcaster via Neynar API. Use for Breaking injury posts and short Tracking updates under 320 characters.",
    {
      text: z.string().min(1).max(320).describe("The cast content (max 320 characters)"),
      channel_id: z.string().optional().describe("Farcaster channel to post in (e.g. 'sidelineiq')"),
      embeds: z
        .array(z.object({ url: z.string().url() }))
        .max(2)
        .optional()
        .describe("Link embeds (max 2)"),
      parent_cast_hash: z.string().optional().describe("Parent cast hash for replies"),
    },
    async (input) => {
      try {
        const result = await client.publishCast(input.text, {
          channel_id: input.channel_id,
          embeds: input.embeds,
          parent_cast_hash: input.parent_cast_hash,
        });
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── farcaster_publish_thread ────────────────────────────────────────
  server.tool(
    "farcaster_publish_thread",
    "Publish a multi-cast thread to Farcaster. Use for Deep Dive injury content requiring more than 320 characters. Automatically chains casts as replies.",
    {
      casts: z
        .array(z.string().min(1).max(320))
        .min(2)
        .max(10)
        .describe("Ordered thread content (2-10 casts, each max 320 characters)"),
      channel_id: z.string().optional().describe("Farcaster channel to post in"),
      embeds_on_first: z
        .array(z.object({ url: z.string().url() }))
        .max(2)
        .optional()
        .describe("Embeds on first cast only"),
    },
    async (input) => {
      try {
        const hashes: string[] = [];
        let threadUrl = "";

        for (let i = 0; i < input.casts.length; i++) {
          const result = await client.publishCast(input.casts[i], {
            channel_id: input.channel_id,
            embeds: i === 0 ? input.embeds_on_first : undefined,
            parent_cast_hash: i > 0 ? hashes[i - 1] : undefined,
          });
          hashes.push(result.hash);
          if (i === 0) threadUrl = result.url;
        }

        return toolSuccess({
          hashes,
          thread_url: threadUrl,
          cast_count: hashes.length,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── farcaster_get_cast ──────────────────────────────────────────────
  server.tool(
    "farcaster_get_cast",
    "Retrieve a previously published cast by hash to verify publication status or retrieve content for editing.",
    {
      hash: z.string().describe("The cast hash to retrieve"),
    },
    async (input) => {
      try {
        const result = await client.getCast(input.hash);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── farcaster_get_notifications ─────────────────────────────────────
  server.tool(
    "farcaster_get_notifications",
    "Fetch recent Farcaster notifications (mentions and replies) for the SidelineIQ account. Filters to mention and reply types only — ignores likes and recasts. Use nextCursor from the response as the cursor on the next call.",
    {
      fid: z.number().int().describe("OTM's Farcaster FID"),
      cursor: z.string().optional().describe("Pagination cursor from previous call"),
      limit: z.number().int().min(1).max(50).default(25).optional().describe("Max notifications to return (1-50, default 25)"),
    },
    async (input) => {
      try {
        const result = await client.getNotifications(input.fid, input.cursor, input.limit ?? 25);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── farcaster_delete_cast ───────────────────────────────────────────
  server.tool(
    "farcaster_delete_cast",
    "Delete a published cast by hash. Use when MD review flags a post for removal after publication.",
    {
      hash: z.string().describe("The cast hash to delete"),
    },
    async (input) => {
      try {
        const result = await client.deleteCast(input.hash);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );
}
