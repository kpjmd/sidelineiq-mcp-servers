import { describe, it, expect } from "vitest";
import { repliedToTweetId } from "../src/servers/twitter/client.js";

/**
 * The reply agent looks our post up by the id a mention replies to. It was
 * handed in_reply_to_user_id — the author, never a post — so the lookup never
 * matched. The post id is only in referenced_tweets.
 */
describe("repliedToTweetId", () => {
  it("returns the replied_to post id", () => {
    expect(
      repliedToTweetId({ referenced_tweets: [{ type: "replied_to", id: "2114149474805162247" }] }),
    ).toBe("2114149474805162247");
  });

  it("ignores quoted and retweeted references", () => {
    expect(
      repliedToTweetId({
        referenced_tweets: [
          { type: "quoted", id: "1" },
          { type: "replied_to", id: "2" },
        ],
      }),
    ).toBe("2");
    expect(repliedToTweetId({ referenced_tweets: [{ type: "quoted", id: "1" }] })).toBeUndefined();
  });

  it("is undefined for a mention that is not a reply", () => {
    expect(repliedToTweetId({})).toBeUndefined();
  });
});
