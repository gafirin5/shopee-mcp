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
   * Product edit page — UNVERIFIED (verified against a shop with zero
   * products). If the real path differs, pass an explicit edit path override
   * or update this builder after checking the edit page URL once.
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
