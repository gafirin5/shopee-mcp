import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sellerCapture } from '../../seller/capture.js';
import { SELLER_PATHS } from '../../seller/urls.js';
import { withErrorHandling } from '../../utils/errors.js';
import { formatSellerPayload } from './format.js';

const ORDER_LIST_CANDIDATES = [
  '/order_list/get_order_list',
  '/get_order_list',
  '/api/v1/orders',
  '/order/get_order_list',
];

const ORDER_DETAIL_CANDIDATES = [
  '/order_detail/get_order_detail',
  '/get_order_info',
  '/order/get_order_info',
  '/order/detail',
];

const LIST_ARRAY_KEYS = ['order_list', 'orders', 'list', 'data'];
const DETAIL_ARRAY_KEYS = ['order_detail', 'item_list', 'package_list', 'list'];

export function registerSellerOrderTools(server: McpServer): void {
  server.tool(
    'list_orders',
    'List orders from the Shopee Seller Centre portal (default: all/newest first). ' +
      'Read-only capture of the portal page the app itself loads.',
    {
      list_type: z
        .enum(['all', 'to_ship', 'shipped', 'completed', 'cancelled', 'return_refund'])
        .default('all')
        .describe('Which order bucket to open (default: all)'),
      page: z.number().int().min(1).default(1).describe('Page number (default: 1)'),
      max_rows: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe('Max rows to render (default: 20)'),
    },
    async ({ list_type, page, max_rows }) => {
      return withErrorHandling(async () => {
        const qs = new URLSearchParams({ page: String(page) });
        if (list_type !== 'all') qs.set('list_type', list_type);
        const json = await sellerCapture<Record<string, unknown>>(
          `${SELLER_PATHS.orderList}?${qs.toString()}`,
          ORDER_LIST_CANDIDATES,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatSellerPayload(
                `📦 Seller Orders (${list_type}, page ${page})`,
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
        const path = `/portal/order/detail?order_id=${encodeURIComponent(order_id)}`;
        const json = await sellerCapture<Record<string, unknown>>(path, ORDER_DETAIL_CANDIDATES);
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
