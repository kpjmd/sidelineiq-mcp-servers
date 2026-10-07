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

export interface TwitterMention {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  authorFollowerCount?: number;
  conversationId: string;
  inReplyToUserId?: string;
  createdAt: string;
}

export interface GetMentionsResult {
  mentions: TwitterMention[];
  newestId?: string;
}

export interface TwitterProfileStats {
  id: string;
  username: string;
  followers_count: number;
  following_count: number;
  tweet_count: number;
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

  // The authenticated account's own counts (GET /2/users/me), for the baseline
  // metrics series. A missing or non-numeric count THROWS rather than
  // defaulting: the caller records a reading only on success.
  async getProfileStats(): Promise<TwitterProfileStats> {
    try {
      const result = await this.client.v2.me({ "user.fields": ["public_metrics"] });
      const metrics = result.data.public_metrics;
      const followers = metrics?.followers_count;
      const following = metrics?.following_count;
      const tweets = metrics?.tweet_count;
      if (!isCount(followers) || !isCount(following) || !isCount(tweets)) {
        throw new McpToolError(
          "Twitter users/me returned no numeric public_metrics",
          "Confirm user.fields=public_metrics is honoured; re-record tests/fixtures/x-users-me.json.",
        );
      }
      return {
        id: result.data.id,
        username: result.data.username,
        followers_count: followers,
        following_count: following,
        tweet_count: tweets,
      };
    } catch (err: unknown) {
      if (err instanceof McpToolError) throw err;
      this.handleTwitterError(err);
    }
  }

  async getMentions(userId: string, sinceId?: string, maxResults?: number): Promise<GetMentionsResult> {
    try {
      const opts: Record<string, unknown> = {
        "tweet.fields": ["id", "text", "author_id", "conversation_id", "in_reply_to_user_id", "created_at"],
        "user.fields": ["public_metrics", "username"],
        expansions: ["author_id"],
        max_results: maxResults ?? 10,
      };
      if (sinceId) {
        opts.since_id = sinceId;
      }

      const timeline = await this.client.v2.userMentionTimeline(userId, opts as Parameters<typeof this.client.v2.userMentionTimeline>[1]);

      const usersMap = new Map<string, { username: string; followerCount?: number }>();
      const includes = timeline.includes;
      if (includes?.users) {
        for (const user of includes.users) {
          usersMap.set(user.id, {
            username: user.username,
            followerCount: user.public_metrics?.followers_count,
          });
        }
      }

      const tweets = timeline.data?.data ?? [];
      const mentions: TwitterMention[] = tweets.map((tweet) => {
        const authorInfo = usersMap.get(tweet.author_id ?? "");
        return {
          id: tweet.id,
          text: tweet.text,
          authorId: tweet.author_id ?? "",
          authorUsername: authorInfo?.username ?? "",
          authorFollowerCount: authorInfo?.followerCount,
          conversationId: tweet.conversation_id ?? tweet.id,
          inReplyToUserId: tweet.in_reply_to_user_id,
          createdAt: tweet.created_at ?? new Date().toISOString(),
        };
      });

      const newestId = timeline.data?.meta?.newest_id;
      return { mentions, newestId };
    } catch (err: unknown) {
      // Handle 429 rate limit gracefully — return empty result instead of throwing
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: number }).code;
        if (code === 429) {
          logger.warn("Twitter mentions rate limit hit — returning empty result");
          return { mentions: [] };
        }
      }
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
    // twitter-api-v2's ApiResponseError carries X's own explanation in `data`
    // ({title, detail, errors[]}); its `message` is only "Request failed with
    // code 403". The first ledger card reply failed with that bare 403 and the
    // log could not say whether it was permissions, a reply restriction, or a
    // post too long for a non-Premium account. Surface the detail everywhere.
    const detail = twitterErrorDetail(err);
    logger.error("Twitter API error", {
      error: err instanceof Error ? err.message : String(err),
      ...(detail ? { detail } : {}),
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
          detail ? `Twitter API forbidden: ${detail}` : "Twitter API forbidden (no detail from X)",
          "A 403 from X means one of: the app lacks write permission (Developer Portal), the account may not reply to that conversation (reply restrictions or a block), the text is longer than the account's limit (280 characters without Premium), or the content was rejected. The detail above is X's own wording.",
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
      detail ? `Twitter API request failed: ${detail}` : "Twitter API request failed",
      "Check server logs for details. Verify Twitter API credentials are valid.",
      err,
    );
  }
}

/** X's own explanation from an ApiResponseError, or null when there is none. Exported for tests. */
export function twitterErrorDetail(err: unknown): string | null {
  const data = (err as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const d = data as { title?: unknown; detail?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof d.title === "string") parts.push(d.title);
  if (typeof d.detail === "string" && d.detail !== d.title) parts.push(d.detail);
  if (Array.isArray(d.errors)) {
    for (const e of d.errors) {
      const m = (e as { message?: unknown } | null)?.message;
      if (typeof m === "string" && !parts.includes(m)) parts.push(m);
    }
  }
  return parts.length > 0 ? parts.join(" — ") : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
