import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ShopeeAPIError, requireLogin, shopeeUrl } from '../api/client.js';
import { BASE_URL, CURRENCY, TIMEZONE, captureAll, waitForCollected } from '../browser/session.js';
import type { CollectedResponse } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling } from '../utils/errors.js';
import { formatPrice } from '../utils/price.js';
import type { FlashSaleItem, FlashSaleSession } from '../api/types.js';

const SESSIONS_API = 'flash_sale/get_all_sessions';
const ITEMS_API = 'flash_sale/flash_sale_batch_get_items';

interface SessionsPayload {
  data?: { sessions?: FlashSaleSession[] | null };
}
interface ItemsPayload {
  data?: { items?: FlashSaleItem[] | null };
}

/** All items across the batches the page fetched while scrolling, de-duplicated. */
export function collectFlashItems(collected: CollectedResponse[]): FlashSaleItem[] {
  const seen = new Set<string>();
  const out: FlashSaleItem[] = [];
  for (const c of collected) {
    if (!c.url.includes(ITEMS_API)) continue;
    for (const it of (c.json as ItemsPayload).data?.items ?? []) {
      const key = `${it.shopid}/${it.itemid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/** "29 Sep 18:00" in the storefront's timezone. */
export function formatTime(unixSeconds: number, timeZone: string = TIMEZONE): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSeconds * 1000));
}

/** "7 of 600 sold" — how much of the flash allocation is gone. */
export function flashStockText(it: FlashSaleItem): string {
  if (!it.flash_sale_stock || it.stock === undefined) return '';
  const sold = Math.max(0, it.flash_sale_stock - it.stock);
  return it.stock === 0
    ? '🔥 Sold out'
    : `📦 ${sold.toLocaleString('id-ID')}/${it.flash_sale_stock.toLocaleString('id-ID')} claimed`;
}

export function registerFlashSaleTools(server: McpServer): void {
  server.tool(
    'get_flash_sale',
    'Show Shopee’s current Flash Sale: the active session’s time window, upcoming sessions, and the deals — ' +
      'flash price vs. original price, discount, how much of the flash stock is claimed, and product URLs.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(20)
        .describe('Max deals to list, 1-60 (default: 20). More deals take longer to load.'),
    },
    { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    async ({ limit }) => {
      return withErrorHandling(async () => {
        const cacheKey = cache.key('flash', limit);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: cached }] };

        await requireLogin();
        // The page fetches deals in batches of ~16 as they scroll into view.
        const collected = await captureAll(shopeeUrl('/flash_sale'), {
          apiMatches: [SESSIONS_API, ITEMS_API],
          interact: async (page, got) => {
            await waitForCollected(
              got,
              (c) => collectFlashItems(c).length >= limit,
              Math.min(45000, 12000 + limit * 600),
              () => page.mouse.wheel(0, 900),
            );
          },
        });

        const sessions =
          (collected.find((c) => c.url.includes(SESSIONS_API))?.json as SessionsPayload | undefined)
            ?.data?.sessions ?? [];
        const items = collectFlashItems(collected);
        if (items.length === 0) {
          throw new ShopeeAPIError(
            'No flash-sale deals loaded. There may be no active session, or retry — Shopee lazy-loads them.',
            undefined,
            ITEMS_API,
          );
        }

        const current = sessions.find((s) => s.is_ongoing) ?? sessions[0];
        const lines: string[] = ['⚡ **Shopee Flash Sale**'];
        if (current) {
          lines.push(
            `🕒 ${current.is_ongoing ? 'Now' : 'Next'}: ${formatTime(current.start_time)} – ${formatTime(current.end_time)} (${TIMEZONE})`,
          );
        }
        const upcoming = sessions.filter(
          (s) => s !== current && s.start_time > (current?.start_time ?? 0),
        );
        if (upcoming.length) {
          lines.push(`⏭ Upcoming: ${upcoming.map((s) => formatTime(s.start_time)).join(', ')}`);
        }
        lines.push('');

        const shown = items.slice(0, limit);
        shown.forEach((it, i) => {
          const before =
            it.price_before_discount && it.price_before_discount > it.price
              ? ` ~~${formatPrice(it.price_before_discount, CURRENCY)}~~`
              : '';
          const meta = [
            it.discount ? `🏷 ${it.discount}` : '',
            flashStockText(it),
            it.item_rating?.rating_star ? `⭐ ${it.item_rating.rating_star.toFixed(1)}` : '',
            `🆔 ${it.itemid}`,
          ].filter(Boolean);
          lines.push(`${i + 1}. **${it.name}**`);
          lines.push(`   💰 ${formatPrice(it.price, CURRENCY)}${before}`);
          lines.push(`   ${meta.join(' | ')}`);
          lines.push(`   🔗 ${BASE_URL}/product/${it.shopid}/${it.itemid}`);
          if (i < shown.length - 1) lines.push('');
        });
        if (shown.length < limit) {
          lines.push('', `ℹ️ Only ${shown.length} deals loaded within the time budget.`);
        }

        const text = lines.join('\n');
        cache.set(cacheKey, text);
        return { content: [{ type: 'text' as const, text }] };
      });
    },
  );
}
