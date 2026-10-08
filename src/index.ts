#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { accountToolsSetting, refreshAccountMode } from './account-mode.js';
import { closeContext, DEBUG } from './browser/session.js';

async function main() {
  const server = createServer();

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
