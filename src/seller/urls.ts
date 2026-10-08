import { SELLER_BASE_URL } from '../browser/session.js';

/**
 * Seller Centre URL builders.
 *
 * Paths below were verified LIVE against the 2026 Indonesian portal by
 * extracting the sidebar menu (scripts/probe-seller3.ts): the old
 * /portal/order/list and /portal/product/list pages are 404 now.
 *
 * Known 2026 paths: orders /portal/sale/order, products
 * /portal/product/list/live/all, chat /portal/chat-management, income
 * /portal/finance/income, marketing /portal/marketing, analytics lives in a
 * separate /datacenter/ app. New shops are redirected to
 * /portal/id-onboarding/qr-code until onboarding is completed — page UI is
 * gated but the shell and its API calls still fire, which is why the capture
 * tools keep working.
 */
export function sellerUrl(pathAndQuery: string): string {
  return `${SELLER_BASE_URL}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
}

export const SELLER_PATHS = {
  /** Shell page that reliably loads the portal app (fires selleraccount APIs). */
  home: '/portal/sale/order',
  /** My Income / balance snapshot. */
  income: '/portal/finance/income',
  /** Order management (tabs are `?type=toship|shipped|completed|…`). */
  orderList: '/portal/sale/order',
  /** Product management. */
  productList: '/portal/product/list/live/all',
  /**
   * Product edit page — UNVERIFIED. It was checked against a shop with zero
   * products, so nobody has seen this URL load a real listing. If it differs,
   * update this builder after looking at the edit page once in Seller Centre.
   *
   * The write actions that use it are guarded, because a wrong path here would
   * otherwise edit the wrong listing: they abort when the landed URL names a
   * different product id, require an explicit `variation_index` when the page
   * exposes several price/stock inputs, and re-read the page after saving to
   * confirm what Shopee stored (see src/seller/actions/product.ts). A failed
   * action leaves a screenshot in ~/.shopee-mcp/debug/ showing where it landed.
   */
  productEdit: (productId: string) => `/portal/product/${productId}`,
  /** Chat management. */
  chat: '/portal/chat-management',
  /** Marketing & promotions. */
  marketing: '/portal/marketing',
  /** Business insight lives in a separate datacenter app. */
  analytics: '/datacenter/',
  /** Onboarding gate for brand-new shops. */
  onboarding: '/portal/id-onboarding/qr-code',
} as const;
