import { SELLER_BASE_URL } from '../browser/session.js';

/**
 * Seller Centre URL builders.
 *
 * Shopee rotates portal paths between regions/UI generations more often than it
 * rotates the marketplace. These constants are best-guess defaults for the
 * current Indonesian Seller Centre; every tool that navigates accepts an
 * explicit `path` override, and `seller_api_probe` exists to discover what the
 * live portal actually uses when a default drifts.
 */
export function sellerUrl(pathAndQuery: string): string {
  return `${SELLER_BASE_URL}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
}

export const SELLER_PATHS = {
  /** Portal landing — also our seller-login probe target. */
  home: '/portal/',
  /** My Income / balance snapshot. */
  income: '/portal/income',
  /** Order management. */
  orderList: '/portal/order/list',
  orderToShip: '/portal/order/list?list_type=to_ship',
  /** Product management. */
  productList: '/portal/product/list',
  productDraft: '/portal/product/list/draft',
  /** Product edit page (new portal uses /portal/product/<id>). */
  productEdit: (productId: string) => `/portal/product/${productId}`,
  /** Chat / conversations. */
  chat: '/portal/chat',
  /** Marketing & promotions. */
  marketing: '/portal/marketing',
  /** Shop performance / analytics dashboard. */
  analytics: '/portal/data/homepage',
} as const;
