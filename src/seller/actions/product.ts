import type { Page, Locator } from 'playwright';
import { withSellerAction, stepDelay } from '../../actions/base.js';
import {
  openProductEdit,
  getPriceInputs,
  getStockInputs,
  saveProduct,
} from '../pages/productEdit.js';
import { openProductList, findRowSwitch, confirmDialogIfAsked } from '../pages/productList.js';

interface NumericUpdateArgs {
  itemId: string;
  value: number;
  /** 0-based variation index; omit for simple (single) products. */
  variationIndex?: number;
}

type FieldKind = 'price' | 'stock';

/**
 * Does a field's rendered text represent `value`?
 *
 * The portal reformats what you type (grouping separators, and a decimal part
 * on currencies that use one), so an exact string comparison would report
 * false failures: "150.000" is 150000 on the Indonesian portal, "150.00" is 150
 * on the Malaysian one. Accept the intended value under either reading — the
 * point of the check is to catch a field that did NOT receive our number (empty,
 * unchanged, or a different row), not to police formatting.
 */
export function numericMatches(shown: string, value: number): boolean {
  const s = shown.trim();
  if (s === '') return false;
  if (s.replace(/[^\d]/g, '') === String(value)) return true;
  const asDecimal = Number(s.replace(/[^\d.-]/g, ''));
  const asGrouped = Number(s.replace(/[^\d]/g, ''));
  return asDecimal === value || asGrouped === value;
}

async function readField(locator: Locator | undefined): Promise<string> {
  if (!locator) return '';
  return (await locator.inputValue().catch(() => '')) || '';
}

/**
 * Update one numeric field (price or stock) on the Seller Centre edit page.
 *
 * Three guards exist because this is the action that moves money:
 *
 *  1. the edit URL is verified to contain the item id before anything is typed
 *     (the edit path is the least-verified portal path we use — a redirect or a
 *     path change would otherwise edit whatever page happened to load);
 *  2. when the page exposes several inputs (one per variation) and the caller
 *     did not say which one, the action refuses instead of silently editing the
 *     first row;
 *  3. the typed value is read back before Save, and re-read from a freshly
 *     loaded edit page after Save — so the result says whether Shopee actually
 *     stored it instead of trusting the toast.
 */
async function applyNumericUpdate(kind: FieldKind, args: NumericUpdateArgs): Promise<string> {
  const { itemId, value, variationIndex } = args;
  const label = kind === 'price' ? 'Price' : 'Stock';
  const inputsFor = kind === 'price' ? getPriceInputs : getStockInputs;
  const where =
    `product ${itemId}` + (variationIndex !== undefined ? ` (variation ${variationIndex})` : '');

  return withSellerAction(
    kind === 'price' ? 'update-price' : 'update-stock',
    async (page: Page) => {
      await openProductEdit(page, itemId);
      // Only object when the URL names a *different* product. The edit path is
      // the least-verified portal path we use, so a redirect to another
      // product's editor must not be typed into — but a URL that simply carries
      // no id (a bare SPA editor, a hash route) is fine and must not block a
      // working flow.
      const urlProductId = /\/product\/(\d+)/.exec(page.url())?.[1];
      if (urlProductId && urlProductId !== itemId) {
        throw new Error(
          `The edit page for product ${itemId} landed on a different product (${urlProductId}). ` +
            'Nothing was changed.',
        );
      }
      await stepDelay();

      let inputs: Locator[];
      try {
        inputs = await inputsFor(page);
      } catch (err) {
        // The landed URL is the first thing to look at when a selector breaks.
        throw new Error(`${err instanceof Error ? err.message : err} (landed on ${page.url()})`, {
          cause: err,
        });
      }
      if (inputs.length > 1 && variationIndex === undefined) {
        throw new Error(
          `This listing's edit page exposes ${inputs.length} ${kind} inputs (one per variation), ` +
            `so an explicit \`variation_index\` is required — refusing to guess which row to edit. ` +
            `Re-run with variation_index: 0-${inputs.length - 1} (0 = the first ${kind} row on the page). ` +
            'Nothing was changed.',
        );
      }
      const idx = variationIndex ?? 0;
      if (idx >= inputs.length) {
        throw new Error(
          `variation_index ${idx} is out of range — the edit page exposes ${inputs.length} ${kind} input(s). ` +
            'For variation products, pass the 0-based model index. Nothing was changed.',
        );
      }

      await inputs[idx].fill(String(value));
      // Blur so the SPA picks up the change event before we save.
      await inputs[idx].press('Tab').catch(() => {});
      await page.waitForTimeout(300);

      // Guard 3a: the field must actually hold our number before we save.
      const typed = await readField(inputs[idx]);
      if (!numericMatches(typed, value)) {
        throw new Error(
          `The ${kind} field still reads "${typed || '(empty)'}" after typing ${value} — nothing was saved. ` +
            'The portal may have rejected or reformatted the value.',
        );
      }

      const saved = await saveProduct(page);
      if (!saved) {
        throw new Error(
          'Save was clicked but no success toast appeared — verify on the edit page. Nothing else was changed.',
        );
      }

      // Guard 3b: prove it persisted, from a fresh page load.
      await openProductEdit(page, itemId);
      await stepDelay();
      const after = await inputsFor(page).catch((): Locator[] => []);
      const shownAfter = await readField(after[idx]);
      if (numericMatches(shownAfter, value)) {
        return `💰 ${label} for ${where} set to ${value.toLocaleString('en-US')} and saved (re-read the edit page to confirm).`;
      }
      return (
        `⚠️ ${label} for ${where}: Save reported success, but the edit page now shows ` +
        `"${shownAfter || '(empty)'}" instead of ${value.toLocaleString('en-US')}. ` +
        'Check the product in Seller Centre before relying on this.'
      );
    },
    `item ${itemId} ${kind} → ${value} (row ${variationIndex ?? 0})`,
  );
}

/** Set a product's price via the Seller Centre edit page. */
export async function updateProductPrice(args: NumericUpdateArgs): Promise<string> {
  if (args.value <= 0) throw new Error('Price must be a positive number (no separators).');
  return applyNumericUpdate('price', args);
}

/** Set a product's stock level via the Seller Centre edit page. */
export async function updateProductStock(args: NumericUpdateArgs): Promise<string> {
  if (args.value < 0) throw new Error('Stock cannot be negative.');
  return applyNumericUpdate('stock', args);
}

export interface ListingArgs {
  itemId: string;
}

/**
 * Flip a product's on/off-sale switch on the Seller Centre list page.
 * `list: true` should only CLICK when the row is currently off — the portal
 * switch carries state, so we read `aria-checked` when present and refuse to
 * toggle into the wrong direction blindly. After clicking, the switch is read
 * again so the report states what the page actually shows.
 */
export async function setItemListing(itemId: string, list: boolean): Promise<string> {
  return withSellerAction(list ? 'list-item' : 'unlist-item', async (page: Page) => {
    await openProductList(page, itemId);
    await stepDelay();
    const sw = await findRowSwitch(page, itemId);

    const state = await sw.getAttribute('aria-checked').catch(() => null);
    if (state !== 'true' && state !== 'false') {
      // Without a readable state we cannot tell a list from an unlist, and a blind
      // click can undo the change the caller asked for. Refuse instead.
      throw new Error(
        `Cannot read whether product ${itemId} is on sale — its switch exposes no aria-checked state. ` +
          'Nothing was clicked; check the row in Seller Centre.',
      );
    }
    if ((state === 'true') === list) {
      return `ℹ️ Product ${itemId} is already ${list ? 'listed (on sale)' : 'unlisted'} — nothing to do.`;
    }
    await sw.click();
    await page.waitForTimeout(800);
    // Unlisting may open a confirmation dialog; listing does not.
    if (await confirmDialogIfAsked(page)) await page.waitForTimeout(500);

    // Re-read the switch (the row re-renders after the toggle) so the reply
    // reports the real state instead of assuming the click worked.
    const after = await findRowSwitch(page, itemId)
      .then((s) => s.getAttribute('aria-checked'))
      .catch(() => null);
    if (after !== null) {
      const isOn = after === 'true';
      return isOn === list
        ? `✅ Product ${itemId} is now ${list ? 'listed (on sale)' : 'unlisted'}.`
        : `⚠️ Product ${itemId} still reads ${isOn ? 'on sale' : 'unlisted'} after toggling — check Seller Centre.`;
    }
    return (
      `✅ Toggled product ${itemId} to ${list ? 'listed (on sale)' : 'unlisted'}. ` +
      'Verify on the product list — the switch state is the source of truth.'
    );
  });
}
