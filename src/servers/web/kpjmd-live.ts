// Verifying that a desk post is actually live on kpjmd.com.
//
// kpjmd.com is not a git repo and has no CI: the MD downloads the handoff JSON,
// drops it into content/injury-desk/published/, runs build-injury-desk.js, and
// rsyncs site/public/ to a DigitalOcean droplet by hand. Nothing calls back. So
// the only trustworthy signal that a publish landed is fetching the live URL —
// which is why this check exists rather than a "yes I deployed it" checkbox.
//
// Two conditions, both required:
//   1. HTTP 200. Verified against the live site: a missing desk slug returns a
//      real 404 (nginx's `error_page 404 /index.html` serves the home page BODY
//      but preserves the status code), so 200 genuinely means the page exists.
//   2. The x-sideline-content-hash meta tag equals the post's current
//      content_hash. Without this, a page left over from an earlier build also
//      returns 200 — so a re-publish or a Return Watch append would "confirm"
//      against stale content. The builder emits the tag from _sideline.content_hash.

export const KPJMD_BASE_URL = "https://kpjmd.com";

export function kpjmdPostUrl(slug: string, baseUrl: string = KPJMD_BASE_URL): string {
  // Trailing slash matters: nginx resolves the directory to index.html, and it
  // is what the page's own canonical link declares.
  return `${baseUrl.replace(/\/+$/, "")}/injury-desk/${slug}/`;
}

export const CONTENT_HASH_META = "x-sideline-content-hash";

// Tolerates attribute order and quote style, which differ between hand-edits of
// the template and whatever a future minifier might do.
export function extractContentHash(html: string): string | null {
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!name || name[1].toLowerCase() !== CONTENT_HASH_META) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    return content ? content[1].trim() : null;
  }
  return null;
}

export interface LiveCheckResult {
  ok: boolean;
  url: string;
  http_status: number | null;
  live_content_hash: string | null;
  expected_content_hash: string;
  reasons: string[];
}

// Decide the outcome from an already-fetched response. Pure, so the reasoning is
// unit-testable without a network.
export function evaluateLiveCheck(
  url: string,
  expectedHash: string,
  httpStatus: number | null,
  html: string | null,
): LiveCheckResult {
  const reasons: string[] = [];
  const liveHash = html ? extractContentHash(html) : null;

  if (httpStatus === null) {
    reasons.push("could not reach kpjmd.com");
  } else if (httpStatus === 404) {
    reasons.push(
      "page not found on kpjmd.com — drop the JSON into content/injury-desk/published/, run build-injury-desk.js, then rsync site/public/",
    );
  } else if (httpStatus !== 200) {
    reasons.push(`kpjmd.com returned HTTP ${httpStatus}`);
  } else if (liveHash === null) {
    // Two causes look identical from here, and the response cannot tell them
    // apart — so name both rather than asserting one. Guessing "old builder" is
    // actively misleading on a legacy hand-authored post, whose page may have
    // been rebuilt minutes ago by the current builder and still carry no tag,
    // because the tag comes from the JSON's _sideline block, not the builder.
    reasons.push(
      `live page carries no ${CONTENT_HASH_META} meta tag, so it cannot be matched to this post. Either the page predates the Phase 3 builder (rebuild and rsync), or its JSON has no _sideline block — which is the case for posts written by hand rather than downloaded from /desk. A hand-authored post cannot be confirmed; re-publish it through /desk to make it verifiable.`,
    );
  } else if (liveHash !== expectedHash) {
    reasons.push(
      `live page is stale: it carries content hash ${liveHash.slice(0, 12)}… but this post is now ${expectedHash.slice(0, 12)}…. Re-run the build and rsync.`,
    );
  }

  return {
    ok: reasons.length === 0,
    url,
    http_status: httpStatus,
    live_content_hash: liveHash,
    expected_content_hash: expectedHash,
    reasons,
  };
}

// Fetch the live page and evaluate it. Network failure is a normal negative
// outcome (ok:false with a reason), never a throw — a transient kpjmd.com
// outage should render as "not confirmed yet", not a 500 in the desk editor.
export async function checkKpjmdLive(
  slug: string,
  expectedHash: string,
  baseUrl: string = KPJMD_BASE_URL,
  timeoutMs = 10_000,
): Promise<LiveCheckResult> {
  const url = kpjmdPostUrl(slug, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: { "User-Agent": "SidelineIQ-DeskHandoff/1.0" },
    });
    const html = res.ok ? await res.text() : null;
    return evaluateLiveCheck(url, expectedHash, res.status, html);
  } catch {
    return evaluateLiveCheck(url, expectedHash, null, null);
  } finally {
    clearTimeout(timer);
  }
}
