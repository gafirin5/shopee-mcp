import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLoggedIn, DOMAIN, safetyStatus } from '../browser/session.js';
import { withErrorHandling } from '../utils/errors.js';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export function registerStatusTools(server: McpServer): void {
  server.tool(
    'check_login_status',
    'Check whether the saved browser session is logged into Shopee. ' +
      'Useful to verify setup before calling search_products / get_product_detail, ' +
      'since those fail slowly (a full page load) when the session is signed out.',
    {},
    async () => {
      return withErrorHandling(async () => {
        const loggedIn = await isLoggedIn();
        const text = loggedIn
          ? `✅ Logged in to ${DOMAIN}. search_products and get_product_detail are ready to use.`
          : `🔒 Not logged in to ${DOMAIN}.\n\nRun \`npm run login\` (or \`shopee-mcp-login\`) once, ` +
            `sign in in the Chromium window that opens, then retry.`;
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'safety_status',
    'Show the account-safety gate status: rate-limit budgets used (reads/writes this hour, ' +
      'writes today), next allowed read/write, and whether the anti-bot cooldown is active. ' +
      'Check this when a tool reports a budget or cooldown error.',
    {},
    async () => {
      return withErrorHandling(async () => {
        const s = safetyStatus();
        const lines = [
          '🛡️ Account-safety gate',
          '',
          `   Reads last hour   : ${s.readsLastHour}/30`,
          `   Writes last hour  : ${s.writesLastHour}/10`,
          `   Writes today      : ${s.writesToday}/30`,
          `   Next read allowed : ${fmtTime(s.nextReadAllowedMs)}`,
          `   Next write allowed: ${fmtTime(s.nextWriteAllowedMs)}`,
          s.blockedUntilMs
            ? `   🧊 Anti-bot cooldown ACTIVE until ${fmtTime(s.blockedUntilMs)} — do not force retries.`
            : '   ✅ No cooldown active.',
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    },
  );
}
