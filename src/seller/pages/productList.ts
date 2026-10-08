import type { Locator, Page } from 'playwright';
import { ACTION_TIMEOUT_MS } from '../../actions/base.js';
import { SELLER_PATHS, sellerUrl } from '../urls.js';

/**
 * Selectors for the Seller Centre product LIST page — used by list/unlist.
 * Same maintenance contract as productEdit.ts: a UI drift is a one-line fix
 * guided by the failing action's debug screenshot.
 *
 * Each entry is a single CSS selector (lists separated by commas are fine).
 * Do not chain them (`row.locator(a).locator(b)`) or use getByRole: CloakBrowser
 * runs humanized actions through a resolver that rejects both.
 */
export const LIST_SEL = {
  /** A product row (the portal renders one card/table-row per product). */
  productRow: '[class*="product" i][class*="row" i], [class*="product-item" i], tbody tr',
  /** The control that carries the on/off-sale state when the portal marks it as a switch. */
  roleSwitch: '[role="switch"]',
  /** Fallback: anything whose class names a switch — often a wrapper, not the control itself. */
  rowSwitch: '[class*="switch" i]',
  /** Buttons inside a portal dialog. Confirmation is only looked for here. */
  dialogButton:
    '[role="dialog"] button, [role="dialog"] [role="button"], [aria-modal="true"] button',
} as const;

/** Attribute used to tag the matched row, so its switch can be reached with one selector. */
const ROW_MARK = 'data-shopee-mcp-row';

/** Labels that confirm a dialog. Matched exactly — never as a substring. */
const CONFIRM_LABEL = /^(ya|yes|ok|konfirmasi|confirm)$/i;

/** Open the product list page. */
export async function openProductList(page: Page, query?: string): Promise<void> {
  const path = query
    ? `${SELLER_PATHS.productList}?search=${encodeURIComponent(query)}`
    : SELLER_PATHS.productList;
  // Must be absolute: page.goto() has no base URL in this browser context, and a
  // bare path fails with "Cannot navigate to invalid URL" before anything happens.
  await page.goto(sellerUrl(path), { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

/**
 * Regex source that matches a product id as a whole number. "777" must not match
 * the row for "7777" — a plain substring test did, and toggled the wrong product.
 * Anything that is not a plain number matches nothing rather than everything.
 */
export function idPattern(itemId: string): string | null {
  return /^\d+$/.test(itemId) ? `(?<!\\d)${itemId}(?!\\d)` : null;
}

/** Does this row's text name the product? */
export function rowNamesProduct(rowText: string, itemId: string): boolean {
  const pattern = idPattern(itemId);
  return pattern !== null && new RegExp(pattern).test(rowText);
}

/**
 * Find the row for a product id and return its on/off-sale switch locator.
 * The portal search box is unreliable to drive, so we scan rows for the id text.
 */
export async function findRowSwitch(page: Page, itemId: string): Promise<Locator> {
  const pattern = idPattern(itemId);
  // Tag the matching row inside the page, then address its switch with one CSS
  // selector — no per-row handles, no chained locators.
  const found =
    pattern !== null &&
    (await page.evaluate(
      ({ rowSel, source, mark }) => {
        document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark));
        const re = new RegExp(source);
        const row = Array.from(document.querySelectorAll(rowSel)).find((el) =>
          re.test((el as HTMLElement).innerText ?? ''),
        );
        if (!row) return false;
        row.setAttribute(mark, '1');
        return true;
      },
      { rowSel: LIST_SEL.productRow, source: pattern, mark: ROW_MARK },
    ));

  if (found) {
    // Prefer the element that carries the state. A wrapper that only has a
    // "switch" class is not the control, and reading its state tells us nothing.
    for (const sel of [LIST_SEL.roleSwitch, LIST_SEL.rowSwitch]) {
      const switches = page.locator(`[${ROW_MARK}="1"] ${sel}`);
      if (await switches.count()) return switches.first();
    }
  }
  throw new Error(
    `Product ${itemId} not found on the list page (or its row has no switch). ` +
      'Check the debug screenshot; also make sure the product is not filtered out.',
  );
}

/**
 * Click the confirm button of an open portal dialog, if one is showing.
 * Returns whether it clicked anything.
 *
 * Only buttons inside a dialog count, and only by exact label. A substring
 * match also hits "Layanan" ("ya") or "Bookmark" ("ok") in the page chrome, and
 * clicking one of those is not a confirmation.
 */
export async function confirmDialogIfAsked(page: Page): Promise<boolean> {
  const buttons = page.locator(LIST_SEL.dialogButton);
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = ((await button.innerText().catch(() => '')) || '').trim();
    if (CONFIRM_LABEL.test(label)) {
      await button.click();
      return true;
    }
  }
  return false;
}
