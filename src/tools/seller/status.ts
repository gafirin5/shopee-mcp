import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isSellerLoggedIn, DOMAIN } from '../../browser/session.js';
import { withErrorHandling } from '../../utils/errors.js';

export function registerSellerStatusTools(server: McpServer): void {
  server.tool(
    'check_seller_login',
    'Check whether the browser session can reach the Shopee Seller Centre ' +
      `portal (seller.${DOMAIN}). Seller tools fail fast without it. ` +
      'If this reports signed-out, run `npm run login:seller` once.',
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async () => {
      return withErrorHandling(async () => {
        const ok = await isSellerLoggedIn();
        const text = ok
          ? `✅ Seller Centre portal (${DOMAIN}) is reachable — seller tools are ready.`
          : `🔒 Seller Centre is not signed in.\n\nRun \`npm run login:seller\` once in the project folder, ` +
            `log into your seller account in the Chromium window, then retry.`;
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
