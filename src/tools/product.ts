import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shopeeCapture, shopeeUrl } from '../api/client.js';
import { BASE_URL, CURRENCY } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling, truncate } from '../utils/errors.js';
import { findVideoInfo } from '../utils/media.js';
import { formatPrice } from '../utils/price.js';
import type {
  PdpResponse,
  PdpPriceValue,
  PdpAttribute,
  PdpShipping,
  PdpShop,
} from '../api/types.js';

/** Render a PDP price value, which is either a single price or a range. */
export function priceText(p: PdpPriceValue, currency: string): string {
  if (p.range_min >= 0 && p.range_max >= 0 && p.range_min !== p.range_max) {
    return `${formatPrice(p.range_min, currency)} – ${formatPrice(p.range_max, currency)}`;
  }
  return formatPrice(p.single_value, currency);
}

/** Parse "shopId/itemId" out of a Shopee product URL, if present. */
export function parseProductUrl(url: string): { shopId: string; itemId: string } | null {
  // /product/<shopid>/<itemid>  OR  ...-i.<shopid>.<itemid>
  const m1 = url.match(/\/product\/(\d+)\/(\d+)/);
  if (m1) return { shopId: m1[1], itemId: m1[2] };
  const m2 = url.match(/-i\.(\d+)\.(\d+)/);
  if (m2) return { shopId: m2[1], itemId: m2[2] };
  return null;
}

/**
 * Resolve a product from explicit IDs or a URL. Every product-scoped tool takes
 * the same trio of optional inputs, so they share one resolver.
 */
export function resolveProductIds(
  shopId?: string,
  itemId?: string,
  url?: string,
): { shopId: string; itemId: string } | null {
  if (shopId && itemId) return { shopId, itemId };
  return url ? parseProductUrl(url) : null;
}

/**
 * Real spec rows only. Shopee mixes in synthetic rows (stock labels) with a
 * null id, and fills blank specs with "-".
 */
export function specLines(attrs: PdpAttribute[] | null | undefined, max = 12): string[] {
  return (attrs ?? [])
    .filter((a) => a.id !== null && a.id !== undefined && a.value && a.value.trim() !== '-')
    .slice(0, max)
    .map((a) => `  • ${a.name}: ${a.value}`);
}

/** Shipping origin, fee range, free-shipping threshold and the fastest delivery estimate. */
export function shippingLines(ship: PdpShipping | null | undefined, currency: string): string[] {
  if (!ship) return [];
  const lines: string[] = [];
  const from = ship.shipping_fee_info?.ship_from_location;
  if (from) lines.push(`  📍 Ships from: ${from}`);

  const fee = ship.shipping_fee_info?.price;
  if (fee) {
    // A single_value of -1 means "see the range"; a 0-0 range is free.
    if (fee.single_value >= 0)
      lines.push(`  💸 Shipping fee: ${formatPrice(fee.single_value, currency)}`);
    else if (fee.range_max > 0) lines.push(`  💸 Shipping fee: ${priceText(fee, currency)}`);
  }

  const min = ship.free_shipping?.min_spend;
  if (ship.free_shipping?.has_fss && min && min.single_value > 0) {
    lines.push(`  🚚 Free shipping on orders over ${formatPrice(min.single_value, currency)}`);
  }

  for (const ch of (ship.ungrouped_channel_infos ?? []).slice(0, 3)) {
    const edt = ch.channel_delivery_info?.edt_text;
    if (edt) lines.push(`  🕒 ${ch.name}: ${edt}`);
  }
  return lines;
}

/** One-glance seller summary from the shop block bundled with the listing. */
export function sellerLines(shop: PdpShop | null | undefined): string[] {
  if (!shop) return [];
  const badges = [
    shop.is_official_shop ? 'Shopee Mall' : '',
    shop.is_preferred_plus_seller ? 'Star+' : '',
    shop.is_shopee_verified ? 'Verified' : '',
  ].filter(Boolean);
  const stats = [
    shop.rating_star ? `⭐ ${shop.rating_star.toFixed(1)}` : '',
    shop.response_rate !== undefined ? `💬 ${shop.response_rate}% response` : '',
    shop.follower_count !== undefined
      ? `👥 ${shop.follower_count.toLocaleString('id-ID')} followers`
      : '',
  ].filter(Boolean);
  return [
    `  🏪 ${shop.name}${badges.length ? ` [${badges.join(', ')}]` : ''} — Shop ID \`${shop.shopid}\``,
    stats.length ? `  ${stats.join(' | ')}` : '',
    shop.vacation ? '  🏖 Seller is on vacation — orders may be delayed' : '',
  ].filter(Boolean);
}

export function registerProductTools(server: McpServer): void {
  server.tool(
    'get_product_detail',
    'Get details for a Shopee product: title, price (and discount), brand, condition, category, rating, stock, specs, ' +
      'shipping (origin, fee, free-shipping threshold, delivery estimate), seller summary, and description. ' +
      'Provide the numeric shopId + itemId (from search_products), or a full product URL.',
    {
      shopId: z
        .string()
        .optional()
        .describe('Numeric shop ID (from search_products URL / results)'),
      itemId: z.string().optional().describe('Numeric item/product ID (the 🆔 in search_products)'),
      url: z
        .string()
        .url()
        .optional()
        .describe('Full product URL, e.g. https://shopee.co.id/product/78730497/47060432055'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ shopId, itemId, url }) => {
      return withErrorHandling(async () => {
        const ids = resolveProductIds(shopId, itemId, url);
        if (!ids) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Please provide both `shopId` and `itemId`, or a full product `url`.',
              },
            ],
          };
        }

        const { shopId: sid, itemId: iid } = ids;
        const cacheKey = cache.key('product', sid, iid);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text', text: cached }] };

        const pageUrl = shopeeUrl(`/product/${sid}/${iid}`);
        const data = await shopeeCapture<PdpResponse>(pageUrl, 'pdp/get_pc');

        const item = data.data?.item;
        const pp = data.data?.product_price;
        if (!item || !pp) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Could not read product data. Check the shopId/itemId or URL.',
              },
            ],
          };
        }

        // Shopee omits the currency on some regions' responses; fall back to the
        // one implied by SHOPEE_DOMAIN rather than assuming Indonesia.
        const currency = item.currency || CURRENCY;
        const price = priceText(pp.price, currency);
        const before =
          pp.price_before_discount && pp.price_before_discount.single_value > pp.price.single_value
            ? pp.price_before_discount
            : undefined;
        const discountPct = before
          ? Math.round((1 - pp.price.single_value / before.single_value) * 100)
          : 0;

        const review = data.data?.product_review;
        const conditionLabel = item.condition === 1 ? 'New' : item.condition ? 'Used' : 'Unknown';
        const rating = item.item_rating?.rating_star;
        const ratingCount = review?.total_rating_count ?? review?.cmt_count ?? 0;
        const soldText =
          review?.sold_count_display ??
          review?.historical_sold_display ??
          review?.global_sold_display;
        const breadcrumb = (item.categories ?? []).map((c) => c.display_name).join(' › ');
        const stock = item.stock ?? item.normal_stock ?? undefined;
        const video = findVideoInfo(data);

        const lines: string[] = [
          `📦 **${item.title}**`,
          '',
          `💰 **Price:** ${price}${before ? ` ~~${priceText(before, currency)}~~ (-${discountPct}%)` : ''}`,
          '',
          `📊 **Stats:**`,
          `  ⭐ Rating: ${rating ? rating.toFixed(2) : 'N/A'}${ratingCount ? ` (${ratingCount.toLocaleString('id-ID')} reviews)` : ''}`,
          soldText ? `  ✅ Sold: ${soldText}` : '',
          video
            ? `  🎬 Video: ${video.url ? video.url : 'present (no direct URL in payload)'}`
            : '',
          '',
          `📋 **Details:**`,
          item.brand ? `  🏷 Brand: ${item.brand}` : '',
          `  🆕 Condition: ${conditionLabel}`,
          breadcrumb ? `  🗂 Category: ${breadcrumb}` : '',
          stock !== undefined && stock !== null
            ? `  📦 Stock: ${stock.toLocaleString('id-ID')}`
            : '',
          item.is_free_shipping ? `  🚚 Free shipping` : '',
          `  📍 Location: ${item.shop_location || 'N/A'}`,
          `  🆔 Item ID: \`${item.item_id}\` | Shop ID: \`${item.shop_id}\``,
        ].filter((l) => l !== '');

        const specs = specLines(data.data?.product_attributes?.attrs);
        if (specs.length) lines.push('', '🧾 **Specs:**', ...specs);
        const shipping = shippingLines(data.data?.product_shipping, currency);
        if (shipping.length) lines.push('', '🚚 **Shipping:**', ...shipping);
        const seller = sellerLines(data.data?.shop_detailed);
        if (seller.length) lines.push('', '🏪 **Seller:**', ...seller);
        if (item.models && item.models.length > 1) {
          lines.push(
            '',
            `🎚 ${item.models.length} variants — use get_product_variants for per-variant prices.`,
          );
        }

        if (item.description) {
          lines.push(
            '',
            '📝 **Description:**',
            truncate(item.description.replace(/\n+/g, ' ').trim(), 400),
          );
        }
        lines.push('', `🔗 ${BASE_URL}/product/${item.shop_id}/${item.item_id}`);

        const text = lines.join('\n');
        cache.set(cacheKey, text);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
