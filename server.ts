/**
 * HTTP server exposing the MCP endpoint over the Streamable HTTP transport —
 * the transport Claude uses to reach a remote custom connector.
 *
 * The endpoint is stateless: each JSON-RPC request gets a fresh MCP server +
 * transport, which is simple and robust for a small read-only tool set and
 * plays nicely with horizontally-scaled hosts.
 *
 * If MCP_AUTH_TOKEN is configured, the /mcp endpoint requires
 * `Authorization: Bearer <token>` (set this in Claude's connector Advanced
 * settings). The health check at `/` is always open.
 */

import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { ClickBankClient } from "./clickbank.js";
import { registerTools } from "./tools.js";
import type { AddressInfo } from "node:net";

const SERVER_NAME = "clickbank-connector";
const SERVER_VERSION = "1.0.0";

function buildMcpServer(cfg: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only ClickBank connector. Use get_sales_analytics for sales & revenue over a " +
        "date range (per-product breakdown + totals), get_clicks_and_conversions for hops/" +
        "conversion rate, get_orders for individual transactions, and list_products to map " +
        "data to offers. All dates are YYYY-MM-DD on a UTC basis; each response carries a " +
        "timezone note reconciling UTC with ClickBank's Pacific-time dashboard.",
    },
  );
  const client = new ClickBankClient(cfg);
  registerTools(server, client, cfg);
  return server;
}

export function createApp(cfg: Config) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Health check — no auth. Never exposes secrets.
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      status: "ok",
      mcp_endpoint: "/mcp",
      auth_required: Boolean(cfg.mcpAuthToken),
      clerk_key_configured: cfg.hasClerkKey,
      role: cfg.role,
      default_account_configured: Boolean(cfg.defaultAccountNickname),
    });
  });

  // Optional bearer-token gate for the MCP endpoint.
  const requireAuth = (req: Request, res: Response): boolean => {
    if (!cfg.mcpAuthToken) return true;
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match && timingSafeEqual(match[1].trim(), cfg.mcpAuthToken)) return true;
    res
      .status(401)
      .set("WWW-Authenticate", "Bearer")
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
        id: null,
      });
    return false;
  };

  // Stateless Streamable HTTP: one server+transport per request.
  app.post("/mcp", async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    const server = buildMcpServer(cfg);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: null,
        });
      }
      // eslint-disable-next-line no-console
      console.error("MCP request error:", err instanceof Error ? err.message : err);
    }
  });

  // Stateless mode has no long-lived SSE stream or session to delete.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for the stateless MCP endpoint." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

/** Constant-time-ish string comparison to avoid trivial timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function startServer(
  cfg: Config,
  port: number = cfg.port,
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp(cfg);
  return new Promise((resolve) => {
    const httpServer = app.listen(port, () => {
      const actualPort = (httpServer.address() as AddressInfo).port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((r) => httpServer.close(() => r())),
      });
    });
  });
}
