/**
 * Entry point. Loads config from the environment and starts the HTTP server.
 */

import { config } from "./config.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const { port } = await startServer(config);
  // eslint-disable-next-line no-console
  console.log(
    [
      `ClickBank Connector MCP listening on port ${port}`,
      `  MCP endpoint:        POST /mcp`,
      `  Health check:        GET  /`,
      `  Role:                ${config.role}`,
      `  Clerk key set:       ${config.hasClerkKey ? "yes" : "NO (set CLICKBANK_CLERK_KEY)"}`,
      `  Default account:     ${config.defaultAccountNickname ?? "(none — pass account_nickname)"}`,
      `  Endpoint auth:       ${config.mcpAuthToken ? "bearer token required" : "OPEN (set MCP_AUTH_TOKEN for public deploys)"}`,
    ].join("\n"),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exit(1);
});
