import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));
const classifier = vi.hoisted(() => ({
  configured: vi.fn(() => false),
  classify: vi.fn(),
}));
vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: classifier.configured,
  classifyDeskPost: classifier.classify,
}));
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { withInputKeyPolicy } from "../src/shared/input-key-policy.js";
import { deskContentHash, serializeSections } from "../src/servers/web/desk-sections.js";
import {
  editDistance,
  mergeCorrection,
  refusingBlockers,
  sizeCapViolations,
  MAX_FIELD_EDIT_DISTANCE,
} from "../src/servers/web/desk-correction.js";
import type { DeskPost } from "../src/servers/web/client.js";
import type { LintFinding } from "../src/servers/web/linter.js";

/**
 * desk_correct_published against a RECORDED row: the live Ben Simmons desk post
 * as desk_get returned it (src/scripts/record-desk-fixture.ts). Its treatment
 * section really does read "completed.The surgical technique" — the typo this
 * tool was built to fix. Every call goes through inputSchema.parse() first.
 */

const recorded = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/desk-post-published-row.json"), "utf8"),
) as { post: DeskPost };

const MD_ID = recorded.post.reviewed_by as string;
const NON_MD_ID = "11111111-1111-4111-8111-111111111111";
const TYPO = "completed.The surgical technique";
const FIXED_TREATMENT = recorded.post.sections!.treatment.replace(TYPO, "completed. The surgical technique");

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

function tool(): RegisteredTool {
  const server = new McpServer({ name: "test-web", version: "1.0.0" }, { capabilities: { tools: {} } });
  registerWebTools(withInputKeyPolicy(server, "strict"));
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools[
    "desk_correct_published"
  ];
}

async function callValidated(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const t = tool();
  const res = (await t.handler(t.inputSchema.parse(args) as Record<string, unknown>, {})) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { isError: res.isError, text: res.content[0].text };
}

interface Db {
  post: DeskPost;
  users: Record<string, { id: string; role: string }>;
  attestations: Record<string, unknown>[];
  versions: unknown[][];
  audits: unknown[][];
  bumpBeforeUpdate?: boolean;
}

let db: Db;

function installDb(post: DeskPost): void {
  db = {
    post: structuredClone(post),
    users: {
      [MD_ID]: { id: MD_ID, role: "md" },
      [NON_MD_ID]: { id: NON_MD_ID, role: "admin" },
    },
    attestations: [],
    versions: [],
    audits: [],
  };
  const handoff = post.draft_json as { player: string; league: string; injury_type: string };
  mockSql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (/FROM users WHERE id/.test(q)) {
      const u = db.users[values[0] as string];
      return u ? [u] : [];
    }
    if (/^ ?SELECT \* FROM desk_posts WHERE id/.test(q)) {
      return values[0] === db.post.id ? [structuredClone(db.post)] : [];
    }
    if (/INSERT INTO desk_attestations/.test(q)) {
      const [desk_post_id, reviewer_user_id, r, e, f, content_hash, ip] = values;
      const row = {
        id: `att-${db.attestations.length + 1}`,
        desk_post_id,
        reviewer_user_id,
        reviewed_source_reports: r,
        edited_for_accuracy: e,
        framing_confirmed: f,
        content_hash,
        ip,
        timestamp: "2026-10-22T12:00:00.000Z",
      };
      db.attestations.push(row);
      return [row];
    }
    if (/UPDATE desk_posts SET markdown_body/.test(q)) {
      if (db.bumpBeforeUpdate) db.post.version += 1;
      const [markdown_body, sections, meta, content_hash, attestation_id, reviewed_by, version, id, prevVersion] =
        values;
      if (id !== db.post.id || db.post.status !== "PUBLISHED" || db.post.version !== prevVersion) return [];
      Object.assign(db.post, {
        markdown_body,
        sections: JSON.parse(sections as string),
        meta: JSON.parse(meta as string),
        content_hash,
        attestation_id,
        reviewed_by,
        version,
      });
      return [structuredClone(db.post)];
    }
    if (/INSERT INTO desk_post_versions/.test(q)) {
      db.versions.push(values);
      return [];
    }
    if (/FROM injury_entities e/.test(q)) {
      return [{ athlete_name: handoff.player, sport: handoff.league, injury_type: handoff.injury_type }];
    }
    if (/FROM desk_post_updates/.test(q)) return [];
    if (/UPDATE desk_posts SET draft_json/.test(q)) {
      db.post.draft_json = JSON.parse(values[0] as string);
      return [];
    }
    if (/INSERT INTO audit_log/.test(q)) {
      db.audits.push(values);
      return [{ id: "audit-1" }];
    }
    throw new Error(`unexpected SQL: ${q}`);
  });
}

const VALID = {
  desk_post_id: recorded.post.id,
  reviewer_user_id: MD_ID,
  sections: { treatment: FIXED_TREATMENT },
  reason: 'Missing space in "completed.The".',
  reviewed_source_reports: true,
  edited_for_accuracy: true,
  framing_confirmed: true,
};

beforeEach(() => {
  mockSql.mockReset();
  classifier.configured.mockReset().mockReturnValue(false);
  classifier.classify.mockReset();
  installDb(recorded.post);
});

describe("the recorded fixture", () => {
  it("carries the live typo exactly once", () => {
    expect(recorded.post.sections!.treatment.split(TYPO)).toHaveLength(2);
  });
});

describe("desk_correct_published", () => {
  it("fixes the Simmons typo, re-attests the new hash and leaves the kpjmd confirmation stale", async () => {
    const prev = recorded.post;
    const sections = { ...prev.sections!, treatment: FIXED_TREATMENT };
    const body = serializeSections(sections, prev.meta!);
    const expectedHash = deskContentHash(prev.title, sections, prev.meta, body);

    const res = await callValidated(VALID);
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.text);

    expect(out.changed).toBe(true);
    expect(out.previous_content_hash).toBe(prev.content_hash);
    expect(out.post.content_hash).toBe(expectedHash);
    expect(out.diff).toEqual({
      "sections.treatment": { from: prev.sections!.treatment, to: FIXED_TREATMENT, distance: 1 },
    });

    expect(db.attestations).toHaveLength(1);
    expect(db.attestations[0].content_hash).toBe(expectedHash);
    expect(db.post.attestation_id).toBe(db.attestations[0].id);

    expect(db.post.status).toBe("PUBLISHED");
    expect(db.post.title).toBe(prev.title);
    expect(db.post.slug).toBe(prev.slug);
    expect(db.post.published_at).toBe(prev.published_at);
    expect(db.post.kpjmd_content_hash).toBe(prev.kpjmd_content_hash);
    expect(db.post.kpjmd_content_hash).not.toBe(db.post.content_hash);
    expect(db.post.version).toBe(prev.version + 1);
    expect(db.post.markdown_body).toBe(body);
    expect(db.post.meta).toEqual(prev.meta);

    // The handoff differs from the recorded one in treatment and content_hash ONLY.
    const before = structuredClone(prev.draft_json) as Record<string, unknown> & { _sideline: Record<string, unknown> };
    const after = db.post.draft_json as Record<string, unknown> & { _sideline: Record<string, unknown> };
    expect(after.treatment).toBe(FIXED_TREATMENT);
    before.treatment = FIXED_TREATMENT;
    before._sideline.content_hash = expectedHash;
    expect(after).toEqual(before);

    expect(db.versions).toHaveLength(1);
    expect(JSON.parse(db.versions[0][8] as string)).toEqual(out.diff);

    expect(db.audits).toHaveLength(1);
    const [actor, actorId, entityType, entityId, action, , , payloadJson] = db.audits[0];
    expect([actor, actorId, entityType, entityId, action]).toEqual([
      "md",
      MD_ID,
      "desk_post",
      prev.id,
      "desk_content_corrected",
    ]);
    expect(JSON.parse(payloadJson as string)).toEqual({
      diff: out.diff,
      total_distance: 1,
      reason: VALID.reason,
      previous_content_hash: prev.content_hash,
      new_content_hash: expectedHash,
      attestation_id: db.attestations[0].id,
      version: prev.version + 1,
      slug: prev.slug,
    });
  });

  it("corrects prose meta and an FAQ answer, leaving structural meta alone", async () => {
    const prev = recorded.post;
    const faqs = prev.meta!.faqs!.map((f, i) => (i === 1 ? { ...f, a: `${f.a} ` } : f));
    const res = await callValidated({
      ...VALID,
      sections: undefined,
      meta: { meta_description: `${prev.meta!.meta_description}!`, faqs },
    });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.text);
    expect(Object.keys(out.diff).sort()).toEqual(["meta.faqs[1].a", "meta.meta_description"]);
    expect(db.post.meta!.related_slugs).toEqual(prev.meta!.related_slugs);
    expect(db.post.meta!.relevant_tool).toBe(prev.meta!.relevant_tool);
    expect(db.post.sections).toEqual(prev.sections);
  });

  it("is a no-op for the stored content: no attestation, no version, no audit", async () => {
    const res = await callValidated({ ...VALID, sections: { treatment: recorded.post.sections!.treatment } });
    const out = JSON.parse(res.text);
    expect(out.changed).toBe(false);
    expect(out.attestation).toBeNull();
    expect(db.attestations).toHaveLength(0);
    expect(db.versions).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-MD before reading the post", async () => {
    const res = await callValidated({ ...VALID, reviewer_user_id: NON_MD_ID });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not 'md'/);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it.each(["reviewed_source_reports", "edited_for_accuracy", "framing_confirmed"])(
    "refuses without %s",
    async (key) => {
      const res = await callValidated({ ...VALID, [key]: false });
      expect(res.isError).toBe(true);
      expect(db.attestations).toHaveLength(0);
    },
  );

  it.each(["DRAFT", "READY", "RETRACTED"] as const)("refuses a %s post", async (status) => {
    installDb({ ...recorded.post, status });
    const res = await callValidated(VALID);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(new RegExp(`is ${status}, not PUBLISHED`));
    expect(db.attestations).toHaveLength(0);
  });

  it("refuses a rewrite above the size cap", async () => {
    const res = await callValidated({
      ...VALID,
      sections: { treatment: `${FIXED_TREATMENT} ${"Added sentence about rehab protocol. ".repeat(6)}` },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Too large for a correction/);
    expect(db.attestations).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("refuses a correction that introduces a deterministic lint blocker", async () => {
    const res = await callValidated({
      ...VALID,
      sections: { treatment: FIXED_TREATMENT.replace("completed. The", "completed. This is career-ending. The") },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/career_prognosis/);
    expect(db.attestations).toHaveLength(0);
  });

  it("refuses markdown introduced into a section", async () => {
    const res = await callValidated({
      ...VALID,
      sections: { treatment: FIXED_TREATMENT.replace("completed. The", "completed. **The**") },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/markdown_in_section/);
  });

  it("refuses a classifier blocker only when the published post did not already carry it", async () => {
    classifier.configured.mockReturnValue(true);
    const finding: LintFinding = { code: "diagnosis_as_fact", severity: "blocker", message: "states a diagnosis" };
    // Flags the corrected body only.
    classifier.classify.mockImplementation(async (input: { markdown_body: string }) =>
      input.markdown_body.includes("completed. The") ? [finding] : [],
    );
    const refused = await callValidated(VALID);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/diagnosis_as_fact/);
    expect(db.attestations).toHaveLength(0);

    // Flags both: an untouched sentence the classifier now dislikes does not block a typo fix.
    classifier.classify.mockResolvedValue([finding]);
    const passed = await callValidated(VALID);
    expect(passed.isError).toBeFalsy();
    expect(JSON.parse(passed.text).changed).toBe(true);
  });

  it("refuses adding or removing an FAQ", async () => {
    const res = await callValidated({
      ...VALID,
      sections: undefined,
      meta: { faqs: recorded.post.meta!.faqs!.slice(1) },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/same number of FAQs/);
  });

  it("throws on a concurrent write and leaves the post untouched", async () => {
    db.bumpBeforeUpdate = true;
    const res = await callValidated(VALID);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/changed concurrently/);
    expect(db.post.sections).toEqual(recorded.post.sections);
    expect(db.versions).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("rejects the title, structural meta and undeclared keys at the schema (strict)", async () => {
    await expect(callValidated({ ...VALID, title: "New" })).rejects.toThrow(/unrecognized/i);
    await expect(callValidated({ ...VALID, meta: { related_slugs: [] } })).rejects.toThrow(/unrecognized/i);
    await expect(callValidated({ ...VALID, meta: { player: "X" } })).rejects.toThrow(/unrecognized/i);
    await expect(callValidated({ ...VALID, actor: "automation" })).rejects.toThrow(/unrecognized/i);
    await expect(callValidated({ ...VALID, reason: "  " })).rejects.toThrow();
  });
});

describe("desk-correction rules", () => {
  it("measures only the differing middle", () => {
    expect(editDistance("completed.The", "completed. The")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("caps each field and the total", () => {
    const big = "x".repeat(MAX_FIELD_EDIT_DISTANCE + 1);
    const m = mergeCorrection(recorded.post.sections, recorded.post.meta, { snapshot: big }, undefined);
    expect(sizeCapViolations(m.diff, m.total_distance)[0]).toMatch(/sections\.snapshot/);
  });

  it("lets every deterministic blocker refuse, prior or not", () => {
    const f = (code: string): LintFinding => ({ code, severity: "blocker", message: code });
    expect(refusingBlockers([f("missing_disclaimer")], [f("missing_disclaimer")])).toHaveLength(1);
    expect(refusingBlockers([f("non_public_scan_detail")], [f("non_public_scan_detail")])).toHaveLength(0);
    expect(refusingBlockers([], [f("non_public_scan_detail")])).toHaveLength(1);
  });
});
