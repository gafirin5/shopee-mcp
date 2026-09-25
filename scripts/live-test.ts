/**
 * Live end-to-end test against real Shopee, using the same capture paths the
 * MCP tools use. Requires a logged-in session (npm run login / login:seller).
 *
 *   npx tsx scripts/live-test.ts
 */
import 'dotenv/config';
import { shopeeCapture, shopeeUrl } from '../src/api/client.js';
import { sellerCapture } from '../src/seller/capture.js';
import { portalApi } from '../src/seller/api.js';
import { SELLER_PATHS } from '../src/seller/urls.js';
import { flattenSearchCards, formatPrice } from '../src/tools/search.js';
import { isLoggedIn, isSellerLoggedIn, closeContext } from '../src/browser/session.js';
import { findVideoInfo } from '../src/utils/media.js';
import type { SearchItemsResponse } from '../src/api/types.js';

function ok(label: string, detail: string): void {
  console.log(`✅ ${label}: ${detail}`);
}
function fail(label: string, err: unknown): void {
  console.log(`❌ ${label}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
}

async function main(): Promise<void> {
  console.log('Session check…');
  ok('buyer login', String(await isLoggedIn().catch((e) => `ERR ${e.message}`)));
  ok('seller portal', String(await isSellerLoggedIn().catch((e) => `ERR ${e.message}`)));

  // ── 1. Buyer: keyword search with empty-capture retry (same as the tool) ──
  let first: ReturnType<typeof flattenSearchCards>[number] | undefined;
  try {
    let hits: ReturnType<typeof flattenSearchCards> = [];
    let totalCount = 0;
    for (let attempt = 0; attempt < 3 && hits.length === 0; attempt++) {
      const data = await shopeeCapture<SearchItemsResponse>(
        shopeeUrl('/search?keyword=kaos%20polos&page=0'),
        'search/search_items',
      );
      totalCount = data.total_count ?? 0;
      hits = flattenSearchCards(data.items as never);
    }
    first = hits[0];
    ok(
      'search_products',
      `${totalCount} total | first: ${first?.itemid ?? '?'} @ ${first ? formatPrice(first.price, 'IDR') : '?'} | name via DOM: ${first?.name ? 'yes' : 'not in this script'}`,
    );
  } catch (e) {
    fail('search_products', e);
  }

  // ── 2. Buyer: product detail + video detection (same as check_product_video) ──
  try {
    if (!first) throw new Error('no search result to open');
    const pdp = await shopeeCapture<Record<string, unknown>>(
      shopeeUrl(`/product/${first.shopid}/${first.itemid}`),
      'pdp/get_pc',
    );
    const video = findVideoInfo(pdp);
    ok(
      'get_product_detail',
      `${((pdp.name as string) ?? '').slice(0, 40)} | video: ${video ? `YES (${video.foundAt})` : 'none'}`,
    );
  } catch (e) {
    fail('get_product_detail', e);
  }

  // ── 3. Seller: shop info via direct portal API (same as get_seller_shop_info) ──
  try {
    const json = await portalApi<Record<string, unknown>>('/api/selleraccount/shop_info/');
    const data = json.data as { name?: string; shop_id?: number; shop_region?: string } | undefined;
    ok(
      'get_seller_shop_info',
      `${data?.name ?? '?'} (id ${data?.shop_id ?? '?'}, region ${data?.shop_region ?? '?'})`,
    );
  } catch (e) {
    fail('get_seller_shop_info', e);
  }

  // ── 4. Seller: product list via direct portal API (same as list_seller_products) ──
  try {
    const json = await portalApi<Record<string, unknown>>(
      '/api/v3/opt/mpsku/list/v2/get_product_list?page_number=1&page_size=10',
    );
    const data = json.data as { page_info?: { total?: number } } | undefined;
    ok('list_seller_products', `total=${data?.page_info?.total ?? '?'}`);
  } catch (e) {
    fail('list_seller_products', e);
  }

  // ── 5. Seller: order list capture (same as list_orders) ──
  try {
    const json = await sellerCapture<Record<string, unknown>>(SELLER_PATHS.orderList, [
      '/order/search_order_list_index',
      '/order/get_order_list_meta_v2',
    ]);
    const data = json.data as { pagination?: { total?: number } } | undefined;
    ok('list_orders', `total=${data?.pagination?.total ?? '?'}`);
  } catch (e) {
    fail('list_orders', e);
  }

  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('live-test failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
