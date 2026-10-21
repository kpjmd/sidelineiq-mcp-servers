import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const mockSql = vi.fn();
vi.mock("../src/shared/database.js", () => ({
  getDatabase: () => mockSql,
}));
vi.mock("../src/servers/web/linter-classifier.js", () => ({
  classifierConfigured: vi.fn(() => false),
  classifyDeskPost: vi.fn(),
}));
vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWebTools } from "../src/servers/web/tools.js";
import { withInputKeyPolicy } from "../src/shared/input-key-policy.js";
import { deskContentHash } from "../src/servers/web/desk-sections.js";
import { checkTitle } from "../src/servers/web/linter.js";
import type { DeskPost } from "../src/servers/web/client.js";

/**
 * desk_correct_title against a RECORDED row: the live Ben Simmons desk post as
 * desk_get returned it (src/scripts/record-desk-fixture.ts), never a hand-built
 * one. Every call goes through inputSchema.parse() first — the raw handler never
 * runs zod, which is how stripped keys used to hide from this suite.
 */

const recorded = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/desk-post-published-row.json"), "utf8"),
) as { post: DeskPost };

const MD_ID = recorded.post.reviewed_by as string;
const NON_MD_ID = "11111111-1111-4111-8111-111111111111";
const NEW_TITLE = "Ben Simmons: Torn Achilles Ends Comeback Before Opening Night";

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

function createTestServer(): McpServer {
  const server = new McpServer({ name: "test-web", version: "1.0.0" }, { capabilities: { tools: {} } });
  registerWebTools(withInputKeyPolicy(server, "strict"));
  return server;
}

async function callValidated(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const server = createTestServer();
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools[
    "desk_correct_title"
  ];
  const res = (await tool.handler(tool.inputSchema.parse(args) as Record<string, unknown>, {})) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { isError: res.isError, text: res.content[0].text };
}

// A tiny in-memory stand-in for the five tables this path touches, dispatched
// on the SQL text so the test pins WHAT is written, not the statement order.
interface Db {
  post: DeskPost;
  users: Record<string, { id: string; role: string }>;
  attestations: Record<string, unknown>[];
  versions: unknown[][];
  audits: unknown[][];
  // Simulates another writer bumping the row between the read and the write.
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
        timestamp: "2026-10-21T12:00:00.000Z",
      };
      db.attestations.push(row);
      return [row];
    }
    if (/UPDATE desk_posts SET title/.test(q)) {
      if (db.bumpBeforeUpdate) db.post.version += 1;
      const [title, content_hash, attestation_id, reviewed_by, version, id, prevVersion] = values;
      if (id !== db.post.id || db.post.status !== "PUBLISHED" || db.post.version !== prevVersion) return [];
      Object.assign(db.post, { title, content_hash, attestation_id, reviewed_by, version });
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
  title: NEW_TITLE,
  reason: "Seeded title shipped lowercase; correcting to the intended headline.",
  reviewed_source_reports: true,
  edited_for_accuracy: true,
  framing_confirmed: true,
};

beforeEach(() => {
  mockSql.mockReset();
  installDb(recorded.post);
});

describe("the recorded fixture", () => {
  it("re-derives its own stored hash, so the fixture is a faithful row", () => {
    const p = recorded.post;
    expect(deskContentHash(p.title, p.sections, p.meta, p.markdown_body)).toBe(p.content_hash);
  });
});

describe("desk_correct_title", () => {
  it("corrects the title, re-attests the new hash and leaves the kpjmd confirmation stale", async () => {
    const prev = recorded.post;
    const expectedHash = deskContentHash(NEW_TITLE, prev.sections, prev.meta, prev.markdown_body);

    const res = await callValidated(VALID);
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.text);

    expect(out.changed).toBe(true);
    expect(out.previous_title).toBe(prev.title);
    expect(out.previous_content_hash).toBe(prev.content_hash);
    expect(out.post.content_hash).toBe(expectedHash);
    expect(expectedHash).not.toBe(prev.content_hash);

    // Re-attested: a new attestation for exactly the new hash, and the post points at it.
    expect(db.attestations).toHaveLength(1);
    expect(db.attestations[0].content_hash).toBe(expectedHash);
    expect(db.attestations[0].reviewer_user_id).toBe(MD_ID);
    expect(db.post.attestation_id).toBe(db.attestations[0].id);

    // Untouched: status, slug, published_at, and the kpjmd confirmation — whose
    // hash now disagrees, which is what makes the desk and confirm-live say stale.
    expect(db.post.status).toBe("PUBLISHED");
    expect(db.post.slug).toBe(prev.slug);
    expect(db.post.published_at).toBe(prev.published_at);
    expect(db.post.kpjmd_content_hash).toBe(prev.kpjmd_content_hash);
    expect(db.post.kpjmd_content_hash).not.toBe(db.post.content_hash);
    expect(db.post.version).toBe(prev.version + 1);
    expect(db.post.markdown_body).toBe(prev.markdown_body);

    // The handoff differs from the recorded one in headline and content_hash ONLY.
    const before = structuredClone(prev.draft_json) as Record<string, unknown> & { _sideline: Record<string, unknown> };
    const after = db.post.draft_json as Record<string, unknown> & { _sideline: Record<string, unknown> };
    expect(after.headline).toBe(NEW_TITLE);
    expect(after._sideline.content_hash).toBe(expectedHash);
    before.headline = NEW_TITLE;
    before._sideline.content_hash = expectedHash;
    expect(after).toEqual(before);

    // A version row carrying the diff.
    expect(db.versions).toHaveLength(1);
    const versionDiff = JSON.parse(db.versions[0][8] as string);
    expect(versionDiff).toEqual({ title: { from: prev.title, to: NEW_TITLE } });

    // One audit row, actor md, with the readable diff in the payload.
    expect(db.audits).toHaveLength(1);
    const [actor, actorId, entityType, entityId, action, , , payloadJson] = db.audits[0];
    expect([actor, actorId, entityType, entityId, action]).toEqual([
      "md",
      MD_ID,
      "desk_post",
      prev.id,
      "desk_title_corrected",
    ]);
    expect(JSON.parse(payloadJson as string)).toEqual({
      previous_title: prev.title,
      new_title: NEW_TITLE,
      reason: VALID.reason,
      previous_content_hash: prev.content_hash,
      new_content_hash: expectedHash,
      attestation_id: db.attestations[0].id,
      version: prev.version + 1,
      slug: prev.slug,
    });
  });

  it("trims the title before hashing", async () => {
    const res = await callValidated({ ...VALID, title: `  ${NEW_TITLE}  ` });
    expect(JSON.parse(res.text).post.title).toBe(NEW_TITLE);
  });

  it("is a no-op for the stored title: no attestation, no version, no audit", async () => {
    const res = await callValidated({ ...VALID, title: recorded.post.title });
    const out = JSON.parse(res.text);
    expect(out.changed).toBe(false);
    expect(out.attestation).toBeNull();
    expect(db.attestations).toHaveLength(0);
    expect(db.versions).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
    // users + desk_posts reads only.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-MD before reading the post", async () => {
    const res = await callValidated({ ...VALID, reviewer_user_id: NON_MD_ID });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not 'md'/);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown reviewer", async () => {
    const res = await callValidated({ ...VALID, reviewer_user_id: "22222222-2222-4222-8222-222222222222" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found/);
  });

  it.each(["reviewed_source_reports", "edited_for_accuracy", "framing_confirmed"])(
    "refuses without %s",
    async (key) => {
      const res = await callValidated({ ...VALID, [key]: false });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/three review steps/);
      expect(db.attestations).toHaveLength(0);
    },
  );

  it.each(["DRAFT", "READY", "RETRACTED"] as const)("refuses a %s post", async (status) => {
    installDb({ ...recorded.post, status });
    const res = await callValidated(VALID);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(new RegExp(`is ${status}, not PUBLISHED`));
    expect(db.attestations).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("refuses a title that is only the athlete's name", async () => {
    const res = await callValidated({ ...VALID, title: "Ben Simmons" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/athlete's name/);
    expect(db.attestations).toHaveLength(0);
  });

  it("throws on a concurrent write and leaves the post untouched", async () => {
    db.bumpBeforeUpdate = true;
    const res = await callValidated(VALID);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/changed concurrently/);
    expect(db.post.title).toBe(recorded.post.title);
    expect(db.versions).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an empty title and an empty reason at the schema", async () => {
    await expect(callValidated({ ...VALID, title: "   " })).rejects.toThrow();
    await expect(callValidated({ ...VALID, reason: "" })).rejects.toThrow();
  });

  it("rejects an undeclared key at the schema (strict)", async () => {
    await expect(callValidated({ ...VALID, actor: "automation" })).rejects.toThrow(/unrecognized/i);
  });
});

describe("desk_correct_title over a real transport", () => {
  it("reports an undeclared key as an isError VALUE, not a throw", async () => {
    const server = new McpServer({ name: "t", version: "1.0.0" }, { capabilities: { tools: {} } });
    registerWebTools(withInputKeyPolicy(server, "strict"));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t-client", version: "1.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const res = (await client.callTool({
      name: "desk_correct_title",
      arguments: { ...VALID, closed_by: "system" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe("title_incomplete", () => {
  const meta = { player: "Ben Simmons" };
  it("blocks an empty title", () => {
    expect(checkTitle("  ", meta)[0]).toMatchObject({ code: "title_incomplete", severity: "blocker" });
  });
  it("blocks the seeded athlete-name stub, whatever its punctuation or case", () => {
    expect(checkTitle("Ben Simmons", meta)).toHaveLength(1);
    expect(checkTitle("ben simmons —", meta)).toHaveLength(1);
  });
  it("passes a real headline, including the live one it replaced", () => {
    expect(checkTitle(NEW_TITLE, meta)).toEqual([]);
    expect(checkTitle(recorded.post.title, recorded.post.meta)).toEqual([]);
  });
  it("passes a non-empty title when no player is recorded", () => {
    expect(checkTitle("Ben Simmons", null)).toEqual([]);
  });
});
