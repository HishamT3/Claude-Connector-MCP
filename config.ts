/**
 * Configuration loading.
 *
 * Reads all settings from environment variables. For local development it will
 * also load a `.env` file if one is present (kept out of git). In production
 * the values come from the host's secrets manager (Railway / Render / Fly.io).
 *
 * The Clerk Key is a SECRET: it is only ever read from the environment here.
 * It is never logged, never returned in a tool response, and never hardcoded.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal `.env` loader (no dependency). Only fills vars that are not already set. */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip matching surrounding quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — fine, rely on real environment variables.
  }
}

loadDotEnv();

/** ClickBank's public "captain" developer key (no real dev key required since 2023). */
const DEFAULT_DEV_KEY = "DEV-123456789012345678901234567890123456";

export type Role = "vendor" | "affiliate";

function parseRole(value: string | undefined): Role {
  const v = (value ?? "vendor").toLowerCase();
  return v === "affiliate" ? "affiliate" : "vendor";
}

export interface Config {
  /** ClickBank base REST URL, e.g. https://api.clickbank.com/rest/1.3/ */
  baseUrl: string;
  /** Developer key portion of the Authorization header. */
  devKey: string;
  /** Clerk (Analytics) API key portion of the Authorization header. SECRET. */
  clerkKey: string;
  /** Whether a Clerk key was actually provided. */
  hasClerkKey: boolean;
  /** Default account nickname used when a tool call omits one. */
  defaultAccountNickname?: string;
  /** Account role for analytics queries. */
  role: Role;
  /** Default analytics breakdown dimension. */
  analyticsDimension: string;
  /** Optional bearer token gate for the MCP endpoint. */
  mcpAuthToken?: string;
  /** HTTP port. */
  port: number;
}

export function loadConfig(): Config {
  const clerkKey = (process.env.CLICKBANK_CLERK_KEY ?? "").trim();
  return {
    baseUrl:
      (process.env.CLICKBANK_BASE_URL ?? "https://api.clickbank.com/rest/1.3/").replace(
        /\/?$/,
        "/",
      ),
    devKey: (process.env.CLICKBANK_DEV_KEY ?? DEFAULT_DEV_KEY).trim(),
    clerkKey,
    hasClerkKey: clerkKey.length > 0,
    defaultAccountNickname: (process.env.CLICKBANK_ACCOUNT_NICKNAME ?? "").trim() || undefined,
    role: parseRole(process.env.CLICKBANK_ROLE),
    analyticsDimension: (process.env.CLICKBANK_ANALYTICS_DIMENSION ?? "PRODUCT").trim(),
    mcpAuthToken: (process.env.MCP_AUTH_TOKEN ?? "").trim() || undefined,
    port: Number.parseInt(process.env.PORT ?? "3000", 10) || 3000,
  };
}

export const config = loadConfig();
