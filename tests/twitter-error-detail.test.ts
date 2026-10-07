import { describe, it, expect } from "vitest";
import { twitterErrorDetail } from "../src/servers/twitter/client.js";

/**
 * X explains a 403 in the response body, not the exception message. The first
 * ledger card reply failed as a bare "Request failed with code 403" and nobody
 * could tell permissions from a too-long post. The detail must travel.
 */
describe("twitterErrorDetail", () => {
  it("joins title, detail and error messages from an ApiResponseError-shaped error", () => {
    const err = Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: { title: "Forbidden", detail: "Your Tweet text is too long.", errors: [{ message: "Your Tweet text is too long." }] },
    });
    expect(twitterErrorDetail(err)).toBe("Forbidden — Your Tweet text is too long.");
  });

  it("is null when X sent nothing usable", () => {
    expect(twitterErrorDetail(new Error("boom"))).toBeNull();
    expect(twitterErrorDetail({ data: {} })).toBeNull();
    expect(twitterErrorDetail(null)).toBeNull();
  });
});
