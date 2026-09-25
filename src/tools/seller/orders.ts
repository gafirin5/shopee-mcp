import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sellerCapture } from '../../seller/capture.js';
import { SELLER_PATHS } from '../../seller/urls.js';
import { withErrorHandling } from '../../utils/errors.js';
import { formatSellerPayload } from './format.js';

// Verified live (2026 portal): the order page fires POST
// /api/v3/order/search_order_list_index — but that endpoint carries anti-fraud
// headers (af-ac-enc-sz-token), so we capture the app's own response instead
// of calling it directly. The page fires it even while a brand-new shop is
// being redirected to onboarding.
const ORDER_LIST_CANDIDATES = [
  '/order/search_order_list_index',
  '/order/get_order_list_meta_v2',
  '/order_list/get_order_list',
  '/api/v1/orders',
];

const LIST_ARRAY_KEYS = ['order_list', 'index_list', 'orders', 'list', 'data'];
const DETAIL_ARRAY_KEYS = ['order_detail', 'item_list', 'package_list', 'list'];

export function registerSellerOrderTools(server: McpServer): void {
  server.tool(
    'list_orders',
    'List orders from the Shopee Seller Centre portal (/portal/sale/order). ' +
      'Captures the search_order_list_index response the page itself fires. ' +
      'A brand-new shop still on the onboarding gate returns an empty list.',
    {
      list_type: z
        .enum(['all', 'to_ship', 'shipped', 'completed', 'cancelled', 'return_refund'])
        .default('all')
        .describe('Which order bucket to open (default: all)'),
      max_rows: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe('Max rows to render (default: 20)'),
    },
    async ({ list_type, max_rows }) => {
      return withErrorHandling(async () => {
        const typeParam: Record<string, string | undefined> = {
          all: undefined,
          to_ship: 'toship',
          shipped: 'shipped',
          completed: 'completed',
          cancelled: 'cancelled',
          return_refund: 'returnrefund',
        };
        const type = typeParam[list_type];
        const path = type ? `${SELLER_PATHS.orderList}?type=${type}` : SELLER_PATHS.orderList;
        // Generous timeout: a shop on the onboarding gate loads slowly and may
        // fire the order API late (or never, if the redirect wins — that reads
        // as an auth-required error, which is accurate guidance).
        const json = await sellerCapture<Record<string, unknown>>(
          path,
          ORDER_LIST_CANDIDATES,
          45000,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatSellerPayload(
                `📦 Seller Orders (${list_type})`,
                json,
                LIST_ARRAY_KEYS,
                max_rows,
              ),
            },
          ],
        };
      });
    },
  );

  server.tool(
    'get_order_detail',
    'Fetch one order detail (items, buyer, payment, shipping) from the Seller Centre.',
    {
      order_id: z.string().min(1).describe('The numeric order id (from list_orders)'),
    },
    async ({ order_id }) => {
      return withErrorHandling(async () => {
        const path = `/portal/sale/order/detail?order_id=${encodeURIComponent(order_id)}`;
        const json = await sellerCapture<Record<string, unknown>>(path, ORDER_LIST_CANDIDATES);
        return {
          content: [
            {
              type: 'text',
              text: formatSellerPayload(`🧾 Order ${order_id}`, json, DETAIL_ARRAY_KEYS, 50),
            },
          ],
        };
      });
    },
  );
}
