/**
 * Smoke test — verifies the MCP transport wiring end to end WITHOUT calling
 * ClickBank (no secret key needed). It starts the server on an ephemeral port,
 * connects a real MCP client over Streamable HTTP, and checks that:
 *   1. the initialize handshake succeeds,
 *   2. tools/list returns the four expected tools,
 *   3. calling a tool with a bad date returns a clean, structured error
 *      (validated before any network call to ClickBank).
 *
 * Run with: npm run build && npm run smoke
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

const EXPECTED_TOOLS = [
  "get_sales_analytics",
  "get_clicks_and_conversions",
  "get_orders",
  "list_products",
];

async function main(): Promise<void> {
  // Force an open endpoint for the test regardless of ambient env.
  const cfg = { ...loadConfig(), mcpAuthToken: undefined };
  const { port, close } = await startServer(cfg, 0);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url);

  let failed = false;
  try {
    await client.connect(transport);
    console.log("✓ initialize handshake succeeded");

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`✓ tools/list returned: ${names.join(", ")}`);
    for (const expected of EXPECTED_TOOLS) {
      if (!names.includes(expected)) {
        console.error(`✗ missing expected tool: ${expected}`);
        failed = true;
      }
    }

    // Date validation should fail cleanly, before any ClickBank call.
    const bad = await client.callTool({
      name: "get_sales_analytics",
      arguments: { start_date: "not-a-date", end_date: "2026-07-09" },
    });
    const isError = (bad as { isError?: boolean }).isError === true;
    if (isError) {
      console.log("✓ invalid-date input produced a clean structured error");
    } else {
      console.error("✗ expected an error for invalid date input");
      failed = true;
    }
  } catch (err) {
    console.error("✗ smoke test threw:", err instanceof Error ? err.message : err);
    failed = true;
  } finally {
    await client.close().catch(() => {});
    await close();
  }

  if (failed) {
    console.error("\nSMOKE TEST FAILED");
    process.exit(1);
  }
  console.log("\nSMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
