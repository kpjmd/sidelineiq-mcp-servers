import { describe, it, expect } from "vitest";
import {
  SECTION_KEYS,
  deskContentHash,
  normalizeSections,
  sectionsComplete,
  serializeSections,
} from "../src/servers/web/desk-sections.js";
import { hashPayload } from "../src/shared/hash.js";
import type { DeskSections } from "../src/servers/web/desk-sections.js";

const SECTIONS: DeskSections = {
  snapshot: "Snapshot prose.",
  what_happened: "What happened prose.",
  anatomy: "Anatomy prose.",
  treatment: "Treatment prose.",
  timeline: "Timeline prose.",
  bridge: "Bridge prose.",
  dr_take: "Take prose.",
};

describe("normalizeSections", () => {
  it("fills every key so readers never see undefined", () => {
    const out = normalizeSections({ snapshot: "only this" });
    expect(Object.keys(out).sort()).toEqual([...SECTION_KEYS].sort());
    expect(out.snapshot).toBe("only this");
    expect(out.dr_take).toBe("");
  });

  // kpjmd's validatePost is presence-only; a non-string reaching the builder
  // throws inside textToHtmlParagraphs. Coercing here turns that into a lint
  // blocker instead of a build crash.
  it("coerces non-strings to empty so the linter catches them", () => {
    const out = normalizeSections({ timeline: [{ date: "x" }], anatomy: 42 });
    expect(out.timeline).toBe("");
    expect(out.anatomy).toBe("");
  });

  it("treats null/array input as no sections at all", () => {
    expect(normalizeSections(null).snapshot).toBe("");
    expect(normalizeSections([1, 2]).snapshot).toBe("");
  });
});

describe("sectionsComplete", () => {
  it("is true only when all seven carry prose", () => {
    expect(sectionsComplete(SECTIONS)).toBe(true);
    expect(sectionsComplete({ ...SECTIONS, bridge: "   " })).toBe(false);
    expect(sectionsComplete(null)).toBe(false);
  });
});

describe("serializeSections", () => {
  it("includes every section under a heading", () => {
    const body = serializeSections(SECTIONS);
    for (const key of SECTION_KEYS) expect(body).toContain(SECTIONS[key]);
    expect(body).toContain("## The Snapshot");
    expect(body).toContain("## Dr. Johnson's Take");
  });

  it("honours a custom treatment heading", () => {
    const body = serializeSections(SECTIONS, { treatment_heading: "The Repair" });
    expect(body).toContain("## The Repair");
    expect(body).not.toContain("## The Treatment");
  });

  // The disclaimer has to be in markdown_body for linter.ts/checkDisclaimer, but
  // must not be inside a section — kpjmd renders "The Fine Print" itself.
  it("appends the Tier 2 disclaimer so the linter's disclaimer check passes", () => {
    expect(serializeSections(SECTIONS)).toContain("has not examined or treated");
  });

  it("is deterministic", () => {
    expect(serializeSections(SECTIONS)).toBe(serializeSections({ ...SECTIONS }));
  });
});

describe("deskContentHash", () => {
  const body = serializeSections(SECTIONS);

  it("is stable across key insertion order", () => {
    const reordered = Object.fromEntries(
      [...SECTION_KEYS].reverse().map((k) => [k, SECTIONS[k]]),
    ) as DeskSections;
    expect(deskContentHash("T", reordered, {}, body)).toBe(deskContentHash("T", SECTIONS, {}, body));
  });

  it("changes when a section changes", () => {
    const edited = { ...SECTIONS, snapshot: "Different." };
    expect(deskContentHash("T", edited, {}, body)).not.toBe(deskContentHash("T", SECTIONS, {}, body));
  });

  // THE reason this helper exists rather than hashing the body: meta must be
  // covered, or an MD could attest and then add an FAQ before publishing.
  it("changes when only meta changes", () => {
    const withFaq = { faqs: [{ q: "q", a: "a" }] };
    expect(deskContentHash("T", SECTIONS, withFaq, body)).not.toBe(
      deskContentHash("T", SECTIONS, {}, body),
    );
  });

  it("changes when only the title changes", () => {
    expect(deskContentHash("A", SECTIONS, {}, body)).not.toBe(deskContentHash("B", SECTIONS, {}, body));
  });

  // Rows predating migration 016 stored attestations over the raw body. Hashing
  // the body for them keeps those attestations valid instead of retroactively
  // invalidating every legacy post.
  it("falls back to hashing the body for a legacy row with no sections", () => {
    expect(deskContentHash("T", null, null, "legacy body")).toBe(hashPayload("legacy body"));
  });
});
