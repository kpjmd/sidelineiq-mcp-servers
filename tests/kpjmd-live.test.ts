import { describe, it, expect } from "vitest";
import {
  evaluateLiveCheck,
  extractContentHash,
  kpjmdPostUrl,
} from "../src/servers/web/kpjmd-live.js";

const HASH = "a".repeat(64);
const URL = "https://kpjmd.com/injury-desk/test-athlete-knee/";

function pageWith(hash: string): string {
  return `<html><head><meta charset="utf-8"><meta name="x-sideline-content-hash" content="${hash}"><title>t</title></head><body>x</body></html>`;
}

describe("kpjmdPostUrl", () => {
  it("builds the canonical trailing-slash URL", () => {
    expect(kpjmdPostUrl("test-athlete-knee")).toBe(URL);
  });

  it("does not double up slashes on a base URL that has one", () => {
    expect(kpjmdPostUrl("x", "https://kpjmd.com/")).toBe("https://kpjmd.com/injury-desk/x/");
  });
});

describe("extractContentHash", () => {
  it("reads the meta tag", () => {
    expect(extractContentHash(pageWith(HASH))).toBe(HASH);
  });

  it("tolerates reversed attribute order and single quotes", () => {
    const html = `<meta content='${HASH}' name='x-sideline-content-hash'>`;
    expect(extractContentHash(html)).toBe(HASH);
  });

  it("returns null when the tag is absent", () => {
    expect(extractContentHash("<html><head><title>t</title></head></html>")).toBeNull();
  });
});

describe("evaluateLiveCheck", () => {
  it("passes on 200 with a matching hash", () => {
    const r = evaluateLiveCheck(URL, HASH, 200, pageWith(HASH));
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  // The reason this check exists at all: nothing calls back from kpjmd.com, so
  // a human saying "I deployed it" is the only alternative signal.
  it("fails on 404 with an actionable reason", () => {
    const r = evaluateLiveCheck(URL, HASH, 404, null);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("not found");
  });

  // The whole point of the hash tag: a page left over from an earlier build
  // also returns 200, so status alone would confirm stale content.
  it("fails on 200 when the live page carries a different hash", () => {
    const r = evaluateLiveCheck(URL, HASH, 200, pageWith("b".repeat(64)));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("stale");
    expect(r.live_content_hash).toBe("b".repeat(64));
  });

  // Reached two ways — an old builder, or a hand-authored post whose JSON has no
  // _sideline block. The response cannot distinguish them, so the reason must
  // name both: blaming the builder is wrong for a legacy post that was rebuilt
  // by the current one minutes ago.
  it("fails on 200 with no hash tag, naming both possible causes", () => {
    const r = evaluateLiveCheck(URL, HASH, 200, "<html><head></head><body>old</body></html>");
    expect(r.ok).toBe(false);
    const why = r.reasons.join(" ");
    expect(why).toContain("no x-sideline-content-hash");
    expect(why).toContain("predates the Phase 3 builder");
    expect(why).toContain("_sideline");
  });

  // A transient kpjmd.com outage is "not confirmed yet", not an error.
  it("fails softly when the site is unreachable", () => {
    const r = evaluateLiveCheck(URL, HASH, null, null);
    expect(r.ok).toBe(false);
    expect(r.http_status).toBeNull();
    expect(r.reasons.join(" ")).toContain("could not reach");
  });
});
