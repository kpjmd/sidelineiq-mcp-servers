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
