/**
 * EXPERIMENTAL cart tools (account mode — only offered while logged in; see
 * src/account-mode.ts).
 *
 * Every change goes through Shopee's own UI (the product page's Add to Cart,
 * the cart page's +/−/Delete) — never a hand-crafted request — and nothing here
 * ever checks out or pays.
 *
 * add_to_cart / get_cart were originally contributed in the DystopiaOwO fork.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import { requireLogin, shopeeCapture, shopeeUrl } from '../api/client.js';
import { BASE_URL, CURRENCY, captureAll, waitForCollected, withPage } from '../browser/session.js';
import type { CollectedResponse } from '../browser/session.js';
import { registerAccountTool } from '../account-mode.js';
import { withErrorHandling } from '../utils/errors.js';
import { formatPrice } from '../utils/price.js';
import { resolveProductIds } from './product.js';
import type { PdpItem, PdpModel, PdpResponse } from '../api/types.js';

// ─── get_cart ────────────────────────────────────────────────────────────────

interface CartItem {
  itemid: number;
  shopid: number;
  modelid?: number;
  name: string;
  model_name?: string | null;
  price: number;
  price_before_discount?: number | null;
  quantity: number;
  item_stock?: number | null;
  currency?: string;
}

interface CartBlock {
  shops?: Array<{ shopname?: string; shopid: number }> | null;
  items?: CartItem[] | null;
}

interface CartResponse {
  error?: number;
  error_msg?: string;
  data?: { cart_blocks?: CartBlock[] | null };
}

/** Render the cart grouped by shop, with a subtotal of the listed prices. */
export function formatCart(blocks: CartBlock[], fallbackCurrency: string): string {
  const groups = blocks.filter((b) => b.items?.length);
  if (groups.length === 0) return '🛒 Your Shopee cart is empty.';

  let count = 0;
  let subtotal = 0;
  let currency = fallbackCurrency;
  const lines: string[] = [];
  for (const b of groups) {
    lines.push(`🏪 **${b.shops?.[0]?.shopname ?? `Shop ${b.shops?.[0]?.shopid ?? '?'}`}**`);
    for (const it of b.items ?? []) {
      currency = it.currency || currency;
      count += it.quantity;
      subtotal += it.price * it.quantity;
      const variant = it.model_name ? ` (${it.model_name})` : '';
      lines.push(
        `  • ${it.name}${variant}`,
        `    ${it.quantity} × ${formatPrice(it.price, currency)}` +
          (it.modelid ? ` | model_id: \`${it.modelid}\`` : '') +
          ` | 🔗 ${BASE_URL}/product/${it.shopid}/${it.itemid}`,
      );
    }
    lines.push('');
  }
  lines.unshift(
    `🛒 **Shopee Cart** — ${count} item${count === 1 ? '' : 's'}, ${formatPrice(subtotal, currency)} before vouchers & shipping`,
    '',
  );
  return lines.join('\n').trim();
}

// ─── add_to_cart ─────────────────────────────────────────────────────────────

/** The option labels (one per tier) that select `model` on the product page. */
export function modelOptionLabels(item: PdpItem, model: PdpModel): string[] | null {
  const tiers = item.tier_variations ?? [];
  const indexes = model.extinfo?.tier_index ?? [];
  if (tiers.length === 0) return [];
  if (indexes.length !== tiers.length) return null;
  const labels = indexes.map((optionIndex, tierIndex) => tiers[tierIndex]?.options?.[optionIndex]);
  return labels.every((l): l is string => typeof l === 'string') ? labels : null;
}

/**
 * Click a variant option by its exact label. A plain DOM click, not Playwright's:
 * CloakBrowser's humanised pointer scrolls first, which throws on Shopee's
 * virtualised option list (same reason as captureWithSelections).
 */
async function clickOption(page: Page, label: string): Promise<boolean> {
  return page.evaluate((l: string) => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => (x.getAttribute('aria-label') || x.textContent || '').trim() === l,
    );
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    b.click();
    return true;
  }, label);
}

/**
 * Set the buy box quantity by clicking its "+" — the box itself is a React-owned
 * text input that ignores programmatic fills. Picking a variant re-renders the
 * box and resets it to 1, so this re-reads after every click and keeps going
 * until it shows the target; it throws rather than add a different quantity.
 */
async function setQuantity(page: Page, quantity: number): Promise<void> {
  const read = (): Promise<string | null> =>
    page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        /^(increase|tambah|增加)$/i.test((x.getAttribute('aria-label') || '').trim()),
      );
      return b?.parentElement?.querySelector('input')?.value ?? null;
    });
  let shown = await read();
  for (let attempt = 0; attempt < quantity + 5 && shown !== String(quantity); attempt++) {
    if (shown !== null && Number(shown) > quantity) break;
    const ok = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        /^(increase|tambah|增加)$/i.test((x.getAttribute('aria-label') || '').trim()),
      );
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    if (!ok) break;
    await page.waitForTimeout(350);
    shown = await read();
  }
  if (shown !== String(quantity)) {
    throw new Error(
      `Could not set the quantity to ${quantity} (the page shows ${shown ?? 'nothing'}; stock or a purchase limit may cap it). Nothing was added.`,
    );
  }
}

/**
 * Click "Add to Cart" — and only that. Matched by its label in the supported
 * storefront languages; deliberately no fallback to the solid "Buy Now" button,
 * which would head into checkout.
 */
async function clickAddToCart(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const re = /add to cart|masukkan keranjang|tambah ke keranjang|加入購物車|加入购物车/i;
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      re.test((x.getAttribute('aria-label') || x.textContent || '').trim()),
    );
    if (!b || b.disabled) return false;
    b.click();
    return true;
  });
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

// ─── cart page edits ─────────────────────────────────────────────────────────

/** Find one line in the cart payload by item and (optionally) variant. */
export function findCartItem(
  blocks: CartBlock[],
  itemId: string,
  modelId?: string,
): { matches: CartItem[]; item?: CartItem } {
  const matches = blocks
    .flatMap((b) => b.items ?? [])
    .filter(
      (it) =>
        String(it.itemid) === itemId && (modelId === undefined || String(it.modelid) === modelId),
    );
  return { matches, item: matches.length === 1 ? matches[0] : undefined };
}

/**
 * Click a control ("Increase", "Decrease", "Delete") inside one cart row. The
 * row is found from the product link (…-i.<shopid>.<itemid>) and, when an item
 * sits in the cart in several variants, the row's "Variations:<name>" label.
 */
async function clickInCartRow(page: Page, line: CartItem, control: string): Promise<boolean> {
  return page.evaluate(
    ({ shopid, itemid, variant, control }) => {
      const links = Array.from(document.querySelectorAll('a')).filter((a) =>
        (a.getAttribute('href') || '').includes(`i.${shopid}.${itemid}`),
      );
      for (const link of links) {
        let row: HTMLElement | null = link;
        for (let i = 0; i < 12 && row; i++) {
          const hasControls = Array.from(row.querySelectorAll('button')).some(
            (b) => (b.getAttribute('aria-label') || b.textContent || '').trim() === control,
          );
          if (hasControls && row.querySelector('input')) break;
          row = row.parentElement;
        }
        if (!row) continue;
        if (variant && !(row.textContent || '').includes(variant)) continue;
        const btn = Array.from(row.querySelectorAll('button')).find(
          (b) => (b.getAttribute('aria-label') || b.textContent || '').trim() === control,
        );
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      }
      return false;
    },
    { shopid: line.shopid, itemid: line.itemid, variant: line.model_name || '', control },
  );
}

/** cart/update calls that edited this item (action_type 1 = quantity, 2 = delete). */
const cartEdits = (got: CollectedResponse[], itemid: number): CollectedResponse[] =>
  got.filter(
    (c) =>
      c.url.includes('cart/update') &&
      /"action_type":[12]/.test(c.postData) &&
      c.postData.includes(`"itemid":${itemid}`),
  );

/** The largest quantity change applied in one call, one click at a time. */
const MAX_QUANTITY_STEP = 20;

export function registerCartTools(server: McpServer): void {
  const add = (tool: ReturnType<McpServer['tool']>): void => registerAccountTool(tool);

  add(
    server.tool(
      'get_cart',
      '[Experimental] Read the logged-in Shopee cart: items grouped by shop, variant, quantity, price, and model IDs. Does not modify the cart.',
      {},
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async () =>
        withErrorHandling(async () => {
          const data = await shopeeCapture<CartResponse>(shopeeUrl('/cart'), 'cart/get');
          return text(formatCart(data.data?.cart_blocks ?? [], CURRENCY));
        }),
    ),
  );

  add(
    server.tool(
      'add_to_cart',
      '[Experimental — modifies your Shopee account] Add a product (and specific variant) to the logged-in cart by ' +
        'clicking Shopee’s own "Add to Cart" button. Never checks out or pays. For multi-variant listings, ' +
        'call get_product_variants first and pass the exact modelId. Only call this when the user explicitly asks.',
      {
        shopId: z.string().optional().describe('Numeric shop ID'),
        itemId: z.string().optional().describe('Numeric item/product ID'),
        url: z.string().url().optional().describe('Full product URL, as an alternative to the IDs'),
        modelId: z
          .string()
          .optional()
          .describe(
            'Exact model_id from get_product_variants. Required when the listing has variants.',
          ),
        quantity: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(1)
          .describe('Quantity to add, 1-20 (default: 1)'),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ shopId, itemId, url, modelId, quantity }) =>
        withErrorHandling(async () => {
          const ids = resolveProductIds(shopId, itemId, url);
          if (!ids)
            return text('❌ Please provide both `shopId` and `itemId`, or a full product `url`.');

          const productUrl = shopeeUrl(`/product/${ids.shopId}/${ids.itemId}`);
          const data = await shopeeCapture<PdpResponse>(productUrl, 'pdp/get_pc');
          const item = data.data?.item;
          if (!item) return text('❌ Could not read product data. Nothing was added.');

          const models = item.models ?? [];
          let model: PdpModel | undefined;
          if (modelId) {
            model = models.find((m) => String(m.model_id) === modelId);
            if (!model) {
              return text(
                `❌ model_id ${modelId} is not a variant of this listing. Call get_product_variants for valid IDs. Nothing was added.`,
              );
            }
          } else if (models.length > 1) {
            return text(
              `❌ This listing has ${models.length} variants — call get_product_variants and pass the exact \`modelId\`. Nothing was added.`,
            );
          } else {
            model = models[0];
          }
          if (model?.has_stock === false) {
            return text(`❌ "${model.name}" is out of stock. Nothing was added.`);
          }

          const labels = model ? modelOptionLabels(item, model) : [];
          if (labels === null) {
            return text('❌ Could not map this variant to the page’s options. Nothing was added.');
          }

          const result = await withPage(async (page) => {
            await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            // Wait for the buy box to render before touching it.
            await page
              .waitForFunction(
                () =>
                  Array.from(document.querySelectorAll('button')).some((b) =>
                    /add to cart|masukkan keranjang|tambah ke keranjang|加入購物車|加入购物车/i.test(
                      b.getAttribute('aria-label') || b.textContent || '',
                    ),
                  ),
                undefined,
                { timeout: 30000 },
              )
              .catch(() => undefined);

            // Clicks before the page hydrates are silently dropped, so each option
            // must be confirmed by the select_variation_pc request it fires; one
            // retry covers a click that landed too early.
            await page.waitForTimeout(1500);
            for (const label of labels) {
              let selected = false;
              for (let attempt = 0; attempt < 2 && !selected; attempt++) {
                const fired = page
                  .waitForResponse((r) => r.url().includes('cart_panel/select_variation_pc'), {
                    timeout: 6000,
                  })
                  .then(() => true)
                  .catch(() => false);
                if (!(await clickOption(page, label))) {
                  fired.catch(() => undefined);
                  throw new Error(
                    `Could not select the "${label}" option on the page. Nothing was added.`,
                  );
                }
                selected = await fired;
                if (!selected) await page.waitForTimeout(1500);
              }
              if (!selected) {
                throw new Error(
                  `Shopee did not register the "${label}" option. Nothing was added.`,
                );
              }
            }
            // Let the variant's own request land and re-render the buy box first.
            await page.waitForTimeout(1200);
            await setQuantity(page, quantity);

            const response = page.waitForResponse(
              (r) =>
                r.url().includes('/api/v4/cart/add_to_cart') && r.request().method() === 'POST',
              { timeout: 15000 },
            );
            if (!(await clickAddToCart(page))) {
              response.catch(() => undefined);
              throw new Error('Could not find an enabled "Add to Cart" button. Nothing was added.');
            }
            const r = await response;
            return {
              ...((await r.json()) as { error?: number; error_msg?: string }),
              sent: r.request().postData() ?? '',
            };
          });

          if (result.error) {
            return text(
              `❌ Shopee rejected the cart update: ${result.error_msg || `error ${result.error}`}`,
            );
          }
          // Belt and braces: confirm the page sent the variant we meant.
          const sentModel = /"modelid":(\d+)/.exec(result.sent)?.[1];
          const variantNote =
            model && sentModel && sentModel !== String(model.model_id)
              ? `\n⚠️ Shopee recorded model_id ${sentModel}, not ${model.model_id} — check your cart.`
              : '';
          const price = model?.price ?? data.data?.product_price.price.single_value;
          return text(
            [
              '✅ Added to your Shopee cart.',
              `📦 ${item.title}${model?.name ? ` (${model.name})` : ''}`,
              `🔢 Quantity: ${quantity}${price !== undefined ? ` × ${formatPrice(price, item.currency || CURRENCY)}` : ''}`,
              `🔗 ${BASE_URL}/product/${ids.shopId}/${ids.itemId}`,
              '',
              'No checkout or payment was performed.',
            ].join('\n') + variantNote,
          );
        }),
    ),
  );

  add(
    server.tool(
      'update_cart_item',
      '[Experimental — modifies your Shopee account] Change the quantity of an item already in the cart, ' +
        'or remove it with quantity=0, using the cart page’s own +/−/Delete controls. Get itemId and modelId ' +
        'from get_cart. Only call this when the user explicitly asks.',
      {
        itemId: z.string().min(1).describe('Numeric item ID of the cart line (from get_cart)'),
        modelId: z
          .string()
          .optional()
          .describe(
            'model_id of the cart line (from get_cart). Required when the item is in the cart in several variants.',
          ),
        quantity: z
          .number()
          .int()
          .min(0)
          .max(999)
          .describe(
            `New quantity; 0 removes the line. Changes by at most ${MAX_QUANTITY_STEP} per call.`,
          ),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ itemId, modelId, quantity }) =>
        withErrorHandling(async () => {
          await requireLogin();
          let outcome: string | undefined;
          let line: CartItem | undefined;
          let applied = 0;

          await captureAll(shopeeUrl('/cart'), {
            apiMatches: ['cart/get', 'cart/update'],
            interact: async (page, got) => {
              const loaded = await waitForCollected(
                got,
                (c) => c.some((x) => x.url.includes('cart/get')),
                30000,
              );
              const cart = got.find((x) => x.url.includes('cart/get'))?.json as
                CartResponse | undefined;
              if (!loaded || !cart) {
                outcome = '❌ The cart did not load. Nothing was changed.';
                return;
              }
              const { matches, item } = findCartItem(cart.data?.cart_blocks ?? [], itemId, modelId);
              if (matches.length === 0) {
                outcome = `❌ Item ${itemId}${modelId ? ` (model_id ${modelId})` : ''} is not in your cart. Nothing was changed.`;
                return;
              }
              if (!item) {
                outcome = `❌ Item ${itemId} is in your cart in ${matches.length} variants — pass the exact \`modelId\` from get_cart. Nothing was changed.`;
                return;
              }
              line = item;
              // Give React a moment to paint the rows the payload describes.
              await page.waitForTimeout(1500);

              const diff = quantity - item.quantity;
              if (quantity === 0) {
                if (!(await clickInCartRow(page, item, 'Delete'))) {
                  outcome = '❌ Could not find this line’s Delete button. Nothing was changed.';
                  return;
                }
                await waitForCollected(got, (c) => cartEdits(c, item.itemid).length > 0, 12000);
                applied = cartEdits(got, item.itemid).length;
                return;
              }
              if (diff === 0) {
                outcome = `ℹ️ Quantity is already ${quantity}. Nothing was changed.`;
                return;
              }
              if (Math.abs(diff) > MAX_QUANTITY_STEP) {
                outcome = `❌ That changes the quantity by ${Math.abs(diff)}; the limit is ${MAX_QUANTITY_STEP} per call. Nothing was changed.`;
                return;
              }
              for (let n = 0; n < Math.abs(diff); n++) {
                const before = cartEdits(got, item.itemid).length;
                if (!(await clickInCartRow(page, item, diff > 0 ? 'Increase' : 'Decrease'))) break;
                if (
                  !(await waitForCollected(
                    got,
                    (c) => cartEdits(c, item.itemid).length > before,
                    12000,
                  ))
                )
                  break;
              }
              applied = cartEdits(got, item.itemid).length;
            },
          });

          if (outcome) return text(outcome);
          if (!line) return text('❌ Nothing was changed.');
          const name = `${line.name}${line.model_name ? ` (${line.model_name})` : ''}`;
          if (quantity === 0) {
            return text(
              applied
                ? `🗑 Removed from your cart: ${name}`
                : `❌ Shopee did not confirm removing ${name}.`,
            );
          }
          const target = Math.abs(quantity - line.quantity);
          const reached = line.quantity + Math.sign(quantity - line.quantity) * applied;
          return text(
            applied === target
              ? `✅ ${name}: quantity ${line.quantity} → ${quantity}`
              : `⚠️ ${name}: only reached quantity ${reached} of ${quantity} (stock or a purchase limit may cap it).`,
          );
        }),
    ),
  );
}
