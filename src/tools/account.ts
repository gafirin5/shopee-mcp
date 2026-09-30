/**
 * EXPERIMENTAL account reads (account mode — only offered while logged in; see
 * src/account-mode.ts): orders, vouchers, coins, notifications.
 *
 * These read the user's own data, so output deliberately leaves out personal
 * details Shopee returns alongside it (delivery address, phone number).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ShopeeAPIError, requireLogin, shopeeCapture, shopeeUrl } from '../api/client.js';
import { BASE_URL, CURRENCY, TIMEZONE, captureAll, waitForCollected } from '../browser/session.js';
import type { CollectedResponse } from '../browser/session.js';
import { registerAccountTool } from '../account-mode.js';
import { withErrorHandling, truncate } from '../utils/errors.js';
import { formatPrice } from '../utils/price.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

/** "label_order_completed" → "Order completed". Shopee sends translation keys. */
export function humanizeLabel(key: string | undefined): string {
  if (!key) return 'Unknown';
  const words = key
    .replace(/^label_/, '')
    .replace(/_/g, ' ')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "29 Sep 2026, 18:00" in the storefront's timezone. */
export function formatDateTime(unixSeconds: number, timeZone: string = TIMEZONE): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSeconds * 1000));
}

// ─── orders ──────────────────────────────────────────────────────────────────

interface OrderItem {
  item_id: number;
  shop_id: number;
  model_id?: number;
  name: string;
  model_name?: string;
  amount: number;
  item_price?: number;
  order_price?: number;
}

interface OrderCard {
  shop_info?: { shop_id: number; shop_name?: string };
  product_info?: { item_groups?: Array<{ items?: OrderItem[] }> };
}

interface OrderListDetail {
  status?: {
    status_label?: { text?: string };
    list_view_status_label?: { text?: string };
  };
  info_card?: {
    order_id: number;
    order_list_cards?: OrderCard[];
    product_count?: number;
    final_total?: number;
  };
}

/** The purchase-page tab → its `type` query param. */
export const ORDER_TABS: Record<string, number> = {
  all: 6,
  to_ship: 7,
  to_receive: 8,
  completed: 3,
  cancelled: 4,
};

/** Orders from every list response the page fetched while scrolling, de-duplicated. */
export function collectOrders(collected: CollectedResponse[]): OrderListDetail[] {
  const seen = new Set<number>();
  const out: OrderListDetail[] = [];
  for (const c of collected) {
    const j = c.json as {
      data?: { details_list?: OrderListDetail[] | null };
      new_data?: { order_or_checkout_data?: Array<{ order_list_detail?: OrderListDetail }> | null };
    };
    const list =
      j.data?.details_list ??
      (j.new_data?.order_or_checkout_data ?? []).map((e) => e.order_list_detail);
    for (const o of list ?? []) {
      const id = o?.info_card?.order_id;
      if (!o || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(o);
    }
  }
  return out;
}

export function formatOrder(o: OrderListDetail, index: number): string {
  const card = o.info_card!;
  const status = humanizeLabel(
    o.status?.list_view_status_label?.text ?? o.status?.status_label?.text,
  );
  const lines = [`${index}. **Order \`${card.order_id}\`** — ${status}`];
  for (const c of card.order_list_cards ?? []) {
    if (c.shop_info?.shop_name) lines.push(`   🏪 ${c.shop_info.shop_name}`);
    for (const g of c.product_info?.item_groups ?? []) {
      for (const it of g.items ?? []) {
        const price = it.order_price ?? it.item_price;
        lines.push(
          `   • ${truncate(it.name, 90)}${it.model_name ? ` (${it.model_name})` : ''} × ${it.amount}` +
            (price !== undefined ? ` — ${formatPrice(price, CURRENCY)}` : ''),
        );
      }
    }
  }
  if (card.final_total !== undefined) {
    lines.push(`   💰 Total: ${formatPrice(card.final_total, CURRENCY)}`);
  }
  return lines.join('\n');
}

// ─── order detail ────────────────────────────────────────────────────────────

interface TrackingEvent {
  ctime: number;
  description?: string;
}

interface OrderDetail {
  status?: { status_label?: { text?: string } };
  pc_shipping?: {
    fulfilment_carrier?: { text?: string };
    forder_shipping_info_list?: Array<{
      tracking_number?: string;
      tracking_info_list?: TrackingEvent[] | null;
    }> | null;
  };
  info_card?: {
    parcel_cards?: Array<{
      shop_info?: { shop_name?: string };
      product_info?: { item_groups?: Array<{ items?: OrderItem[] }> };
    }>;
    subtotal?: number;
    final_total?: number;
    currency?: string;
  };
  payment_method?: { payment_channel_name?: { text?: string } };
  pc_processing_info?: {
    order_sn?: string;
    create_time?: number;
    pay_time?: number;
    shipping_confirm_time?: number;
    delivery_time?: number;
    complete_time?: number;
    is_rated?: boolean;
  };
}

/** Order detail without the delivery address or phone number Shopee also returns. */
export function formatOrderDetail(orderId: string, d: OrderDetail): string {
  const currency = d.info_card?.currency || CURRENCY;
  const p = d.pc_processing_info ?? {};
  const lines = [
    `🧾 **Order \`${orderId}\`**${p.order_sn ? ` (${p.order_sn})` : ''}`,
    `📌 Status: ${humanizeLabel(d.status?.status_label?.text)}`,
    '',
    '📦 **Items:**',
  ];
  for (const c of d.info_card?.parcel_cards ?? []) {
    if (c.shop_info?.shop_name) lines.push(`  🏪 ${c.shop_info.shop_name}`);
    for (const g of c.product_info?.item_groups ?? []) {
      for (const it of g.items ?? []) {
        const price = it.order_price ?? it.item_price;
        lines.push(
          `  • ${truncate(it.name, 90)}${it.model_name ? ` (${it.model_name})` : ''} × ${it.amount}` +
            (price !== undefined ? ` — ${formatPrice(price, currency)}` : '') +
            ` | 🔗 ${BASE_URL}/product/${it.shop_id}/${it.item_id}`,
        );
      }
    }
  }
  if (d.info_card?.final_total !== undefined) {
    lines.push(`  💰 Total paid: ${formatPrice(d.info_card.final_total, currency)}`);
  }
  const pay = d.payment_method?.payment_channel_name?.text;
  if (pay) lines.push(`  💳 Payment: ${pay}`);

  const timeline: Array<[string, number | undefined]> = [
    ['Ordered', p.create_time],
    ['Paid', p.pay_time],
    ['Shipped', p.shipping_confirm_time],
    ['Delivered', p.delivery_time],
    ['Completed', p.complete_time],
  ];
  const steps = timeline.filter(([, t]) => t && t > 0);
  if (steps.length) {
    lines.push('', '🗓 **Timeline:**', ...steps.map(([l, t]) => `  ${l}: ${formatDateTime(t!)}`));
  }

  const carrier = d.pc_shipping?.fulfilment_carrier?.text;
  const parcels = d.pc_shipping?.forder_shipping_info_list ?? [];
  if (carrier || parcels.length) {
    lines.push('', '🚚 **Shipping:**');
    if (carrier) lines.push(`  Courier: ${carrier}`);
    for (const parcel of parcels) {
      if (parcel.tracking_number) lines.push(`  Tracking no.: ${parcel.tracking_number}`);
      for (const ev of (parcel.tracking_info_list ?? []).slice(0, 6)) {
        lines.push(`  • ${formatDateTime(ev.ctime)} — ${(ev.description ?? '').trim()}`);
      }
    }
  }
  if (p.is_rated === false && p.complete_time) lines.push('', '⭐ Not rated yet.');
  return lines.join('\n');
}

// ─── vouchers ────────────────────────────────────────────────────────────────

export interface WalletVoucher {
  voucher_code?: string;
  min_spend?: number;
  discount_value?: number;
  discount_percentage?: number;
  discount_cap?: number;
  reward_percentage?: number;
  reward_cap?: number;
  reward_type?: number;
  end_time?: number;
  shop_name?: string | null;
  icon_text?: string | null;
  percentage_used?: number | null;
}

/** "Rp10.000 off" / "8% off (max Rp1.000.000)" / "8% coins cashback". */
export function voucherBenefit(v: WalletVoucher, currency: string = CURRENCY): string {
  if (v.discount_value) return `${formatPrice(v.discount_value, currency)} off`;
  if (v.discount_percentage) {
    return `${v.discount_percentage}% off${v.discount_cap ? ` (max ${formatPrice(v.discount_cap, currency)})` : ''}`;
  }
  if (v.reward_percentage) {
    return `${v.reward_percentage}% coins cashback${v.reward_cap ? ` (max ${(v.reward_cap / 100000).toLocaleString('id-ID')} coins)` : ''}`;
  }
  return 'Discount';
}

export function formatVoucher(
  v: WalletVoucher,
  index: number,
  currency: string = CURRENCY,
): string {
  const scope = v.shop_name || v.icon_text || 'Shopee';
  const meta = [
    v.min_spend ? `min. spend ${formatPrice(v.min_spend, currency)}` : 'no min. spend',
    v.end_time ? `until ${formatDateTime(v.end_time)}` : '',
    v.percentage_used ? `${v.percentage_used}% used up` : '',
  ].filter(Boolean);
  return `${index}. **${voucherBenefit(v, currency)}** — ${scope}${v.voucher_code ? ` | \`${v.voucher_code}\`` : ''}\n   ${meta.join(' | ')}`;
}

// ─── notifications ───────────────────────────────────────────────────────────

/** Notification page tab → Shopee's `action_cate`. */
export const NOTIFICATION_TABS: Record<string, { path: string; cate: number }> = {
  order: { path: 'order', cate: 4 },
  promotion: { path: 'promotion', cate: 1 },
  shopee: { path: 'shopee', cate: 6 },
};

interface NotificationAction {
  title?: string;
  content?: string;
  createtime?: number;
  id_info?: { orderid?: number | null } | null;
}

/** Shopee hex-encodes notification text (UTF-8) and embeds light HTML. */
export function decodeNotificationText(hex: string | undefined): string {
  if (!hex) return '';
  let s = hex;
  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) {
    s = Buffer.from(hex, 'hex').toString('utf8');
  }
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatNotification(a: NotificationAction, index: number): string {
  const title = decodeNotificationText(a.title);
  const body = decodeNotificationText(a.content);
  const when = a.createtime ? formatDateTime(a.createtime) : '';
  const order = a.id_info?.orderid ? ` | order \`${a.id_info.orderid}\`` : '';
  return `${index}. ${title ? `**${title}**` : ''}${when ? ` (${when})` : ''}${order}\n   ${truncate(body, 240)}`;
}

// ─── tools ───────────────────────────────────────────────────────────────────

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export function registerAccountTools(server: McpServer): void {
  const add = (tool: ReturnType<McpServer['tool']>): void => registerAccountTool(tool);

  add(
    server.tool(
      'get_orders',
      '[Experimental, account] List your Shopee orders: status, shop, items, and totals. Filter by tab ' +
        '(all, to_ship, to_receive, completed, cancelled). Use get_order_detail for tracking.',
      {
        status: z
          .enum(['all', 'to_ship', 'to_receive', 'completed', 'cancelled'])
          .default('all')
          .describe('Which purchase tab to read (default: all)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(10)
          .describe('Max orders, 1-30 (default: 10)'),
      },
      READ,
      async ({ status, limit }) =>
        withErrorHandling(async () => {
          await requireLogin();
          const isOrderList = (c: CollectedResponse): boolean =>
            c.url.includes('order/get_order_list') ||
            c.url.includes('order/get_all_order_and_checkout_list');
          const listIsDone = (c: CollectedResponse[]): boolean => {
            const lists = c.filter(isOrderList);
            const last = lists.at(-1)?.json as
              | {
                  data?: { details_list?: unknown[] | null };
                  new_data?: { order_or_checkout_data?: unknown[] | null };
                }
              | undefined;
            const n = (last?.data?.details_list ?? last?.new_data?.order_or_checkout_data ?? [])
              .length;
            return lists.length > 0 && n === 0;
          };
          // Orders load 5 at a time as the list scrolls.
          const collected = await captureAll(
            shopeeUrl(`/user/purchase/?type=${ORDER_TABS[status]}`),
            {
              apiMatches: ['order/get_order_list', 'order/get_all_order_and_checkout_list'],
              interact: async (page, got) => {
                await waitForCollected(
                  got,
                  (c) => collectOrders(c.filter(isOrderList)).length >= limit || listIsDone(c),
                  Math.min(45000, 10000 + limit * 1200),
                  () => page.mouse.wheel(0, 1200),
                );
              },
            },
          );
          const orders = collectOrders(collected.filter(isOrderList)).slice(0, limit);
          if (!collected.some(isOrderList)) {
            throw new ShopeeAPIError('Your order list did not load. Retry in a moment.');
          }
          if (orders.length === 0) return text(`🧾 No orders in "${status}".`);
          return text(
            [`🧾 **Your orders** — ${status} (${orders.length} shown)`, '']
              .concat(orders.map((o, i) => formatOrder(o, i + 1)).join('\n\n'))
              .join('\n'),
          );
        }),
    ),
  );

  add(
    server.tool(
      'get_order_detail',
      '[Experimental, account] One of your orders in detail: status, items, total paid, payment channel, ' +
        'timeline, courier, tracking number and latest tracking events. Your address and phone are omitted.',
      { orderId: z.string().regex(/^\d+$/).describe('Order ID (from get_orders)') },
      READ,
      async ({ orderId }) =>
        withErrorHandling(async () => {
          const data = await shopeeCapture<{
            error?: number;
            error_msg?: string;
            data?: OrderDetail;
          }>(shopeeUrl(`/user/purchase/order/${orderId}`), 'order/get_order_detail');
          if (!data.data) return text(`❌ Could not read order ${orderId}.`);
          return text(formatOrderDetail(orderId, data.data));
        }),
    ),
  );

  add(
    server.tool(
      'get_my_vouchers',
      '[Experimental, account] Vouchers saved in your voucher wallet: benefit, where it applies, minimum spend, and expiry.',
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Max vouchers, 1-50 (default: 20)'),
      },
      READ,
      async ({ limit }) =>
        withErrorHandling(async () => {
          const data = await shopeeCapture<{
            error?: number;
            error_msg?: string;
            data?: { user_voucher_list?: WalletVoucher[] | null };
          }>(
            shopeeUrl('/user/voucher-wallet'),
            // The v2 list, not the v4 `get_user_voucher_list_meta` fired just before it.
            'api/v2/voucher_wallet/get_user_voucher_list',
          );
          const list = (data.data?.user_voucher_list ?? []).slice(0, limit);
          if (list.length === 0) return text('🎟 Your voucher wallet is empty.');
          return text(
            [`🎟 **Your vouchers** (${list.length} shown)`, '']
              .concat(list.map((v, i) => formatVoucher(v, i + 1)))
              .join('\n'),
          );
        }),
    ),
  );

  add(
    server.tool(
      'get_coins',
      '[Experimental, account] Your Shopee Coins balance and recent coin transactions.',
      {},
      READ,
      async () =>
        withErrorHandling(async () => {
          await requireLogin();
          const got = await captureAll(shopeeUrl('/user/coin'), {
            apiMatches: ['coin/get_user_coins_summary', 'coin/get_user_coin_transaction_list'],
            interact: async (_page, c) => {
              await waitForCollected(c, (x) => x.length >= 2, 20000);
            },
          });
          const summary = got.find((c) => c.url.includes('get_user_coins_summary'))?.json as
            | { data?: { coin_info?: { available_amount?: number; fe_available_amount?: number } } }
            | undefined;
          if (!summary)
            throw new ShopeeAPIError('Your coin balance did not load. Retry in a moment.');
          const tx =
            (
              got.find((c) => c.url.includes('get_user_coin_transaction_list'))?.json as
                | {
                    data?: {
                      coin_transactions?: Array<{
                        ctime?: number;
                        amount?: number;
                        name?: string;
                        reason?: string;
                      }> | null;
                    };
                  }
                | undefined
            )?.data?.coin_transactions ?? [];
          // `fe_available_amount` is the display value; fall back to the raw field,
          // which (like prices) is assumed to be ×100000.
          const info = summary.data?.coin_info;
          const balance = info?.fe_available_amount ?? (info?.available_amount ?? 0) / 100000;
          const lines = [`🪙 **Shopee Coins:** ${balance.toLocaleString('id-ID')}`];
          if (tx.length) {
            lines.push('', '**Recent transactions:**');
            for (const t of tx.slice(0, 10)) {
              const amt = (t.amount ?? 0) / 100000;
              lines.push(
                `  • ${amt > 0 ? '+' : ''}${amt.toLocaleString('id-ID')}${t.name || t.reason ? ` — ${t.name ?? t.reason}` : ''}${t.ctime ? ` (${formatDateTime(t.ctime)})` : ''}`,
              );
            }
          } else {
            lines.push('No coin transactions yet.');
          }
          return text(lines.join('\n'));
        }),
    ),
  );

  add(
    server.tool(
      'get_notifications',
      '[Experimental, account] Your Shopee notifications: order updates, promotions, or Shopee updates.',
      {
        category: z
          .enum(['order', 'promotion', 'shopee'])
          .default('order')
          .describe('Notification tab (default: order)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe('Max notifications, 1-20 (default: 10)'),
      },
      READ,
      async ({ category, limit }) =>
        withErrorHandling(async () => {
          await requireLogin();
          const tab = NOTIFICATION_TABS[category];
          const isTab = (c: CollectedResponse): boolean =>
            c.url.includes('notification/get_notifications') &&
            c.url.includes(`action_cate=${tab.cate}`);
          const got = await captureAll(shopeeUrl(`/user/notifications/${tab.path}`), {
            apiMatches: ['notification/get_notifications'],
            interact: async (_page, c) => {
              await waitForCollected(c, (x) => x.some(isTab), 20000);
            },
          });
          const res = got.find(isTab)?.json as
            { data?: { actions?: NotificationAction[] | null } } | undefined;
          if (!res) throw new ShopeeAPIError('Your notifications did not load. Retry in a moment.');
          const actions = (res.data?.actions ?? []).slice(0, limit);
          if (actions.length === 0) return text(`🔔 No ${category} notifications.`);
          return text(
            [`🔔 **${category.charAt(0).toUpperCase() + category.slice(1)} notifications**`, '']
              .concat(actions.map((a, i) => formatNotification(a, i + 1)))
              .join('\n'),
          );
        }),
    ),
  );
}
