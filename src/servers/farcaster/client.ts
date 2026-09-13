import { McpToolError, requireEnv } from "../../shared/errors.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("farcaster-client");

interface NeynarCastResponse {
  cast: {
    hash: string;
    text: string;
    timestamp: string;
    author: { fid: number; username: string };
    reactions?: { likes_count: number; recasts_count: number };
  };
}

export interface PublishCastOptions {
  channel_id?: string;
  embeds?: Array<{ url: string }>;
  parent_cast_hash?: string;
}

export interface CastResult {
  hash: string;
  timestamp: string;
  url: string;
}

export interface CastDetails {
  hash: string;
  text: string;
  timestamp: string;
  reactions: { likes_count: number; recasts_count: number };
  status: string;
}

export interface FarcasterNotification {
  hash: string;
  text: string;
  authorFid: number;
  authorUsername: string;
  authorFollowerCount?: number;
  parentHash?: string;
  timestamp: string;
  type: "mention" | "reply";
}

const NOTIFICATION_TYPE_ALIASES: Record<string, "mention" | "reply" | undefined> = {
  mention: "mention",
  mentions: "mention",
  reply: "reply",
  replies: "reply",
};

export interface GetNotificationsResult {
  notifications: FarcasterNotification[];
  nextCursor?: string;
}

export interface FarcasterProfileStats {
  fid: number;
  username: string;
  follower_count: number;
  following_count: number;
}

interface NeynarUserBulkResponse {
  users?: Array<{
    fid?: number;
    username?: string;
    follower_count?: unknown;
    following_count?: unknown;
  }>;
}

export class NeynarClient {
  private baseUrl = "https://api.neynar.com/v2/farcaster";
  private apiKey: string;
  private signerUuid: string;

  constructor() {
    this.apiKey = requireEnv("NEYNAR_API_KEY");
    this.signerUuid = requireEnv("NEYNAR_SIGNER_UUID");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | string[]>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        // Neynar's array-valued filters must be genuinely repeated params
        // (?type=mentions&type=replies). `set` cannot express that, and a
        // comma-joined scalar is rejected with 400 InvalidField.
        if (Array.isArray(value)) {
          for (const entry of value) url.searchParams.append(key, entry);
        } else {
          url.searchParams.set(key, value);
        }
      }
    }

    const response = await fetch(url.toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("Neynar API error", {
        status: response.status,
        body: errorBody,
        path,
      });

      if (response.status === 403) {
        throw new McpToolError(
          "Farcaster signer not approved or API key invalid",
          "Verify NEYNAR_API_KEY and NEYNAR_SIGNER_UUID are correct and the signer is approved.",
          undefined,
          403,
        );
      }

      if (response.status === 429) {
        throw new McpToolError(
          "Neynar API rate limit exceeded",
          "Wait 60 seconds and retry the request.",
          undefined,
          429,
        );
      }

      throw new McpToolError(
        `Neynar API returned status ${response.status}`,
        "Check server logs for details. Verify API key and signer UUID are valid.",
        undefined,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  async publishCast(text: string, options?: PublishCastOptions): Promise<CastResult> {
    const body: Record<string, unknown> = {
      signer_uuid: this.signerUuid,
      text,
    };

    if (options?.channel_id) body.channel_id = options.channel_id;
    if (options?.embeds) body.embeds = options.embeds;
    if (options?.parent_cast_hash) body.parent = options.parent_cast_hash;

    const data = await this.request<NeynarCastResponse>("POST", "/cast", body);

    return {
      hash: data.cast.hash,
      timestamp: data.cast.timestamp,
      url: `https://warpcast.com/~/conversations/${data.cast.hash}`,
    };
  }

  // The account's own follower count, for the baseline metrics series. The FID
  // is read here rather than in the constructor so a missing value fails this
  // one tool, never publishing. Every malformed shape THROWS: the caller
  // records a reading only on success, and a 0 invented from a missing field
  // would read as "lost every follower" in the growth gate.
  async getProfileStats(): Promise<FarcasterProfileStats> {
    const rawFid = requireEnv("SIDELINEIQ_FARCASTER_FID");
    const fid = Number(rawFid);
    if (!Number.isInteger(fid) || fid <= 0) {
      throw new McpToolError(
        `SIDELINEIQ_FARCASTER_FID is not a positive integer: ${rawFid}`,
        "Set SIDELINEIQ_FARCASTER_FID to the account's numeric FID.",
      );
    }

    const data = await this.request<NeynarUserBulkResponse>("GET", "/user/bulk", undefined, {
      fids: String(fid),
    });
    const user = data.users?.find((u) => u.fid === fid);
    if (!user) {
      throw new McpToolError(
        `Neynar /user/bulk returned no user for fid ${fid}`,
        "Verify SIDELINEIQ_FARCASTER_FID is the SidelineIQ account's FID.",
      );
    }
    if (!isCount(user.follower_count) || !isCount(user.following_count)) {
      throw new McpToolError(
        `Neynar /user/bulk returned a non-numeric follower count for fid ${fid}`,
        "Neynar's user shape may have changed; re-record tests/fixtures/neynar-user-bulk.json.",
      );
    }

    return {
      fid,
      username: user.username ?? "",
      follower_count: user.follower_count,
      following_count: user.following_count,
    };
  }

  async getNotifications(fid: number, cursor?: string, limit?: number): Promise<GetNotificationsResult> {
    const params: Record<string, string | string[]> = {
      fid: String(fid),
      // Plural values, one repeated param each. Neynar rejects the old
      // "mention,reply" scalar with 400 InvalidField: "type must be an array of
      // one or more of: likes, replies, recasts, mentions, follows, quotes".
      type: ["mentions", "replies"],
      limit: String(limit ?? 25),
    };
    if (cursor) {
      params.cursor = cursor;
    }

    try {
      const data = await this.request<{
        notifications?: Array<{
          type?: string;
          cast?: {
            hash?: string;
            text?: string;
            parent_hash?: string;
            timestamp?: string;
            author?: {
              fid?: number;
              username?: string;
              follower_count?: number;
            };
          };
        }>;
        next?: { cursor?: string };
      }>("GET", "/notifications", undefined, params);

      const notifications: FarcasterNotification[] = [];

      for (const raw of data.notifications ?? []) {
        // The request filter takes plurals; responses have been observed with
        // the singular form. Accept either and normalise to the singular, which
        // is the shape every consumer downstream already expects.
        const type = raw.type ? NOTIFICATION_TYPE_ALIASES[raw.type] : undefined;
        if (!type) continue;
        const cast = raw.cast;
        if (!cast?.hash || !cast.text) continue;

        notifications.push({
          hash: cast.hash,
          text: cast.text,
          authorFid: cast.author?.fid ?? 0,
          authorUsername: cast.author?.username ?? "",
          authorFollowerCount: cast.author?.follower_count,
          parentHash: cast.parent_hash,
          timestamp: cast.timestamp ?? new Date().toISOString(),
          type,
        });
      }

      return {
        notifications,
        nextCursor: data.next?.cursor,
      };
    } catch (err: unknown) {
      // Handle 429 rate limit gracefully — return empty result instead of
      // throwing. Tests the status, not the message: the 429 path throws
      // "Neynar API rate limit exceeded", which never contained "429", so the
      // old string match made this branch unreachable.
      if (err instanceof McpToolError && err.status === 429) {
        logger.warn("Neynar notifications rate limit hit — returning empty result");
        return { notifications: [] };
      }
      throw err;
    }
  }

  async getCast(hash: string): Promise<CastDetails> {
    const data = await this.request<NeynarCastResponse>("GET", "/cast", undefined, {
      identifier: hash,
      type: "hash",
    });

    return {
      hash: data.cast.hash,
      text: data.cast.text,
      timestamp: data.cast.timestamp,
      reactions: data.cast.reactions ?? { likes_count: 0, recasts_count: 0 },
      status: "published",
    };
  }

  async deleteCast(hash: string): Promise<{ success: boolean; deleted_hash: string }> {
    await this.request("DELETE", "/cast", {
      signer_uuid: this.signerUuid,
      target_hash: hash,
    });

    return { success: true, deleted_hash: hash };
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
