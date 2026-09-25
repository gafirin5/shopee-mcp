import type { Page } from 'playwright';
import { ACTION_TIMEOUT_MS } from '../../actions/base.js';
import { SELLER_PATHS } from '../urls.js';

/**
 * Selectors for the Seller Centre product LIST page — used by list/unlist.
 * Same maintenance contract as productEdit.ts: a UI drift is a one-line fix
 * guided by the failing action's debug screenshot.
 */
export const LIST_SEL = {
  /** A product row (the portal renders one card/table-row per product). */
  productRow: '[class*="product" i][class*="row" i], [class*="product-item" i], tbody tr',
  /** On/off-sale switch inside a row. */
  rowSwitch: '[class*="switch" i]',
  /** Confirm button of the portal's confirm dialog (if shown). */
  confirmButton:
    'button:has-text("Ya"), button:has-text("OK"), button:has-text("Confirm"), button:has-text("Konfirmasi")',
} as const;

/** Open the product list page. */
export async function openProductList(page: Page, query?: string): Promise<void> {
  const url = query
    ? `${SELLER_PATHS.productList}?search=${encodeURIComponent(query)}`
    : SELLER_PATHS.productList;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

/**
 * Find the row for a product id and return its on/off-sale switch locator.
 * The portal search box is unreliable to drive, so we scan rows for the id text.
 */
export async function findRowSwitch(
  page: Page,
  itemId: string,
): Promise<ReturnType<Page['locator']>> {
  const rows = page.locator(LIST_SEL.productRow);
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const text = (await row.innerText().catch(() => '')) || '';
    if (text.includes(itemId)) {
      const sw = row.locator(LIST_SEL.rowSwitch);
      if (await sw.count()) return sw.first();
    }
  }
  throw new Error(
    `Product ${itemId} not found on the list page (or its row has no switch). ` +
      'Check the debug screenshot; also make sure the product is not filtered out.',
  );
}
