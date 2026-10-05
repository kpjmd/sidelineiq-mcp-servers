/**
 * Prove migration 026's triggers against a real database.
 *
 * `mockSql` cannot exercise a trigger, and the ledger's whole promise — a
 * published forecast row is immutable — lives in one. This script publishes a
 * test row the way ledger-client.ts does and then attempts every forbidden
 * write, expecting each to raise, and every permitted write, expecting each
 * to succeed exactly once.
 *
 * It leaves a PUBLISHED test row behind (by design it cannot delete it), so it
 * must only ever run against a scratch Neon branch on which 026 has already
 * been applied with psql:
 *
 *   LEDGER_SCHEMA_CHECK_DATABASE_URL=postgres://… \
 *     npx tsx src/scripts/ledger-schema-check.ts --scratch
 *
 * Exit 0 when every expectation holds; 1 otherwise, with the table printed.
 */
import { neon } from "@neondatabase/serverless";

const url = process.env.LEDGER_SCHEMA_CHECK_DATABASE_URL;
if (!url || !process.argv.includes("--scratch")) {
  console.error(
    "Refusing to run: set LEDGER_SCHEMA_CHECK_DATABASE_URL to a SCRATCH branch and pass --scratch.\n" +
      "This script publishes a permanent test row; it must never run against production.",
  );
  process.exit(2);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
  console.error("Refusing to run: LEDGER_SCHEMA_CHECK_DATABASE_URL equals DATABASE_URL.");
  process.exit(2);
}

const sql = neon(url);

interface Check {
  name: string;
  expect: "ok" | "raise";
  run: () => Promise<unknown>;
}

const results: { name: string; expect: string; got: string; ok: boolean; detail?: string }[] = [];

async function check(c: Check): Promise<void> {
  try {
    await c.run();
    results.push({ name: c.name, expect: c.expect, got: "ok", ok: c.expect === "ok" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: c.name, expect: c.expect, got: "raise", ok: c.expect === "raise", detail: msg.split("\n")[0] });
  }
}

async function main(): Promise<void> {
  const md = (await sql`SELECT id FROM users WHERE role = 'md' ORDER BY created_at LIMIT 1`) as { id: string }[];
  if (md.length === 0) throw new Error("no md user on this branch; apply 012 first");
  const mdId = md[0].id;
  const stamp = Date.now();
  const rowKey = `schema_check_${stamp}`;

  await sql`
    INSERT INTO ledger_base_rates (row_key, injury_type, strength, source_rank, updated_by)
    VALUES (${rowKey}, 'schema check', 'thin', 4, ${mdId})
  `;

  const draftRows = (await sql`
    INSERT INTO ledger_forecasts (
      status, version, player, team, position, injury_date, reported_injury, source_tier, source_urls,
      mechanism, base_rate_row, base_rate_strength, f1_ir, f2_next, f3_4wk, f4_point, f4_low, f4_high,
      f5_reinjury, season_ending, what_moves_this, tier, created_by
    ) VALUES (
      'draft', 1, ${"Schema Check " + stamp}, 'ZZZ', 'QB', '2026-01-01', 'schema check row', 'C', '["https://example.com/schema-check"]',
      'Schema check.', ${rowKey}, 'thin', 0.1, 0.2, 0.3, 2, 1, 3, 0.1, false, 'Nothing; this is a schema check.', 2, ${mdId}
    ) RETURNING id
  `) as { id: string }[];
  const id = draftRows[0].id;

  // Drafts are mutable.
  await check({ name: "draft: UPDATE player", expect: "ok", run: () => sql`UPDATE ledger_forecasts SET player = 'Schema Check Edited' WHERE id = ${id}` });

  // Publish (the same statement shape as ledger-client.ts publishForecast).
  const published = (await sql`
    WITH yr AS (SELECT 2999 AS y),
    seq AS (
      INSERT INTO ledger_entry_sequence (year, next_n)
      SELECT y, 2 FROM yr
      WHERE EXISTS (SELECT 1 FROM ledger_forecasts WHERE id = ${id} AND status = 'draft' AND entry_id IS NULL)
      ON CONFLICT (year) DO UPDATE SET next_n = ledger_entry_sequence.next_n + 1
      RETURNING year, next_n - 1 AS n
    )
    UPDATE ledger_forecasts f
    SET status = 'published',
        entry_id = 'PT-' || seq.year::text || '-' || lpad(seq.n::text, 3, '0'),
        published_at = date_trunc('milliseconds', NOW()),
        confirmed_by = ${mdId}, confirmed_at = NOW(), updated_at = NOW()
    FROM seq
    WHERE f.id = ${id} AND f.status = 'draft' AND f.entry_id IS NULL
    RETURNING f.entry_id, f.published_at
  `) as { entry_id: string; published_at: Date }[];
  if (published.length !== 1) throw new Error("publish statement updated no row");
  console.log(`published test row ${published[0].entry_id} (year 2999 keeps it out of the real sequence)`);

  const hash = "a".repeat(64);
  await check({ name: "published: set row_hash once", expect: "ok", run: () => sql`UPDATE ledger_forecasts SET row_hash = ${hash} WHERE id = ${id}` });
  await check({ name: "published: change row_hash", expect: "raise", run: () => sql`UPDATE ledger_forecasts SET row_hash = ${"b".repeat(64)} WHERE id = ${id}` });
  await check({ name: "published: same row_hash again (no-op)", expect: "ok", run: () => sql`UPDATE ledger_forecasts SET row_hash = ${hash} WHERE id = ${id}` });
  await check({ name: "published: change player", expect: "raise", run: () => sql`UPDATE ledger_forecasts SET player = 'Tampered' WHERE id = ${id}` });
  await check({ name: "published: change f2_next", expect: "raise", run: () => sql`UPDATE ledger_forecasts SET f2_next = 0.9 WHERE id = ${id}` });
  await check({ name: "published: change published_at", expect: "raise", run: () => sql`UPDATE ledger_forecasts SET published_at = NOW() WHERE id = ${id}` });
  await check({ name: "published: back to draft", expect: "raise", run: () => sql`UPDATE ledger_forecasts SET status = 'draft' WHERE id = ${id}` });
  await check({ name: "published: change confirmed_by", expect: "raise", run: () => sql`UPDATE ledger_forecasts SET confirmed_by = NULL WHERE id = ${id}` });
  await check({ name: "published: set commit_sha once", expect: "ok", run: () => sql`UPDATE ledger_forecasts SET commit_sha = 'abc1234' WHERE id = ${id}` });
  await check({ name: "published: change commit_sha", expect: "raise", run: () => sql`UPDATE ledger_forecasts SET commit_sha = 'def5678' WHERE id = ${id}` });
  await check({ name: "published: set x_post_id via COALESCE (first value sticks)", expect: "ok", run: () => sql`UPDATE ledger_forecasts SET x_post_id = COALESCE(x_post_id, '1') WHERE id = ${id}` });
  await check({ name: "published: COALESCE a second x_post_id (no change, no raise)", expect: "ok", run: () => sql`UPDATE ledger_forecasts SET x_post_id = COALESCE(x_post_id, '2') WHERE id = ${id}` });
  await check({ name: "published: DELETE", expect: "raise", run: () => sql`DELETE FROM ledger_forecasts WHERE id = ${id}` });

  // Resolutions.
  const entryId = published[0].entry_id;
  await sql`INSERT INTO ledger_resolutions (entry_id, field, status) VALUES (${entryId}, 'F1', 'open')`;
  await check({
    name: "resolution: open → resolved",
    expect: "ok",
    run: () => sql`
      UPDATE ledger_resolutions SET status = 'resolved', outcome = 1, freeze_at = NOW(), resolved_at = NOW(),
        confirmed_by = ${mdId}, confirmed_at = NOW()
      WHERE entry_id = ${entryId} AND field = 'F1'`,
  });
  await check({ name: "resolution: change a resolved outcome", expect: "raise", run: () => sql`UPDATE ledger_resolutions SET outcome = 0 WHERE entry_id = ${entryId} AND field = 'F1'` });
  await check({ name: "resolution: DELETE", expect: "raise", run: () => sql`DELETE FROM ledger_resolutions WHERE entry_id = ${entryId} AND field = 'F1'` });
  await check({
    name: "resolution: resolved without confirmer (CHECK)",
    expect: "raise",
    run: () => sql`INSERT INTO ledger_resolutions (entry_id, field, status, outcome, freeze_at) VALUES (${entryId}, 'F2', 'resolved', 1, NOW())`,
  });

  // Corrections.
  const corr = (await sql`
    INSERT INTO ledger_corrections (entry_id, field, old_value, new_value, note, corrected_by)
    VALUES (${entryId}, 'player', 'A', 'B', 'schema check', ${mdId}) RETURNING id
  `) as { id: string }[];
  await check({ name: "correction: UPDATE", expect: "raise", run: () => sql`UPDATE ledger_corrections SET note = 'x' WHERE id = ${corr[0].id}` });
  await check({ name: "correction: DELETE", expect: "raise", run: () => sql`DELETE FROM ledger_corrections WHERE id = ${corr[0].id}` });

  // A draft may be deleted; a revision draft must carry a trigger to publish.
  const d2 = (await sql`
    INSERT INTO ledger_forecasts (
      status, entry_id, version, player, team, position, injury_date, reported_injury, source_tier, source_urls,
      mechanism, base_rate_row, base_rate_strength, f1_ir, f2_next, f3_4wk, f4_point, f4_low, f4_high,
      f5_reinjury, season_ending, what_moves_this, tier, created_by
    ) VALUES (
      'draft', ${entryId}, 2, 'Schema Check', 'ZZZ', 'QB', '2026-01-01', 'schema check row', 'C', '["https://example.com/schema-check"]',
      'Schema check.', ${rowKey}, 'thin', 0.1, 0.2, 0.3, 2, 1, 3, 0.1, false, 'Nothing.', 2, ${mdId}
    ) RETURNING id
  `) as { id: string }[];
  await check({
    name: "revision without trigger cannot be published (CHECK)",
    expect: "raise",
    run: () => sql`UPDATE ledger_forecasts SET status = 'published', published_at = NOW(), confirmed_by = ${mdId}, confirmed_at = NOW() WHERE id = ${d2[0].id}`,
  });
  await check({ name: "second draft for the same entry (partial unique)", expect: "raise", run: () => sql`
    INSERT INTO ledger_forecasts (
      status, entry_id, version, player, team, position, injury_date, reported_injury, source_tier, source_urls,
      mechanism, base_rate_row, base_rate_strength, f1_ir, f2_next, f3_4wk, f4_point, f4_low, f4_high,
      f5_reinjury, season_ending, what_moves_this, tier, created_by
    ) VALUES (
      'draft', ${entryId}, 3, 'Schema Check', 'ZZZ', 'QB', '2026-01-01', 'schema check row', 'C', '[]',
      'Schema check.', ${rowKey}, 'thin', 0.1, 0.2, 0.3, 2, 1, 3, 0.1, false, 'Nothing.', 2, ${mdId}
    )` });
  await check({ name: "draft: DELETE", expect: "ok", run: () => sql`DELETE FROM ledger_forecasts WHERE id = ${d2[0].id} AND status = 'draft'` });

  const width = Math.max(...results.map((r) => r.name.length));
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expect.padEnd(5)} got ${r.got.padEnd(5)} ${r.detail ?? ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} expectations held. Test row ${entryId} stays on this branch (immutable by design).`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
