import { describe, it, expect } from "vitest";
import { assembleDeskHandoff } from "../src/servers/web/desk-handoff.js";
import { TIER2_DISCLAIMER } from "../src/servers/web/disclaimer.js";
import { serializeSections, SECTION_KEYS } from "../src/servers/web/desk-sections.js";
import type { DeskSections, DeskMeta } from "../src/servers/web/desk-sections.js";
import type { DeskPost } from "../src/servers/web/client.js";

const SECTIONS: DeskSections = {
  snapshot: "A concise, quotable answer that stands on its own.",
  what_happened: "Per public reporting, the injury occurred in practice.",
  anatomy: "The knee carries load through several ligaments.",
  treatment: "Management ranges from rest to surgical repair.",
  timeline: "Recovery timelines vary with the confirmed grade.",
  bridge: "Persistent swelling in a recreational athlete warrants evaluation.",
  dr_take: "General educational analysis, not a diagnosis.",
};

function post(overrides: Partial<DeskPost> = {}): DeskPost {
  const sections = (overrides.sections ?? SECTIONS) as DeskSections;
  const meta = (overrides.meta ?? {}) as DeskMeta;
  return {
    id: "880e8400-e29b-41d4-a716-446655440000",
    candidate_id: null,
    entity_id: "aa0e8400-e29b-41d4-a716-446655440000",
    slug: "test-athlete-knee",
    title: "Test Athlete Knee",
    markdown_body: serializeSections(sections, meta),
    sections,
    meta,
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
    kpjmd_published_at: null,
    kpjmd_url: null,
    kpjmd_content_hash: null,
    ...overrides,
  };
}

const UPDATES = [
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
];

describe("assembleDeskHandoff", () => {
  // The whole point of V2: the emitted object IS kpjmd's
  // content/injury-desk/published/{slug}.json, so it must carry exactly the
  // field names validatePost() in build-injury-desk.js requires.
  it("emits every field kpjmd's validatePost requires", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", [], "ACL tear");
    const required = [
      "slug",
      "headline",
      "league",
      "injury_type",
      "published_date",
      ...SECTION_KEYS,
    ];
    for (const field of required) {
      const value = (handoff as unknown as Record<string, unknown>)[field];
      expect(value, `required field ${field}`).toBeTruthy();
    }
    expect(handoff.schema_version).toBe(2);
    expect(handoff.headline).toBe("Test Athlete Knee");
    expect(handoff.league).toBe("NBA");
    expect(handoff.injury_type).toBe("ACL tear");
    expect(handoff.snapshot).toBe(SECTIONS.snapshot);
    expect(handoff.dr_take).toBe(SECTIONS.dr_take);
  });

  it("reduces published_at to a plain YYYY-MM-DD published_date", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", [], "ACL tear");
    expect(handoff.published_date).toBe("2026-06-15");
  });

  it("carries provenance under _sideline, not as content", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", [], "ACL tear");
    expect(handoff._sideline.desk_post_id).toBe(post().id);
    expect(handoff._sideline.content_hash).toBe("hash");
    expect(handoff._sideline.status).toBe("PUBLISHED");
    expect(handoff._sideline.disclaimer).toBe(TIER2_DISCLAIMER);
    // The disclaimer must NOT also appear in a section: kpjmd's template renders
    // "The Fine Print" verbatim, so a copy in the JSON would print twice.
    for (const key of SECTION_KEYS) {
      expect(handoff[key]).not.toContain("has not examined or treated");
    }
  });

  it("sorts updates newest-first and renames markdown_body to body", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", UPDATES, "ACL tear");
    expect(handoff.updates?.map((u) => u.headline)).toEqual([
      "Day 298: first game back",
      "Day 200: cleared for contact",
    ]);
    expect(handoff.updates?.[0].body).toBe("Minutes restriction lifted.");
    expect(handoff.updates?.[0].occurred_at).toBe("2026-07-18T00:00:00Z");
  });

  it("derives modified_date from the newest update", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", UPDATES, "ACL tear");
    expect(handoff.modified_date).toBe("2026-07-18");
  });

  // Absent rather than empty: kpjmd treats '' and null as missing, and an empty
  // optional would render an empty element instead of being omitted.
  it("omits empty optionals entirely", () => {
    const handoff = assembleDeskHandoff(post(), "Test Athlete", "NBA", [], "ACL tear");
    expect(handoff).not.toHaveProperty("updates");
    expect(handoff).not.toHaveProperty("modified_date");
    expect(handoff).not.toHaveProperty("short_title");
    expect(handoff).not.toHaveProperty("conflict_flag");
  });

  it("passes meta through and always stamps conflict_flag.sideline_slug", () => {
    const meta: DeskMeta = {
      short_title: "Test · Knee",
      treatment_heading: "The Repair",
      relevant_tool: "acl",
      faqs: [{ q: "How long?", a: "It depends." }],
      conflict_flag: {
        team_timeline: "~6 weeks",
        otm_range: "12-16 weeks",
        rationale: "Return to play and return to form differ.",
      },
    };
    const handoff = assembleDeskHandoff(post({ meta }), "Test Athlete", "NBA", [], "ACL tear");
    expect(handoff.short_title).toBe("Test · Knee");
    expect(handoff.treatment_heading).toBe("The Repair");
    expect(handoff.faqs).toHaveLength(1);
    // The builder warns without it, and it drives the isBasedOn JSON-LD link.
    expect(handoff.conflict_flag?.sideline_slug).toBe("test-athlete-knee");
  });

  it("defaults player to the joined athlete name, and lets meta override", () => {
    expect(assembleDeskHandoff(post(), "Test Athlete", "NBA", [], "ACL tear").player).toBe(
      "Test Athlete",
    );
    const overridden = assembleDeskHandoff(
      post({ meta: { player: "T. Athlete Jr." } }),
      "Test Athlete",
      "NBA",
      [],
      "ACL tear",
    );
    expect(overridden.player).toBe("T. Athlete Jr.");
  });

  it("marks a RETRACTED post in _sideline and stamps retracted_at", () => {
    const handoff = assembleDeskHandoff(
      post({ status: "RETRACTED" }),
      null,
      null,
      [],
      null,
    );
    expect(handoff._sideline.status).toBe("RETRACTED");
    expect(handoff._sideline.retracted_at).toBe("2026-06-12T00:00:00Z");
  });

  // A legacy row (migration 016 left sections NULL) must not throw here — the
  // linter is what blocks it from publishing, and the handoff should degrade to
  // empty strings so the failure surfaces as a builder validation error.
  it("degrades to empty sections rather than throwing on a legacy row", () => {
    const handoff = assembleDeskHandoff(post({ sections: null }), "A", "NBA", [], "ACL tear");
    expect(handoff.snapshot).toBe("");
    expect(handoff.dr_take).toBe("");
  });
});
