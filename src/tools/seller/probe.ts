import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sellerCaptureRaw } from '../../seller/capture.js';
import { withErrorHandling } from '../../utils/errors.js';
import { summarizeJson } from '../../utils/json.js';

/**
 * Discovery tool for the Seller Centre's internal XHR endpoints.
 *
 * The portal app fires dozens of API calls per page and Shopee renames them
 * across UI generations; instead of guessing blindly, this tool navigates a
 * portal page you name and returns the first matching JSON response together
 * with its URL — which is exactly what other seller tools key their capture
 * patterns on. Use it when a seller tool reports "endpoint not found".
 */
export function registerSellerProbeTools(server: McpServer): void {
  server.tool(
    'seller_api_probe',
    'Navigate a Shopee Seller Centre page and capture the first JSON XHR response ' +
      'whose URL contains the given substring. Use to discover live endpoint URLs ' +
      'when a seller tool cannot find its data (portal paths drift between UI versions).',
    {
      path: z
        .string()
        .min(1)
        .describe('Portal path to open, e.g. "/portal/order/list" or "/portal/product/list"'),
      match: z
        .string()
        .default('/api/')
        .describe('Substring the response URL must contain (default "/api/" = any portal XHR)'),
      timeout_ms: z
        .number()
        .int()
        .min(5000)
        .max(120000)
        .default(30000)
        .describe('How long to wait for the matching response (ms)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ path, match, timeout_ms }) => {
      return withErrorHandling(async () => {
        const { json, matchedUrl } = await sellerCaptureRaw<unknown>(path, match, timeout_ms);
        const text =
          `🔬 Probe result\n` + `Endpoint: ${matchedUrl}\n\n` + summarizeJson(json, 6000);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
