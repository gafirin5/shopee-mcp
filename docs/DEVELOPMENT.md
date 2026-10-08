# Development

## Scripts

| Command                | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `npm install`          | Install dependencies (also fetches the CloakBrowser binary)                      |
| `npm run login`        | One-time: open a browser window and log into Shopee                              |
| `npm run login:seller` | One-time: sign into the Seller Centre portal (usually SSO)                       |
| `npm run build`        | Compile TypeScript to `build/` (`tsc`)                                           |
| `npm run dev`          | Watch mode: `tsx watch src/index.ts`                                             |
| `npm run start`        | Run compiled server: `node build/index.js`                                       |
| `npm run lint`         | ESLint over the repo                                                             |
| `npm run format`       | Prettier write; `npm run format:check` to verify                                 |
| `npm run typecheck`    | `tsc --noEmit`, strict, with unused-symbol checks (src + tests)                  |
| `npm run test:unit`    | Offline unit tests for pure helpers — no login, no display                       |
| `npm run test:tools`   | Offline registry test: builds the server and lists its tools                     |
| `npm run test:browser` | Seller and buyer account writes in a real browser vs. local fixtures (see below) |
| `npm test`             | **Live smoke test** — needs a login and a display                                |

### Browser tests (`npm run test:browser`)

These drive the real write code (session, CloakBrowser, Playwright, the selectors, Save, the fresh-load re-read) against two fixtures served by route interception: the Seller Centre portal on `seller.shopee.test` (`test/seller-browser.ts`) and the storefront on `shopee.test` for the buyer account writes (`test/buyer-browser.ts`). The buyer tests call the registered tool handlers, so the confirm gates, the Shopee-response checks, the write budget and the audit entry all run. Every other host is aborted, and HOME is a throwaway directory, so the real account is never touched.

```bash
CLOAKBROWSER_BINARY_PATH=/path/to/chromium npm run test:browser
```

Without the variable the script prints `SKIPPED` and exits 0, so CI is unaffected. CloakBrowser's own Chromium download is often blocked on restricted networks; any Chromium that Playwright can launch will do. CloakBrowser is kept on 0.5.x: its 0.6.0 release failed 19 of the 20 browser checks in the test environment, which runs a non-bundled Chromium 153, and it has not been evaluated with its own binary.

What it shows: the control flow and the guards (refusals, redirect abort, unverified saves, the exact Save label next to a look-alike draft button, saves that show no toast, listing toggles, dialog confirmation, audit entries, account-write metering, request counting). It also covers video upload and removal (waiting for processing, never attaching a video to an image uploader, removal confirmed on a reloaded page), chat reads and replies (one exact buyer, refusal on a shared name, a reply confirmed by its text in the thread, one line per reply), and every buyer click path (like, follow, voucher claim, add to cart, cart edits) including what happens when Shopee rejects the call. Each new check failed on the code before its fix. Reverting one fix at a time turned only its check red. That revert step is done by hand, not by the script.

What it cannot show: that the fixtures match Shopee's current DOM and API. The selectors in `src/seller/pages/`, the cart and voucher field names, and the button labels are still unverified against the live site, so the last check before relying on them is one look at the edit, chat, product, shop and cart pages in a logged-in browser.

## Project layout

```
src/
  index.ts          # MCP server entry: stdio transport + shutdown handling
  server.ts         # createServer(): registers every tool group (testable)
  account-mode.ts   # hides the experimental account tools until logged in
  login.ts          # one-time interactive login (npm run login)
  login-seller.ts   # one-time Seller Centre login (npm run login:seller)
  api/
    client.ts       # navigates the real page and intercepts the app's response
    capture-dom.ts  # capture + scrape the rendered product names
    types.ts        # shared types
  browser/
    session.ts      # CloakBrowser persistent-profile session, safety gate
  actions/
    base.ts         # write-action wrapper: audit log, screenshots, gates
  seller/
    api.ts          # direct Seller Centre portal API calls (SPC_CDS)
    capture.ts      # portal capture (endpoints needing anti-fraud headers)
    urls.ts         # portal paths
    actions/, pages/  # selectors + UI flows for price, stock, video, chats
  tools/            # MCP tool definitions (one module per tool group)
    seller/         # portal reads, orders, writes, chat
  utils/            # rate-limit gate, cache, audit, confirm, price, media
scripts/            # ad-hoc live probes (not published, not part of the build)
test/
  unit.ts           # offline unit tests (npm run test:unit)
  tools.ts          # offline tool-registry test (npm run test:tools)
  seller-browser.ts # seller writes in a real browser vs. a fixture (npm run test:browser)
  buyer-browser.ts  # buyer account writes in a real browser vs. a fixture (npm run test:browser)
  smoke.ts          # the npm test health check (live)
```

`tsconfig.json` compiles `src/` only — that is what ships. `tsconfig.test.json`
typechecks `src/` **and** `test/` together, which is what `npm run typecheck`
runs: the test files are not part of the published build, but a test double that
drifts from the real signature stops being a test.

## Why a browser is required

Shopee does **not** expose an open API or server-rendered product HTML. Its `/api/v4/*` endpoints are guarded by an anti-fraud gate that requires per-request signature headers minted by Shopee's own obfuscated SDK. Plain `fetch`, headless Chromium, and hand-rolled in-page fetches are all rejected.

So this server drives **[CloakBrowser](https://github.com/CloakHQ/cloakbrowser)** (a fingerprint-patched Chromium) against a persistent profile you log into once, **navigates to the real Shopee page, and intercepts the response** its own app fetches — so the request carries valid signatures. The browser runs **headed** (Shopee detects headless); on a server use `xvfb`.

## Build output

`npm run build` emits JavaScript under **`build/`**. The repo **gitignores** `build/`; CI and `prepublishOnly` run `npm run build`.

## Tech stack

- TypeScript, **strict** (with `noUnusedLocals` / `noUnusedParameters`)
- Zod for MCP tool input validation
- `@modelcontextprotocol/sdk` (stdio), CloakBrowser + Playwright
