import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TwitterClient } from "./client.js";
import { handleToolError, toolSuccess } from "../../shared/errors.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("twitter-tools");

export function registerTwitterTools(server: McpServer): void {
  const client = new TwitterClient();

  // ── twitter_publish_tweet ───────────────────────────────────────────
  server.tool(
    "twitter_publish_tweet",
    "Publish a single tweet to X/Twitter. Use for Breaking injury posts. Hard limit of 280 characters enforced. Rejects if content exceeds limit.",
    {
      text: z.string().min(1).max(500).describe("Tweet content. Twitter counts URLs as 23 chars (t.co shortening), so raw strings with long URLs may exceed 280 chars but still be valid."),
      reply_to_id: z.string().optional().describe("Tweet ID to reply to"),
    },
    async (input) => {
      try {
        const result = await client.publishTweet(input.text, input.reply_to_id);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── twitter_publish_thread ──────────────────────────────────────────
  server.tool(
    "twitter_publish_thread",
    "Publish a multi-tweet thread to X/Twitter. Use for Deep Dive injury content. Each tweet max 280 characters. Automatically chains as replies. Maximum 10 tweets per thread.",
    {
      tweets: z
        .array(z.string().min(1).max(500))
        .min(2)
        .max(10)
        .describe("Ordered thread content (2-10 tweets). Twitter counts URLs as 23 chars (t.co shortening), so raw strings with long URLs may exceed 280 chars but still be valid."),
    },
    async (input) => {
      try {
        const ids: string[] = [];
        let threadUrl = "";

        for (let i = 0; i < input.tweets.length; i++) {
          const result = await client.publishTweet(
            input.tweets[i],
            i > 0 ? ids[i - 1] : undefined,
          );
          ids.push(result.id);
          if (i === 0) threadUrl = result.url;
        }

        return toolSuccess({
          ids,
          thread_url: threadUrl,
          tweet_count: ids.length,
        });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── twitter_get_tweet ───────────────────────────────────────────────
  server.tool(
    "twitter_get_tweet",
    "Retrieve a published tweet by ID to verify publication status.",
    {
      id: z.string().describe("The tweet ID to retrieve"),
    },
    async (input) => {
      try {
        const result = await client.getTweet(input.id);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── twitter_delete_tweet ────────────────────────────────────────────
  server.tool(
    "twitter_delete_tweet",
    "Delete a published tweet by ID. Use when MD review flags a post for removal after publication.",
    {
      id: z.string().describe("The tweet ID to delete"),
    },
    async (input) => {
      try {
        const result = await client.deleteTweet(input.id);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );
}
