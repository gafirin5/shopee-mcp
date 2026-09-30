# shopee-mcp

[![npm](https://img.shields.io/npm/v/@bintangtimurlangit/shopee-mcp?style=flat-square)](https://www.npmjs.com/package/@bintangtimurlangit/shopee-mcp)
[![license](https://img.shields.io/github/license/bintangtimurlangit/shopee-mcp?style=flat-square)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/bintangtimurlangit/shopee-mcp/ci.yml?branch=main&style=flat-square)](https://github.com/bintangtimurlangit/shopee-mcp/actions)
[![GitHub Repo](https://img.shields.io/badge/GitHub-shopee--mcp-24292f?style=flat-square&logo=github)](https://github.com/bintangtimurlangit/shopee-mcp)

An MCP ([Model Context Protocol](https://modelcontextprotocol.io/)) server for **exploring Shopee** — product & shop search, prices, reviews — plus a **Seller Centre** realm for reading and acting on **your own shop**. Works with any MCP client (Claude Desktop, Claude Code, Cursor, …) over stdio.

> **Login required, read-mostly, unofficial.** Shopee blocks anonymous requests, so this server works through **your own logged-in browser session** (a persistent [CloakBrowser](https://github.com/CloakHQ/cloakbrowser) profile). It is not affiliated with Shopee — see [Disclaimer](#disclaimer).

| Doc                                      | What's inside                                       |
| ---------------------------------------- | --------------------------------------------------- |
| [Documentation index](./docs/README.md)  | All guides                                          |
| [Configuration](./docs/CONFIGURATION.md) | Env vars, `mcpServers` JSON, per-client setup, xvfb |
| [Development](./docs/DEVELOPMENT.md)     | Scripts, build, login, live smoke test              |
| [Releases](./docs/RELEASES.md)           | SemVer, npm/git tags, publishing                    |
| [Changelog](./CHANGELOG.md)              | Version history                                     |

## What you get

- **Product discovery (buyer side)** — keyword search with sorting & pagination, full product detail (price, discount, stock, ratings, video info), per-shop listings, shop search, review capture, and price comparison across listings.
- **Seller Centre** — portal reads (shop info, wallet/income, analytics, marketing campaigns, orders) and **write actions on your own shop**: price/stock edits, list/unlist, product video upload & removal, chat replies.
- **Account-safety gate** — every browser operation passes through jittered rate limiting, hourly/daily budgets, an anti-bot circuit breaker, two-step confirmation for writes, and a JSONL audit log. One account + one IP means _behaviour_ is what gets accounts flagged, so the gate enforces human-like pacing by default.

## Tools

All tools live behind one logged-in browser session. Reads are read-only; writes are **off by default** and gated (see [Safety & anti-ban](#safety--anti-ban)).

### Discovery (buyer side) — read-only

| Tool                  | What it returns                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_products`     | Keyword search with sorting & pagination — names, prices, sold counts, ratings, seller location, product IDs, URLs.                        |
| `get_product_detail`  | One product — price & discount, brand, condition, category, rating, review & sold counts, stock, location, description, **video info**.    |
| `get_shop_products`   | Products of one shop (by shop ref) — names, prices, sales.                                                                                 |
| `search_shops`        | Shop search by keyword — shop names, IDs, locations, ratings.                                                                              |
| `get_product_reviews` | Buyer-side review capture (scrolls the product page so the ratings XHR fires).                                                             |
| `compare_prices`      | Current prices for up to 10 product refs (URL or `shopid:itemid`), 2 s gap between items.                                                  |
| `check_product_video` | Read-only check (buyer side) whether a listing currently has video media.                                                                  |
| `check_login_status`  | Whether the saved browser session is currently logged into Shopee — call this before the tools above instead of waiting on a slow failure. |

### Seller Centre — reads

Reachable via the same browser profile (`seller.shopee.co.id` — the portal usually SSOs in).

| Tool                                                                                           | What it returns                                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `check_seller_login`                                                                           | Whether the Seller Centre portal is reachable with the current session.                |
| `get_seller_shop_info` / `get_seller_income` / `get_seller_analytics` / `get_seller_marketing` | Portal reads — shop profile, wallet, performance, campaigns.                           |
| `list_orders` / `get_order_detail`                                                             | Order management reads from the portal.                                                |
| `list_seller_products`                                                                         | Your product list with IDs, price/stock when present.                                  |
| `seller_api_probe`                                                                             | Navigate any portal page and capture the first matching XHR JSON — endpoint discovery. |

### Chat — reads

| Tool                       | What it returns                      |
| -------------------------- | ------------------------------------ |
| `list_chats` / `read_chat` | List conversations; read one thread. |

### Write actions — gated

| Tool                                            | Action                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `update_price` / `update_stock`                 | Edit price/stock on the edit page; variation products via 0-based `variation_index`.                             |
| `list_item` / `unlist_item`                     | Flip the on/off-sale switch on the product list page.                                                            |
| `upload_product_video` / `remove_product_video` | Upload (MP4/MOV) or delete a listing's video via the edit page; waits for processing.                            |
| `send_chat_reply`                               | Send one reply in a buyer chat thread.                                                                           |
| `post_shopee_video`                             | Post to the Shopee Video feed (the web uploader is probed first — app-first feature; refuses cleanly if absent). |

### Utilities

| Tool                 | What it returns                                                                       |
| -------------------- | ------------------------------------------------------------------------------------- |
| `safety_status`      | Budgets used, next allowed slots, cooldown state — introspection for the safety gate. |
| `shopee_video_probe` | Probe whether the Shopee Video web uploader is available for this account.            |

Every failing write saves a screenshot to `~/.shopee-mcp/debug/` so UI drift is diagnosable; portal selectors are centralised in `src/seller/pages/*` and `src/actions/*` for one-line fixes.

## Requirements

- **Node.js ≥ 18**
- **A display** — the browser runs _headed_ (Shopee detects headless). On a server, wrap commands in `xvfb-run`.
- **A Shopee account that is yours.** Automation violates Shopee's ToS; only point this at an account you own, at low volume.

## Installation

### From npm (recommended)

```bash
npm install -g @bintangtimurlangit/shopee-mcp   # downloads the CloakBrowser binary (~200 MB, cached)
```

This puts three commands on your PATH:

- **`shopee-mcp`** — the MCP server
- **`shopee-mcp-login`** — one-time buyer login
- **`shopee-mcp-seller-login`** — one-time Seller Centre login

Or run without installing: `npx -y @bintangtimurlangit/shopee-mcp`.

### From source

```bash
git clone https://github.com/bintangtimurlangit/shopee-mcp.git
cd shopee-mcp
npm install          # also downloads the CloakBrowser binary (~200 MB, cached)
npm run build
```

## Quick start

### 1. Log in once

Shopee blocks anonymous requests, so you sign in one time. This saves a session to `~/.shopee-mcp/chrome-profile`.

```bash
shopee-mcp-login            # global install — or from a source checkout: npm run login
```

- A CloakBrowser window opens — log in, then press Enter in the terminal.
- Re-run only when the session expires.

**For the Seller Centre tools**, sign in once too (usually covered by buyer-session SSO):

```bash
shopee-mcp-seller-login     # or: npm run login:seller
```

### 2. Register with your MCP client

Add to Claude Desktop / Claude Code / Cursor `mcpServers`:

```json
{
  "mcpServers": {
    "shopee": {
      "command": "shopee-mcp",
      "args": []
    }
  }
}
```

The server launches a **headed** browser, so it needs a display. On a headless server wrap it:

```json
{
  "mcpServers": {
    "shopee": {
      "command": "xvfb-run",
      "args": ["-a", "shopee-mcp"]
    }
  }
}
```

From a source checkout, use `"command": "node"`, `"args": ["/absolute/path/to/shopee-mcp/build/index.js"]` (wrapped in `xvfb-run` on a headless box).

### 3. Try it

Ask your MCP client things like:

- _"Search Shopee for 'mechanical keyboard' under 500k, sorted by sold count."_
- _"Compare the prices of these two product URLs."_
- _"What's my shop's income this month?"_ (Seller Centre)
- _"Set product 12345 to out of stock."_ → the tool returns a **preview**; re-call with `confirm: true` to execute.

## Safety & anti-ban

Every browser operation — read or write — passes through one account-safety gate (`src/utils/rate-limit.ts`), because all traffic comes from **one account + one IP**, and behaviour is what gets accounts flagged:

1. **Jittered spacing** — reads wait 3–6 s between operations, writes 1–3 min. Never a fixed rhythm.
2. **Budgets** — max 30 reads/hour, 10 writes/hour, 30 writes/day (persisted in `~/.shopee-mcp/usage.json`, surviving restarts). Exceeding a budget fails fast with the reset time instead of hammering.
3. **Anti-bot circuit breaker** — an anti-bot block (`90309999`), an auth-required error, or two consecutive timeouts cools the whole server down for 10 minutes. Tools fail fast during cooldown with the unlock time; don't force retries.
4. **Two-step confirmation** — every write tool returns a **preview** unless called with `confirm: true`, so an AI client can never modify your account uninvited.
5. **Seller-write switch** — all seller-side writes stay disabled until `SHOPEE_ENABLE_SELLER_WRITES=true` in `.env`.
6. **Audit trail** — every write (success or failure) and every block is appended to `~/.shopee-mcp/audit.log` (JSONL).
7. **Introspection** — the `safety_status` tool shows budgets used, next allowed slots, and cooldown state.

**Honest limits:** these measures reduce the risk of behavioural detection; they cannot eliminate it. Automation of any kind remains against Shopee's ToS — run this only on your own account, at low volume, and never for bulk scraping. Rotating proxies are out of scope by design.

## Configuration

All optional — copy `.env.example` to `.env` to override. Full explanations: [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

| Variable                                | Default                        | Purpose                                                     |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `SHOPEE_DOMAIN`                         | `shopee.co.id`                 | Regional Shopee domain.                                     |
| `SHOPEE_PROFILE_DIR`                    | `~/.shopee-mcp/chrome-profile` | Where the saved login lives.                                |
| `SHOPEE_SELLER_PROFILE_DIR`             | (same profile)                 | Isolate the Seller Centre realm in its own profile.         |
| `SHOPEE_HEADLESS`                       | `false`                        | Keep `false` — headless is detected.                        |
| `CACHE_TTL_MS`                          | `30000`                        | In-memory cache lifetime.                                   |
| `SHOPEE_ENABLE_SELLER_WRITES`           | `false`                        | Master switch for all seller-side write tools.              |
| `SHOPEE_READ_SPACING_MS` (+ `_SPREAD`)  | `3000` (+ `3000`)              | Jittered delay between reads.                               |
| `SHOPEE_WRITE_SPACING_MS` (+ `_SPREAD`) | `60000` (+ `120000`)           | Jittered delay between writes.                              |
| `SHOPEE_READ_MAX_PER_HOUR`              | `30`                           | Read budget per hour.                                       |
| `SHOPEE_WRITE_MAX_PER_HOUR`             | `10`                           | Write budget per hour.                                      |
| `SHOPEE_WRITE_MAX_PER_DAY`              | `30`                           | Write budget per day.                                       |
| `SHOPEE_COOLDOWN_MS`                    | `600000`                       | Anti-bot circuit-breaker cooldown (10 min).                 |
| `SHOPEE_ACTION_TIMEOUT_MS`              | `60000`                        | UI write-action timeout (uploads, edits).                   |
| `SHOPEE_ACTION_DELAY_MS`                | `2000`                         | Politeness delay between UI steps.                          |
| `SHOPEE_VIDEO_MAX_MB`                   | `200`                          | Upload guard — reject larger video files before the portal. |
| `DEBUG`                                 | `false`                        | Log startup/debug info to stderr.                           |

## Why a browser?

Shopee does **not** expose an open API or server-rendered product HTML. Its `/api/v4/*` endpoints are guarded by an anti-fraud gate (`error 90309999`) that requires per-request signature headers (`af-ac-enc-dat`, `x-sap-sec`, …) minted by Shopee's own obfuscated SDK. Plain `fetch`, headless Chromium, and even a hand-rolled fetch from inside the page all get rejected.

So this server:

1. Drives **[CloakBrowser](https://github.com/CloakHQ/cloakbrowser)** — a Chromium with binary-level fingerprint patches — against a **persistent profile you log into once**.
2. **Navigates to the real Shopee page and intercepts the response** its own app fetches, so the request carries valid signatures.

The browser must run **headed** (Shopee detects headless); on a server use a virtual display (`xvfb`).

## Project layout

```
src/
├── index.ts              # MCP server: registers all tool groups
├── login.ts / login-seller.ts
├── browser/session.ts    # shared CloakBrowser session
├── api/                  # buyer-side capture (XHR + DOM fallback)
├── tools/                # MCP tool definitions
│   ├── search.ts / product.ts / shop.ts / status.ts / research.ts
│   └── seller/           # portal reads, orders, writes, chat
├── seller/               # portal URLs, pages, selectors, capture
└── utils/                # rate-limit gate, cache, audit, confirm
```

## Development

```bash
npm run lint         # eslint
npm run format       # prettier --write (format:check to verify)
npm run typecheck
npm run test:unit    # offline unit tests (no login/display needed)
npm test             # live smoke test (needs a display; use xvfb-run on servers)
npm run dev          # tsx watch
```

More detail: **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**.

## Troubleshooting

| Symptom                                       | Likely cause / fix                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `🔒 Not signed in` / anonymous-request errors | No/expired session → run `npm run login`.                                                                                                                               |
| `error 90309999` or empty results             | Shopee's anti-bot gate rejected the request. Ensure you're logged in and running **headed** (or via `xvfb-run`); retry after the cooldown (`safety_status` shows when). |
| Tools fail fast with "cooldown"               | The circuit breaker is cooling the server down after an anti-bot signal — wait for the unlock time instead of retrying.                                                 |
| Seller tools say writes are disabled          | Set `SHOPEE_ENABLE_SELLER_WRITES=true` in `.env`, and confirm with `confirm: true`.                                                                                     |
| A read returns empty for a valid product      | Shopee lazy-loads; retry, and run with `DEBUG=true` to inspect.                                                                                                         |
| Empty or stale results right after a change   | In-memory cache — lower `CACHE_TTL_MS` or wait for the TTL to expire.                                                                                                   |
| Headless / server has no display              | Wrap the command in `xvfb-run -a …`.                                                                                                                                    |

## Caveats

- **Login required.** No session → tools return a friendly "run `npm run login`" prompt.
- **Anti-bot is a moving target.** The free CloakBrowser binary can go stale as Shopee updates detection; CloakBrowser Pro ships newer patches.
- **UI writes are fragile by nature.** Shopee's Seller Centre DOM changes without notice; a failing write saves a debug screenshot to `~/.shopee-mcp/debug/`.
- Respect Shopee's Terms of Service. This is for personal market exploration and managing your own shop, not scraping at scale.

## Contributing & security

[CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

[MIT](./LICENSE)

---

## Disclaimer

This is an **unofficial** project. It is **not affiliated with, authorized, maintained, sponsored, or endorsed by Shopee or Sea Limited**.

It works by driving a real logged-in browser session against Shopee's web app, which can change without notice — a tool may break when Shopee updates its site or anti-bot behavior. It reads publicly available data and, when you explicitly enable and confirm them, performs write actions **on your own shop only**.

You are responsible for using this software in compliance with [Shopee's Terms of Service](https://shopee.co.id/docs/terms) and applicable law. Use reasonable request volumes. All product names, logos, and brands are property of their respective owners.
