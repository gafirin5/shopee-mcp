import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sellerCapture } from '../../seller/capture.js';
import { SELLER_PATHS } from '../../seller/urls.js';
import { withErrorHandling } from '../../utils/errors.js';
import { formatSellerPayload } from './format.js';

const PRODUCT_LIST_CANDIDATES = [
  '/product/get_products',
  '/get_products',
  '/api/v1/products',
  '/product_list/get',
  '/product/list/get',
];

const PRODUCT_ARRAY_KEYS = ['product_list', 'items', 'list', 'products'];

export function registerSellerProductTools(server: McpServer): void {
  server.tool(
    'list_seller_products',
    'List the shop products from the Seller Centre portal (names, ids, price/stock if present). ' +
      'Read-only capture of the product list page the portal app itself loads.',
    {
      page: z.number().int().min(1).default(1).describe('Page number (default: 1)'),
      max_rows: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe('Max rows to render (default: 20)'),
    },
    async ({ page, max_rows }) => {
      return withErrorHandling(async () => {
        const json = await sellerCapture<Record<string, unknown>>(
          `${SELLER_PATHS.productList}?page=${page}`,
          PRODUCT_LIST_CANDIDATES,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatSellerPayload(
                `🛍️ Seller Products (page ${page})`,
                json,
                PRODUCT_ARRAY_KEYS,
                max_rows,
              ),
            },
          ],
        };
      });
    },
  );
}
