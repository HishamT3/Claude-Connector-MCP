/**
 * ClickBank REST API client (read-only).
 *
 * Auth: ClickBank combines two keys in a single `Authorization` header,
 * developer key and clerk (API) key joined with a colon:
 *
 *     Authorization: DEV-xxxxxxxx:API-xxxxxxxx
 *     Accept: application/json
 *
 * Base URL: https://api.clickbank.com/rest/1.3/
 *
 * A 403 Forbidden from ClickBank means the credentials are wrong or missing —
 * fix the header/keys, not the endpoint. This client surfaces that explicitly.
 *
 * This client only ever issues GET requests. It has no method that can change
 * anything in the ClickBank account (read-only by construction).
 */

import type { Config, Role } from "./config.js";

/** Coerce a possibly-single XML→JSON node into an array. */
export function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/** First finite number found among the given candidate keys (case-insensitive). */
function pickNumber(obj: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!obj) return undefined;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v;
  for (const key of keys) {
    const v = lower[key.toLowerCase()];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(String(v));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export class ClickBankError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ClickBankError";
  }
}

export class ClickBankClient {
  constructor(private readonly cfg: Config) {}

  /** The Authorization header value: `<devKey>:<clerkKey>`. Never logged. */
  private authHeader(): string {
    return `${this.cfg.devKey}:${this.cfg.clerkKey}`;
  }

  /**
   * Low-level GET. Builds the URL, sends the auth + JSON headers, parses JSON,
   * and turns non-2xx responses into a ClickBankError with a helpful message.
   */
  async get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<{ data: unknown; url: string }> {
    if (!this.cfg.hasClerkKey) {
      throw new ClickBankError(
        "No ClickBank Clerk Key configured. Set the CLICKBANK_CLERK_KEY environment " +
          "variable (a secret) on the host. See README / .env.example.",
        0,
        "",
      );
    }

    const url = new URL(path.replace(/^\//, ""), this.cfg.baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
    // Redact the query for logs is unnecessary (no secrets in query); the auth
    // is header-only. We never log the header.
    const displayUrl = url.toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader(),
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const reason = err instanceof Error ? err.message : String(err);
      throw new ClickBankError(
        `Network error calling ClickBank: ${reason}`,
        0,
        displayUrl,
      );
    }
    clearTimeout(timeout);

    const text = await res.text();

    if (res.status === 403) {
      throw new ClickBankError(
        "ClickBank returned 403 Forbidden. This means the credentials are wrong or " +
          "missing — the Clerk Key or the Authorization header format is off, not the " +
          "endpoint. Verify CLICKBANK_CLERK_KEY has the Analytics role and that the " +
          "account role/nickname are correct.",
        403,
        displayUrl,
        text.slice(0, 500),
      );
    }
    if (!res.ok) {
      throw new ClickBankError(
        `ClickBank returned HTTP ${res.status} ${res.statusText}.`,
        res.status,
        displayUrl,
        text.slice(0, 800),
      );
    }

    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // ClickBank normally returns JSON when Accept: application/json is sent.
      // If we somehow got XML/text back, surface it rather than crashing.
      data = { _nonJsonResponse: text.slice(0, 2000) };
    }
    return { data, url: displayUrl };
  }

  // -------------------------------------------------------------------------
  // Endpoint wrappers
  // -------------------------------------------------------------------------

  /**
   * Analytics API: GET /analytics/{role}/{dimension}
   * Returns summary statistics (sales, revenue, hops, etc.) for the role,
   * broken down by the given dimension, over a date range.
   */
  async analytics(params: {
    role: Role;
    dimension: string;
    account: string;
    startDate: string;
    endDate: string;
  }): Promise<{ data: unknown; url: string }> {
    const { role, dimension, account, startDate, endDate } = params;
    return this.get(`analytics/${role}/${encodeURIComponent(dimension)}`, {
      account,
      startDate,
      endDate,
    });
  }

  /**
   * Orders API: GET /orders2/list
   * Individual order / transaction detail for a date range.
   */
  async orders(params: {
    role: Role;
    account: string;
    startDate: string;
    endDate: string;
    type?: string;
    page?: number;
  }): Promise<{ data: unknown; url: string }> {
    const { role, account, startDate, endDate, type, page } = params;
    return this.get("orders2/list", {
      role,
      account,
      startDate,
      endDate,
      type,
      page: page !== undefined ? String(page) : undefined,
    });
  }

  /**
   * Products API: GET /products/list/{account}
   * Product list for the account nickname (seller-only).
   */
  async products(account: string): Promise<{ data: unknown; url: string }> {
    return this.get(`products/list/${encodeURIComponent(account)}`);
  }
}

// ---------------------------------------------------------------------------
// Normalizers — turn ClickBank's XML-derived JSON into clean, labelled data.
// These are defensive: ClickBank's JSON can nest single vs. repeated nodes
// inconsistently, so we tolerate several shapes and always keep the raw payload
// available for debugging when the expected structure is not found.
// ---------------------------------------------------------------------------

/** Find the first value whose key matches a predicate, searching shallowly. */
function findByKey(obj: unknown, matches: (key: string) => boolean): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (matches(k.toLowerCase())) return v;
  }
  return undefined;
}

export interface AnalyticsRow {
  dimension_identifier?: string;
  dimension_value?: string;
  account?: string;
  /** Best-effort normalized headline metrics (present when recognizable). */
  sales_count?: number;
  hop_count?: number;
  amount?: number;
  rebill_sales_count?: number;
  rebill_amount?: number;
  /** All raw metric fields as ClickBank returned them, unmodified. */
  metrics: Record<string, unknown>;
}

export interface NormalizedAnalytics {
  rows: AnalyticsRow[];
  totals?: Record<string, unknown> & {
    sales_count?: number;
    hop_count?: number;
    amount?: number;
    rebill_sales_count?: number;
    rebill_amount?: number;
  };
  /** True when we could locate the analytics result structure. */
  recognized: boolean;
  raw?: unknown;
}

function normalizeMetricBlock(block: Record<string, unknown> | undefined) {
  return {
    sales_count: pickNumber(block, ["saleCount", "totalSaleCount", "TOTAL_SALE_COUNT", "sales"]),
    hop_count: pickNumber(block, ["hopCount", "totalHopCount", "TOTAL_HOP_COUNT", "hops"]),
    amount: pickNumber(block, [
      "amount",
      "totalAmount",
      "TOTAL_AMOUNT",
      "saleAmount",
      "revenue",
    ]),
    rebill_sales_count: pickNumber(block, [
      "rebillSaleCount",
      "totalRebillSaleCount",
      "REBILL_SALE_COUNT",
    ]),
    rebill_amount: pickNumber(block, ["rebillAmount", "totalRebillAmount", "REBILL_AMOUNT"]),
  };
}

export function normalizeAnalytics(data: unknown): NormalizedAnalytics {
  // Locate the analytics result root (a key containing "analytic").
  const root =
    findByKey(data, (k) => k.includes("analytic")) ??
    (data && typeof data === "object" ? data : undefined);

  if (!root || typeof root !== "object") {
    return { rows: [], recognized: false, raw: data };
  }
  const rootObj = root as Record<string, unknown>;

  // Rows can appear under row / rows / analyticsResultRow, possibly nested.
  let rowsNode =
    findByKey(rootObj, (k) => k === "row" || k === "rows" || k.includes("resultrow"));
  if (rowsNode && typeof rowsNode === "object" && !Array.isArray(rowsNode)) {
    // Sometimes it's { row: [...] } one level deeper.
    const inner = findByKey(rowsNode, (k) => k === "row" || k.includes("resultrow"));
    if (inner !== undefined) rowsNode = inner;
  }
  const rawRows = asArray(rowsNode as unknown);

  const rows: AnalyticsRow[] = rawRows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => {
      const attributes = (findByKey(r, (k) => k.includes("attribute")) ?? r) as Record<
        string,
        unknown
      >;
      const dataBlock = (findByKey(r, (k) => k === "data" || k.includes("data")) ??
        r) as Record<string, unknown>;
      const metrics =
        dataBlock && typeof dataBlock === "object" ? (dataBlock as Record<string, unknown>) : {};
      return {
        dimension_identifier: strOrUndef(
          attributes.dimensionIdentifier ?? attributes.dimensionidentifier,
        ),
        dimension_value: strOrUndef(
          attributes.dimensionValue ??
            attributes.dimensionvalue ??
            attributes.dimension ??
            attributes.productTitle ??
            attributes.sku,
        ),
        account: strOrUndef(attributes.accountNickName ?? attributes.account),
        ...normalizeMetricBlock(metrics),
        metrics,
      };
    });

  // Totals block.
  const totalsNode = findByKey(rootObj, (k) => k.includes("total")) as
    | Record<string, unknown>
    | undefined;
  const totals =
    totalsNode && typeof totalsNode === "object"
      ? { ...normalizeMetricBlock(totalsNode), ...totalsNode }
      : undefined;

  return {
    rows,
    totals,
    recognized: rows.length > 0 || totals !== undefined,
    raw: rows.length > 0 ? undefined : data,
  };
}

function strOrUndef(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.length ? s : undefined;
}

/** Sum a metric across analytics rows (used to derive account totals if absent). */
export function sumRows(rows: AnalyticsRow[], key: keyof AnalyticsRow): number | undefined {
  let total = 0;
  let any = false;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      any = true;
    }
  }
  return any ? Number(total.toFixed(2)) : undefined;
}

export interface NormalizedOrders {
  count: number;
  orders: Record<string, unknown>[];
  recognized: boolean;
  raw?: unknown;
}

export function normalizeOrders(data: unknown): NormalizedOrders {
  const root = findByKey(data, (k) => k.includes("order")) ?? data;
  let node = findByKey(root, (k) => k.includes("data") || k.includes("order")) ?? root;
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const inner = findByKey(node, (k) => k.includes("order") || k.includes("row"));
    if (inner !== undefined) node = inner;
  }
  const orders = asArray(node as unknown).filter(
    (o): o is Record<string, unknown> => !!o && typeof o === "object",
  );
  return {
    count: orders.length,
    orders,
    recognized: orders.length > 0,
    raw: orders.length > 0 ? undefined : data,
  };
}

export interface NormalizedProducts {
  count: number;
  products: Record<string, unknown>[];
  recognized: boolean;
  raw?: unknown;
}

export function normalizeProducts(data: unknown): NormalizedProducts {
  const root = findByKey(data, (k) => k.includes("product")) ?? data;
  let node = findByKey(root, (k) => k.includes("product") || k.includes("data")) ?? root;
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const inner = findByKey(node, (k) => k.includes("product") || k.includes("row"));
    if (inner !== undefined) node = inner;
  }
  const products = asArray(node as unknown).filter(
    (p): p is Record<string, unknown> => !!p && typeof p === "object",
  );
  return {
    count: products.length,
    products,
    recognized: products.length > 0,
    raw: products.length > 0 ? undefined : data,
  };
}
