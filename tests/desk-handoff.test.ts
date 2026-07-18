import { describe, it, expect } from "vitest";
import { assembleDeskHandoff } from "../src/servers/web/desk-handoff.js";
import { TIER2_DISCLAIMER } from "../src/servers/web/disclaimer.js";
import type { DeskPost } from "../src/servers/web/client.js";

function post(overrides: Partial<DeskPost> = {}): DeskPost {
  return {
    id: "880e8400-e29b-41d4-a716-446655440000",
    candidate_id: null,
    entity_id: "aa0e8400-e29b-41d4-a716-446655440000",
    slug: "test-athlete-knee",
    title: "Test Athlete Knee",
    markdown_body: "Body.",
    draft_json: null,
    status: "PUBLISHED",
    version: 1,
    author_id: "770e8400-e29b-41d4-a716-446655440002",
    reviewed_by: null,
    attestation_id: null,
    content_hash: "hash",
    source_attribution: { url: "https://espn.com/story" },
    disclaimer_present: true,
    created_at: "2026-06-12T00:00:00Z",
    updated_at: "2026-06-12T00:00:00Z",
    published_at: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

describe("assembleDeskHandoff", () => {
  it("assembles schema_version 1 with no updates", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", []);
    expect(handoff.schema_version).toBe(1);
    expect(handoff.desk_post_id).toBe(post().id);
    expect(handoff.athlete_name).toBe("Test Athlete");
    expect(handoff.sport).toBe("NBA");
    expect(handoff.disclaimer).toBe(TIER2_DISCLAIMER);
    expect(handoff.updates).toEqual([]);
  });

  it("sorts updates oldest-first and maps created_at to published_at", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", [
      {
        id: "u2",
        headline: "Day 298: first game back",
        markdown_body: "Minutes restriction lifted.",
        occurred_at: "2026-07-18T00:00:00Z",
        created_at: "2026-07-19T00:00:00Z",
      },
      {
        id: "u1",
        headline: "Day 200: cleared for contact",
        markdown_body: "Full-contact practice.",
        occurred_at: "2026-05-01T00:00:00Z",
        created_at: "2026-05-02T00:00:00Z",
      },
    ]);
    expect(handoff.updates.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(handoff.updates[0].published_at).toBe("2026-05-02T00:00:00Z");
  });

  it("marks a RETRACTED post's status accordingly", () => {
    const handoff = assembleDeskHandoff(post({ status: "RETRACTED" }), null, null, []);
    expect(handoff.status).toBe("RETRACTED");
    expect(handoff.athlete_name).toBeNull();
  });
});
