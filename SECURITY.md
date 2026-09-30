# Security

## Supported versions

Security fixes are applied to the **latest release** on the default branch when practical.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for undisclosed security problems.

1. Use [GitHub private vulnerability reporting](https://github.com/bintangtimurlangit/shopee-mcp/security/advisories/new) if it is enabled for this repository, **or**
2. Contact the maintainers via a private channel (e.g. email on your GitHub profile).

Include:

- A short description of the issue and its impact
- Steps to reproduce (or a proof-of-concept), if safe to share
- Affected versions or dependency versions, if known

We aim to acknowledge reports within a few days and coordinate disclosure after a fix is available.

## Scope and credential handling

This is a **local MCP server** that reads **public** Shopee product data through a **logged-in browser session** (Shopee blocks anonymous requests). Be aware:

- Your **session lives on your machine** under `~/.shopee-mcp/chrome-profile` (configurable via `SHOPEE_PROFILE_DIR`). Treat that directory like a password. It is never transmitted anywhere by this server, and the repo **gitignores** local profile/state.
- **Signed out, the server is read-only** — public product, review, shop and flash-sale lookups; no account actions.
- **Signed in, experimental account mode** also offers tools that read your own data (orders, cart, vouchers, coins, notifications) and that **modify your account**: add/update/remove cart items, like/unlike products, follow/unfollow shops, and claim shop vouchers. Nothing in this server checks out, pays, changes addresses, payment methods or passwords, or sends chat messages; order detail omits your address and phone number.
- Set `SHOPEE_ACCOUNT_TOOLS=off` to keep a logged-in server read-only. Only use account mode with an MCP client you trust to ask before acting — write tools are annotated `readOnlyHint: false` so clients can prompt for them.

Issues in **Shopee's services**, **CloakBrowser**, or **upstream** dependencies (e.g. `@modelcontextprotocol/sdk`, `playwright`) should be reported to those projects when appropriate.
