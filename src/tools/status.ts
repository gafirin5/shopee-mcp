import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLoggedIn, DOMAIN, safetyStatus } from '../browser/session.js';
import { withErrorHandling } from '../utils/errors.js';
import { accountToolsSetting, setLoggedIn } from '../account-mode.js';

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
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async () => {
      return withErrorHandling(async () => {
        const loggedIn = await isLoggedIn();
        setLoggedIn(loggedIn);
        const mode =
          accountToolsSetting() === 'off'
            ? 'Account tools are turned off (SHOPEE_ACCOUNT_TOOLS=off) — read-only mode.'
            : 'Experimental account tools (orders, vouchers, coins, notifications, cart, likes, follows) are enabled.';
        const text = loggedIn
          ? `✅ Logged in to ${DOMAIN}. All discovery tools are ready.\n${mode}`
          : `🔒 Not logged in to ${DOMAIN} — read-only mode, account tools hidden.\n\n` +
            `Run \`npm run login\` (or \`shopee-mcp-login\`) once, ` +
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
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async () => {
      return withErrorHandling(async () => {
        const s = safetyStatus();
        const lines = [
          '🛡️ Account-safety gate',
          '',
          // Budgets come from the gate, so SHOPEE_*_MAX_* overrides show up here.
          `   Reads last hour   : ${s.readsLastHour}/${s.limits.readMaxPerHour}`,
          `   Writes last hour  : ${s.writesLastHour}/${s.limits.writeMaxPerHour}`,
          `   Writes today      : ${s.writesToday}/${s.limits.writeMaxPerDay}`,
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
