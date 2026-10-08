import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ShopeeAuthRequiredError, shopeeCapture } from '../api/client.js';
import { BASE_URL, CURRENCY } from '../browser/session.js';
import { sleep } from '../actions/base.js';
import { withErrorHandling } from '../utils/errors.js';
import { parseProductUrl, priceText } from './product.js';
import type { PdpResponse } from '../api/types.js';

/**
 * Parse a product reference: a full marketplace URL, a "shopid:itemid" pair,
 * or a bare itemid (paired with default_shop_id). Pure — unit-tested.
 */
export function parseProductRef(
  ref: string,
  defaultShopId?: string,
): { shopId: string; itemId: string } | null {
  const value = ref.trim();
  const fromUrl = parseProductUrl(value);
  if (fromUrl) return fromUrl;
  const pair = value.match(/^(\d+)\s*[:|,]\s*(\d+)$/);
  if (pair) return { shopId: pair[1], itemId: pair[2] };
  if (/^\d+$/.test(value) && defaultShopId) return { shopId: defaultShopId, itemId: value };
  return null;
}

/**
 * Buyer-side competitor/price research.
 *
 * NOTE: `get_product_reviews` used to live here as well. It duplicated the tool
 * of the same name in `src/tools/reviews.ts` (which is the richer, filters-and-
 * paging implementation) and a duplicate name makes `server.tool()` throw, so
 * the whole server failed to start. Keep product reviews in reviews.ts only —
 * `test/tools.ts` now guards against a repeat.
 */
export function registerResearchTools(server: McpServer): void {
  server.tool(
    'compare_prices',
    "Fetch the CURRENT price of several products (your own or competitors') in one pass, " +
      'via the buyer marketplace. Prices are rendered in the storefront currency (see SHOPEE_DOMAIN). ' +
      '2s politeness gap between items; max 10 refs per call.',
    {
      products: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Product refs: full URL, or "shopid:itemid" pairs'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ products }) => {
      return withErrorHandling(async () => {
        const refs = products
          .map((p) => parseProductRef(p))
          .map((r, i) => ({ r, i }))
          .filter((x): x is { r: { shopId: string; itemId: string }; i: number } => x.r !== null);
        const invalid = products.length - refs.length;
        if (!refs.length) {
          return {
            content: [
              { type: 'text', text: '❌ No valid refs. Use full product URLs or "shopid:itemid".' },
            ],
          };
        }
        const lines: string[] = ['💰 Current prices', ''];
        let signedOut = false;
        for (const { r } of refs) {
          const pageUrl = `${BASE_URL}/product/${r.shopId}/${r.itemId}`;
          try {
            // shopeeCapture (not a bare captureJson) so a signed-out session fails
            // fast with the login prompt, the anti-bot gate is mapped to its own
            // error, and a slow first attempt is retried once.
            const data = await shopeeCapture<PdpResponse>(pageUrl, 'pdp/get_pc', 30000);
            const item = data.data?.item;
            const pp = data.data?.product_price;
            if (!item || !pp) {
              lines.push(`• ${r.shopId}:${r.itemId} — no product data returned`);
            } else {
              const currency = item.currency || CURRENCY;
              const before =
                pp.price_before_discount &&
                pp.price_before_discount.single_value > pp.price.single_value
                  ? ` (was ${priceText(pp.price_before_discount, currency)})`
                  : '';
              lines.push(`• ${item.title} — ${priceText(pp.price, currency)}${before}`);
              lines.push(`  🔗 ${pageUrl}`);
            }
          } catch (err) {
            if (err instanceof ShopeeAuthRequiredError) {
              signedOut = true;
              break;
            }
            lines.push(
              `• ${r.shopId}:${r.itemId} — failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          await sleep(2000);
        }
        if (signedOut) {
          lines.push(
            '',
            '🔒 Not signed in to Shopee — run `npm run login` once, then retry. ' +
              '(No further items were requested.)',
          );
        }
        if (invalid > 0) lines.push('', `(${invalid} ref(s) skipped as unparseable)`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    },
  );
}
