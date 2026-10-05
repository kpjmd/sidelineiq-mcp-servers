/**
 * The ledger row hash is stamped here at publish and printed on the card, and
 * three repos compute it. This pins the mcp twin (src/servers/web/ledger-hash.ts,
 * byte-identical to agents src/ledger/row-hash.ts) to the recorded fixture.
 */
import { describe, it, expect } from "vitest";
import {
  LEDGER_HASH_VERSION,
  ledgerHashInput,
  ledgerRowHash,
  type HashableForecastRow,
} from "../src/servers/web/ledger-hash.js";
import fixture from "./fixtures/ledger-hash-cases.json" with { type: "json" };

interface Case {
  name: string;
  rule: string;
  input: Record<string, unknown>;
  equivalent?: Record<string, unknown>;
  normalized: Record<string, unknown>;
  row_hash: string;
}

function revive(input: Record<string, unknown>): HashableForecastRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v && typeof v === "object" && "$date" in (v as object)) out[k] = new Date((v as { $date: string }).$date);
    else if (v && typeof v === "object" && "$undefined" in (v as object)) continue;
    else out[k] = v;
  }
  return out as unknown as HashableForecastRow;
}

const CASES = (fixture as unknown as { cases: Case[] }).cases;

describe("ledger row hash (mcp twin)", () => {
  it("was recorded against this hash version", () => {
    expect((fixture as unknown as { hash_version: number }).hash_version).toBe(LEDGER_HASH_VERSION);
  });

  for (const c of CASES) {
    it(`${c.name} — ${c.rule}`, () => {
      const row = revive(c.input);
      expect(ledgerHashInput(row)).toEqual(c.normalized);
      expect(ledgerRowHash(row)).toBe(c.row_hash);
      if (c.equivalent) expect(ledgerRowHash(revive(c.equivalent))).toBe(c.row_hash);
    });
  }
});
