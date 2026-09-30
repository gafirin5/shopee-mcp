import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shopeeCapture, shopeeUrl } from '../api/client.js';
import { captureWithNames } from '../api/capture-dom.js';
import { BASE_URL, captureJson } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling, truncate } from '../utils/errors.js';
import { captureSearchResults, formatResultList } from './search.js';
import { findArray } from './seller/format.js';
import type { ShopBase, ShopBaseResponse } from '../api/types.js';

/** Parse a shop reference: numeric id, a /shop/<id> URL, or a product URL slug. */
export function parseShopRef(ref: string): string | null {
  const value = ref.trim();
  if (/^\d+$/.test(value)) return value;
  const shopUrl = value.match(/\/shop\/(\d+)/);
  if (shopUrl) return shopUrl[1];
  const slug = value.match(/-i\.(\d+)\.\d+/);
  if (slug) return slug[1];
  return null;
}

/** Shop listing sort → the shop search page's params (note "pop", not "relevancy"). */
const SHOP_SORT_MAP: Record<string, { sortBy: string; order?: string }> = {
  popular: { sortBy: 'pop' },
  newest: { sortBy: 'ctime' },
  top_sales: { sortBy: 'sales' },
  price_low: { sortBy: 'price', order: 'asc' },
  price_high: { sortBy: 'price', order: 'desc' },
};

/** "2h", "3 days" — Shopee reports response time in seconds. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Render a shop profile. `now` is injectable so tests are deterministic. */
export function formatShop(s: ShopBase, now: number = Date.now()): string {
  const badges = [
    s.is_official_shop ? 'Shopee Mall' : '',
    s.is_preferred_plus_seller ? 'Star+' : '',
    s.is_shopee_verified ? 'Verified' : '',
  ].filter(Boolean);
  const username = s.account?.username;
  const lines = [
    `🏪 **${s.name}**${badges.length ? ` [${badges.join(', ')}]` : ''}`,
    username ? `👤 @${username}` : '',
    '',
    `📊 **Stats:**`,
    s.rating_star ? `  ⭐ Shop rating: ${s.rating_star.toFixed(2)}` : '',
    s.item_count !== undefined ? `  📦 Products: ${s.item_count.toLocaleString('id-ID')}` : '',
    s.follower_count !== undefined
      ? `  👥 Followers: ${s.follower_count.toLocaleString('id-ID')}`
      : '',
    s.response_rate !== undefined
      ? `  💬 Chat response: ${s.response_rate}%${s.response_time ? ` (within ~${formatDuration(s.response_time)})` : ''}`
      : '',
    s.ctime ? `  📅 Joined: ${new Date(s.ctime * 1000).toISOString().slice(0, 10)}` : '',
    s.last_active_time
      ? `  🕒 Last active: ${formatDuration(Math.max(0, now / 1000 - s.last_active_time))} ago`
      : '',
    s.vacation ? '  🏖 On vacation — orders may be delayed' : '',
    `  🆔 Shop ID: \`${s.shopid}\``,
  ];
  const desc = s.description?.replace(/\s+/g, ' ').trim();
  if (desc) lines.push('', '📝 **About:**', truncate(desc, 400));
  lines.push(
    '',
    `🔗 ${BASE_URL}/${username ?? `shop/${s.shopid}`}`,
    '💡 Use get_shop_products to browse this shop’s listings.',
  );
  // Drop empty rows, but keep the intentional blank separators.
  return lines.filter((l, i) => l !== '' || (i > 0 && lines[i - 1] !== '')).join('\n');
}

export function registerShopTools(server: McpServer): void {
  server.tool(
    'get_shop_info',
    'Get a Shopee seller’s profile: name, Shopee Mall / Star+ / verified badges, shop rating, product and follower ' +
      'counts, chat response rate and time, join date, last active, vacation status, and description. ' +
      'Takes the numeric shopId (shown by search_products / get_product_detail) or the shop’s username.',
    {
      shopId: z.string().optional().describe('Numeric shop ID'),
      username: z
        .string()
        .optional()
        .describe('Shop username — the part after the domain in the shop URL'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ shopId, username }) => {
      return withErrorHandling(async () => {
        const handle = username?.replace(/^@/, '').trim();
        if (!shopId && !handle) {
          return {
            content: [
              { type: 'text' as const, text: '❌ Please provide a `shopId` or a shop `username`.' },
            ],
          };
        }

        const cacheKey = cache.key('shop', shopId ?? `@${handle}`);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: cached }] };

        const path = shopId ? `/shop/${shopId}` : `/${encodeURIComponent(handle!)}`;
        // Shop profiles are the one read Shopee still serves anonymously, so skip
        // the signed-out fast-fail: this works in read-only mode without a login.
        const data = await shopeeCapture<ShopBaseResponse>(
          shopeeUrl(path),
          'shop/get_shop_base_v2',
          undefined,
          false,
          captureJson,
          async () => true,
        );
        if (!data.data?.shopid) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '❌ Could not read shop data. Check the shopId or username.',
              },
            ],
          };
        }

        const text = formatShop(data.data);
        cache.set(cacheKey, text);
        return { content: [{ type: 'text' as const, text }] };
      });
    },
  );

  server.tool(
    'get_shop_products',
    'List the products a Shopee shop sells, with sorting and pagination — names, prices, sold counts, ratings, ' +
      'product IDs, and URLs. Use it to browse one seller’s catalogue after search_products or get_shop_info.',
    {
      shopId: z
        .string()
        .min(1)
        .describe('Numeric shop ID, a /shop/<id> URL, or any product URL of that shop'),
      page: z.number().int().min(1).default(1).describe('Page number (default: 1)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(20)
        .describe('Max results to show from the page, 1-60 (default: 20)'),
      sort: z
        .enum(['popular', 'newest', 'top_sales', 'price_low', 'price_high'])
        .default('popular')
        .describe('Sort order (default: popular)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ shopId: rawRef, page, limit, sort }) => {
      return withErrorHandling(async () => {
        // Accept a bare numeric id, a /shop/<id> URL, or a product URL — its
        // -i.<shopid>.<itemid> slug carries the shop id.
        const shopId = parseShopRef(rawRef) ?? rawRef.trim();
        const cacheKey = cache.key('shop-products', shopId, page, limit, sort);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: cached }] };

        // /shop/<id>/search redirects here; going direct saves a hop.
        const { sortBy, order } = SHOP_SORT_MAP[sort] ?? SHOP_SORT_MAP.popular;
        const qs = new URLSearchParams({ shop: shopId, page: String(page - 1), sortBy });
        if (order) qs.set('order', order);
        // captureSearchResults (not shopeeCapture) because the 2026 .co.id card
        // APIs carry no product names — it fills them from the rendered tiles,
        // same as keyword search.
        const { data, results: items } = await captureSearchResults(
          shopeeUrl(`/search?${qs.toString()}`),
        );

        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No products found for shop \`${shopId}\`${page > 1 ? ` on page ${page}` : ''}.`,
              },
            ],
          };
        }

        const text = formatResultList(items, {
          title: `🏪 Products from shop \`${shopId}\``,
          page,
          limit,
          totalCount: data.total_count ?? 0,
          nomore: data.nomore,
        });
        cache.set(cacheKey, text);
        return { content: [{ type: 'text' as const, text }] };
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
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ query, limit }) => {
      return withErrorHandling(async () => {
        const cacheKey = cache.key('search-shops', query, limit);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: cached }] };

        const url = `${BASE_URL}/search_user?keyword=${encodeURIComponent(query)}`;
        const { data } = await captureWithNames<Record<string, unknown>>(url, 'search/search_user');

        const users = findArray(data, ['users', 'shops', 'list']) ?? [];
        if (!users.length) {
          return {
            content: [{ type: 'text' as const, text: `No shops found for "${query}".` }],
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
        return { content: [{ type: 'text' as const, text }] };
      });
    },
  );
}
