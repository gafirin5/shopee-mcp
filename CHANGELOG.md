# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0/). For **how** we version, tag, and publish, see [docs/RELEASES.md](./docs/RELEASES.md).

## [Unreleased]

## [0.4.0] - 2026-10-09
### Added

- **Seller Centre realm** (unreleased): portal reads — `check_seller_login`, `get_seller_shop_info`, `get_seller_income`, `get_seller_analytics`, `get_seller_marketing`, `list_orders`, `get_seller_order_detail`, `list_seller_products`, `seller_api_probe` — plus write actions on your own shop: `update_price`, `update_stock`, `list_item` / `unlist_item`, `upload_product_video` / `remove_product_video`, `send_chat_reply`, `post_shopee_video`. All writes sit behind `SHOPEE_ENABLE_SELLER_WRITES`, `confirm: true`, the rate-limit gate, and the audit log.
- **Account-safety gate** (unreleased): every browser operation passes through one gate — jittered read/write spacing, hourly/daily budgets persisted to `~/.shopee-mcp/usage.json`, an anti-bot circuit breaker, and a JSONL audit log; `safety_status` reports the state.
- **Chat**: `list_chats`, `read_chat`, `send_chat_reply`.
- **Buyer extras**: `get_shop_products`, `search_shops`, video info in `get_product_detail`, `check_product_video`, `shopee_video_probe`, `compare_prices`.
- `test/tools.ts` (`npm run test:tools`): offline registry test that builds the real server and lists its tools; wired into CI.
- `npm run typecheck` now also checks `test/` (via `tsconfig.test.json`); it previously compiled only `src/`, and two test doubles had quietly drifted from the real `CaptureFn` shape.
- `test/seller-browser.ts` (`npm run test:browser`): runs the seller write actions in a real Chromium against a local fixture of the Seller Centre, served by route interception on a test host (every other host is aborted, and HOME is a throwaway directory). It covers price/stock writes, variation refusal, redirect abort, unverified saves, the exact Save label, saves without a toast, listing toggles, look-alike buttons, audit entries, account-write metering and the request counter, plus video upload and removal (processing, image-uploader mix-ups, removal confirmed on reload) and chat reads and replies (exact buyer, shared names, reply text confirmed in the thread). It needs `CLOAKBROWSER_BINARY_PATH` and skips otherwise.
- `test/buyer-browser.ts` (also `npm run test:browser`): the buyer account writes (like, unlike, follow, unfollow, claim a shop voucher, add to cart, edit the cart) run through their registered tool handlers against a storefront fixture. It covers the confirm gate, refusals before the page is touched, Shopee rejections, the outcome of each click, the write budget and audit entries, and that a read spends no write.

### Changed

- **Breaking: `like_product`, `follow_shop`, `add_to_cart` and `update_cart_item` require `confirm: true`.** Like `claim_shop_voucher`, they return a preview and change nothing unless called with `confirm: true`. A client that called them directly must now pass `confirm: true` once the user has approved the preview.
- **The release workflow stops when the version is already on npm.** It used to print a notice and still create a GitHub release with no npm update. It now fails before publishing, so bump `version` before tagging (see `docs/RELEASES.md`).
- **zod 4 changes the advertised input schemas.** `tools/list` no longer sets `additionalProperties: false` on tool inputs, and the `get_product_reviews` `filter` values are listed in a different order. Unknown arguments are still dropped rather than rejected.
- Dependencies: in-range updates (Playwright 1.64, ESLint 10.12, `@types/node` 24.19 and others) and `dotenv` 18. TypeScript stays on 5.9, because `typescript-eslint` does not support TypeScript 7 yet.
- **Seller price/stock edits can no longer silently touch the wrong row.** `update_price` and `update_stock` now refuse to edit a variation listing unless `variation_index` says which row (they previously edited the first one), verify the typed value before Save, and re-read the edit page afterwards to report whether Shopee really stored it. A redirect to a different product aborts the action.
- **`claim_shop_voucher` requires `confirm: true`** — a claim cannot be undone, so it now uses the same preview-then-execute gate as the Seller Centre writes.
- **The safety gate counts requests, not just operations.** Every `/api/vN/…` response the browser makes is tallied; `safety_status` reports the rolling-hour total, and `SHOPEE_API_REQUESTS_MAX_PER_HOUR` (unset by default) turns that into a real cap — one operation can be a dozen requests.
- Seller tool output and cooldown/next-slot times are English and use the machine's local 24-hour clock, instead of Indonesian labels and `id-ID` formatting on every storefront.
- `engines.node` is now `>=20` (18 is past end-of-life and was never exercised by CI, which tests 20/22/24).

### Fixed

- **A Save click could press the wrong button.** The Save button was matched by substring, so "Simpan Draf" (save as draft) could be pressed instead of "Simpan". It now matches the exact label, and an action refuses, with nothing clicked, when no exact Save button is showing.
- **A save that worked could be reported as failed.** `update_price` and `update_stock` required a success toast, so a save that stored the value but showed no toast was reported as an error. The fresh re-read now decides; the toast is advisory.
- **Account writes were counted as reads and never audited.** `like_product`, `follow_shop`, `claim_shop_voucher`, `add_to_cart` and `update_cart_item` used the read path, so they skipped the write budget and spacing and left no `audit.log` entry. They now count as writes and are audited. An audit `ok` means the browser step finished without an error; the tool's reply carries the business outcome.
- **Seller write actions could not run at all.** `update_price`, `update_stock`, `list_item`/`unlist_item` and the product-video actions opened the Seller Centre edit or list page with a bare path, which Playwright rejects (`Cannot navigate to invalid URL`) before any step ran. They now use the absolute URL, like the other seller pages. The new browser suite found this; no earlier check executed those paths.
- **List/unlist could toggle the wrong product or click the wrong button.** The row match was a substring test (`777` matched the row for `7777`); the confirmation step clicked any visible button whose text contained "ya" or "ok" (e.g. "Layanan"), even outside a dialog; and a switch with no readable on/off state was clicked anyway. The id now matches as a whole number, confirmation is only looked for inside a dialog by exact label, and an unreadable state is refused with nothing clicked.
- **List/unlist finds its switch under CloakBrowser's humanized actions.** Chained locators and `getByRole` are rejected there, so the lookup failed in the real browser even once the navigation was fixed; it now uses one CSS selector per element.
- **`0` is a valid value for `SHOPEE_*_SPACING_MS`, `SHOPEE_*_SPREAD_MS` and the `SHOPEE_*_MAX_*` budgets.** It was silently replaced by the default, so `SHOPEE_WRITE_SPACING_MS=0` still waited 60–120 s between writes.
- **`read_chat` and `shopee_video_probe` were counted as writes.** Both ran through the write path, so every read spent the write budget (30 a day by default), waited the 1–3 minute write spacing, and appeared in `audit.log` as writes. They are reads now: they spend the read budget and leave no write entry.
- **A video upload could save before processing finished, and could attach the video to an image uploader.** The wait returned as soon as a preview appeared, though a preview can render before processing ends, and the fallback input search took any file input on the page. The wait now also waits for the progress bar to clear, and a fallback input has to declare a video type.
- **Video upload and removal trusted the Save toast.** After Save, both now reload the edit page and report what it shows. A removal that left the video in place is an error, not "Video deleted", and an upload is confirmed by the reloaded page even when no toast appeared.
- **`send_chat_reply` could reply to the wrong buyer.** The conversation match was a bare substring, so "Budi" opened "Budi Santoso" when that conversation came first. An exact name match wins, and two conversations that both match are refused.
- **`send_chat_reply` reported "Reply sent" from a new bubble alone.** A buyer's message arriving at the same moment would fake it. The reply now counts only when its text appears in the thread. A multi-line reply is refused, because Enter sends each line separately.
- **`update_cart_item` reported a change that Shopee rejected.** A rejected cart/update counted as applied, so the reply said "quantity 1 → 3" while the quantity stayed 1. Only accepted edits count now, and a rejection reads "did not confirm".
- **The server failed to start** with `Fatal error: Error: Tool get_product_reviews is already registered` — the tool was registered twice (an older copy in `research.ts` alongside the real one in `reviews.ts`) and `server.tool()` throws on a duplicate name. The duplicate is gone and `npm run test:tools` now fails CI if it ever returns.
- `compare_prices` read `name`/`price`/`price_min` from the top level of the PDP response (the payload is nested under `data.item` / `data.product_price`), so every listing printed `?`; it also hardcoded `Rp` and Indonesian number formatting for all regions. It now reads the real fields, renders prices in the storefront currency, and fails fast with the login prompt when signed out.
- `safety_status` printed hardcoded budgets (`/30`, `/10`, `/30`) that ignored `SHOPEE_*_MAX_*` overrides; it now reports the limits the gate actually enforces.
- MCP tool annotations are now sent for **every** tool, including the seller realm, the chat tools, and `safety_status` (the 0.3.0 claim only held for the buyer tools).
- Lint: unused import in `scripts/probe-creator.ts` broke `npm run lint` (and therefore CI).
- Docs: the release guide described a `NPM_TOKEN` secret although the workflow uses npm Trusted Publishing (OIDC); `docs/CONFIGURATION.md` was missing the safety-gate, seller-write, and action-tuning variables; `SHOPEE_SELLER_PROFILE_DIR` was documented in the README/`.env.example` but never implemented — the realms share one profile via SSO, and the docs now say so.

## [0.3.0] - 2026-09-29

### Added

- **New tool `get_product_reviews`** — rating summary (star breakdown, reviews with comments/media) and pages of buyer reviews with variant bought and seller replies; filter by star rating, comments, or media.
- **New tools `get_shop_info` and `get_shop_products`** — a seller's profile (by shop ID or username) and their catalogue with sorting and pagination.
- **New tool `get_flash_sale`** — the current Flash Sale session, upcoming sessions, and deals with flash vs. original price and claimed stock.
- **New tool `get_product_variants`** — every variant with model ID and per-variant price, with an opt-in exact stock lookup (thanks [@dennislwy](https://github.com/dennislwy); a similar tool was also built by [@franshjy](https://github.com/franshjy)).
- `search_products` **filters**: `minPrice`, `maxPrice`, `minRating`, `location`, `officialMallOnly`.
- `get_product_detail` now includes **specs**, **shipping** (origin, fee range, free-shipping threshold, delivery estimates), a **seller summary**, and a variant count — all from the same page load.
- **Malaysia, Singapore and Taiwan**: the browser locale, timezone and currency now follow `SHOPEE_DOMAIN`, overridable with `SHOPEE_LOCALE` / `SHOPEE_TIMEZONE` (thanks [@dennislwy](https://github.com/dennislwy); also explored by [@nundorn](https://github.com/nundorn) and [@DystopiaOwO](https://github.com/DystopiaOwO)).
- **Experimental account mode.** While the saved session is logged in, the server also offers tools for your own account; signed out, it stays read-only with those tools hidden. It checks the login in the background at startup and on `check_login_status`, and notifies clients via `tools/list_changed`. `SHOPEE_ACCOUNT_TOOLS=off` keeps it read-only.
  - Reads: `get_orders`, `get_order_detail` (tracking, timeline — address and phone omitted), `get_my_vouchers`, `get_coins`, `get_notifications`, `get_cart`, `get_shop_vouchers`.
  - Actions (modify your account, never checkout or payment): `add_to_cart`, `update_cart_item` (change quantity or remove), `like_product`, `follow_shop`, `claim_shop_voucher`. Each clicks Shopee's own button, checks the current state first, and reports only what Shopee confirmed. The cart tools build on [@DystopiaOwO](https://github.com/DystopiaOwO)'s fork.
- `get_shop_info` works without a login (Shopee still serves shop profiles anonymously).
- MCP tool annotations (`readOnlyHint`, `idempotentHint`, …) are now actually sent for every tool.

### Fixed

- `search_products` handles Shopee's newer card-shaped search results (`item_data` / `item_card_displayed_asset`) and resolves "virtual item" cards to their real listing (thanks [@dennislwy](https://github.com/dennislwy); the shape change was also fixed independently by [@nundorn](https://github.com/nundorn) and [@franshjy](https://github.com/franshjy)).
- A signed-out session now fails in about a second with the login prompt, instead of after a full capture timeout plus retry.
- Pages that redirect (e.g. a shop's `/<username>` URL) no longer fail with "response body is not available": an unreadable matching response is skipped and the next one is used.
- Prices are formatted with the right symbol and decimals per currency (IDR, MYR, SGD, TWD).

### Changed

- Bumped `cloakbrowser` (0.5.5 → 0.5.10, #36), `playwright` (1.62.1 → 1.63.0, #43), and development tooling (#28, #29, #38, #39, #41, #42, #44, #45).
- The default capture timeout is 60s (was 30s), since some regions fire the search request ~28s into the page load.

## [0.2.0] - 2026-08-12

### Added

- **New tool `check_login_status`** — reports whether the saved browser session is currently logged into Shopee, so a client can check auth state upfront instead of waiting on a slow failure inside `search_products` / `get_product_detail`.
- `test/unit.ts` — a fast, offline unit test suite (no login/display needed) covering the `real_items` search-result flattening, price formatting, product URL parsing, the TTL cache, and the new capture-retry logic. Wired into CI via `npm run test:unit`, which now runs on every push/PR alongside lint/typecheck/build.

### Fixed

- `search_products` no longer crashes on Shopee's recommendation/ads search cards, which nest their real products under `real_items` instead of the usual top-level `item_basic` (thanks [@teguholica](https://github.com/teguholica), #25).
- A timeout waiting for Shopee's API response is now retried once before being reported as "not logged in" — a slow page load or transient network blip was previously indistinguishable from the anti-bot gate silently dropping the request.

### Changed

- Bumped `@modelcontextprotocol/sdk` (1.29.0 → 1.30.0), `cloakbrowser` (0.4.12 → 0.5.5), and `playwright` (1.61.1 → 1.62.1), plus development tooling (`eslint`, `prettier`, `tsx`, `lint-staged`, `typescript-eslint`).
- The MCP server now reports its actual `package.json` version at connect time instead of a hardcoded, previously-stale string.

## [0.1.1] - 2026-07-21

### Added

- Standardized project scaffolding: `LICENSE` (MIT), `.editorconfig`, ESLint + Prettier, Conventional Commits (commitlint), Husky pre-commit hooks, CI + release workflows, issue/PR templates, and a `docs/` guide set.

### Changed

- Updated runtime and development dependencies, and standardized the npm trusted-publishing release workflow.

## [0.1.0] - 2026-07-12

### Added

- Initial release: MCP server for **exploring Shopee** over stdio, driving a logged-in CloakBrowser session to clear Shopee's anti-bot gate.
- **2 tools:** `search_products` (keyword search with sorting & pagination) and `get_product_detail` (price, discount, brand, condition, rating, review/sold counts, stock, location, description).
- In-memory read cache and a persistent browser profile under `~/.shopee-mcp/`.

[Unreleased]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bintangtimurlangit/shopee-mcp/releases/tag/v0.1.0
