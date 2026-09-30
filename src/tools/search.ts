import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ShopeeAPIError,
  ShopeeAuthRequiredError,
  SHOPEE_ANTIBOT_ERROR,
  shopeeUrl,
} from '../api/client.js';
import { captureWithNames } from '../api/capture-dom.js';
import { isLoggedIn, BASE_URL, CURRENCY } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling } from '../utils/errors.js';
import { formatPrice } from '../utils/price.js';
import type { SearchItemsResponse, SearchItem, ItemBasic, SearchResult } from '../api/types.js';

/** Normalise a legacy `item_basic` card. */
function fromItemBasic(b: ItemBasic): SearchResult {
  return {
    itemid: b.itemid,
    shopid: b.shopid,
    name: b.name,
    price: b.price,
    priceMin: b.price_min,
    priceMax: b.price_max,
    priceBeforeDiscount: b.price_before_discount,
    currency: b.currency,
    ratingStar: b.item_rating?.rating_star,
    sold: b.historical_sold || b.sold,
    shopLocation: b.shop_location,
    isOfficialShop: b.is_official_shop,
  };
}

/** Normalise a newer card-shaped result (`item_data` + `item_card_displayed_asset`). */
function fromCard(it: SearchItem): SearchResult | null {
  const d = it.item_data ?? undefined;
  const asset = it.item_card_displayed_asset ?? undefined;
  const p = d?.item_card_display_price ?? undefined;
  const price = p?.price;

  // Without a price there's nothing worth showing.
  if (!p || typeof price !== 'number') return null;

  const soldCount = d?.item_card_display_sold_count ?? undefined;
  const before = p.original_price ?? p.strikethrough_price ?? undefined;

  // On a "virtual item" card the top-level ids are a synthetic selection-model
  // placeholder that pdp/get_pc rejects (266900504); real_items holds the actual
  // listing. Display still comes from the card the user sees.
  const real = it.real_items?.[0];
  const itemid = real?.item_id ?? it.itemid ?? d?.itemid ?? 0;
  const shopid = real?.shop_id ?? it.shopid ?? d?.shopid ?? 0;
  if (!itemid || !shopid) return null;

  return {
    itemid,
    shopid,
    // The 2026 .co.id card APIs carry no product name at all — left empty so the
    // caller can fill it from the rendered tiles (see captureSearchResults).
    name: asset?.name?.trim() ?? '',
    price,
    priceBeforeDiscount: before ?? undefined,
    // Newer cards carry no currency field either — left undefined so the caller
    // falls back to the region's currency.
    currency: undefined,
    ratingStar: d?.item_rating?.rating_star,
    sold: soldCount?.historical_sold_count ?? soldCount?.monthly_sold_count ?? undefined,
    soldText:
      soldCount?.historical_sold_count_text ?? soldCount?.monthly_sold_count_text ?? undefined,
    shopLocation: asset?.shop_location ?? undefined,
    // No Shopee Mall equivalent is exposed on these cards (`shopee_verified` is a
    // different, seller-level flag), so the badge is simply omitted.
    isOfficialShop: undefined,
  };
}

/**
 * Flatten a search response into products, detecting each card's shape
 * individually rather than assuming one shape per domain — Shopee is rolling the
 * newer card format out per-market, and a single response can mix forms.
 *
 * Order matters: newer cards also carry a `real_items` array, but there it
 * describes the same product (see fromCard) rather than extra ones, so the
 * legacy fan-out is only tried once both other shapes have been ruled out.
 */
export function flattenSearchItems(items: SearchItem[] | null | undefined): SearchResult[] {
  return (items ?? []).flatMap((it) => {
    // 1. Legacy plain card.
    if (it.item_basic) return [fromItemBasic(it.item_basic)];

    // 2. Newer card shape — the product lives on the card itself.
    if (it.item_data || it.item_card_displayed_asset) {
      const card = fromCard(it);
      if (card) return [card];
    }

    // 3. Legacy recommendation/ads card nesting real products.
    if (it.real_items?.length) {
      return it.real_items
        .map((ri) => ri.item_basic)
        .filter((b): b is ItemBasic => Boolean(b))
        .map(fromItemBasic);
    }

    return [];
  });
}

function priceText(r: SearchResult, fallbackCurrency: string): string {
  const currency = r.currency || fallbackCurrency;
  if (r.priceMin && r.priceMax && r.priceMin !== r.priceMax) {
    return `${formatPrice(r.priceMin, currency)} – ${formatPrice(r.priceMax, currency)}`;
  }
  return formatPrice(r.price, currency);
}

export interface ResultListOptions {
  /** First line of the listing, e.g. `🛒 Search Results for "laptop"`. */
  title: string;
  page: number;
  limit: number;
  totalCount: number;
  nomore: boolean;
}

/**
 * Render a page of normalised results. Shared by keyword search and a shop's
 * product listing, which both come back as `search_items` payloads.
 */
export function formatResultList(items: SearchResult[], opts: ResultListOptions): string {
  const { page, limit, totalCount } = opts;
  const shown = items.slice(0, limit);
  // Estimate only: `items.length` is Shopee's per-request page size, but flattening
  // an ads card into multiple real_items (see flattenSearchItems) can inflate it
  // above that true size, undercounting totalPages. Shopee doesn't expose the real
  // page size otherwise, so this stays an approximation — it doesn't affect
  // pagination itself, only the displayed page count.
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / items.length) : page;

  const lines: string[] = [
    opts.title,
    `📊 ${totalCount.toLocaleString('id-ID')} total products | Page ${page}${totalPages > 1 ? `/${totalPages}` : ''}`,
    ``,
  ];

  shown.forEach((r, i) => {
    const rank = (page - 1) * limit + i + 1;
    const rating = r.ratingStar ? `⭐ ${r.ratingStar.toFixed(1)}` : '⭐ N/A';
    // Newer cards give a pre-formatted string ("20k+ sold"); older ones a raw count.
    const soldLabel = r.soldText
      ? r.soldText
      : r.sold
        ? `${r.sold.toLocaleString('id-ID')} sold`
        : '';
    const soldText = soldLabel ? ` | 📦 ${soldLabel}` : '';
    const official = r.isOfficialShop ? ' [Shopee Mall]' : '';
    const url = `${BASE_URL}/product/${r.shopid}/${r.itemid}`;
    // Discounted listings show the original price struck through (legacy cards
    // carry it as price_before_discount; newer ones as the display price's
    // original/strikethrough field).
    const before =
      r.priceBeforeDiscount && r.priceBeforeDiscount > r.price
        ? ` ~~${formatPrice(r.priceBeforeDiscount, r.currency || CURRENCY)}~~`
        : '';

    lines.push(`${rank}. **${r.name || `(item ${r.itemid})`}**`);
    lines.push(`   💰 ${priceText(r, CURRENCY)}${before}`);
    lines.push(
      `   ${rating}${soldText} | 🏪 ${r.shopLocation || 'N/A'}${official} | 🆔 ${r.itemid}`,
    );
    lines.push(`   🔗 ${url}`);
    if (i < shown.length - 1) lines.push('');
  });

  if (!opts.nomore) {
    lines.push(``, `📄 Use page=${page + 1} to see more results.`);
  }
  return lines.join('\n');
}

/**
 * Capture one search_items page AND the rendered product names. The 2026
 * .co.id card APIs no longer carry the product name — it only exists in the
 * rendered tiles (see captureWithNames) — so keyword and shop listings both
 * fill names from the DOM after the capture. Errors map to the same friendly
 * shapes shopeeCapture produces for the other buyer tools.
 */
export async function captureSearchResults(
  pageUrl: string,
): Promise<{ data: SearchItemsResponse; results: SearchResult[] }> {
  if (!(await isLoggedIn())) throw new ShopeeAuthRequiredError('search/search_items');

  const { data, names } = await captureWithNames<SearchItemsResponse>(
    pageUrl,
    'search/search_items',
  );
  if (data.error === SHOPEE_ANTIBOT_ERROR) {
    throw new ShopeeAuthRequiredError('search/search_items');
  }
  if (data.error !== undefined && data.error !== null && data.error !== 0) {
    throw new ShopeeAPIError(
      `Shopee API error ${data.error}${data.error_msg ? `: ${data.error_msg}` : ''}`,
      200,
      'search/search_items',
      data.error,
    );
  }

  const results = flattenSearchItems(data.items);
  for (const r of results) r.name ||= names[`${r.shopid}:${r.itemid}`] ?? '';
  return { data, results };
}

// Sort option → Shopee search-URL params.
const SORT_MAP: Record<string, { sortBy: string; order?: string }> = {
  relevance: { sortBy: 'relevancy' },
  newest: { sortBy: 'ctime' },
  top_sales: { sortBy: 'sales' },
  price_low: { sortBy: 'price', order: 'asc' },
  price_high: { sortBy: 'price', order: 'desc' },
};

export interface SearchFilters {
  /** Whole currency units, as typed into Shopee's price-range box. */
  minPrice?: number;
  maxPrice?: number;
  /** Minimum star rating, 1-5. */
  minRating?: number;
  /** Seller location as Shopee lists it under "Shipped From", e.g. "DKI Jakarta". */
  location?: string;
  officialMallOnly?: boolean;
}

/**
 * Build the /search page URL. The filters are the page's own query params —
 * Shopee's app reads them and forwards them to search_items (as price_min,
 * rating_filter, locations, official_mall), so we never craft the API call.
 */
export function buildSearchPath(
  query: string,
  page: number,
  sort: string,
  filters: SearchFilters = {},
): string {
  const { sortBy, order } = SORT_MAP[sort] ?? SORT_MAP.relevance;
  const qs = new URLSearchParams({ keyword: query, page: String(page - 1), sortBy });
  if (order) qs.set('order', order);
  if (filters.minPrice !== undefined) qs.set('minPrice', String(filters.minPrice));
  if (filters.maxPrice !== undefined) qs.set('maxPrice', String(filters.maxPrice));
  if (filters.minRating !== undefined) qs.set('ratingFilter', String(filters.minRating));
  if (filters.location) qs.set('locations', filters.location);
  if (filters.officialMallOnly) qs.set('officialMall', 'true');
  return `/search?${qs.toString()}`;
}

export function registerSearchTools(server: McpServer): void {
  server.tool(
    'search_products',
    'Search for products on Shopee by keyword, with sorting, filters (price range, minimum rating, seller location, Shopee Mall only) and pagination. ' +
      'Returns product names, prices, sold counts, ratings, seller location, product IDs, and direct URLs. ' +
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
      minPrice: z
        .number()
        .min(0)
        .optional()
        .describe('Minimum price in whole currency units, e.g. 200000 for Rp200.000'),
      maxPrice: z.number().min(0).optional().describe('Maximum price in whole currency units'),
      minRating: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('Only products rated at least this many stars (1-5)'),
      location: z
        .string()
        .optional()
        .describe('Seller location as Shopee names it, e.g. "DKI Jakarta", "Jawa Barat"'),
      officialMallOnly: z
        .boolean()
        .optional()
        .describe('Only products from Shopee Mall (official) shops'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ query, page, limit, sort, ...filters }) => {
      return withErrorHandling(async () => {
        const cacheKey = cache.key('search', query, page, limit, sort, JSON.stringify(filters));
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text', text: cached }] };

        const searchUrl = shopeeUrl(buildSearchPath(query, page, sort, filters));

        // The page fires search_items more than once and the first response can
        // be a prefill with an empty item list (verified live) — re-run until
        // items appear, bounded. Each attempt also scrapes the rendered tiles
        // for product names (the newer card APIs ship without them).
        let data: SearchItemsResponse | undefined;
        let items: SearchResult[] = [];
        for (let attempt = 0; attempt < 3 && items.length === 0; attempt++) {
          ({ data, results: items } = await captureSearchResults(searchUrl));
        }
        if (!data || items.length === 0) {
          const filtered = Object.values(filters).some((v) => v !== undefined);
          return {
            content: [
              {
                type: 'text',
                text:
                  `No products found for "${query}"` +
                  (filtered
                    ? ' with these filters. Try loosening them.'
                    : '. Try a different keyword.'),
              },
            ],
          };
        }

        const text = formatResultList(items, {
          title: `🛒 Search Results for "${query}"`,
          page,
          limit,
          totalCount: data.total_count ?? 0,
          nomore: data.nomore ?? false,
        });
        cache.set(cacheKey, text);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
