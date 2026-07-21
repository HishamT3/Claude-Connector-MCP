/**
 * MCP tool definitions.
 *
 * The tool surface is deliberately small and clearly named. Every tool:
 *   - validates dates (YYYY-MM-DD),
 *   - resolves the account nickname (argument or configured default),
 *   - calls ClickBank read-only,
 *   - returns clean, labelled JSON (never raw XML), and
 *   - attaches an explicit timezone note (UTC API vs Pacific dashboard).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import {
  ClickBankClient,
  ClickBankError,
  normalizeAnalytics,
  normalizeOrders,
  normalizeProducts,
  sumRows,
} from "./clickbank.js";
import { assertDate, timezoneNote } from "./timezone.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(error: unknown, context: Record<string, unknown>): ToolResult {
  let message: string;
  const details: Record<string, unknown> = { ...context };
  if (error instanceof ClickBankError) {
    message = error.message;
    details.http_status = error.status || undefined;
    details.request_url = error.url || undefined;
    if (error.body) details.clickbank_response = error.body;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  const payload = { ok: false, error: message, ...details };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

export function registerTools(server: McpServer, client: ClickBankClient, cfg: Config): void {
  const resolveAccount = (provided?: string): string => {
    const account = (provided ?? cfg.defaultAccountNickname ?? "").trim();
    if (!account) {
      throw new Error(
        "No account nickname provided and no CLICKBANK_ACCOUNT_NICKNAME default is set. " +
          "Pass account_nickname or configure the default on the host.",
      );
    }
    return account;
  };

  // -------------------------------------------------------------------------
  // get_sales_analytics — the primary tool.
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_sales_analytics",
    {
      title: "Get sales analytics",
      description:
        "Primary tool. Returns sales count, revenue, and rebill (subscription) figures " +
        "for the seller/vendor account over a date range, broken down by dimension " +
        "(default: per product, so you can isolate a specific offer such as UTS). " +
        "Includes account-level totals. Dates are YYYY-MM-DD and are treated as UTC by " +
        "ClickBank; the response includes a timezone note explaining the UTC-vs-Pacific " +
        "offset versus the ClickBank dashboard.",
      inputSchema: {
        start_date: z.string().describe("Start date, inclusive, in YYYY-MM-DD (UTC basis)."),
        end_date: z.string().describe("End date, inclusive, in YYYY-MM-DD (UTC basis)."),
        account_nickname: z
          .string()
          .optional()
          .describe("ClickBank account nickname. Defaults to the server's configured account."),
        dimension: z
          .string()
          .optional()
          .describe(
            "Analytics breakdown dimension (e.g. PRODUCT, VENDOR, AFFILIATE, TID). " +
              "Defaults to the server's configured dimension (PRODUCT).",
          ),
      },
    },
    async (args): Promise<ToolResult> => {
      const context: Record<string, unknown> = { tool: "get_sales_analytics", ...args };
      try {
        assertDate("start_date", args.start_date);
        assertDate("end_date", args.end_date);
        const account = resolveAccount(args.account_nickname);
        const dimension = (args.dimension ?? cfg.analyticsDimension).trim();

        const { data, url } = await client.analytics({
          role: cfg.role,
          dimension,
          account,
          startDate: args.start_date,
          endDate: args.end_date,
        });
        const norm = normalizeAnalytics(data);

        // Prefer ClickBank-provided totals; otherwise sum the rows.
        const totals = {
          sales_count: norm.totals?.sales_count ?? sumRows(norm.rows, "sales_count"),
          revenue: norm.totals?.amount ?? sumRows(norm.rows, "amount"),
          rebill_sales_count:
            norm.totals?.rebill_sales_count ?? sumRows(norm.rows, "rebill_sales_count"),
          rebill_revenue: norm.totals?.rebill_amount ?? sumRows(norm.rows, "rebill_amount"),
          currency: "USD",
        };

        return ok({
          ok: true,
          account,
          role: cfg.role,
          dimension,
          date_range: { start_date: args.start_date, end_date: args.end_date, timezone: "UTC" },
          totals,
          breakdown: norm.rows,
          timezone_note: timezoneNote(args.start_date),
          request_url: url,
          ...(norm.recognized
            ? {}
            : {
                normalization_warning:
                  "Could not match ClickBank's expected analytics structure; returning the " +
                  "raw response so no data is lost. If this persists, the dimension may be " +
                  "invalid for this role — see README for valid dimensions.",
                raw_response: norm.raw,
              }),
        });
      } catch (err) {
        return fail(err, context);
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_clicks_and_conversions — hops and conversion rate.
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_clicks_and_conversions",
    {
      title: "Get clicks and conversions",
      description:
        "Returns hops (ClickBank's term for tracked clicks), sales count, and the derived " +
        "conversion rate for the account over a date range. Dates are YYYY-MM-DD (UTC basis).",
      inputSchema: {
        start_date: z.string().describe("Start date, inclusive, in YYYY-MM-DD (UTC basis)."),
        end_date: z.string().describe("End date, inclusive, in YYYY-MM-DD (UTC basis)."),
        account_nickname: z
          .string()
          .optional()
          .describe("ClickBank account nickname. Defaults to the server's configured account."),
      },
    },
    async (args): Promise<ToolResult> => {
      const context: Record<string, unknown> = { tool: "get_clicks_and_conversions", ...args };
      try {
        assertDate("start_date", args.start_date);
        assertDate("end_date", args.end_date);
        const account = resolveAccount(args.account_nickname);
        const dimension = cfg.analyticsDimension;

        const { data, url } = await client.analytics({
          role: cfg.role,
          dimension,
          account,
          startDate: args.start_date,
          endDate: args.end_date,
        });
        const norm = normalizeAnalytics(data);

        const hops = norm.totals?.hop_count ?? sumRows(norm.rows, "hop_count");
        const sales = norm.totals?.sales_count ?? sumRows(norm.rows, "sales_count");
        const conversionRate =
          hops && hops > 0 && sales !== undefined
            ? Number(((sales / hops) * 100).toFixed(2))
            : undefined;

        return ok({
          ok: true,
          account,
          role: cfg.role,
          date_range: { start_date: args.start_date, end_date: args.end_date, timezone: "UTC" },
          hops,
          sales,
          conversion_rate_percent: conversionRate,
          conversion_rate_note:
            hops === undefined
              ? "ClickBank did not return hop data for this role; hops are primarily reported " +
                "for the affiliate role. Sales are still shown."
              : undefined,
          timezone_note: timezoneNote(args.start_date),
          request_url: url,
          ...(norm.recognized ? {} : { raw_response: norm.raw }),
        });
      } catch (err) {
        return fail(err, context);
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_orders — individual transactions.
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_orders",
    {
      title: "Get orders",
      description:
        "Returns individual order / transaction detail for a date range (line-item sales " +
        "rather than aggregates). Optionally filter by transaction type. Dates are " +
        "YYYY-MM-DD (UTC basis).",
      inputSchema: {
        start_date: z.string().describe("Start date, inclusive, in YYYY-MM-DD (UTC basis)."),
        end_date: z.string().describe("End date, inclusive, in YYYY-MM-DD (UTC basis)."),
        account_nickname: z
          .string()
          .optional()
          .describe("ClickBank account nickname. Defaults to the server's configured account."),
        type: z
          .string()
          .optional()
          .describe(
            "Optional ClickBank transaction type filter, e.g. SALE, BILL, RFND (refund), " +
              "CGBK (chargeback), TEST. Omit for all types.",
          ),
        page: z.number().int().positive().optional().describe("Page number for pagination."),
      },
    },
    async (args): Promise<ToolResult> => {
      const context: Record<string, unknown> = { tool: "get_orders", ...args };
      try {
        assertDate("start_date", args.start_date);
        assertDate("end_date", args.end_date);
        const account = resolveAccount(args.account_nickname);

        const { data, url } = await client.orders({
          role: cfg.role,
          account,
          startDate: args.start_date,
          endDate: args.end_date,
          type: args.type,
          page: args.page,
        });
        const norm = normalizeOrders(data);

        return ok({
          ok: true,
          account,
          role: cfg.role,
          date_range: { start_date: args.start_date, end_date: args.end_date, timezone: "UTC" },
          type: args.type,
          count: norm.count,
          orders: norm.orders,
          timezone_note: timezoneNote(args.start_date),
          request_url: url,
          ...(norm.recognized ? {} : { raw_response: norm.raw }),
        });
      } catch (err) {
        return fail(err, context);
      }
    },
  );

  // -------------------------------------------------------------------------
  // list_products — product catalogue for the account.
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "Returns the product list for the seller account nickname. Useful for mapping " +
        "analytics/orders to specific offers (e.g. isolating UTS from other products).",
      inputSchema: {
        account_nickname: z
          .string()
          .optional()
          .describe("ClickBank account nickname. Defaults to the server's configured account."),
      },
    },
    async (args): Promise<ToolResult> => {
      const context: Record<string, unknown> = { tool: "list_products", ...args };
      try {
        const account = resolveAccount(args.account_nickname);
        const { data, url } = await client.products(account);
        const norm = normalizeProducts(data);
        return ok({
          ok: true,
          account,
          count: norm.count,
          products: norm.products,
          request_url: url,
          ...(norm.recognized ? {} : { raw_response: norm.raw }),
        });
      } catch (err) {
        return fail(err, context);
      }
    },
  );
}
