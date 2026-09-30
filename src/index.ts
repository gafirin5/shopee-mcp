#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSearchTools } from './tools/search.js';
import { registerProductTools } from './tools/product.js';
import { registerVariantTools } from './tools/variants.js';
import { registerReviewTools } from './tools/reviews.js';
import { registerShopTools } from './tools/shop.js';
import { registerFlashSaleTools } from './tools/flashsale.js';
import { registerStatusTools } from './tools/status.js';
import { registerSellerStatusTools } from './tools/seller/status.js';
import { registerSellerProbeTools } from './tools/seller/probe.js';
import { registerSellerShopTools } from './tools/seller/shop.js';
import { registerSellerOrderTools } from './tools/seller/orders.js';
import { registerSellerProductTools } from './tools/seller/products.js';
import { registerSellerVideoTools } from './tools/seller/video.js';
import { registerSellerModifyTools } from './tools/seller/modify.js';
import { registerSellerChatTools } from './tools/seller/chat.js';
import { registerResearchTools } from './tools/research.js';
import { registerShopeeVideoTools } from './tools/shopeeVideo.js';
import { registerCartTools } from './tools/cart.js';
import { registerAccountTools } from './tools/account.js';
import { registerActionTools } from './tools/actions.js';
import { accountToolsSetting, initAccountMode, refreshAccountMode } from './account-mode.js';
import { closeContext, DEBUG } from './browser/session.js';

// Read the version from package.json at runtime so it can't drift from the
// published package version (this file previously hardcoded a stale string).
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

async function main() {
  const server = new McpServer({
    name: 'shopee-mcp',
    version: pkg.version,
  });

  // Register tool groups. Buyer tools run through the shared, logged-in browser
  // session (see src/browser/session.ts) — sign in once with `npm run login`.
  registerSearchTools(server);
  registerProductTools(server);
  registerVariantTools(server);
  registerReviewTools(server);
  registerShopTools(server);
  registerFlashSaleTools(server);
  registerStatusTools(server);

  // Seller Centre realm: portal reads + product write actions on your own shop.
  // Sign in once with `npm run login:seller` (SSO usually covers it).
  registerSellerStatusTools(server);
  registerSellerProbeTools(server);
  registerSellerShopTools(server);
  registerSellerOrderTools(server);
  registerSellerProductTools(server);
  registerSellerVideoTools(server);
  registerSellerModifyTools(server);
  registerSellerChatTools(server);

  // Research tools run on the buyer realm (reviews, competitor prices).
  registerResearchTools(server);
  // Shopee Video feed (web availability is probed first — app-first feature).
  registerShopeeVideoTools(server);

  // Experimental account tools (reads of the user's own data, and the only
  // tools that modify the account). Registered hidden; account mode shows them
  // once the session is confirmed logged in (see src/account-mode.ts).
  initAccountMode(server);
  registerAccountTools(server);
  registerCartTools(server);
  registerActionTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Check the session in the background so a logged-in user gets the account
  // tools without calling anything first; clients are notified via list_changed.
  if (accountToolsSetting() === 'auto') void refreshAccountMode();

  if (DEBUG) {
    process.stderr.write('[shopee-mcp] Server started via stdio (browser-backed discovery)\n');
  }
}

// Tidy up the browser on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeContext().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  process.stderr.write(`[shopee-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});
