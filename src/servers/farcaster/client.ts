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

export interface GetNotificationsResult {
  notifications: FarcasterNotification[];
  nextCursor?: string;
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
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
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
        );
      }

      if (response.status === 429) {
        throw new McpToolError(
          "Neynar API rate limit exceeded",
          "Wait 60 seconds and retry the request.",
        );
      }

      throw new McpToolError(
        `Neynar API returned status ${response.status}`,
        "Check server logs for details. Verify API key and signer UUID are valid.",
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

  async getNotifications(fid: number, cursor?: string, limit?: number): Promise<GetNotificationsResult> {
    const params: Record<string, string> = {
      fid: String(fid),
      type: "mention,reply",
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
        const type = raw.type;
        if (type !== "mention" && type !== "reply") continue;
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
          type: type as "mention" | "reply",
        });
      }

      return {
        notifications,
        nextCursor: data.next?.cursor,
      };
    } catch (err: unknown) {
      // Handle 429 rate limit gracefully — return empty result instead of throwing
      if (err instanceof Error && err.message.includes("429")) {
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
