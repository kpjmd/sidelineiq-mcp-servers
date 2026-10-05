// ── Prognosis Ledger: database access ──────────────────────────────────
//
// Composes over WebDatabaseClient for the two things the ledger shares with
// the rest of the web server — re-deriving a user's role (getUser) and the
// append-only audit trail (auditAppend) — and owns every ledger_* query.
//
// Invariants this file keeps, in order of importance:
//  1. Nothing publishes without a physician: publishForecast re-derives the
//     role from `users` and refuses anything but 'md'. A blocked publish is a
//     successful result with published:false (frontend → 422), audited.
//  2. A published row is never mutated here. The database trigger (026) is the
//     enforcement; this file simply never tries, except for the once-settable
//     provenance columns.
//  3. The ingest can only PROPOSE. proposeResolution writes to
//     ledger_resolution_proposals; only decideProposal, which requires an MD,
//     writes a resolved/void row — and does so in ONE data-modifying CTE with
//     the proposal's own state change.
//  4. The entry id is allocated INSIDE the publish statement, from a per-year
//     sequence, so an abandoned draft never leaves a gap.

import { getDatabase } from "../../shared/database.js";
import { McpToolError } from "../../shared/errors.js";
import type { WebDatabaseClient } from "./client.js";
import {
  evaluateLedgerPublishGate,
  lockedFields,
  publishedRowHash,
  LEDGER_FIELDS,
  type BaseRateStrength,
  type LedgerBaseRate,
  type LedgerCorrection,
  type LedgerFieldName,
  type LedgerForecast,
  type LedgerProposal,
  type LedgerPublishGate,
  type LedgerResolution,
  type ReplyProposal,
  type SourceTier,
} from "./ledger-service.js";

export interface LedgerDraftFields {
  player: string;
  team: string;
  position: string;
  injury_date: string;
  reported_injury: string;
  source_tier: SourceTier;
  source_urls: string[];
  mechanism: string;
  base_rate_row: string;
  base_rate_strength: BaseRateStrength;
  f1_ir: number;
  f2_next: number;
  f3_4wk: number;
  f4_point: number;
  f4_low: number;
  f4_high: number;
  f5_reinjury: number | null;
  season_ending: boolean;
  what_moves_this: string;
  tier: 1 | 2;
  trigger?: string | null;
  reply_to_url?: string | null;
  espn_athlete_id?: string | null;
  gsis_id?: string | null;
  pfr_id?: string | null;
  nflverse_team?: string | null;
  season?: number | null;
  player_id?: string | null;
  entity_id?: string | null;
}

export interface CreateLedgerDraftInput extends LedgerDraftFields {
  created_by: string;
  /** Set to revise an existing entry; the draft becomes the next version. */
  parent_entry_id?: string | null;
}

export interface UpdateLedgerDraftInput extends Partial<LedgerDraftFields> {
  draft_id: string;
  edited_by: string;
}

export interface LedgerPublishResult {
  published: boolean;
  gate: LedgerPublishGate;
  forecast: LedgerForecast | null;
  resolutions: LedgerResolution[];
}

export interface LedgerProvenanceInput {
  forecast_id: string;
  commit_sha?: string;
  commit_url?: string;
  x_post_id?: string;
  x_self_reply_id?: string;
  farcaster_hash?: string;
}

export interface ProposeResolutionInput {
  entry_id: string;
  field: LedgerFieldName;
  proposed_status: "resolved" | "void";
  proposed_outcome?: number | null;
  outcome_date?: string | null;
  freeze_at?: string | null;
  void_reason?: string | null;
  evidence_url?: string | null;
  evidence?: Record<string, unknown> | null;
  proposer?: string;
}

export interface DecideProposalInput {
  proposal_id: string;
  reviewer_user_id: string;
  decision: "confirmed" | "rejected";
  note?: string | null;
}

export interface RecordCorrectionInput {
  entry_id: string;
  field: string;
  old_value?: string | null;
  new_value?: string | null;
  note: string;
  corrected_by: string;
}

export interface UpsertBaseRateInput {
  row_key: string;
  injury_type: string;
  strength: BaseRateStrength;
  source_rank?: number | null;
  sources?: string | null;
  n?: number | null;
  year_range?: string | null;
  f1_ir?: number | null;
  f2_next?: number | null;
  f3_4wk?: number | null;
  f5_reinjury?: number | null;
  f4_point?: number | null;
  f4_low?: number | null;
  f4_high?: number | null;
  notes?: string | null;
  updated_by: string;
}

export interface ProposeReplyInput {
  platform: "x" | "farcaster";
  mention_id: string;
  mention_url?: string | null;
  mention_author?: string | null;
  mention_text?: string | null;
  proposed_text: string;
}

export interface DecideReplyInput {
  proposal_id: string;
  reviewer_user_id: string;
  /** 027: the MD approves or discards. 'posted' is written only by recordReplyPost after the platform answers. */
  decision: "approved" | "discarded";
  /** The MD's final wording if edited before approval. */
  approved_text?: string | null;
  note?: string | null;
}

export interface RecordReplyPostInput {
  proposal_id: string;
  /** claim: take the approved row for posting (once); posted: record the platform id; failed: release the claim. */
  outcome: "claim" | "posted" | "failed";
  posted_id?: string | null;
  posted_text?: string | null;
  error?: string | null;
}

export interface LedgerEntryDetail {
  entry_id: string;
  versions: LedgerForecast[];
  resolutions: LedgerResolution[];
  corrections: LedgerCorrection[];
  proposals: LedgerProposal[];
}

export interface LedgerExport {
  forecasts: LedgerForecast[];
  resolutions: LedgerResolution[];
  corrections: LedgerCorrection[];
  exported_at: string;
}

function notFound(what: string, id: string, hint: string): McpToolError {
  return new McpToolError(`${what} ${id} not found`, hint);
}

export class LedgerClient {
  constructor(private readonly web: WebDatabaseClient) {}

  private get sql() {
    return getDatabase();
  }

  private async requireMd(userId: string, action: string) {
    const user = await this.web.getUser(userId);
    if (!user || user.role !== "md") {
      throw new McpToolError(
        `${action} requires an MD; user ${userId} is ${user ? user.role : "unknown"}`,
        "Only the physician's user id (role md in the users table) may perform this action.",
      );
    }
    return user;
  }

  // ── Base rates ──────────────────────────────────────────────────────

  async upsertBaseRate(input: UpsertBaseRateInput): Promise<LedgerBaseRate> {
    const rows = await this.sql`
      INSERT INTO ledger_base_rates (
        row_key, injury_type, strength, source_rank, sources, n, year_range,
        f1_ir, f2_next, f3_4wk, f5_reinjury, f4_point, f4_low, f4_high, notes, updated_by, updated_at
      ) VALUES (
        ${input.row_key}, ${input.injury_type}, ${input.strength}, ${input.source_rank ?? null}, ${input.sources ?? null},
        ${input.n ?? null}, ${input.year_range ?? null},
        ${input.f1_ir ?? null}, ${input.f2_next ?? null}, ${input.f3_4wk ?? null}, ${input.f5_reinjury ?? null},
        ${input.f4_point ?? null}, ${input.f4_low ?? null}, ${input.f4_high ?? null}, ${input.notes ?? null},
        ${input.updated_by}, NOW()
      )
      ON CONFLICT (row_key) DO UPDATE SET
        injury_type = EXCLUDED.injury_type, strength = EXCLUDED.strength, source_rank = EXCLUDED.source_rank,
        sources = EXCLUDED.sources, n = EXCLUDED.n, year_range = EXCLUDED.year_range,
        f1_ir = EXCLUDED.f1_ir, f2_next = EXCLUDED.f2_next, f3_4wk = EXCLUDED.f3_4wk, f5_reinjury = EXCLUDED.f5_reinjury,
        f4_point = EXCLUDED.f4_point, f4_low = EXCLUDED.f4_low, f4_high = EXCLUDED.f4_high, notes = EXCLUDED.notes,
        updated_by = EXCLUDED.updated_by, updated_at = NOW()
      RETURNING *
    `;
    const row = rows[0] as LedgerBaseRate;
    await this.web.auditAppend({
      actor: "md",
      actor_id: input.updated_by,
      entity_type: "ledger_base_rate",
      action: "upsert_base_rate",
      after: row,
      payload: { row_key: row.row_key, strength: row.strength },
    });
    return row;
  }

  async listBaseRates(): Promise<LedgerBaseRate[]> {
    const rows = await this.sql`SELECT * FROM ledger_base_rates ORDER BY row_key`;
    return rows as LedgerBaseRate[];
  }

  // ── Drafts ──────────────────────────────────────────────────────────

  async createDraft(input: CreateLedgerDraftInput): Promise<LedgerForecast> {
    let version = 1;
    let entryId: string | null = null;
    if (input.parent_entry_id) {
      const prev = await this.sql`
        SELECT max(version) AS v FROM ledger_forecasts WHERE entry_id = ${input.parent_entry_id} AND status = 'published'
      `;
      const maxV = Number((prev[0] as { v: number | string | null })?.v ?? 0);
      if (!maxV) {
        throw notFound("Published ledger entry", input.parent_entry_id, "A revision needs a published entry. Use web_list_ledger_entries to find one.");
      }
      version = maxV + 1;
      entryId = input.parent_entry_id;
    }

    const rows = await this.sql`
      INSERT INTO ledger_forecasts (
        status, entry_id, version, trigger, player, team, position, injury_date, reported_injury,
        source_tier, source_urls, mechanism, base_rate_row, base_rate_strength,
        f1_ir, f2_next, f3_4wk, f4_point, f4_low, f4_high, f5_reinjury, season_ending, what_moves_this, tier,
        reply_to_url, espn_athlete_id, gsis_id, pfr_id, nflverse_team, season, player_id, entity_id, created_by
      ) VALUES (
        'draft', ${entryId}, ${version}, ${input.trigger ?? null}, ${input.player}, ${input.team}, ${input.position},
        ${input.injury_date}, ${input.reported_injury},
        ${input.source_tier}, ${JSON.stringify(input.source_urls)}, ${input.mechanism}, ${input.base_rate_row}, ${input.base_rate_strength},
        ${input.f1_ir}, ${input.f2_next}, ${input.f3_4wk}, ${input.f4_point}, ${input.f4_low}, ${input.f4_high},
        ${input.f5_reinjury ?? null}, ${input.season_ending}, ${input.what_moves_this}, ${input.tier},
        ${input.reply_to_url ?? null}, ${input.espn_athlete_id ?? null}, ${input.gsis_id ?? null}, ${input.pfr_id ?? null},
        ${input.nflverse_team ?? null}, ${input.season ?? null}, ${input.player_id ?? null}, ${input.entity_id ?? null},
        ${input.created_by}
      )
      RETURNING *
    `;
    const draft = rows[0] as LedgerForecast;
    await this.web.auditAppend({
      actor: "md",
      actor_id: input.created_by,
      entity_type: "ledger_forecast",
      entity_id: draft.id,
      action: "ledger_create_draft",
      payload: { entry_id: draft.entry_id, version: draft.version, player: draft.player },
    });
    return draft;
  }

  async updateDraft(input: UpdateLedgerDraftInput): Promise<LedgerForecast> {
    const current = await this.sql`SELECT * FROM ledger_forecasts WHERE id = ${input.draft_id}`;
    if (current.length === 0) throw notFound("Ledger draft", input.draft_id, "Use web_list_ledger_entries with include_drafts to find it.");
    const prev = current[0] as LedgerForecast;
    if (prev.status !== "draft") {
      throw new McpToolError(
        `Ledger row ${input.draft_id} is published and immutable`,
        "A published forecast is never edited. Create a revision (web_create_ledger_draft with parent_entry_id) or record a correction.",
      );
    }
    const v = <K extends keyof LedgerDraftFields>(k: K): LedgerDraftFields[K] | null =>
      (input[k] !== undefined ? (input[k] as LedgerDraftFields[K]) : null);

    const rows = await this.sql`
      UPDATE ledger_forecasts SET
        trigger = CASE WHEN ${input.trigger !== undefined} THEN ${input.trigger ?? null} ELSE trigger END,
        player = COALESCE(${v("player")}, player),
        team = COALESCE(${v("team")}, team),
        position = COALESCE(${v("position")}, position),
        injury_date = COALESCE(${v("injury_date")}, injury_date),
        reported_injury = COALESCE(${v("reported_injury")}, reported_injury),
        source_tier = COALESCE(${v("source_tier")}, source_tier),
        source_urls = COALESCE(${input.source_urls ? JSON.stringify(input.source_urls) : null}, source_urls),
        mechanism = COALESCE(${v("mechanism")}, mechanism),
        base_rate_row = COALESCE(${v("base_rate_row")}, base_rate_row),
        base_rate_strength = COALESCE(${v("base_rate_strength")}, base_rate_strength),
        f1_ir = COALESCE(${v("f1_ir")}, f1_ir),
        f2_next = COALESCE(${v("f2_next")}, f2_next),
        f3_4wk = COALESCE(${v("f3_4wk")}, f3_4wk),
        f4_point = COALESCE(${v("f4_point")}, f4_point),
        f4_low = COALESCE(${v("f4_low")}, f4_low),
        f4_high = COALESCE(${v("f4_high")}, f4_high),
        f5_reinjury = CASE WHEN ${input.f5_reinjury !== undefined} THEN ${input.f5_reinjury ?? null} ELSE f5_reinjury END,
        season_ending = COALESCE(${v("season_ending")}, season_ending),
        what_moves_this = COALESCE(${v("what_moves_this")}, what_moves_this),
        tier = COALESCE(${v("tier")}, tier),
        reply_to_url = CASE WHEN ${input.reply_to_url !== undefined} THEN ${input.reply_to_url ?? null} ELSE reply_to_url END,
        espn_athlete_id = COALESCE(${v("espn_athlete_id")}, espn_athlete_id),
        gsis_id = COALESCE(${v("gsis_id")}, gsis_id),
        pfr_id = COALESCE(${v("pfr_id")}, pfr_id),
        nflverse_team = COALESCE(${v("nflverse_team")}, nflverse_team),
        season = COALESCE(${v("season")}, season),
        player_id = COALESCE(${v("player_id")}, player_id),
        entity_id = COALESCE(${v("entity_id")}, entity_id),
        updated_at = NOW()
      WHERE id = ${input.draft_id} AND status = 'draft'
      RETURNING *
    `;
    if (rows.length === 0) {
      throw new McpToolError(
        `Ledger draft ${input.draft_id} changed concurrently`,
        "The row left draft since it was read. Re-fetch it and retry.",
      );
    }
    const draft = rows[0] as LedgerForecast;
    await this.web.auditAppend({
      actor: "md",
      actor_id: input.edited_by,
      entity_type: "ledger_forecast",
      entity_id: draft.id,
      action: "ledger_update_draft",
      before: prev,
      after: draft,
      payload: { fields: Object.keys(input).filter((k) => k !== "draft_id" && k !== "edited_by") },
    });
    return draft;
  }

  async deleteDraft(draftId: string, userId: string): Promise<{ deleted: boolean }> {
    await this.requireMd(userId, "Deleting a ledger draft");
    const rows = await this.sql`DELETE FROM ledger_forecasts WHERE id = ${draftId} AND status = 'draft' RETURNING id`;
    if (rows.length > 0) {
      await this.web.auditAppend({
        actor: "md",
        actor_id: userId,
        entity_type: "ledger_forecast",
        entity_id: draftId,
        action: "ledger_delete_draft",
      });
    }
    return { deleted: rows.length > 0 };
  }

  // ── Publish ─────────────────────────────────────────────────────────

  /**
   * THE CONFIRMATION STEP. Re-derives the reviewer's role, runs the gate, and
   * only then: stamps published_at (truncated to ms), allocates the entry id
   * from the per-year sequence inside the same statement, flips the row to
   * published, computes and writes row_hash from the stored row, opens five
   * resolution rows, and audits who confirmed and when.
   */
  async publishForecast(draftId: string, reviewerUserId: string): Promise<LedgerPublishResult> {
    const rows = await this.sql`SELECT * FROM ledger_forecasts WHERE id = ${draftId}`;
    if (rows.length === 0) throw notFound("Ledger draft", draftId, "Use web_list_ledger_entries with include_drafts to find it.");
    const draft = rows[0] as LedgerForecast;
    const user = await this.web.getUser(reviewerUserId);

    let previous: LedgerForecast | null = null;
    let locked: LedgerResolution[] = [];
    if (draft.entry_id) {
      const prevRows = await this.sql`
        SELECT * FROM ledger_forecasts WHERE entry_id = ${draft.entry_id} AND status = 'published'
        ORDER BY version DESC LIMIT 1
      `;
      previous = (prevRows[0] as LedgerForecast | undefined) ?? null;
      const resRows = await this.sql`SELECT * FROM ledger_resolutions WHERE entry_id = ${draft.entry_id}`;
      locked = lockedFields(resRows as LedgerResolution[]);
    }

    const gate = evaluateLedgerPublishGate(draft, user, previous, locked);
    if (!gate.passed) {
      await this.web.auditAppend({
        actor: user?.role === "md" ? "md" : "system",
        actor_id: reviewerUserId,
        entity_type: "ledger_forecast",
        entity_id: draft.id,
        action: "ledger_publish_blocked",
        payload: { reasons: gate.reasons, entry_id: draft.entry_id, version: draft.version },
      });
      return { published: false, gate, forecast: null, resolutions: [] };
    }

    // New entry: the sequence row is inserted/bumped ONLY if this draft is still
    // an unpublished new entry, so a lost race consumes no number. Revision:
    // the entry id is already set and no number is consumed.
    const published = draft.entry_id
      ? await this.sql`
          UPDATE ledger_forecasts
          SET status = 'published',
              published_at = date_trunc('milliseconds', NOW()),
              confirmed_by = ${reviewerUserId},
              confirmed_at = NOW(),
              updated_at = NOW()
          WHERE id = ${draftId} AND status = 'draft'
          RETURNING *
        `
      : await this.sql`
          WITH yr AS (
            SELECT EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'America/New_York'))::int AS y
          ),
          seq AS (
            INSERT INTO ledger_entry_sequence (year, next_n)
            SELECT y, 2 FROM yr
            WHERE EXISTS (SELECT 1 FROM ledger_forecasts WHERE id = ${draftId} AND status = 'draft' AND entry_id IS NULL)
            ON CONFLICT (year) DO UPDATE SET next_n = ledger_entry_sequence.next_n + 1
            RETURNING year, next_n - 1 AS n
          )
          UPDATE ledger_forecasts f
          SET status = 'published',
              entry_id = 'PT-' || seq.year::text || '-' || lpad(seq.n::text, 3, '0'),
              published_at = date_trunc('milliseconds', NOW()),
              confirmed_by = ${reviewerUserId},
              confirmed_at = NOW(),
              updated_at = NOW()
          FROM seq
          WHERE f.id = ${draftId} AND f.status = 'draft' AND f.entry_id IS NULL
          RETURNING f.*
        `;
    if (published.length === 0) {
      const blocked: LedgerPublishGate = { ...gate, passed: false, reasons: [...gate.reasons, "row left draft during publish (concurrent modification)"] };
      await this.web.auditAppend({
        actor: "md",
        actor_id: reviewerUserId,
        entity_type: "ledger_forecast",
        entity_id: draft.id,
        action: "ledger_publish_blocked",
        payload: { reasons: blocked.reasons },
      });
      return { published: false, gate: blocked, forecast: null, resolutions: [] };
    }
    let forecast = published[0] as LedgerForecast;

    // The hash is computed from the STORED row (what the card and the commit
    // will carry) and written once. The trigger allows exactly this write.
    const hash = publishedRowHash(forecast);
    const hashed = await this.sql`
      UPDATE ledger_forecasts SET row_hash = ${hash}, updated_at = NOW()
      WHERE id = ${forecast.id} AND row_hash IS NULL
      RETURNING *
    `;
    if (hashed.length > 0) forecast = hashed[0] as LedgerForecast;

    const resolutions = await this.openResolutions(forecast.entry_id!);

    await this.web.auditAppend({
      actor: "md",
      actor_id: reviewerUserId,
      entity_type: "ledger_forecast",
      entity_id: forecast.id,
      action: "ledger_publish",
      after: forecast,
      payload: {
        entry_id: forecast.entry_id,
        version: forecast.version,
        row_hash: forecast.row_hash,
        published_at: forecast.published_at instanceof Date ? forecast.published_at.toISOString() : forecast.published_at,
        confirmed_by: reviewerUserId,
      },
    });
    return { published: true, gate, forecast, resolutions };
  }

  /** Five open rows per entry; a revision finds them already present. */
  private async openResolutions(entryId: string): Promise<LedgerResolution[]> {
    for (const field of LEDGER_FIELDS) {
      await this.sql`
        INSERT INTO ledger_resolutions (entry_id, field, status) VALUES (${entryId}, ${field}, 'open')
        ON CONFLICT (entry_id, field) DO NOTHING
      `;
    }
    const rows = await this.sql`SELECT * FROM ledger_resolutions WHERE entry_id = ${entryId} ORDER BY field`;
    return rows as LedgerResolution[];
  }

  /** Once-settable provenance after the commit and the social posts. The trigger refuses a second value. */
  async recordProvenance(input: LedgerProvenanceInput): Promise<LedgerForecast> {
    const rows = await this.sql`
      UPDATE ledger_forecasts SET
        commit_sha = COALESCE(commit_sha, ${input.commit_sha ?? null}),
        commit_url = COALESCE(commit_url, ${input.commit_url ?? null}),
        x_post_id = COALESCE(x_post_id, ${input.x_post_id ?? null}),
        x_self_reply_id = COALESCE(x_self_reply_id, ${input.x_self_reply_id ?? null}),
        farcaster_hash = COALESCE(farcaster_hash, ${input.farcaster_hash ?? null}),
        updated_at = NOW()
      WHERE id = ${input.forecast_id} AND status = 'published'
      RETURNING *
    `;
    if (rows.length === 0) throw notFound("Published ledger forecast", input.forecast_id, "Provenance is recorded on published rows only.");
    const row = rows[0] as LedgerForecast;
    await this.web.auditAppend({
      actor: "system",
      actor_id: "ledger-publish",
      entity_type: "ledger_forecast",
      entity_id: row.id,
      action: "ledger_provenance",
      payload: {
        entry_id: row.entry_id,
        version: row.version,
        commit_sha: row.commit_sha,
        x_post_id: row.x_post_id,
        x_self_reply_id: row.x_self_reply_id,
        farcaster_hash: row.farcaster_hash,
      },
    });
    return row;
  }

  // ── Reads ───────────────────────────────────────────────────────────

  /** One forecast row by primary key, draft or published. The agents' publish function reads the STORED row this way. */
  async getForecast(forecastId: string): Promise<LedgerForecast> {
    const rows = await this.sql`SELECT * FROM ledger_forecasts WHERE id = ${forecastId}`;
    if (rows.length === 0) throw notFound("Ledger forecast", forecastId, "Use web_list_ledger_entries (include_drafts for drafts) to find it.");
    return rows[0] as LedgerForecast;
  }

  async getEntry(entryId: string): Promise<LedgerEntryDetail> {
    const versions = (await this.sql`
      SELECT * FROM ledger_forecasts WHERE entry_id = ${entryId} AND status = 'published' ORDER BY version
    `) as LedgerForecast[];
    if (versions.length === 0) throw notFound("Ledger entry", entryId, "Use web_list_ledger_entries to find a valid entry id.");
    const resolutions = (await this.sql`SELECT * FROM ledger_resolutions WHERE entry_id = ${entryId} ORDER BY field`) as LedgerResolution[];
    const corrections = (await this.sql`SELECT * FROM ledger_corrections WHERE entry_id = ${entryId} ORDER BY corrected_at`) as LedgerCorrection[];
    const proposals = (await this.sql`
      SELECT * FROM ledger_resolution_proposals WHERE entry_id = ${entryId} ORDER BY proposed_at DESC
    `) as LedgerProposal[];
    return { entry_id: entryId, versions, resolutions, corrections, proposals };
  }

  async listEntries(opts: { include_drafts?: boolean; season?: number | null; limit?: number; offset?: number } = {}): Promise<LedgerForecast[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = opts.include_drafts
      ? await this.sql`
          SELECT * FROM ledger_forecasts
          WHERE (${opts.season ?? null}::int IS NULL OR season = ${opts.season ?? null})
          ORDER BY COALESCE(published_at, created_at) DESC, version DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await this.sql`
          SELECT * FROM ledger_forecasts
          WHERE status = 'published' AND (${opts.season ?? null}::int IS NULL OR season = ${opts.season ?? null})
          ORDER BY published_at DESC, version DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
    return rows as LedgerForecast[];
  }

  async listResolutions(opts: { entry_id?: string | null; status?: "open" | "resolved" | "void" | null } = {}): Promise<LedgerResolution[]> {
    const rows = await this.sql`
      SELECT * FROM ledger_resolutions
      WHERE (${opts.entry_id ?? null}::text IS NULL OR entry_id = ${opts.entry_id ?? null})
        AND (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null})
      ORDER BY entry_id, field
    `;
    return rows as LedgerResolution[];
  }

  async exportLedger(): Promise<LedgerExport> {
    const forecasts = (await this.sql`
      SELECT * FROM ledger_forecasts WHERE status = 'published' ORDER BY entry_id, version
    `) as LedgerForecast[];
    const resolutions = (await this.sql`SELECT * FROM ledger_resolutions ORDER BY entry_id, field`) as LedgerResolution[];
    const corrections = (await this.sql`SELECT * FROM ledger_corrections ORDER BY corrected_at`) as LedgerCorrection[];
    return { forecasts, resolutions, corrections, exported_at: new Date().toISOString() };
  }

  // ── Resolution proposals ────────────────────────────────────────────

  /**
   * The ingest's only write. Idempotent: an identical pending proposal is
   * returned rather than duplicated. A locked field takes no proposal.
   */
  async proposeResolution(input: ProposeResolutionInput): Promise<{ proposal: LedgerProposal | null; status: "created" | "duplicate" | "field_locked" }> {
    const res = await this.sql`
      SELECT status FROM ledger_resolutions WHERE entry_id = ${input.entry_id} AND field = ${input.field}
    `;
    const current = (res[0] as { status: string } | undefined)?.status;
    if (current && current !== "open") return { proposal: null, status: "field_locked" };

    const existing = await this.sql`
      SELECT * FROM ledger_resolution_proposals
      WHERE entry_id = ${input.entry_id} AND field = ${input.field} AND decision = 'pending'
        AND proposed_status = ${input.proposed_status}
        AND proposed_outcome IS NOT DISTINCT FROM ${input.proposed_outcome ?? null}
        AND void_reason IS NOT DISTINCT FROM ${input.void_reason ?? null}
      LIMIT 1
    `;
    if (existing.length > 0) return { proposal: existing[0] as LedgerProposal, status: "duplicate" };

    const rows = await this.sql`
      INSERT INTO ledger_resolution_proposals (
        entry_id, field, proposed_status, proposed_outcome, outcome_date, freeze_at, void_reason,
        evidence_url, evidence, proposer
      ) VALUES (
        ${input.entry_id}, ${input.field}, ${input.proposed_status}, ${input.proposed_outcome ?? null},
        ${input.outcome_date ?? null}, ${input.freeze_at ?? null}, ${input.void_reason ?? null},
        ${input.evidence_url ?? null}, ${input.evidence ? JSON.stringify(input.evidence) : null}, ${input.proposer ?? "ingest"}
      )
      RETURNING *
    `;
    const proposal = rows[0] as LedgerProposal;
    await this.web.auditAppend({
      actor: "system",
      actor_id: input.proposer ?? "ingest",
      entity_type: "ledger_resolution_proposal",
      entity_id: proposal.id,
      action: "ledger_propose_resolution",
      payload: {
        entry_id: input.entry_id,
        field: input.field,
        proposed_status: input.proposed_status,
        proposed_outcome: input.proposed_outcome ?? null,
        void_reason: input.void_reason ?? null,
      },
    });
    return { proposal, status: "created" };
  }

  async listProposals(opts: { decision?: "pending" | "confirmed" | "rejected" | null; entry_id?: string | null } = {}): Promise<LedgerProposal[]> {
    const rows = await this.sql`
      SELECT * FROM ledger_resolution_proposals
      WHERE (${opts.decision ?? null}::text IS NULL OR decision = ${opts.decision ?? null})
        AND (${opts.entry_id ?? null}::text IS NULL OR entry_id = ${opts.entry_id ?? null})
      ORDER BY proposed_at DESC
    `;
    return rows as LedgerProposal[];
  }

  /**
   * The physician's answer. A confirm copies the proposal onto the open
   * resolution row and locks it, in ONE data-modifying CTE with the proposal's
   * own state change, so neither can land without the other. The proposal's
   * UPDATE is conditioned on the resolution still being open.
   */
  async decideProposal(input: DecideProposalInput): Promise<{ proposal: LedgerProposal; resolution: LedgerResolution | null }> {
    await this.requireMd(input.reviewer_user_id, "Deciding a ledger resolution");

    if (input.decision === "rejected") {
      const rows = await this.sql`
        UPDATE ledger_resolution_proposals
        SET decision = 'rejected', decided_by = ${input.reviewer_user_id}, decided_at = NOW(), note = ${input.note ?? null}
        WHERE id = ${input.proposal_id} AND decision = 'pending'
        RETURNING *
      `;
      if (rows.length === 0) throw notFound("Pending ledger proposal", input.proposal_id, "It may already be decided. List proposals with decision=pending.");
      const proposal = rows[0] as LedgerProposal;
      await this.web.auditAppend({
        actor: "md",
        actor_id: input.reviewer_user_id,
        entity_type: "ledger_resolution_proposal",
        entity_id: proposal.id,
        action: "ledger_reject_proposal",
        payload: { entry_id: proposal.entry_id, field: proposal.field, note: input.note ?? null },
      });
      return { proposal, resolution: null };
    }

    const rows = await this.sql`
      WITH p AS (
        UPDATE ledger_resolution_proposals pr
        SET decision = 'confirmed', decided_by = ${input.reviewer_user_id}, decided_at = NOW(), note = ${input.note ?? null}
        WHERE pr.id = ${input.proposal_id} AND pr.decision = 'pending'
          AND EXISTS (
            SELECT 1 FROM ledger_resolutions x
            WHERE x.entry_id = pr.entry_id AND x.field = pr.field AND x.status = 'open'
          )
        RETURNING pr.*
      ),
      r AS (
        UPDATE ledger_resolutions res
        SET status = p.proposed_status,
            outcome = p.proposed_outcome,
            outcome_date = p.outcome_date,
            resolved_at = NOW(),
            freeze_at = COALESCE(p.freeze_at, res.freeze_at),
            void_reason = p.void_reason,
            evidence_url = p.evidence_url,
            evidence = p.evidence,
            proposal_id = p.id,
            confirmed_by = ${input.reviewer_user_id},
            confirmed_at = NOW()
        FROM p
        WHERE res.entry_id = p.entry_id AND res.field = p.field AND res.status = 'open'
        RETURNING res.*
      )
      SELECT (SELECT row_to_json(p) FROM p) AS proposal, (SELECT row_to_json(r) FROM r) AS resolution
    `;
    const out = rows[0] as { proposal: LedgerProposal | null; resolution: LedgerResolution | null } | undefined;
    if (!out?.proposal) {
      throw new McpToolError(
        `Ledger proposal ${input.proposal_id} is not pending, or its field is no longer open`,
        "A field that already resolved or was voided is locked (spec: a resolved field is never revised). List proposals with decision=pending.",
      );
    }
    await this.web.auditAppend({
      actor: "md",
      actor_id: input.reviewer_user_id,
      entity_type: "ledger_resolution",
      entity_id: out.resolution?.id,
      action: "ledger_confirm_resolution",
      after: out.resolution ?? undefined,
      payload: {
        entry_id: out.proposal.entry_id,
        field: out.proposal.field,
        status: out.proposal.proposed_status,
        outcome: out.proposal.proposed_outcome,
        void_reason: out.proposal.void_reason,
        proposal_id: out.proposal.id,
        confirmed_by: input.reviewer_user_id,
      },
    });
    return { proposal: out.proposal, resolution: out.resolution };
  }

  // ── Corrections ─────────────────────────────────────────────────────

  async recordCorrection(input: RecordCorrectionInput): Promise<LedgerCorrection> {
    await this.requireMd(input.corrected_by, "Recording a ledger correction");
    const rows = await this.sql`
      INSERT INTO ledger_corrections (entry_id, field, old_value, new_value, note, corrected_by)
      VALUES (${input.entry_id}, ${input.field}, ${input.old_value ?? null}, ${input.new_value ?? null}, ${input.note}, ${input.corrected_by})
      RETURNING *
    `;
    const row = rows[0] as LedgerCorrection;
    await this.web.auditAppend({
      actor: "md",
      actor_id: input.corrected_by,
      entity_type: "ledger_correction",
      entity_id: row.id,
      action: "ledger_record_correction",
      payload: { entry_id: row.entry_id, field: row.field, old_value: row.old_value, new_value: row.new_value },
    });
    return row;
  }

  // ── Gated replies (D6) ──────────────────────────────────────────────

  async proposeReply(input: ProposeReplyInput): Promise<{ proposal: ReplyProposal; status: "created" | "duplicate" }> {
    const existing = await this.sql`
      SELECT * FROM reply_proposals WHERE platform = ${input.platform} AND mention_id = ${input.mention_id}
    `;
    if (existing.length > 0) return { proposal: existing[0] as ReplyProposal, status: "duplicate" };
    const rows = await this.sql`
      INSERT INTO reply_proposals (platform, mention_id, mention_url, mention_author, mention_text, proposed_text)
      VALUES (${input.platform}, ${input.mention_id}, ${input.mention_url ?? null}, ${input.mention_author ?? null},
              ${input.mention_text ?? null}, ${input.proposed_text})
      RETURNING *
    `;
    const proposal = rows[0] as ReplyProposal;
    await this.web.auditAppend({
      actor: "agent",
      actor_id: "reply-agent",
      entity_type: "reply_proposal",
      entity_id: proposal.id,
      action: "reply_propose",
      payload: { platform: proposal.platform, mention_id: proposal.mention_id },
    });
    return { proposal, status: "created" };
  }

  async listReplyProposals(decision: "pending" | "posted" | "discarded" | null = "pending"): Promise<ReplyProposal[]> {
    const rows = await this.sql`
      SELECT * FROM reply_proposals
      WHERE (${decision}::text IS NULL OR decision = ${decision})
      ORDER BY proposed_at DESC
    `;
    return rows as ReplyProposal[];
  }

  /**
   * The physician's decision on a proposal (027): approve (recording who, when and
   * the final wording) or discard. Nothing is posted here. 'posted' is not a value
   * the MD can set — recordReplyPost writes it after the platform returns an id.
   */
  async decideReply(input: DecideReplyInput): Promise<ReplyProposal> {
    await this.requireMd(input.reviewer_user_id, "Deciding a reply");
    const approvedText = input.decision === "approved" ? (input.approved_text?.trim() || null) : null;
    const rows = await this.sql`
      UPDATE reply_proposals
      SET decision = ${input.decision}, decided_by = ${input.reviewer_user_id}, decided_at = NOW(),
          approved_text = ${approvedText}, note = ${input.note ?? null}
      WHERE id = ${input.proposal_id} AND decision = 'pending'
      RETURNING *
    `;
    if (rows.length === 0) throw notFound("Pending reply proposal", input.proposal_id, "It may already be decided. List reply proposals with decision=pending.");
    const proposal = rows[0] as ReplyProposal;
    await this.web.auditAppend({
      actor: "md",
      actor_id: input.reviewer_user_id,
      entity_type: "reply_proposal",
      entity_id: proposal.id,
      action: input.decision === "approved" ? "reply_approved" : "reply_discarded",
      payload: {
        platform: proposal.platform,
        mention_id: proposal.mention_id,
        text_edited: approvedText !== null && approvedText !== proposal.proposed_text,
      },
    });
    return proposal;
  }

  /**
   * The reply publisher's state machine, system caller (027). Every transition is
   * one guarded UPDATE whose WHERE clause IS the rule:
   *   claim  — approved AND no attempt in flight → post_attempted_at = NOW(). Zero rows
   *            is an error, not a no-op: that is the double-click lock.
   *   posted — approved AND claimed → decision 'posted' + the platform id.
   *   failed — approved AND claimed → claim released, error recorded; the MD retries.
   * A pending or discarded proposal is never touched by any branch.
   */
  async recordReplyPost(input: RecordReplyPostInput): Promise<ReplyProposal> {
    let rows: unknown[];
    if (input.outcome === "claim") {
      rows = await this.sql`
        UPDATE reply_proposals SET post_attempted_at = NOW(), post_error = NULL
        WHERE id = ${input.proposal_id} AND decision = 'approved' AND post_attempted_at IS NULL
        RETURNING *
      `;
      if (rows.length === 0) {
        throw new McpToolError(
          `Reply proposal ${input.proposal_id} is not approved, or a post attempt is already in flight`,
          "Only an approved proposal with no attempt in flight can be claimed. If an earlier attempt hung, inspect the row before retrying.",
        );
      }
    } else if (input.outcome === "posted") {
      if (!input.posted_id) throw new McpToolError("A posted reply needs its posted_id", "Pass the id the platform returned for the reply.");
      rows = await this.sql`
        UPDATE reply_proposals SET decision = 'posted', posted_id = ${input.posted_id}, posted_text = ${input.posted_text ?? null}, post_error = NULL
        WHERE id = ${input.proposal_id} AND decision = 'approved' AND post_attempted_at IS NOT NULL
        RETURNING *
      `;
      if (rows.length === 0) throw notFound("Claimed approved reply proposal", input.proposal_id, "'posted' follows a successful 'claim' on an approved proposal.");
    } else {
      rows = await this.sql`
        UPDATE reply_proposals SET post_attempted_at = NULL, post_error = ${input.error ?? "unknown error"}
        WHERE id = ${input.proposal_id} AND decision = 'approved' AND post_attempted_at IS NOT NULL
        RETURNING *
      `;
      if (rows.length === 0) throw notFound("Claimed approved reply proposal", input.proposal_id, "'failed' releases a claim; there is none to release.");
    }
    const proposal = rows[0] as ReplyProposal;
    await this.web.auditAppend({
      actor: "system",
      actor_id: "ledger-reply-publish",
      entity_type: "reply_proposal",
      entity_id: proposal.id,
      action: `reply_post_${input.outcome}`,
      payload: { platform: proposal.platform, mention_id: proposal.mention_id, posted_id: proposal.posted_id, error: input.error ?? null },
    });
    return proposal;
  }
}
