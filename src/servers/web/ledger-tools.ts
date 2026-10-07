// ── Prognosis Ledger tools ─────────────────────────────────────────────
//
// Registered from registerWebTools so the pinned tool-count tests and the
// strict-input policy cover them like every other web tool. Naming follows the
// repo convention {server}_{action}_{resource}.
//
// The automation boundary, as tools:
//   the ingest may call   web_propose_ledger_resolution, web_propose_reply
//   the publish loop may  web_record_ledger_provenance (after a confirmed publish)
//   ONLY the physician    web_publish_ledger_forecast, web_decide_ledger_proposal,
//                         web_record_ledger_correction, web_record_ledger_linkage,
//                         web_decide_reply
//   — each of those takes reviewer_user_id and the client re-derives the role
//   from the users table; a caller-supplied role is never read.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../../shared/logger.js";
import { handleToolError, toolSuccess } from "../../shared/errors.js";
import type { WebDatabaseClient } from "./client.js";
import { LedgerClient } from "./ledger-client.js";

const probability = (what: string) =>
  z.number().min(0).max(1).describe(`${what}, a probability from 0 to 1. Printed on the card as a whole-number percentage.`);
const games = (what: string) => z.number().int().min(0).describe(what);
const uuid = (what: string) => z.string().uuid().describe(what);
const entryId = z.string().regex(/^PT-\d{4}-\d{3,}$/).describe("Ledger entry id, PT-YYYY-NNN");
const fieldEnum = z.enum(["F1", "F2", "F3", "F4", "F5"]);
const reviewer = uuid("MD user id (UUID = session.user.id); the role is re-derived from the users table, never trusted from the caller");

const draftFields = {
  player: z.string().min(1),
  team: z.string().min(1).describe("Team as printed on the card"),
  position: z.string().min(1),
  injury_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, the day the injury occurred (not the report date)"),
  reported_injury: z.string().min(1).describe("The injury AS WORDED BY THE SOURCE, e.g. 'Grade 2 hamstring strain'. Never a diagnosis."),
  source_tier: z.enum(["A", "B", "C"]).describe("A = team/official or confirmed surgery; B = national or beat reporter; C = film only"),
  source_urls: z.array(z.string().url()).min(1).describe("Every input the entry names"),
  mechanism: z.string().min(1).describe("One or two film-based lines, e.g. 'Non-contact. Planted left foot, knee valgus. Q3 2:14.'"),
  base_rate_row: z.string().min(1).describe("row_key into ledger_base_rates"),
  base_rate_strength: z.enum(["strong", "moderate", "thin"]),
  f1_ir: probability("F1: P(placed on IR within 7 days of injury)"),
  f2_next: probability("F2: P(plays ≥1 snap in the team's next scheduled game)"),
  f3_4wk: probability("F3: P(plays ≥1 snap in any game within 28 days)"),
  f4_point: games("F4 point estimate: regular-season games missed from injury through the game before first return"),
  f4_low: games("F4 80% interval lower bound, in games"),
  f4_high: games("F4 80% interval upper bound, in games"),
  f5_reinjury: probability("F5: P(same-site injury on the injury report AND ≥1 game missed within 6 games of return)")
    .nullable()
    .describe("F5 probability, or null ONLY for a concussion entry (F5 is void by rule)"),
  season_ending: z.boolean().describe("Set when F3 < 5% and f4_low exceeds the regular-season games remaining"),
  what_moves_this: z.string().min(1).describe("One line: the public event that would change this forecast"),
  tier: z.union([z.literal(1), z.literal(2)]).describe("1 = full card, 2 = ledger only. Scored identically."),
  trigger: z.string().min(1).nullable().optional().describe("Required for a revision: the public event that prompted it. 'Changed my mind' is not a trigger."),
  reply_to_url: z.string().url().nullable().optional().describe("The report post the card will reply to"),
  espn_athlete_id: z.string().nullable().optional(),
  gsis_id: z.string().nullable().optional().describe("nflverse/NFL GSIS id, for the injury report"),
  pfr_id: z.string().nullable().optional().describe("Pro Football Reference id, for snap counts"),
  nflverse_team: z.string().max(4).nullable().optional().describe("Team abbreviation as nflverse games.csv spells it, e.g. BUF"),
  season: z.number().int().nullable().optional(),
  player_id: z.string().uuid().nullable().optional(),
  entity_id: z.string().uuid().nullable().optional(),
};

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerLedgerTools(server: McpServer, web: WebDatabaseClient, logger: Logger): void {
  const ledger = new LedgerClient(web);

  // ── Base rates ──────────────────────────────────────────────────────
  server.tool(
    "web_upsert_ledger_base_rate",
    "Create or replace one row of the ledger's base-rate sheet (one per injury type). A forecast copies base_rate_row and base_rate_strength at publish, so editing a base rate never rewrites a published card.",
    {
      row_key: z.string().min(1).max(64).describe("Stable key, e.g. hamstring_strain, acl, concussion"),
      injury_type: z.string().min(1),
      strength: z.enum(["strong", "moderate", "thin"]),
      source_rank: z.number().int().min(1).max(4).nullable().optional().describe("1 empirical NFL history, 2 NFL literature, 3 other elite cohorts, 4 general athletic populations"),
      sources: z.string().nullable().optional(),
      n: z.number().int().min(0).nullable().optional(),
      year_range: z.string().nullable().optional(),
      f1_ir: z.number().min(0).max(1).nullable().optional(),
      f2_next: z.number().min(0).max(1).nullable().optional(),
      f3_4wk: z.number().min(0).max(1).nullable().optional(),
      f5_reinjury: z.number().min(0).max(1).nullable().optional(),
      f4_point: z.number().int().min(0).nullable().optional(),
      f4_low: z.number().int().min(0).nullable().optional(),
      f4_high: z.number().int().min(0).nullable().optional(),
      notes: z.string().nullable().optional(),
      updated_by: uuid("User id of the editor"),
    },
    // Upsert converges on the same row; not destructive because the forecast
    // rows carry their own copy of the values they used.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (input) => {
      try {
        return toolSuccess({ base_rate: await ledger.upsertBaseRate(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_list_ledger_base_rates",
    "List the ledger's base-rate sheet.",
    {},
    READ,
    async () => {
      try {
        return toolSuccess({ base_rates: await ledger.listBaseRates() });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Drafts ──────────────────────────────────────────────────────────
  server.tool(
    "web_create_ledger_draft",
    "Create a DRAFT ledger forecast (a new entry, or with parent_entry_id the next version of a published entry). A draft has no entry id, is never public, and publishes only through web_publish_ledger_forecast with the physician's confirmation.",
    {
      ...draftFields,
      created_by: uuid("User id of the drafter"),
      parent_entry_id: entryId.nullable().optional().describe("Set to draft a REVISION of a published entry"),
    },
    WRITE,
    async (input) => {
      try {
        return toolSuccess({ draft: await ledger.createDraft(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_update_ledger_draft",
    "Edit a DRAFT ledger forecast. Omitted fields keep their stored value. A published row is immutable and this tool refuses it.",
    {
      draft_id: uuid("ledger_forecasts.id of the draft"),
      edited_by: uuid("User id of the editor"),
      ...Object.fromEntries(Object.entries(draftFields).map(([k, s]) => [k, s.optional()])),
    },
    // Drafts are mutable by design; the published row they become is not.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (input) => {
      try {
        return toolSuccess({ draft: await ledger.updateDraft(input as Parameters<LedgerClient["updateDraft"]>[0]) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_delete_ledger_draft",
    "Delete a DRAFT ledger forecast. MD only. A published row cannot be deleted by anyone — the database refuses.",
    {
      draft_id: uuid("ledger_forecasts.id of the draft"),
      reviewer_user_id: reviewer,
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (input) => {
      try {
        return toolSuccess(await ledger.deleteDraft(input.draft_id, input.reviewer_user_id));
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Publish (THE CONFIRMATION STEP) ─────────────────────────────────
  server.tool(
    "web_publish_ledger_forecast",
    "The physician's confirmation. Re-derives the role of reviewer_user_id (must be 'md'), runs the publish gate (every field present, a revision names its trigger, probabilities in range, F4 low ≤ point ≤ high, F5 null only for concussion, no resolved field changed), then stamps published_at, allocates the entry id PT-YYYY-NNN, flips the row to published, writes row_hash from the stored row, opens the five resolution rows and records who confirmed and when. A blocked publish is a SUCCESSFUL call with published:false and reasons (map to 422), not an error.",
    {
      draft_id: uuid("ledger_forecasts.id of the draft to publish"),
      reviewer_user_id: reviewer,
    },
    // Not destructive (adds to the public record); not idempotent (a second call
    // on the same draft finds it published and is blocked, but the first one
    // allocates an entry id).
    WRITE,
    async (input) => {
      try {
        return toolSuccess(await ledger.publishForecast(input.draft_id, input.reviewer_user_id));
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_record_ledger_provenance",
    "Record the commit SHA/URL and the X and Farcaster ids of a published forecast. Each is set once; the database refuses a second value. Called by the agents' publish function after the commit and the posts.",
    {
      forecast_id: uuid("ledger_forecasts.id of the published row"),
      commit_sha: z.string().min(7).max(64).optional(),
      commit_url: z.string().url().optional(),
      x_post_id: z.string().min(1).optional(),
      x_self_reply_id: z.string().min(1).optional(),
      farcaster_hash: z.string().min(1).optional(),
    },
    // COALESCE keeps the first value, so a retry converges.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (input) => {
      try {
        return toolSuccess({ forecast: await ledger.recordProvenance(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Reads ───────────────────────────────────────────────────────────
  server.tool(
    "web_get_ledger_entry",
    "Fetch one ledger entry: every published version, its five resolutions, corrections and proposals.",
    { entry_id: entryId },
    READ,
    async (input) => {
      try {
        return toolSuccess(await ledger.getEntry(input.entry_id));
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_get_ledger_forecast",
    "Fetch one ledger forecast row by its id, draft or published. The agents' publish function reads the STORED published row this way before rendering the card text and the commit from it; nothing is ever rendered from caller-supplied fields.",
    { forecast_id: uuid("ledger_forecasts.id") },
    READ,
    async (input) => {
      try {
        return toolSuccess({ forecast: await ledger.getForecast(input.forecast_id) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_list_ledger_entries",
    "List ledger forecast rows, newest first. Published only unless include_drafts.",
    {
      include_drafts: z.boolean().optional(),
      season: z.number().int().nullable().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    READ,
    async (input) => {
      try {
        return toolSuccess({ forecasts: await ledger.listEntries(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_list_ledger_resolutions",
    "List resolution rows (one per entry per field), optionally by entry or status.",
    {
      entry_id: entryId.nullable().optional(),
      status: z.enum(["open", "resolved", "void"]).nullable().optional(),
    },
    READ,
    async (input) => {
      try {
        return toolSuccess({ resolutions: await ledger.listResolutions(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_export_ledger",
    "The raw export: every published forecast row, every resolution row and every correction. The public CSV is rendered from this so anyone can recompute the scores.",
    {},
    READ,
    async () => {
      try {
        return toolSuccess(await ledger.exportLedger());
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Resolution proposals ────────────────────────────────────────────
  server.tool(
    "web_propose_ledger_resolution",
    "The resolution ingest's ONLY write: propose that a field resolved (with outcome, outcome_date, freeze_at and evidence) or is void (with a reason). Nothing resolves until the physician confirms it with web_decide_ledger_proposal. Idempotent on an identical pending proposal; a locked field takes no proposal.",
    {
      entry_id: entryId,
      field: fieldEnum,
      proposed_status: z.enum(["resolved", "void"]),
      proposed_outcome: z.number().nullable().optional().describe("0/1 for F1, F2, F3, F5; games missed for F4"),
      outcome_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("The calendar date the field resolved on"),
      freeze_at: z.string().datetime().nullable().optional().describe("The field's first resolvable moment (ISO UTC); decides which version scores"),
      void_reason: z.string().min(1).nullable().optional(),
      evidence_url: z.string().nullable().optional().describe("PFR boxscore, transactions page or injury file"),
      evidence: z.record(z.unknown()).nullable().optional(),
      proposer: z.string().min(1).optional().describe("Defaults to 'ingest'"),
    },
    // Idempotent on identical content; never destructive.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (input) => {
      try {
        return toolSuccess(await ledger.proposeResolution(input));
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_list_ledger_proposals",
    "List resolution proposals, pending by default.",
    {
      decision: z.enum(["pending", "confirmed", "rejected"]).nullable().optional(),
      entry_id: entryId.nullable().optional(),
    },
    READ,
    async (input) => {
      try {
        return toolSuccess({ proposals: await ledger.listProposals({ decision: input.decision ?? "pending", entry_id: input.entry_id ?? null }) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_decide_ledger_proposal",
    "The physician confirms or rejects a proposed resolution. MD only (role re-derived). A confirm copies the proposal onto the open resolution row and locks it, in one statement with the proposal's own state change; a locked field cannot be re-decided.",
    {
      proposal_id: uuid("ledger_resolution_proposals.id"),
      reviewer_user_id: reviewer,
      decision: z.enum(["confirmed", "rejected"]),
      note: z.string().nullable().optional(),
    },
    // A second call finds the proposal decided and throws; the first locks a row.
    WRITE,
    async (input) => {
      try {
        return toolSuccess(await ledger.decideProposal(input));
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Corrections ─────────────────────────────────────────────────────
  server.tool(
    "web_record_ledger_correction",
    "Log a clerical correction (wrong player, wrong date) against an entry. MD only. Never edits a forecast row — the correction is its own append-only row with a note, shown beside the entry.",
    {
      entry_id: entryId,
      field: z.string().min(1).describe("The forecast field or metadata the correction concerns"),
      old_value: z.string().nullable().optional(),
      new_value: z.string().nullable().optional(),
      note: z.string().min(1),
      corrected_by: reviewer,
    },
    WRITE,
    async (input) => {
      try {
        return toolSuccess({ correction: await ledger.recordCorrection(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Linkage (028) ───────────────────────────────────────────────────
  server.tool(
    "web_record_ledger_linkage",
    "Attach the public-record ids the resolution ingest keys on (ESPN athlete id, nflverse GSIS and PFR ids, nflverse team, season) to every published version of an entry. MD only. Each id is set once and never changed; none is part of the row hash. Also writes a ledger_corrections row recording the ids. Look the ids up by ESPN id first (agents GET /admin/ledger/nflverse-ids); never by name.",
    {
      entry_id: entryId,
      reviewer_user_id: reviewer,
      espn_athlete_id: z.string().regex(/^\d{1,12}$/).describe("ESPN athlete id (numeric)"),
      gsis_id: z.string().regex(/^\d{2}-\d{7}$/).describe("nflverse GSIS id, e.g. 00-0034796 (injury report key)"),
      pfr_id: z.string().regex(/^[A-Za-z][A-Za-z.]{1,7}\d{2}$/).describe("Pro Football Reference id, e.g. JackLa00 (snap counts key)"),
      nflverse_team: z.string().regex(/^[A-Z]{2,3}$/).nullable().optional().describe("Team abbreviation as nflverse games.csv spells it"),
      season: z.number().int().min(2000).max(2100).nullable().optional().describe("NFL season (the year it starts)"),
      note: z.string().min(1).nullable().optional(),
    },
    // Set-once: the same ids again are a no-op; different ids are refused.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (input) => {
      try {
        return toolSuccess(await ledger.recordLinkage(input));
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  // ── Gated replies (D6) ──────────────────────────────────────────────
  server.tool(
    "web_propose_reply",
    "File a drafted reply to a mention for the physician to post or discard. The reply agent's ONLY write; nothing is posted by this call. Idempotent per (platform, mention_id).",
    {
      platform: z.enum(["x", "farcaster"]),
      mention_id: z.string().min(1),
      mention_url: z.string().nullable().optional(),
      mention_author: z.string().nullable().optional(),
      mention_text: z.string().nullable().optional(),
      proposed_text: z.string().min(1),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (input) => {
      try {
        return toolSuccess(await ledger.proposeReply(input));
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_list_reply_proposals",
    "List reply proposals, pending by default.",
    { decision: z.enum(["pending", "posted", "discarded"]).nullable().optional() },
    READ,
    async (input) => {
      try {
        return toolSuccess({ proposals: await ledger.listReplyProposals(input.decision === undefined ? "pending" : input.decision) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_decide_reply",
    "The physician's decision on a reply proposal (027): approved (with the final wording, if edited) or discarded. MD only (role re-derived). Records who and when BEFORE anything is posted; nothing is posted by this call. The agents' reply publisher posts only an approved proposal and records the result with web_record_reply_post.",
    {
      proposal_id: uuid("reply_proposals.id"),
      reviewer_user_id: reviewer,
      decision: z.enum(["approved", "discarded"]),
      approved_text: z.string().min(1).nullable().optional().describe("The MD's final wording when edited; omitted = post proposed_text as drafted"),
      note: z.string().nullable().optional(),
    },
    WRITE,
    async (input) => {
      try {
        return toolSuccess({ proposal: await ledger.decideReply(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );

  server.tool(
    "web_record_reply_post",
    "The reply publisher's state machine, system caller (027). 'claim' takes an APPROVED proposal for posting, once — a second claim is an error, which is what stops a double click or a retried request posting twice. 'posted' records the platform id and the text that went out. 'failed' releases the claim and records the error so the physician can retry. A pending or discarded proposal is never changed.",
    {
      proposal_id: uuid("reply_proposals.id"),
      outcome: z.enum(["claim", "posted", "failed"]),
      posted_id: z.string().min(1).nullable().optional().describe("Required with outcome 'posted': the tweet id or cast hash"),
      posted_text: z.string().nullable().optional(),
      error: z.string().nullable().optional().describe("With outcome 'failed': why the post did not go out"),
    },
    // Each transition is a one-way step; a repeat is an error by design.
    WRITE,
    async (input) => {
      try {
        return toolSuccess({ proposal: await ledger.recordReplyPost(input) });
      } catch (err) {
        return handleToolError(err, logger);
      }
    },
  );
}
