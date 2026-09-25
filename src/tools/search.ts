import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withBrowserLock, BASE_URL } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling } from '../utils/errors.js';
import type { SearchItemsResponse, SearchItem, ItemBasic } from '../api/types.js';

/** A product card as the 2026 search page ships it: item_basic (legacy) OR item_data. */
type SearchCard = SearchItem & {
  item_data?: {
    itemid?: number;
    shopid?: number;
    item_card_display_price?: { price?: number; strikethrough_price?: number; discount?: number };
    item_card_display_sold_count?: {
      historical_sold_count?: number;
      monthly_sold_count?: number;
    };
    item_rating?: { rating_star?: number };
    shop_data?: { shop_name?: string };
  };
};

/**
 * Normalized search result — the union of the legacy `item_basic` fields and
 * whatever the new `item_data` card can provide. `name` may be empty: the
 * 2026 card shape carries no product name at all, so the tool fills it from
 * the rendered DOM (see collectSearchNames).
 */
export interface SearchHit {
  name: string;
  itemid: number;
  shopid: number;
  price: number;
  priceBefore: number;
  sold: number;
  ratingStar?: number;
  isOfficialShop: boolean;
  shopLocation?: string;
}

/**
 * Flatten one search card into hits. Handles the legacy `item_basic` shape,
 * the 2026 `item_data` shape (name-less; price/sold moved into display
 * sub-objects — verified live), and recommendation/ads cards that nest real
 * products under `real_items`. Cards with neither shape are dropped.
 */
export function normalizeSearchCard(card: SearchCard | null | undefined): SearchHit[] {
  if (!card) return [];
  const b = card.item_basic;
  if (b) {
    return [
      {
        name: b.name,
        itemid: b.itemid,
        shopid: b.shopid,
        price: b.price,
        priceBefore: b.price_before_discount ?? 0,
        sold: b.historical_sold || b.sold || 0,
        ratingStar: b.item_rating?.rating_star || undefined,
        isOfficialShop: !!b.is_official_shop,
        shopLocation: b.shop_location,
      },
    ];
  }
  if (card.real_items?.length) {
    return card.real_items.flatMap((ri) => normalizeSearchCard(ri as SearchCard));
  }
  const d = card.item_data;
  if (d?.itemid && d.shopid) {
    const dp = d.item_card_display_price ?? {};
    const sc = d.item_card_display_sold_count ?? {};
    return [
      {
        name: '',
        itemid: d.itemid,
        shopid: d.shopid,
        price: dp.price ?? 0,
        priceBefore: dp.strikethrough_price ?? 0,
        sold: sc.historical_sold_count || sc.monthly_sold_count || 0,
        ratingStar: d.item_rating?.rating_star || undefined,
        isOfficialShop: false,
        shopLocation: d.shop_data?.shop_name,
      },
    ];
  }
  return [];
}

export function flattenSearchCards(items: SearchCard[] | null | undefined): SearchHit[] {
  return (items ?? []).flatMap((it) => normalizeSearchCard(it));
}

/** Legacy helper kept for compatibility: raw item_basic pass-through. */
export function flattenSearchItems(items: SearchItem[] | null | undefined): ItemBasic[] {
  return (items ?? []).flatMap((it) => {
    if (it.item_basic) return [it.item_basic];
    if (it.real_items?.length) return it.real_items.map((ri) => ri.item_basic).filter(Boolean);
    return [];
  });
}

// Shopee stores prices as the real amount × 100000.
export function formatPrice(raw: number, currency = 'IDR'): string {
  const amount = raw / 100000;
  if (currency === 'IDR') return `Rp${Math.round(amount).toLocaleString('id-ID')}`;
  return `${currency} ${amount.toLocaleString('id-ID')}`;
}

function priceText(h: SearchHit): string {
  if (h.priceBefore > h.price && h.price > 0) {
    return `${formatPrice(h.price)} ~~${formatPrice(h.priceBefore)}~~`;
  }
  return formatPrice(h.price);
}

// Sort option → Shopee search-URL params.
const SORT_MAP: Record<string, { sortBy: string; order?: string }> = {
  relevance: { sortBy: 'relevancy' },
  newest: { sortBy: 'ctime' },
  top_sales: { sortBy: 'sales' },
  price_low: { sortBy: 'price', order: 'asc' },
  price_high: { sortBy: 'price', order: 'desc' },
};

/**
 * Run one search: capture the `search_items` response AND the rendered product
 * names from the page DOM (matched by `shopid:itemid` from tile hrefs — the
 * 2026 card API no longer carries the product name). One lock round-trip.
 */
async function searchOnce(
  searchUrl: string,
): Promise<{ data: SearchItemsResponse; names: Record<string, string> }> {
  return withBrowserLock(async () => {
    const { getPageFor } = await import('../browser/session.js');
    const page = await getPageFor('buyer');

    const result = await new Promise<{ json: SearchItemsResponse; matchedUrl: string }>(
      (resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          page.off('response', handler);
          fn();
        };
        const timer = setTimeout(
          () =>
            finish(() => reject(new Error('Timeout 30000ms exceeded waiting for search_items'))),
          30000,
        );
        const handler = (r: { url(): string; text(): Promise<string> }): void => {
          if (!r.url().includes('/api/v4/search/search_items')) return;
          void r
            .text()
            .then((text) => {
              try {
                finish(() => resolve({ json: JSON.parse(text), matchedUrl: r.url() }));
              } catch {
                /* keep listening */
              }
            })
            .catch(() => {});
        };
        page.on('response', handler);
        page
          .goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
          .catch((err) => finish(() => reject(err)));
      },
    );

    // The names only exist in the rendered tiles — the API response arrives
    // BEFORE the DOM paints, so wait for a product link to appear first.
    await page
      .waitForSelector('a[href*="/product/"], a[href*="-i."]', { timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(800);

    const names = await page
      .evaluate(() => {
        const map: Record<string, string> = {};
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = a.getAttribute('href') ?? '';
          const m = href.match(/-i\.(\d+)\.(\d+)/) ?? href.match(/\/product\/(\d+)\/(\d+)/);
          if (!m) continue;
          const key = `${m[1]}:${m[2]}`;
          if (map[key]) continue;
          const alt = a.querySelector('img')?.getAttribute('alt')?.trim() ?? '';
          const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
          const name = alt.length >= 8 ? alt : text.length >= 8 ? text : '';
          if (name) map[key] = name.slice(0, 200);
        }
        return map;
      })
      .catch(() => ({}) as Record<string, string>);

    return { data: result.json, names };
  });
}

export function registerSearchTools(server: McpServer): void {
  server.tool(
    'search_products',
    'Search for products on Shopee by keyword, with sorting and pagination. ' +
      'Returns product names, prices, sold counts, ratings, seller, product IDs, and direct URLs. ' +
      'Requires a one-time login (run `npm run login`) because Shopee blocks anonymous requests.',
    {
      query: z.string().min(1).describe('The search query, e.g. "laptop gaming", "sepatu nike"'),
      page: z.number().int().min(1).default(1).describe('Page number (default: 1)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(20)
        .describe('Max results to show from the page, 1-60 (default: 20)'),
      sort: z
        .enum(['relevance', 'newest', 'top_sales', 'price_low', 'price_high'])
        .default('relevance')
        .describe('Sort order (default: relevance)'),
    },
    async ({ query, page, limit, sort }) => {
      return withErrorHandling(async () => {
        const cacheKey = cache.key('search', query, page, limit, sort);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text', text: cached }] };

        const { sortBy, order } = SORT_MAP[sort] ?? SORT_MAP.relevance;
        const qs = new URLSearchParams({ keyword: query, page: String(page - 1), sortBy });
        if (order) qs.set('order', order);
        const searchUrl = `${BASE_URL}/search?${qs.toString()}`;

        // The page fires search_items more than once and the first response can
        // be a prefill with an empty item list (verified live) — re-run until
        // items appear, bounded.
        let data: SearchItemsResponse | undefined;
        let hits: SearchHit[] = [];
        let names: Record<string, string> | undefined;
        for (let attempt = 0; attempt < 3 && hits.length === 0; attempt++) {
          const run = await searchOnce(searchUrl);
          data = run.data;
          names = run.names;
          hits = flattenSearchCards(data.items as SearchCard[]);
          for (const h of hits) h.name ||= names?.[`${h.shopid}:${h.itemid}`] ?? '';
        }
        if (!data || hits.length === 0) {
          return {
            content: [
              { type: 'text', text: `No products found for "${query}". Try a different keyword.` },
            ],
          };
        }

        const shown = hits.slice(0, limit);
        const totalCount = data.total_count ?? 0;
        const totalPages = totalCount > 0 ? Math.ceil(totalCount / hits.length) : page;

        const lines: string[] = [
          `🛒 Search Results for "${query}"`,
          `📊 ${totalCount.toLocaleString('id-ID')} total products | Page ${page}${totalPages > 1 ? `/${totalPages}` : ''}`,
          ``,
        ];

        shown.forEach((h, i) => {
          const rank = (page - 1) * limit + i + 1;
          const rating = h.ratingStar ? `⭐ ${h.ratingStar.toFixed(1)}` : '⭐ N/A';
          const soldText = h.sold > 0 ? ` | 📦 ${h.sold.toLocaleString('id-ID')} sold` : '';
          const official = h.isOfficialShop ? ' [Shopee Mall]' : '';
          const title = h.name || `(item ${h.itemid})`;
          const url = `${BASE_URL}/product/${h.shopid}/${h.itemid}`;

          lines.push(`${rank}. **${title}**`);
          lines.push(`   💰 ${priceText(h)}`);
          lines.push(`   ${rating}${soldText} | 🏪 ${h.shopLocation || 'N/A'}${official}`);
          lines.push(`   🔗 ${url}`);
          if (i < shown.length - 1) lines.push('');
        });

        if (!data.nomore) {
          lines.push(``, `📄 Use page=${page + 1} to see more results.`);
        }

        const text = lines.join('\n');
        cache.set(cacheKey, text);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
