import { describe, it, expect } from "vitest";

// Pure-function tests: no DB, no network, no mocks. These cover the logic
// extracted out of client.ts (the publish gate, injury-thread accuracy math,
// attest preconditions, slugs) plus the DATE normalization helpers that guard
// against the neon-driver-returns-Date bug fixed in 15bb517.

import { hashPayload } from "../src/shared/hash.js";
import { McpToolError } from "../src/shared/errors.js";
import {
  toIsoDate,
  daysBetween,
  addWeeks,
  normalizeEntityDates,
  normalizePostDates,
} from "../src/servers/web/date-utils.js";
import {
  evaluatePublishGate,
  computeAccuracyRecord,
  resolveActualIso,
  assertCanAttest,
  slugify,
} from "../src/servers/web/service.js";
import type { User, DeskPost, DeskAttestation, InjuryEntity, OtmProjection } from "../src/servers/web/client.js";
import type { LintFinding } from "../src/servers/web/linter.js";
import type { InjuryPost } from "../src/shared/types.js";

const mdUser = { id: "u1", email: "md@x.com", role: "md", name: null, created_at: "2026-01-01T00:00:00Z" } as User;
const editorUser = { ...mdUser, role: "editor" } as User;

describe("date-utils", () => {
  describe("toIsoDate", () => {
    it("passes a plain YYYY-MM-DD string through unchanged", () => {
      expect(toIsoDate("2026-01-19")).toBe("2026-01-19");
    });

    it("truncates a full ISO timestamp string to the date", () => {
      expect(toIsoDate("2026-01-19T00:00:00.000Z")).toBe("2026-01-19");
    });

    it("reads a UTC-midnight Date object without shifting the day", () => {
      // This is exactly what the neon driver hands back for a DATE column.
      expect(toIsoDate(new Date("2026-01-19T00:00:00.000Z"))).toBe("2026-01-19");
    });

    it("uses the UTC calendar day for a Date carrying a time component", () => {
      expect(toIsoDate(new Date("2026-01-19T23:59:59.000Z"))).toBe("2026-01-19");
    });
  });

  describe("daysBetween", () => {
    it("counts whole days between two date strings", () => {
      expect(daysBetween("2026-01-01", "2026-01-08")).toBe(7);
    });

    it("accepts Date objects on either side (driver values)", () => {
      expect(daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-11T00:00:00Z"))).toBe(10);
    });

    it("is negative when the return precedes the projection", () => {
      expect(daysBetween("2026-01-10", "2026-01-05")).toBe(-5);
    });
  });

  describe("addWeeks", () => {
    it("adds whole weeks and returns a date string", () => {
      expect(addWeeks("2026-01-01", 2)).toBe("2026-01-15");
    });

    it("accepts a Date base", () => {
      expect(addWeeks(new Date("2026-01-01T00:00:00Z"), 6)).toBe("2026-02-12");
    });
  });

  describe("normalizeEntityDates / normalizePostDates", () => {
    it("converts DATE columns returned as Date objects into YYYY-MM-DD strings", () => {
      const raw = {
        injury_date: new Date("2026-01-19T00:00:00.000Z"),
        surgery_date: new Date("2026-02-02T00:00:00.000Z"),
        actual_return_date: new Date("2026-05-01T00:00:00.000Z"),
        otm_projection: null,
      } as unknown as InjuryEntity;
      const out = normalizeEntityDates(raw);
      expect(out.injury_date).toBe("2026-01-19");
      expect(out.surgery_date).toBe("2026-02-02");
      expect(out.actual_return_date).toBe("2026-05-01");
    });

    it("leaves null date fields as null", () => {
      const raw = {
        injury_date: null,
        surgery_date: null,
        actual_return_date: null,
      } as unknown as InjuryEntity;
      const out = normalizeEntityDates(raw);
      expect(out.injury_date).toBeNull();
      expect(out.actual_return_date).toBeNull();
    });

    it("normalizes injury_posts.injury_date", () => {
      const raw = { injury_date: new Date("2026-03-24T00:00:00.000Z") } as unknown as InjuryPost;
      expect(normalizePostDates(raw).injury_date).toBe("2026-03-24");
    });
  });
});

describe("service", () => {
  const BODY = "clean body";
  const post = { markdown_body: BODY } as DeskPost;
  const goodAtt = { content_hash: hashPayload(BODY) } as DeskAttestation;
  const noBlockers: LintFinding[] = [];

  describe("evaluatePublishGate", () => {
    it("passes when role=md, hash matches, zero blockers", () => {
      const gate = evaluatePublishGate(post, mdUser, goodAtt, noBlockers);
      expect(gate.passed).toBe(true);
      expect(gate.reasons).toEqual([]);
    });

    it("fails a non-MD reviewer", () => {
      const gate = evaluatePublishGate(post, editorUser, goodAtt, noBlockers);
      expect(gate.passed).toBe(false);
      expect(gate.role_ok).toBe(false);
      expect(gate.reasons).toContain("reviewer is not an MD");
    });

    it("fails a null reviewer", () => {
      const gate = evaluatePublishGate(post, null, goodAtt, noBlockers);
      expect(gate.role_ok).toBe(false);
      expect(gate.passed).toBe(false);
    });

    it("fails when there is no attestation", () => {
      const gate = evaluatePublishGate(post, mdUser, null, noBlockers);
      expect(gate.hash_match).toBe(false);
      expect(gate.reasons).toContain("no attestation found");
    });

    it("fails when the body was edited after attestation (hash mismatch)", () => {
      const stale = { content_hash: hashPayload("different body") } as DeskAttestation;
      const gate = evaluatePublishGate(post, mdUser, stale, noBlockers);
      expect(gate.hash_match).toBe(false);
      expect(gate.reasons).toContain("post edited after attestation (content hash mismatch)");
    });

    it("fails and surfaces blockers even with role+hash OK", () => {
      const blockers: LintFinding[] = [
        { code: "career_prognosis", severity: "blocker", message: "no career predictions" },
      ];
      const gate = evaluatePublishGate(post, mdUser, goodAtt, blockers);
      expect(gate.role_ok).toBe(true);
      expect(gate.hash_match).toBe(true);
      expect(gate.passed).toBe(false);
      expect(gate.reasons).toContain("career_prognosis: no career predictions");
    });
  });

  describe("computeAccuracyRecord", () => {
    const projection: OtmProjection = {
      min_weeks: 4,
      max_weeks: 8,
      projected_return_date: "2026-03-01",
    };

    it("returns null when the entity has no projection", () => {
      const entity = { otm_projection: null, injury_date: "2026-01-01" } as unknown as InjuryEntity;
      expect(computeAccuracyRecord(entity, "2026-03-01")).toBeNull();
    });

    it("computes error_days from projected vs actual", () => {
      const entity = { otm_projection: projection, injury_date: "2026-01-01" } as unknown as InjuryEntity;
      const rec = computeAccuracyRecord(entity, "2026-03-05");
      expect(rec?.error_days).toBe(4); // 2026-03-05 is 4 days after 2026-03-01
    });

    it("flags within_range when actual falls inside [injury+min, injury+max]", () => {
      // injury 2026-01-01, min 4w = 2026-01-29, max 8w = 2026-02-26.
      const entity = { otm_projection: projection, injury_date: "2026-01-01" } as unknown as InjuryEntity;
      expect(computeAccuracyRecord(entity, "2026-02-10")?.within_range).toBe(true);
      expect(computeAccuracyRecord(entity, "2026-03-15")?.within_range).toBe(false);
    });

    it("handles a Date-object injury_date (the 15bb517 driver case)", () => {
      // Before the fix, a Date here produced NaN math / a mis-typed comparison.
      const entity = {
        otm_projection: projection,
        injury_date: new Date("2026-01-01T00:00:00.000Z"),
      } as unknown as InjuryEntity;
      const rec = computeAccuracyRecord(entity, "2026-02-10");
      expect(rec?.within_range).toBe(true);
      expect(rec?.error_days).toBe(daysBetween("2026-03-01", "2026-02-10"));
    });
  });

  describe("resolveActualIso", () => {
    it("prefers the tool-supplied date over the stored one", () => {
      const entity = { actual_return_date: new Date("2026-05-01T00:00:00Z") } as unknown as InjuryEntity;
      expect(resolveActualIso(entity, "2026-04-15")).toBe("2026-04-15");
    });

    it("falls back to the entity's stored Date value", () => {
      const entity = { actual_return_date: new Date("2026-05-01T00:00:00Z") } as unknown as InjuryEntity;
      expect(resolveActualIso(entity)).toBe("2026-05-01");
    });

    it("returns null when neither is present", () => {
      const entity = { actual_return_date: null } as unknown as InjuryEntity;
      expect(resolveActualIso(entity)).toBeNull();
    });
  });

  describe("assertCanAttest", () => {
    const post = { id: "p1", status: "DRAFT" } as DeskPost;
    const input = {
      reviewer_user_id: "u1",
      reviewed_source_reports: true,
      edited_for_accuracy: true,
      framing_confirmed: true,
    };

    it("passes for an MD with all confirmations on a DRAFT/READY post", () => {
      expect(() => assertCanAttest(mdUser, input, post)).not.toThrow();
      expect(() => assertCanAttest(mdUser, input, { ...post, status: "READY" } as DeskPost)).not.toThrow();
    });

    it("throws for an unknown reviewer", () => {
      expect(() => assertCanAttest(null, input, post)).toThrow(McpToolError);
    });

    it("throws for a non-MD reviewer", () => {
      expect(() => assertCanAttest(editorUser, input, post)).toThrow(/not 'md'/);
    });

    it("throws when a confirmation is false", () => {
      expect(() => assertCanAttest(mdUser, { ...input, framing_confirmed: false }, post)).toThrow(
        /three review steps/,
      );
    });

    it("throws when the post is not DRAFT or READY", () => {
      expect(() => assertCanAttest(mdUser, input, { ...post, status: "PUBLISHED" } as DeskPost)).toThrow(
        /cannot be attested/,
      );
    });
  });

  describe("slugify", () => {
    it("lowercases, strips punctuation, and hyphenates", () => {
      expect(slugify("Patrick Mahomes' Ankle!")).toBe("patrick-mahomes-ankle");
    });

    it("collapses repeated separators and trims edges", () => {
      expect(slugify("  --Foo   Bar-- ")).toBe("foo-bar");
    });

    it("caps length and falls back when empty", () => {
      expect(slugify("!!!", 200, "injury-desk-post")).toBe("injury-desk-post");
      expect(slugify("a".repeat(300)).length).toBe(200);
    });
  });
});
