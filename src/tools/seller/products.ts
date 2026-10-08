import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { portalApi } from '../../seller/api.js';
import { sellerCapture } from '../../seller/capture.js';
import { SELLER_PATHS } from '../../seller/urls.js';
import { withErrorHandling } from '../../utils/errors.js';
import { formatSellerPayload } from './format.js';

// Verified live (2026 portal): the product list page fires
// GET /api/v3/opt/mpsku/list/v2/get_product_list — no anti-fraud headers, so
// we call it directly and fall back to capture if the direct call is refused.
const PRODUCT_LIST_API = '/api/v3/opt/mpsku/list/v2/get_product_list';
const PRODUCT_ARRAY_KEYS = ['product_list', 'list', 'items', 'products'];

export function registerSellerProductTools(server: McpServer): void {
  server.tool(
    'list_seller_products',
    'List the shop products from the Seller Centre portal (direct API call to the ' +
      'mpsku product list — works even while a brand-new shop is on the onboarding gate).',
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
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ page, max_rows }) => {
      return withErrorHandling(async () => {
        let json: Record<string, unknown>;
        try {
          json = await portalApi<Record<string, unknown>>(
            `${PRODUCT_LIST_API}?page_number=${page}&page_size=${max_rows}`,
          );
        } catch {
          json = await sellerCapture<Record<string, unknown>>(
            `${SELLER_PATHS.productList}?page=${page}`,
            ['/mpsku/list/v2/get_product_list', '/mpsku/list/v2/search_product_list'],
          );
        }
        const data = (json.data ?? json) as Record<string, unknown>;
        const pageInfo = data.page_info as { total?: number } | undefined;
        if (pageInfo?.total === 0) {
          return {
            content: [
              {
                type: 'text',
                text: '🛍️ Seller Products (page 1)\n\nToko belum punya produk (total=0). Tambahkan produk lewat /portal/product/new, lalu coba lagi.',
              },
            ],
          };
        }
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
