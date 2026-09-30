import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import { ShopeeAPIError, requireLogin, shopeeUrl } from '../api/client.js';
import { BASE_URL, captureAll, waitForCollected } from '../browser/session.js';
import type { CollectedResponse } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling, truncate } from '../utils/errors.js';
import { resolveProductIds } from './product.js';
import type { Rating, RatingSummary, RatingsResponse } from '../api/types.js';

/** Shopee's desktop product page shows this many reviews per page. */
export const REVIEWS_PER_PAGE = 6;
/** Each page is a click and a round trip; keep the call inside client timeouts. */
const MAX_PAGE = 10;

const REVIEW_FILTERS = ['all', '5', '4', '3', '2', '1', 'with_comments', 'with_media'] as const;
type ReviewFilter = (typeof REVIEW_FILTERS)[number];

const RATINGS_API = 'item/get_ratings';
const isRatings = (c: CollectedResponse): boolean => c.url.includes(RATINGS_API);

/**
 * Click one of the rating-overview filter chips ("5 star (41,7k)", "With Media", …).
 * Stars match on the leading digit and the two content filters on keywords in
 * the storefront languages we support, so it works whatever the UI language.
 */
async function clickFilter(page: Page, filter: ReviewFilter): Promise<boolean> {
  return page.evaluate((f: string) => {
    const chips = Array.from(
      document.querySelectorAll<HTMLElement>('.product-rating-overview__filter'),
    );
    // Labels are lower-cased up front: a named helper here would break under
    // tsx, whose __name wrapper doesn't exist inside the page.
    const labelled = chips.map((c) => ({ c, t: (c.textContent || '').trim().toLowerCase() }));
    let hit: { c: HTMLElement; t: string } | undefined;
    if (/^[1-5]$/.test(f)) hit = labelled.find((x) => x.t.startsWith(`${f} `));
    else if (f === 'with_comments')
      hit = labelled.find((x) => /comment|komentar|評論|评论/.test(x.t));
    else if (f === 'with_media') hit = labelled.find((x) => /media|foto|照片|相片/.test(x.t));
    const chip = hit?.c;
    if (!chip) return false;
    chip.click();
    return true;
  }, filter);
}

async function clickNextPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const next = document.querySelector<HTMLButtonElement>(
      '.product-ratings__page-controller .shopee-icon-button--right',
    );
    if (!next || next.disabled) return false;
    next.click();
    return true;
  });
}

/** "1★ 455 · 2★ 366 …" from Shopee's 1★..5★ count array. */
export function starBreakdown(summary: RatingSummary): string {
  return [5, 4, 3, 2, 1]
    .map((star) => `${star}★ ${(summary.rating_count[star - 1] ?? 0).toLocaleString('id-ID')}`)
    .join(' · ');
}

/** One review, rendered compactly. */
export function formatReview(r: Rating, index: number): string {
  const stars = '★'.repeat(r.rating_star) + '☆'.repeat(Math.max(0, 5 - r.rating_star));
  const date = new Date(r.ctime * 1000).toISOString().slice(0, 10);
  const author = r.anonymous || !r.author_username ? 'Anonymous' : r.author_username;
  const variant = r.product_items?.[0]?.model_name;
  const media = (r.images?.length ?? 0) + (r.videos?.length ?? 0);
  const meta = [
    `${stars}`,
    author,
    date,
    variant ? `variant: ${variant}` : '',
    media ? `📷 ${media}` : '',
    r.like_count ? `👍 ${r.like_count}` : '',
  ].filter(Boolean);

  const lines = [`${index}. ${meta.join(' | ')}`];
  const comment = (r.comment ?? '').replace(/\s+/g, ' ').trim();
  lines.push(`   ${comment ? truncate(comment, 350) : '(no written comment)'}`);
  const reply = r.ItemRatingReply?.comment?.replace(/\s+/g, ' ').trim();
  if (reply) lines.push(`   ↳ Seller: ${truncate(reply, 200)}`);
  return lines.join('\n');
}

export function registerReviewTools(server: McpServer): void {
  server.tool(
    'get_product_reviews',
    'Read buyer reviews for a Shopee product: the rating summary (star breakdown, reviews with media/comments) ' +
      `and a page of ${REVIEWS_PER_PAGE} reviews with star rating, variant bought, comment, and seller reply. ` +
      'Filter by star rating or to reviews with comments/media. Slower than get_product_detail — it scrolls ' +
      'the page and clicks through Shopee’s review pager.',
    {
      shopId: z.string().optional().describe('Numeric shop ID (from search_products)'),
      itemId: z.string().optional().describe('Numeric item/product ID (from search_products)'),
      url: z.string().url().optional().describe('Full product URL, as an alternative to the IDs'),
      filter: z
        .enum(REVIEW_FILTERS)
        .default('all')
        .describe('"all", a star rating "1"-"5", "with_comments", or "with_media" (default: all)'),
      page: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE)
        .default(1)
        .describe(`Review page, 1-${MAX_PAGE} (${REVIEWS_PER_PAGE} reviews each; default: 1)`),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ shopId, itemId, url, filter, page }) => {
      return withErrorHandling(async () => {
        const ids = resolveProductIds(shopId, itemId, url);
        if (!ids) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '❌ Please provide both `shopId` and `itemId`, or a full product `url`.',
              },
            ],
          };
        }

        const cacheKey = cache.key('reviews', ids.shopId, ids.itemId, filter, page);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: cached }] };

        await requireLogin();
        let reachedPage = 1;
        let filterMissing = false;
        const pageUrl = shopeeUrl(`/product/${ids.shopId}/${ids.itemId}`);
        const collected = await captureAll(pageUrl, {
          apiMatches: [RATINGS_API],
          interact: async (p, got) => {
            const count = (): number => got.filter(isRatings).length;

            // Reviews are lazy-loaded when their section scrolls into view.
            const loaded = await waitForCollected(
              got,
              () => count() > 0,
              30000,
              () => p.mouse.wheel(0, 800),
            );
            if (!loaded) return;

            if (filter !== 'all') {
              const before = count();
              if (!(await clickFilter(p, filter))) {
                filterMissing = true;
                return;
              }
              // No fresh response means the filter didn't take — don't pass off the
              // unfiltered page as filtered.
              if (!(await waitForCollected(got, () => count() > before, 12000))) {
                filterMissing = true;
                return;
              }
            }

            for (let n = 2; n <= page; n++) {
              const before = count();
              if (!(await clickNextPage(p))) break;
              if (!(await waitForCollected(got, () => count() > before, 12000))) break;
              reachedPage = n;
            }
          },
        });

        if (filterMissing) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `❌ Could not apply the "${filter}" review filter on this product (there may be no such reviews). Try filter="all".`,
              },
            ],
          };
        }

        const last = collected.filter(isRatings).at(-1)?.json as RatingsResponse | undefined;
        if (!last) {
          throw new ShopeeAPIError(
            'Reviews never loaded on the product page. Check the IDs, or retry — Shopee lazy-loads them.',
            undefined,
            RATINGS_API,
          );
        }
        if (last.error) {
          throw new ShopeeAPIError(
            `Shopee API error ${last.error}${last.error_msg ? `: ${last.error_msg}` : ''}`,
            200,
            RATINGS_API,
            last.error,
          );
        }

        const ratings = last.data?.ratings ?? [];
        const summary = last.data?.item_rating_summary;
        const lines: string[] = [`💬 **Reviews** for product \`${ids.itemId}\``];
        if (summary) {
          lines.push(
            `📊 ${summary.rating_total.toLocaleString('id-ID')} ratings | ${starBreakdown(summary)}`,
          );
          const extras = [
            summary.rcount_with_context !== undefined
              ? `${summary.rcount_with_context.toLocaleString('id-ID')} with comments`
              : '',
            summary.rcount_with_media !== undefined
              ? `${summary.rcount_with_media.toLocaleString('id-ID')} with media`
              : '',
          ].filter(Boolean);
          if (extras.length) lines.push(`   ${extras.join(' | ')}`);
        }
        lines.push(`🔎 Filter: ${filter} | Page ${reachedPage}`, '');

        if (ratings.length === 0) {
          lines.push('No reviews match this filter.');
        } else {
          ratings.forEach((r, i) => {
            lines.push(formatReview(r, (reachedPage - 1) * REVIEWS_PER_PAGE + i + 1));
            if (i < ratings.length - 1) lines.push('');
          });
        }

        if (reachedPage < page) {
          lines.push(
            '',
            `⚠️ Only reached page ${reachedPage} of the ${page} requested — no more reviews.`,
          );
        } else if (
          last.data?.has_more !== false &&
          ratings.length === REVIEWS_PER_PAGE &&
          page < MAX_PAGE
        ) {
          lines.push('', `📄 Use page=${page + 1} for more.`);
        }
        lines.push('', `🔗 ${BASE_URL}/product/${ids.shopId}/${ids.itemId}`);

        const text = lines.join('\n');
        cache.set(cacheKey, text);
        return { content: [{ type: 'text' as const, text }] };
      });
    },
  );
}
