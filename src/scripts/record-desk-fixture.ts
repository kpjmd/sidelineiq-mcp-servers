/**
 * Record a real desk_get payload as a test fixture. Read-only: it calls only
 * desk_get, through the deployed tool, so the fixture is the row exactly as a
 * caller receives it — never a hand-written approximation (see CLAUDE.md on the
 * fixtures that passed against the same wrong names the code used).
 *
 *   railway run --service sidelineiq-mcp-servers -- env \
 *     WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp \
 *     npx tsx src/scripts/record-desk-fixture.ts <desk_post_id> tests/fixtures/<name>.json
 *
 * The auth secret is read from MCP_AUTH_SECRET, sent only as a header, and never
 * printed.
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [deskPostId, outPath] = process.argv.slice(2);
const url = process.env.WEB_MCP_URL;
const secret = process.env.MCP_AUTH_SECRET;
if (!deskPostId || !outPath || !url || !secret) {
  console.error(
    "Usage: WEB_MCP_URL=… MCP_AUTH_SECRET=… npx tsx src/scripts/record-desk-fixture.ts <desk_post_id> <out.json>",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const client = new Client({ name: "record-desk-fixture", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url as string), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  try {
    const res = (await client.callTool({ name: "desk_get", arguments: { desk_post_id: deskPostId } })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    // A rejected call is a VALUE carrying isError, not a throw.
    if (res.isError) throw new Error(`desk_get rejected: ${text}`);
    const detail = JSON.parse(text) as { post: unknown };
    const fixture = {
      _recorded: {
        tool: "desk_get",
        desk_post_id: deskPostId,
        at: new Date().toISOString(),
        source: "src/scripts/record-desk-fixture.ts",
      },
      ...detail,
    };
    writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
