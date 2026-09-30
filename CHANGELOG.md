# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0/). For **how** we version, tag, and publish, see [docs/RELEASES.md](./docs/RELEASES.md).

## [Unreleased]

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

[Unreleased]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/bintangtimurlangit/shopee-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bintangtimurlangit/shopee-mcp/releases/tag/v0.1.0
