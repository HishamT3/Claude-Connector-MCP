# ClickBank → Claude Connector (MCP)

A small **remote MCP server** that wraps ClickBank's Analytics API so Claude can
pull sales, revenue, clicks, conversions, orders, and products **on demand**,
instead of reading them manually from the ClickBank dashboard.

Built around the **seller / vendor** role (the role with the fullest Analytics
access, including subscription / rebill detail). It is **read-only** — nothing
here can change the ClickBank account.

---

## What Claude gets (the tools)

| Tool | What it returns |
|------|-----------------|
| `get_sales_analytics(start_date, end_date, account_nickname?, dimension?)` | **Primary tool.** Sales count, revenue, and rebill (subscription) figures for the date range, broken down by dimension (default: per product, to isolate a specific offer such as UTS) plus account-level totals. |
| `get_clicks_and_conversions(start_date, end_date, account_nickname?)` | Hops (tracked clicks), sales, and the derived conversion rate. |
| `get_orders(start_date, end_date, account_nickname?, type?, page?)` | Individual order / transaction detail (line-item sales), optionally filtered by transaction type. |
| `list_products(account_nickname?)` | Product list for the account, for mapping data to specific offers. |

Every tool returns **clean, labelled JSON** (never raw ClickBank XML) with a
date range, currency, counts, and — for time-based tools — an explicit
**timezone note** (see below).

Dates are always `YYYY-MM-DD`.

---

## The timezone thing (read this)

ClickBank's Analytics API treats the dates you pass as **UTC** calendar days and
reports on a UTC basis. ClickBank's own **dashboard shows Pacific time**
(PST/PDT). Those clocks are 7–8 hours apart, so a UTC-bounded query will not line
up *exactly* with a Pacific-bounded dashboard view near the day boundaries.

This connector makes that explicit: every time-based response includes a
`timezone_note` object stating the API basis (UTC), the dashboard basis
(Pacific), the exact offset for the queried date (DST-aware), and a
reconciliation tip. **If numbers are close to the dashboard but off by a few
hours' worth of sales, that's the offset, not a bug.**

---

## Authentication (how the connector talks to ClickBank)

ClickBank combines two keys in a single `Authorization` header, joined with a
colon, plus a JSON `Accept` header:

```
Authorization: <developer-key>:<clerk-key>
Accept: application/json
```

- **Clerk Key** — your real API key with the **Analytics** role, created in
  ClickBank → *Settings* → *My Account* → *API Management*. **This is the
  secret.** It is read only from the `CLICKBANK_CLERK_KEY` environment variable.
- **Developer Key** — ClickBank stopped requiring a real one in 2023, so this
  defaults to ClickBank's public "captain" key
  `DEV-123456789012345678901234567890123456`. Override via `CLICKBANK_DEV_KEY`
  only if ClickBank issues you a specific one.

> A **`403 Forbidden`** from ClickBank means the credentials are wrong or
> missing — fix the header/keys, **not the endpoint**. The connector surfaces
> this explicitly in its error output.

Base URL: `https://api.clickbank.com/rest/1.3/`

---

## Configuration (environment variables)

Copy `.env.example` to `.env` for local dev (it's gitignored), or set these as
secrets on your host. See `.env.example` for full descriptions.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `CLICKBANK_CLERK_KEY` | **Yes** | — | **Secret.** Analytics-role API key. |
| `CLICKBANK_DEV_KEY` | No | public captain key | Only override if issued one. |
| `CLICKBANK_ACCOUNT_NICKNAME` | No | — | Default account; tools can then omit `account_nickname`. |
| `CLICKBANK_ROLE` | No | `vendor` | `vendor` or `affiliate`. Sellers use `vendor`. |
| `CLICKBANK_ANALYTICS_DIMENSION` | No | `PRODUCT` | Default breakdown dimension. |
| `MCP_AUTH_TOKEN` | Recommended | — | If set, `/mcp` requires `Authorization: Bearer <token>`. **Set this for any public deploy.** |
| `PORT` | No | `3000` | Hosts usually set this automatically. |

---

## Run it locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env         # then paste your Clerk Key into .env in your editor
npm run build
npm start
```

Health check: `curl http://localhost:3000/` → JSON status (never leaks secrets).

**Smoke test** (no Clerk Key needed — verifies the MCP wiring end to end):

```bash
npm run build && npm run smoke
```

**Try a real query** once your key is in `.env` — point any MCP client at
`http://localhost:3000/mcp` and call `get_sales_analytics` for a date range you
can cross-check against the ClickBank dashboard (remembering the UTC vs Pacific
offset when you compare).

---

## Deploy to the public internet

Claude connects to the server **from Anthropic's cloud**, so it must be reachable
on the public internet — a laptop or a machine behind a firewall won't work.
Config files are included for the three usual cheap hosts. **Set
`CLICKBANK_CLERK_KEY` (and `MCP_AUTH_TOKEN`) as a secret on the host — never in
the code or the repo.**

### Railway (easiest)
1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   `railway.json` handles build/start.
3. **Variables** tab → add `CLICKBANK_CLERK_KEY`, `MCP_AUTH_TOKEN`, and
   optionally `CLICKBANK_ACCOUNT_NICKNAME`.
4. Railway gives you a public URL like `https://something.up.railway.app`. Your
   MCP endpoint is that URL **+ `/mcp`**.

### Render
Uses `render.yaml` (a Blueprint). Create a Blueprint service from the repo, then
add the secret env vars in the dashboard (`sync: false` keeps them out of the
file).

### Fly.io
`fly launch --no-deploy`, then
`fly secrets set CLICKBANK_CLERK_KEY=... MCP_AUTH_TOKEN=...`, then `fly deploy`.
A `Dockerfile` is included and used automatically.

Verify any deploy with `curl https://<your-host>/` → you should get the health
JSON with `"clerk_key_configured": true`.

---

## Add it to Claude

Done by Hisham or an account **Owner** (on Team/Enterprise plans only an Owner
can add a custom connector):

1. Claude → **Settings → Connectors**.
2. **Add custom connector**.
3. Paste the hosted MCP URL — **remember the `/mcp` path**, e.g.
   `https://something.up.railway.app/mcp`.
4. Under **Advanced settings**, if you set `MCP_AUTH_TOKEN`, provide it as the
   bearer token / auth header.
5. **Add.**

Then enable it in a conversation via the **+** menu and ask, e.g.,
*"Pull UTS sales and revenue for last week."* Confirm the numbers match the
dashboard (allowing for the UTC/Pacific offset).

---

## Security

- The **Clerk Key is a secret**. It lives only in an environment variable /
  secrets manager, never in source, never in a chat, never committed. `.env` is
  gitignored.
- The connector is **read-only** by construction — it only issues `GET`
  requests and wraps no endpoint that can modify the account.
- Set **`MCP_AUTH_TOKEN`** on any public deploy so only Claude (with the token)
  can reach the tools.
- If the Clerk Key is ever exposed, **regenerate it** in ClickBank → *API
  Management* → *Actions*, and update the secret on the host.

---

## Troubleshooting

- **`403 Forbidden` from ClickBank** → credentials, not the endpoint. Check
  `CLICKBANK_CLERK_KEY` is the Analytics-role key and the account
  nickname/role are correct. Re-confirm the header format against the live spec:
  <https://support.clickbank.com/en/articles/10535397-clickbank-api-specifications>
- **Numbers close but not exact vs the dashboard** → the UTC vs Pacific offset.
  See the `timezone_note` in every response.
- **`normalization_warning` / `raw_response` in the output** → the chosen
  analytics `dimension` may be invalid for the role, or ClickBank changed the
  response shape. The raw payload is included so no data is lost; try a
  different `dimension` (e.g. `VENDOR`, `PRODUCT`, `AFFILIATE`, `TID`) or check
  the [Analytics API docs](https://support.clickbank.com/en/articles/10535402-analytics-api).
- **401 from the connector** → the `MCP_AUTH_TOKEN` bearer token is missing or
  wrong in Claude's Advanced settings.

---

## Project layout

```
src/
  index.ts       entry point
  server.ts      Express + Streamable HTTP MCP transport, auth gate, health check
  tools.ts       the four MCP tools
  clickbank.ts   ClickBank REST client (read-only) + response normalizers
  timezone.ts    UTC vs Pacific handling and the timezone note
  config.ts      environment / secrets loading
  smoke.ts       end-to-end transport smoke test (no key required)
```

Reference: [ClickBank API Specifications](https://support.clickbank.com/en/articles/10535397-clickbank-api-specifications)
· [Analytics API](https://support.clickbank.com/en/articles/10535402-analytics-api)
· [Orders API](https://support.clickbank.com/en/articles/10535407-orders-api)
· [MCP](https://modelcontextprotocol.io)
