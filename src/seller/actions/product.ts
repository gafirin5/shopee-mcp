import type { Page } from 'playwright';
import { withSellerAction, stepDelay } from '../../actions/base.js';
import {
  openProductEdit,
  getPriceInputs,
  getStockInputs,
  saveProduct,
} from '../pages/productEdit.js';
import { openProductList, findRowSwitch } from '../pages/productList.js';

interface NumericUpdateArgs {
  itemId: string;
  value: number;
  /** 0-based variation index; omit for simple (single) products. */
  variationIndex?: number;
}

async function fillNumericField(
  page: Page,
  locator: { fill: (v: string) => Promise<void>; press: (key: string) => Promise<void> },
  value: number,
): Promise<void> {
  await locator.fill(String(value));
  // Blur so the SPA picks up the change event before we save.
  await locator.press('Tab').catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Update a product's price via the Seller Centre edit page.
 * One action per call; the caller sees every step in the result text.
 */
export async function updateProductPrice(args: NumericUpdateArgs): Promise<string> {
  const { itemId, value, variationIndex } = args;
  if (value <= 0) throw new Error('Price must be a positive number (no separators).');
  return withSellerAction(
    'update-price',
    async (page: Page) => {
      await openProductEdit(page, itemId);
      await stepDelay();
      const inputs = await getPriceInputs(page);
      const idx = variationIndex ?? 0;
      if (idx >= inputs.length) {
        throw new Error(
          `variation_index ${idx} is out of range — the edit page exposes ${inputs.length} price input(s). ` +
            'For variation products, pass the 0-based model index.',
        );
      }
      await fillNumericField(page, inputs[idx], value);
      const saved = await saveProduct(page);
      if (!saved) {
        throw new Error('Save clicked but no success toast appeared — verify on the edit page.');
      }
      return `💰 Price for product ${itemId}${variationIndex !== undefined ? ` (variation ${variationIndex})` : ''} set to ${value.toLocaleString('en-US')} and saved.`;
    },
    `item ${itemId} price → ${value}`,
  );
}

/** Update a product's stock via the Seller Centre edit page. */
export async function updateProductStock(args: NumericUpdateArgs): Promise<string> {
  const { itemId, value, variationIndex } = args;
  if (value < 0) throw new Error('Stock cannot be negative.');
  return withSellerAction(
    'update-stock',
    async (page: Page) => {
      await openProductEdit(page, itemId);
      await stepDelay();
      const inputs = await getStockInputs(page);
      const idx = variationIndex ?? 0;
      if (idx >= inputs.length) {
        throw new Error(
          `variation_index ${idx} is out of range — the edit page exposes ${inputs.length} stock input(s). ` +
            'For variation products, pass the 0-based model index.',
        );
      }
      await fillNumericField(page, inputs[idx], value);
      const saved = await saveProduct(page);
      if (!saved) {
        throw new Error('Save clicked but no success toast appeared — verify on the edit page.');
      }
      return `📦 Stock for product ${itemId}${variationIndex !== undefined ? ` (variation ${variationIndex})` : ''} set to ${value} and saved.`;
    },
    `item ${itemId} stock → ${value}`,
  );
}

export interface ListingArgs {
  itemId: string;
}

/**
 * Flip a product's on/off-sale switch on the Seller Centre list page.
 * `list: true` should only CLICK when the row is currently off — the portal
 * switch carries state, so we read `aria-checked` when present and refuse to
 * toggle into the wrong direction blindly.
 */
export async function setItemListing(itemId: string, list: boolean): Promise<string> {
  return withSellerAction(list ? 'list-item' : 'unlist-item', async (page: Page) => {
    await openProductList(page, itemId);
    await stepDelay();
    const sw = await findRowSwitch(page, itemId);

    const state = await sw.getAttribute('aria-checked').catch(() => null);
    if (state !== null) {
      const isOn = state === 'true';
      if (isOn === list) {
        return `ℹ️ Product ${itemId} is already ${list ? 'listed (on sale)' : 'unlisted'} — nothing to do.`;
      }
    }
    await sw.click();
    await page.waitForTimeout(800);
    // The portal may ask for confirmation on unlist.
    const confirm = page
      .locator('button:has-text("Ya"), button:has-text("OK"), button:has-text("Konfirmasi")')
      .first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await page.waitForTimeout(500);
    }
    return (
      `✅ Toggled product ${itemId} to ${list ? 'listed (on sale)' : 'unlisted'}. ` +
      'Verify on the product list — the switch state is the source of truth.'
    );
  });
}
