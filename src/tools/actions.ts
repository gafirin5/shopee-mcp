/**
 * EXPERIMENTAL account actions (account mode — only offered while logged in;
 * see src/account-mode.ts): like a product, follow a shop, claim a shop voucher.
 *
 * Each one reads the current state from the page's own payload first and only
 * clicks when a change is needed, so repeating a call is harmless. Every click
 * is Shopee's own button; the tool then waits for the matching API response and
 * reports what Shopee confirmed.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import { requireLogin, shopeeUrl } from '../api/client.js';
import { BASE_URL, CURRENCY, captureAll, waitForCollected } from '../browser/session.js';
import type { CollectedResponse } from '../browser/session.js';
import { registerAccountTool } from '../account-mode.js';
import { withErrorHandling } from '../utils/errors.js';
import { formatPrice } from '../utils/price.js';
import { resolveProductIds } from './product.js';
import { voucherBenefit, formatDateTime } from './account.js';
import type { WalletVoucher } from './account.js';
import type { PdpResponse, ShopBaseResponse } from '../api/types.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const find = (got: CollectedResponse[], match: string): CollectedResponse | undefined =>
  got.find((c) => c.url.includes(match));

/** Shopee's `{error: 0}` is success; anything else (or no response) is not. */
const succeeded = (c: CollectedResponse | undefined): boolean =>
  !!c && !((c.json as { error?: number | null }).error ?? 0);

/** Click the first button whose visible text matches `pattern` (a regex source). */
async function clickButton(page: Page, pattern: string): Promise<string | null> {
  return page.evaluate((src: string) => {
    const re = new RegExp(src, 'i');
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      re.test((x.textContent || '').trim()),
    );
    if (!b) return null;
    b.click();
    return (b.textContent || '').trim();
  }, pattern);
}

// ─── shop vouchers ───────────────────────────────────────────────────────────

export interface ShopVoucher extends WalletVoucher {
  promotionid: number;
  voucher_code: string;
  is_claimed_before?: boolean;
}

interface ShopTabResponse {
  data?: {
    decoration?: Array<{ shop_voucher?: { voucher_list?: ShopVoucher[] | null } | null }> | null;
  };
}

export function shopVouchersFrom(tab: ShopTabResponse | undefined): ShopVoucher[] {
  return (tab?.data?.decoration ?? []).flatMap((d) => d.shop_voucher?.voucher_list ?? []);
}

export function formatShopVouchers(shopId: string, vouchers: ShopVoucher[]): string {
  if (vouchers.length === 0) return `🎟 Shop \`${shopId}\` has no claimable vouchers right now.`;
  const lines = [`🎟 **Vouchers from shop \`${shopId}\`**`, ''];
  vouchers.forEach((v, i) => {
    const meta = [
      v.min_spend ? `min. spend ${formatPrice(v.min_spend, CURRENCY)}` : 'no min. spend',
      v.end_time ? `until ${formatDateTime(v.end_time)}` : '',
      v.percentage_used ? `${v.percentage_used}% used up` : '',
      v.is_claimed_before ? '✅ claimed' : '',
    ].filter(Boolean);
    lines.push(
      `${i + 1}. **${voucherBenefit(v)}** | code \`${v.voucher_code}\``,
      `   ${meta.join(' | ')}`,
    );
  });
  return lines.join('\n');
}

/** Buttons on a shop's voucher strip read "Claim" until claimed, then "Use". */
const VOUCHER_BUTTON = '^(claim|klaim|simpan|use|pakai|gunakan|領取|使用)$';
const VOUCHER_CLAIM = '^(claim|klaim|simpan|領取)$';

// ─── tools ───────────────────────────────────────────────────────────────────

export function registerActionTools(server: McpServer): void {
  const add = (tool: ReturnType<McpServer['tool']>): void => registerAccountTool(tool);

  add(
    server.tool(
      'like_product',
      '[Experimental — modifies your Shopee account] Like (favourite) or unlike a product, via the product ' +
        'page’s own heart button. Does nothing if it is already in the requested state.',
      {
        shopId: z.string().optional().describe('Numeric shop ID'),
        itemId: z.string().optional().describe('Numeric item/product ID'),
        url: z.string().url().optional().describe('Full product URL, as an alternative to the IDs'),
        like: z.boolean().default(true).describe('true to like, false to unlike (default: true)'),
      },
      WRITE,
      async ({ shopId, itemId, url, like }) =>
        withErrorHandling(async () => {
          const ids = resolveProductIds(shopId, itemId, url);
          if (!ids)
            return text('❌ Please provide both `shopId` and `itemId`, or a full product `url`.');
          await requireLogin();

          let already: boolean | undefined;
          let clicked = false;
          const action = like ? 'pages/like_items' : 'pages/unlike_items';
          const got = await captureAll(shopeeUrl(`/product/${ids.shopId}/${ids.itemId}`), {
            apiMatches: ['pdp/get_pc', action],
            interact: async (page, c) => {
              if (!(await waitForCollected(c, (x) => !!find(x, 'pdp/get_pc'), 30000))) return;
              const pdp = find(c, 'pdp/get_pc')!.json as PdpResponse & {
                data?: { product_review?: { liked?: boolean } };
              };
              already = pdp.data?.product_review?.liked;
              if (already === like) return;
              // The heart button reads "Favorite (6,3k)" / "Favorit (…)" / "喜歡 (…)".
              await page.waitForTimeout(1500);
              clicked = !!(await clickButton(
                page,
                '^(favorite|favorit|disukai|suka|喜歡|喜欢)\\s*\\(',
              ));
              if (clicked) await waitForCollected(c, (x) => !!find(x, action), 12000);
            },
          });

          const link = `🔗 ${BASE_URL}/product/${ids.shopId}/${ids.itemId}`;
          if (already === undefined)
            return text('❌ Could not read the product page. Nothing was changed.');
          if (already === like)
            return text(
              `ℹ️ Already ${like ? 'liked' : 'not liked'}. Nothing was changed.\n${link}`,
            );
          if (!clicked) return text('❌ Could not find the like button. Nothing was changed.');
          return text(
            succeeded(find(got, action))
              ? `${like ? '❤️ Liked' : '🤍 Unliked'} the product.\n${link}`
              : `❌ Shopee did not confirm the ${like ? 'like' : 'unlike'}.\n${link}`,
          );
        }),
    ),
  );

  add(
    server.tool(
      'follow_shop',
      '[Experimental — modifies your Shopee account] Follow or unfollow a shop, via the shop page’s own ' +
        'Follow button. Does nothing if it is already in the requested state.',
      {
        shopId: z.string().regex(/^\d+$/).describe('Numeric shop ID'),
        follow: z
          .boolean()
          .default(true)
          .describe('true to follow, false to unfollow (default: true)'),
      },
      WRITE,
      async ({ shopId, follow }) =>
        withErrorHandling(async () => {
          await requireLogin();
          let already: boolean | undefined;
          let name = `shop ${shopId}`;
          let clicked = false;
          const action = follow ? 'shop/follow' : 'shop/unfollow';
          const got = await captureAll(shopeeUrl(`/shop/${shopId}`), {
            apiMatches: ['shop/get_shop_base_v2', action],
            interact: async (page, c) => {
              if (!(await waitForCollected(c, (x) => !!find(x, 'get_shop_base_v2'), 30000))) return;
              const base = (
                find(c, 'get_shop_base_v2')!.json as ShopBaseResponse & {
                  data?: { followed?: boolean };
                }
              ).data;
              already = base?.followed;
              if (base?.name) name = base.name;
              if (already === follow) return;
              await page.waitForTimeout(1500);
              // Follow ⇄ Following ("Ikuti" ⇄ "Mengikuti", "關注" ⇄ "已關注").
              clicked = !!(await clickButton(
                page,
                follow ? '^(follow|ikuti|關注|关注)$' : '^(following|mengikuti|已關注|已关注)$',
              ));
              if (clicked) await waitForCollected(c, (x) => !!find(x, action), 12000);
            },
          });

          if (already === undefined)
            return text('❌ Could not read the shop page. Nothing was changed.');
          if (already === follow) {
            return text(
              `ℹ️ Already ${follow ? 'following' : 'not following'} ${name}. Nothing was changed.`,
            );
          }
          if (!clicked) return text('❌ Could not find the Follow button. Nothing was changed.');
          return text(
            succeeded(find(got, action))
              ? `${follow ? '➕ Now following' : '➖ Unfollowed'} ${name}.\n🔗 ${BASE_URL}/shop/${shopId}`
              : `❌ Shopee did not confirm the ${follow ? 'follow' : 'unfollow'}.`,
          );
        }),
    ),
  );

  add(
    server.tool(
      'get_shop_vouchers',
      '[Experimental, account] The vouchers a shop is currently giving away: benefit, minimum spend, expiry, ' +
        'code, and whether you have already claimed each one. Claim one with claim_shop_voucher.',
      { shopId: z.string().regex(/^\d+$/).describe('Numeric shop ID') },
      { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async ({ shopId }) =>
        withErrorHandling(async () => {
          await requireLogin();
          const got = await captureAll(shopeeUrl(`/shop/${shopId}`), {
            apiMatches: ['shop/get_shop_tab'],
            interact: async (_page, c) => {
              await waitForCollected(c, (x) => x.length > 0, 30000);
            },
          });
          const tab = got[0]?.json as ShopTabResponse | undefined;
          if (!tab) return text('❌ Could not read the shop page.');
          return text(formatShopVouchers(shopId, shopVouchersFrom(tab)));
        }),
    ),
  );

  add(
    server.tool(
      'claim_shop_voucher',
      '[Experimental — modifies your Shopee account] Claim (save) one of a shop’s vouchers into your voucher ' +
        'wallet, via the shop page’s own Claim button. Get the code from get_shop_vouchers. A claim cannot be undone.',
      {
        shopId: z.string().regex(/^\d+$/).describe('Numeric shop ID'),
        voucherCode: z.string().min(1).describe('Voucher code from get_shop_vouchers'),
      },
      { ...WRITE, idempotentHint: true },
      async ({ shopId, voucherCode }) =>
        withErrorHandling(async () => {
          await requireLogin();
          let outcome: string | undefined;
          let target: ShopVoucher | undefined;
          const got = await captureAll(shopeeUrl(`/shop/${shopId}`), {
            apiMatches: ['shop/get_shop_tab', 'voucher_wallet/save_voucher'],
            interact: async (page, c) => {
              if (!(await waitForCollected(c, (x) => !!find(x, 'get_shop_tab'), 30000))) {
                outcome = '❌ Could not read the shop page. Nothing was claimed.';
                return;
              }
              const vouchers = shopVouchersFrom(find(c, 'get_shop_tab')!.json as ShopTabResponse);
              const index = vouchers.findIndex((v) => v.voucher_code === voucherCode);
              if (index < 0) {
                outcome = `❌ Shop ${shopId} has no voucher \`${voucherCode}\` right now (see get_shop_vouchers). Nothing was claimed.`;
                return;
              }
              target = vouchers[index];
              if (target.is_claimed_before) {
                outcome = `ℹ️ You already claimed \`${voucherCode}\`. Nothing was changed.`;
                return;
              }
              await page.waitForTimeout(1500);
              // The strip renders one button per voucher, in payload order. Only click
              // when the counts line up, so a layout change can't claim the wrong one.
              const clicked = await page.evaluate(
                ({ all, claim, index, total }) => {
                  const btns = Array.from(document.querySelectorAll('button')).filter((b) =>
                    new RegExp(all, 'i').test((b.textContent || '').trim()),
                  );
                  if (btns.length !== total) return `mismatch:${btns.length}`;
                  const b = btns[index];
                  if (!new RegExp(claim, 'i').test((b.textContent || '').trim()))
                    return 'not-claimable';
                  b.click();
                  return 'ok';
                },
                { all: VOUCHER_BUTTON, claim: VOUCHER_CLAIM, index, total: vouchers.length },
              );
              if (clicked !== 'ok') {
                outcome =
                  clicked === 'not-claimable'
                    ? `ℹ️ \`${voucherCode}\` is not claimable (already claimed or fully used). Nothing was changed.`
                    : `❌ The page’s voucher buttons didn’t line up with the shop’s voucher list (${clicked}), so nothing was clicked.`;
                return;
              }
              await waitForCollected(c, (x) => !!find(x, 'save_voucher'), 12000);
            },
          });

          if (outcome) return text(outcome);
          const saved = find(got, 'save_voucher');
          const code = (
            saved?.json as { data?: { voucher?: { voucher_code?: string } } } | undefined
          )?.data?.voucher?.voucher_code;
          if (!succeeded(saved))
            return text(`❌ Shopee did not confirm claiming \`${voucherCode}\`.`);
          if (code && code !== voucherCode) {
            return text(
              `⚠️ Shopee saved \`${code}\`, not \`${voucherCode}\` — check your voucher wallet.`,
            );
          }
          return text(
            `🎟 Claimed \`${voucherCode}\` — ${target ? voucherBenefit(target) : 'saved'} — into your voucher wallet.`,
          );
        }),
    ),
  );
}
