import { TwitterApi } from "twitter-api-v2";
import { McpToolError, requireEnv } from "../../shared/errors.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("twitter-client");

export interface TweetResult {
  id: string;
  text: string;
  timestamp: string;
  url: string;
}

export interface TweetDetails {
  id: string;
  text: string;
  timestamp: string;
  metrics: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    impression_count: number;
  };
}

export class TwitterClient {
  private client: TwitterApi;

  constructor() {
    this.client = new TwitterApi({
      appKey: requireEnv("TWITTER_API_KEY"),
      appSecret: requireEnv("TWITTER_API_SECRET"),
      accessToken: requireEnv("TWITTER_ACCESS_TOKEN"),
      accessSecret: requireEnv("TWITTER_ACCESS_TOKEN_SECRET"),
    });
  }

  async publishTweet(text: string, replyToId?: string): Promise<TweetResult> {
    try {
      const params: Record<string, unknown> = { text };
      if (replyToId) {
        params.reply = { in_reply_to_tweet_id: replyToId };
      }

      const result = await this.client.v2.tweet(params as Parameters<typeof this.client.v2.tweet>[0]);

      return {
        id: result.data.id,
        text: result.data.text,
        timestamp: new Date().toISOString(),
        url: `https://x.com/i/web/status/${result.data.id}`,
      };
    } catch (err: unknown) {
      this.handleTwitterError(err);
    }
  }

  async getTweet(id: string): Promise<TweetDetails> {
    try {
      const result = await this.client.v2.singleTweet(id, {
        "tweet.fields": ["created_at", "public_metrics"],
      });

      return {
        id: result.data.id,
        text: result.data.text,
        timestamp: result.data.created_at ?? new Date().toISOString(),
        metrics: result.data.public_metrics ?? {
          retweet_count: 0,
          reply_count: 0,
          like_count: 0,
          impression_count: 0,
        },
      };
    } catch (err: unknown) {
      this.handleTwitterError(err);
    }
  }

  async deleteTweet(id: string): Promise<{ success: boolean; deleted_id: string }> {
    try {
      await this.client.v2.deleteTweet(id);
      return { success: true, deleted_id: id };
    } catch (err: unknown) {
      this.handleTwitterError(err);
    }
  }

  private handleTwitterError(err: unknown): never {
    logger.error("Twitter API error", {
      error: err instanceof Error ? err.message : String(err),
    });

    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: number }).code;

      if (code === 429) {
        const resetAt =
          err && typeof err === "object" && "rateLimit" in err
            ? (err as { rateLimit: { reset: number } }).rateLimit?.reset
            : undefined;
        const resetMsg = resetAt
          ? ` Rate limit resets at ${new Date(resetAt * 1000).toISOString()}.`
          : "";
        throw new McpToolError(
          "Twitter API rate limit exceeded",
          `Wait and retry after the rate limit resets.${resetMsg}`,
        );
      }

      if (code === 403) {
        throw new McpToolError(
          "Twitter API forbidden — check app permissions",
          "Verify Twitter API credentials have read+write permissions in the Twitter Developer Portal.",
        );
      }
    }

    if (err instanceof Error && err.message.includes("duplicate")) {
      throw new McpToolError(
        "Duplicate tweet content rejected by Twitter",
        "Modify the tweet text to be unique before retrying.",
      );
    }

    throw new McpToolError(
      "Twitter API request failed",
      "Check server logs for details. Verify Twitter API credentials are valid.",
      err,
    );
  }
}
