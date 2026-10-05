import { describe, it, expect } from "vitest";

// Pure-function tests for the ledger publish gate and helpers. No DB, no mocks.

import {
  evaluateLedgerPublishGate,
  formatEntryId,
  ENTRY_ID_RE,
  publishedRowHash,
  lockedFields,
  type LedgerForecast,
  type LedgerResolution,
} from "../src/servers/web/ledger-service.js";
import type { User } from "../src/servers/web/client.js";

const md = { id: "11111111-1111-4111-8111-111111111111", email: "md@x.com", role: "md", name: null, created_at: "2026-01-01T00:00:00Z" } as User;
const editor = { ...md, id: "22222222-2222-4222-8222-222222222222", role: "editor" } as User;

function draft(over: Partial<LedgerForecast> = {}): LedgerForecast {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    status: "draft",
    entry_id: null,
    version: 1,
    published_at: null,
    trigger: null,
    player: "Example Player",
    team: "BUF",
    position: "WR",
    injury_date: "2026-10-04",
    reported_injury: "Grade 2 hamstring strain",
    source_tier: "B",
    source_urls: ["https://x.com/example/status/1"],
    mechanism: "Non-contact. Acceleration out of a cut. Q3 2:14.",
    base_rate_row: "hamstring_strain",
    base_rate_strength: "moderate",
    f1_ir: "0.1800",
    f2_next: "0.1200",
    f3_4wk: "0.6100",
    f4_point: 3,
    f4_low: 2,
    f4_high: 5,
    f5_reinjury: "0.2200",
    season_ending: false,
    what_moves_this: "An IR designation, or a limited practice by Thursday.",
    tier: 1,
    row_hash: null,
    confirmed_by: null,
    confirmed_at: null,
    commit_sha: null,
    commit_url: null,
    x_post_id: null,
    x_self_reply_id: null,
    farcaster_hash: null,
    reply_to_url: null,
    espn_athlete_id: null,
    gsis_id: null,
    pfr_id: null,
    nflverse_team: "BUF",
    season: 2026,
    player_id: null,
    entity_id: null,
    created_by: md.id,
    created_at: "2026-10-04T20:00:00Z",
    updated_at: "2026-10-04T20:00:00Z",
    ...over,
  };
}

const resolution = (field: LedgerResolution["field"], status: LedgerResolution["status"]): LedgerResolution => ({
  id: `r-${field}`,
  entry_id: "PT-2026-001",
  field,
  status,
  outcome: status === "resolved" ? 1 : null,
  outcome_date: null,
  resolved_at: null,
  freeze_at: status === "open" ? null : "2026-10-11T17:00:00.000Z",
  void_reason: status === "void" ? "traded" : null,
  evidence_url: null,
  evidence: null,
  proposal_id: null,
  confirmed_by: status === "open" ? null : md.id,
  confirmed_at: null,
  created_at: "2026-10-04T20:00:00Z",
});

describe("formatEntryId", () => {
  it("is PT-YYYY-NNN, zero-padded, and grows past 999", () => {
    expect(formatEntryId(2026, 1)).toBe("PT-2026-001");
    expect(formatEntryId(2026, 41)).toBe("PT-2026-041");
    expect(formatEntryId(2026, 1234)).toBe("PT-2026-1234");
    expect(ENTRY_ID_RE.test("PT-2026-001")).toBe(true);
    expect(ENTRY_ID_RE.test("PT-26-1")).toBe(false);
    expect(() => formatEntryId(2026, 0)).toThrow();
  });
});

describe("evaluateLedgerPublishGate", () => {
  it("passes a complete v1 draft for an MD", () => {
    const g = evaluateLedgerPublishGate(draft(), md, null, []);
    expect(g).toEqual({ role_ok: true, passed: true, reasons: [] });
  });

  it("refuses anyone who is not an MD, including an unknown user", () => {
    expect(evaluateLedgerPublishGate(draft(), editor, null, []).reasons).toContain("reviewer is not an MD");
    expect(evaluateLedgerPublishGate(draft(), null, null, []).passed).toBe(false);
  });

  it("refuses a row that is already published", () => {
    expect(evaluateLedgerPublishGate(draft({ status: "published" }), md, null, []).reasons).toContain("row is published, not a draft");
  });

  it("names every missing required field rather than stopping at the first", () => {
    const g = evaluateLedgerPublishGate(draft({ mechanism: "  ", what_moves_this: "", source_urls: [] }), md, null, []);
    expect(g.reasons).toEqual(expect.arrayContaining(["mechanism is required", "what_moves_this is required", "at least one source URL is required"]));
    expect(g.passed).toBe(false);
  });

  it("checks probabilities, the F4 interval and the F5 concussion exemption", () => {
    expect(evaluateLedgerPublishGate(draft({ f1_ir: "1.2" }), md, null, []).reasons).toContain("f1_ir must be a probability in [0, 1]");
    expect(evaluateLedgerPublishGate(draft({ f4_low: 4 }), md, null, []).reasons).toContain("f4 interval must satisfy low ≤ point ≤ high");
    expect(evaluateLedgerPublishGate(draft({ f5_reinjury: null }), md, null, []).reasons).toContain("f5_reinjury is required unless the base-rate row is concussion");
    expect(evaluateLedgerPublishGate(draft({ f5_reinjury: null, base_rate_row: "concussion" }), md, null, []).passed).toBe(true);
  });

  it("a revision must name its trigger and have a published previous version", () => {
    const prev = draft({ status: "published", entry_id: "PT-2026-001", published_at: "2026-10-04T22:00:00.000Z" });
    const rev = draft({ entry_id: "PT-2026-001", version: 2, trigger: null });
    expect(evaluateLedgerPublishGate(rev, md, prev, []).reasons).toContain("a revision must name its public trigger");
    expect(evaluateLedgerPublishGate({ ...rev, trigger: "Placed on IR" }, md, null, []).reasons).toContain("a revision needs a published previous version");
    expect(evaluateLedgerPublishGate({ ...rev, trigger: "Placed on IR" }, md, prev, []).passed).toBe(true);
  });

  it("a revision may not move a field that has resolved or been voided, and may move the open ones", () => {
    const prev = draft({ status: "published", entry_id: "PT-2026-001", published_at: "2026-10-04T22:00:00.000Z" });
    const rev = draft({ entry_id: "PT-2026-001", version: 2, trigger: "Placed on IR", f1_ir: "1.0000", f2_next: "0.0000", f4_point: 6, f4_low: 4, f4_high: 8 });
    const locked = lockedFields([resolution("F1", "resolved"), resolution("F2", "void"), resolution("F3", "open"), resolution("F4", "open")]);
    expect(locked.map((r) => r.field)).toEqual(["F1", "F2"]);
    const g = evaluateLedgerPublishGate(rev, md, prev, locked);
    expect(g.reasons).toEqual(["F1 is resolved and may not change in a revision", "F2 is void and may not change in a revision"]);
    // Copying the locked values forward unchanged passes.
    const copied = { ...rev, f1_ir: prev.f1_ir, f2_next: prev.f2_next };
    expect(evaluateLedgerPublishGate(copied, md, prev, locked).passed).toBe(true);
  });
});

describe("publishedRowHash", () => {
  it("hashes a published row and refuses a draft", () => {
    const row = draft({ status: "published", entry_id: "PT-2026-001", published_at: new Date("2026-10-06T18:04:05.123Z") });
    expect(publishedRowHash(row)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => publishedRowHash(draft())).toThrow(/unpublished/);
  });

  it("ignores provenance and linkage columns", () => {
    const row = draft({ status: "published", entry_id: "PT-2026-001", published_at: "2026-10-06T18:04:05.123Z" });
    const withProv = { ...row, commit_sha: "abc", x_post_id: "1", gsis_id: "00-0", confirmed_by: md.id };
    expect(publishedRowHash(withProv)).toBe(publishedRowHash(row));
  });
});
