import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_URL } from '../browser/session.js';
import { captureWithNames } from '../api/capture-dom.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling, truncate } from '../utils/errors.js';
import { flattenSearchCards, formatPrice, type SearchCard, type SearchHit } from './search.js';
import { findArray } from './seller/format.js';

/** Parse a shop reference: numeric id, a /shop/<id> URL, or -i.<shopid>.<itemid> slug. */
export function parseShopRef(ref: string): string | null {
  const value = ref.trim();
  if (/^\d+$/.test(value)) return value;
  const shopUrl = value.match(/\/shop\/(\d+)/);
  if (shopUrl) return shopUrl[1];
  const slug = value.match(/-i\.(\d+)\.\d+/);
  if (slug) return slug[1];
  return null;
}

function renderHits(hits: SearchHit[], shown: SearchHit[], page: number, total: number): string {
  const lines: string[] = [`📊 ${total.toLocaleString('id-ID')} products`, ``];
  shown.forEach((h, i) => {
    const rank = (page - 1) * hits.length + i + 1;
    const rating = h.ratingStar ? `⭐ ${h.ratingStar.toFixed(1)}` : '⭐ N/A';
    const soldText = h.sold > 0 ? ` | 📦 ${h.sold.toLocaleString('id-ID')} sold` : '';
    const official = h.isOfficialShop ? ' [Mall]' : '';
    lines.push(`${rank}. **${h.name || `(item ${h.itemid})`}**`);
    lines.push(
      `   💰 ${formatPrice(h.price)}${h.priceBefore > h.price ? ` ~~${formatPrice(h.priceBefore)}~~` : ''}`,
    );
    lines.push(`   ${rating}${soldText}${official} | 🆔 ${h.itemid}`);
    lines.push(`   🔗 ${BASE_URL}/product/${h.shopid}/${h.itemid}`);
    if (i < shown.length - 1) lines.push('');
  });
  return lines.join('\n');
}

export function registerShopTools(server: McpServer): void {
  server.tool(
    'get_shop_products',
    'Browse the product catalog of a Shopee SHOP from the buyer side (by shop id or URL), ' +
      'with names, prices, sold counts, ratings. Useful for competitor research and monitoring.',
    {
      shop: z
        .string()
        .min(1)
        .describe('Shop id, a /shop/<id> URL, or any product URL of that shop'),
      page: z.number().int().min(1).default(1).describe('Page number (default: 1)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(20)
        .describe('Max products to show (default: 20)'),
      sort: z
        .enum(['relevance', 'newest', 'top_sales', 'price_low', 'price_high'])
        .default('relevance')
        .describe('Sort order (default: relevance)'),
    },
    async ({ shop, page, limit, sort }) => {
      return withErrorHandling(async () => {
        const shopId = parseShopRef(shop);
        if (!shopId) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Provide a numeric shop id, /shop/<id> URL, or a product URL.',
              },
            ],
          };
        }
        const cacheKey = cache.key('shop-products', shopId, page, limit, sort);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text', text: cached }] };

        const sortBy = {
          relevance: 'relevancy',
          newest: 'ctime',
          top_sales: 'sales',
          price_low: 'price',
          price_high: 'price',
        }[sort];
        const order = sort === 'price_low' ? 'asc' : sort === 'price_high' ? 'desc' : undefined;
        const qs = new URLSearchParams({ shop: shopId, page: String(page - 1), sortBy });
        if (order) qs.set('order', order);
        // Verified live: /shop/<id>/search redirects to /search?shop=<id> —
        // shop browsing is unified into the search page and fires the same
        // search_items endpoint.
        const shopUrl = `${BASE_URL}/search?${qs.toString()}`;

        let data: { items?: unknown[]; total_count?: number; nomore?: boolean } | undefined;
        let hits: SearchHit[] = [];
        let names: Record<string, string> | undefined;
        for (let attempt = 0; attempt < 3 && hits.length === 0; attempt++) {
          const run = await captureWithNames<{
            items?: unknown[];
            total_count?: number;
            nomore?: boolean;
          }>(shopUrl, '/api/v4/search/search_items');
          data = run.data;
          names = run.names;
          hits = flattenSearchCards((data.items ?? []) as SearchCard[]);
          // The unified search returns other shops' items too — keep only this shop's.
          hits = hits.filter((h) => String(h.shopid) === shopId);
          for (const h of hits) h.name ||= names?.[`${h.shopid}:${h.itemid}`] ?? '';
        }
        if (!data || hits.length === 0) {
          return {
            content: [
              { type: 'text', text: `No products found for shop ${shopId} on page ${page}.` },
            ],
          };
        }

        const shown = hits.slice(0, limit);
        const text =
          `🏪 Shop ${shopId} products\n` +
          renderHits(hits, shown, page, data.total_count ?? 0) +
          (data.nomore ? '' : `\n\n📄 Use page=${page + 1} to see more.`);
        cache.set(cacheKey, text);
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'search_shops',
    'Search for Shopee SHOPS by keyword from the buyer side (shop names, ids, location when present).',
    {
      query: z.string().min(1).describe('The shop search query, e.g. "kaos polos jakarta"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .describe('Max shops to show (default: 10)'),
    },
    async ({ query, limit }) => {
      return withErrorHandling(async () => {
        const cacheKey = cache.key('search-shops', query, limit);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text', text: cached }] };

        const url = `${BASE_URL}/search_user?keyword=${encodeURIComponent(query)}`;
        const { data } = await captureWithNames<Record<string, unknown>>(url, 'search/search_user');

        const users = findArray(data, ['users', 'shops', 'list']) ?? [];
        if (!users.length) {
          return {
            content: [{ type: 'text', text: `No shops found for "${query}".` }],
          };
        }
        const lines: string[] = [`🏬 Shops for "${query}"`, ``];
        for (const u of users.slice(0, limit)) {
          const row = u as Record<string, unknown>;
          const name = String(
            row.display_name ?? row.username ?? row.shop_name ?? row.name ?? '(shop)',
          );
          const shopId = String(row.shopid ?? row.userid ?? row.id ?? '?');
          const loc = typeof row.shop_location === 'string' ? row.shop_location : '';
          const itemCount = Number(row.item_count ?? row.product_count ?? 0);
          lines.push(
            `• **${name}** #${shopId}${loc ? ` | 📍 ${loc}` : ''}${itemCount ? ` | ${itemCount.toLocaleString('id-ID')} items` : ''}`,
          );
          lines.push(`  🔗 ${BASE_URL}/shop/${shopId}`);
          const raw = JSON.stringify(row) ?? '';
          if (raw.length > 0 && lines.length <= 4) lines.push(`  ℹ️ ${truncate(raw, 200)}`);
        }
        const text = lines.join('\n');
        cache.set(cacheKey, text);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
