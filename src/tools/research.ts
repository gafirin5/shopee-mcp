import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Page } from 'playwright';
import { captureJson, BASE_URL } from '../browser/session.js';
import { sleep } from '../actions/base.js';
import { withErrorHandling, truncate } from '../utils/errors.js';
import { pick } from '../utils/json.js';
import { parseProductUrl } from './product.js';

const ANTIBOT = 90309999;

/**
 * Parse a product reference: a full marketplace URL, a "shopid:itemid" pair,
 * or a bare itemid (paired with default_shop_id). Pure — unit-tested.
 */
export function parseProductRef(
  ref: string,
  defaultShopId?: string,
): { shopId: string; itemId: string } | null {
  const fromUrl = parseProductUrl(ref);
  if (fromUrl) return fromUrl;
  const pair = ref.match(/^(\d+)\s*[:|,]\s*(\d+)$/);
  if (pair) return { shopId: pair[1], itemId: pair[2] };
  if (/^\d+$/.test(ref) && defaultShopId) return { shopId: defaultShopId, itemId: ref };
  return null;
}

function scrollTrigger(page: Page): Promise<void> {
  return (async () => {
    // The ratings XHR is lazy — walk down the page until it fires.
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(600);
    }
  })();
}

interface RatingRow {
  comment?: string;
  author_username?: string;
  rating_star?: number;
  ctime?: number;
}

export function registerResearchTools(server: McpServer): void {
  server.tool(
    'get_product_reviews',
    'Fetch buyer reviews for a product (stars, comment, reviewer, time) from the ' +
      'buyer-facing marketplace. Scrolls the review section so the app fires its ' +
      'ratings request.',
    {
      shop_id: z.string().optional().describe('Numeric shop id (or give url)'),
      item_id: z.string().optional().describe('Numeric item id (or give url)'),
      url: z.string().url().optional().describe('Full marketplace product URL'),
      limit: z.number().int().min(1).max(20).default(10).describe('Max reviews to render'),
    },
    async ({ shop_id, item_id, url, limit }) => {
      return withErrorHandling(async () => {
        const parsed =
          (url ? parseProductUrl(url) : null) ??
          (shop_id && item_id ? { shopId: shop_id, itemId: item_id } : null);
        if (!parsed) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Provide both `shop_id` and `item_id`, or a product `url`.',
              },
            ],
          };
        }
        const pageUrl = `${BASE_URL}/product/${parsed.shopId}/${parsed.itemId}`;
        const { json } = await captureJson<Record<string, unknown>>(pageUrl, {
          apiMatch: ['get_ratings', 'get_rating_summary'],
          timeoutMs: 45000,
          trigger: scrollTrigger,
        });
        if (pick<number>(json, 'error') === ANTIBOT) {
          return {
            content: [
              {
                type: 'text',
                text: '🔒 Blocked by the anti-bot gate — run `npm run login` once, then retry.',
              },
            ],
          };
        }
        // The ratings array hides under several shapes depending on which call fired.
        const ratings =
          pick<RatingRow[]>(json, 'ratings') ??
          pick<RatingRow[]>(pick(json, 'data') as unknown, 'ratings') ??
          [];
        if (!ratings.length) {
          return {
            content: [
              { type: 'text', text: 'No reviews rendered yet for this product (or it has none).' },
            ],
          };
        }
        const lines: string[] = [`⭐ Reviews for item ${parsed.itemId}`, ''];
        for (const r of ratings.slice(0, limit)) {
          const star = typeof r.rating_star === 'number' ? `${r.rating_star.toFixed(1)}★` : '★?';
          const who = r.author_username || 'anonymous';
          const when =
            typeof r.ctime === 'number' ? new Date(r.ctime * 1000).toISOString().slice(0, 10) : '';
          lines.push(`• ${star} ${who}${when ? ` (${when})` : ''}`);
          if (r.comment) lines.push(`  "${truncate(r.comment, 240)}"`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    },
  );

  server.tool(
    'compare_prices',
    "Fetch the CURRENT price of several products (your own or competitors') in one pass, " +
      'via the buyer marketplace. 2s politeness gap between items; max 10 refs per call.',
    {
      products: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Product refs: full URL, or "shopid:itemid" pairs'),
    },
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
        for (const { r } of refs) {
          const pageUrl = `${BASE_URL}/product/${r.shopId}/${r.itemId}`;
          try {
            const { json } = await captureJson<Record<string, unknown>>(pageUrl, {
              apiMatch: 'pdp/get_pc',
              timeoutMs: 30000,
            });
            const name = (pick<string>(json, 'name') ?? '').trim();
            const price = pick<number>(json, 'price') ?? 0;
            const pmin = pick<number>(json, 'price_min');
            const pmax = pick<number>(json, 'price_max');
            const fmt = (v?: number) =>
              typeof v === 'number' && v > 0
                ? `Rp${Math.round(v / 100000).toLocaleString('id-ID')}`
                : '?';
            const priceText =
              pmin && pmax && pmin !== pmax ? `${fmt(pmin)} – ${fmt(pmax)}` : fmt(price);
            lines.push(`• ${name || r.itemId} — ${priceText}`);
            lines.push(`  🔗 ${pageUrl}`);
          } catch (err) {
            lines.push(
              `• ${r.shopId}:${r.itemId} — failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          await sleep(2000);
        }
        if (invalid > 0) lines.push('', `(${invalid} ref(s) skipped as unparseable)`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    },
  );
}
