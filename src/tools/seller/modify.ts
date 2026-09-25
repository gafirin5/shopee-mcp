import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { updateProductPrice, updateProductStock, setItemListing } from '../../seller/actions/product.js';
import { withErrorHandling } from '../../utils/errors.js';

const numericArgs = {
  item_id: z.string().min(1).describe('The product/item id'),
  variation_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('0-based model index for variation products; omit for simple products'),
};

export function registerSellerModifyTools(server: McpServer): void {
  server.tool(
    'update_price',
    'Set a product price via the Seller Centre edit page (IDR, no separators), then save. ' +
      'One write per call on your own shop.',
    { ...numericArgs, price: z.number().int().min(1).describe('New price in IDR, e.g. 150000') },
    async ({ item_id, variation_index, price }) => {
      return withErrorHandling(async () => {
        const text = await updateProductPrice({ itemId: item_id, value: price, variationIndex: variation_index });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'update_stock',
    'Set a product stock level via the Seller Centre edit page, then save. ' +
      'One write per call on your own shop.',
    { ...numericArgs, stock: z.number().int().min(0).describe('New stock quantity') },
    async ({ item_id, variation_index, stock }) => {
      return withErrorHandling(async () => {
        const text = await updateProductStock({ itemId: item_id, value: stock, variationIndex: variation_index });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'unlist_item',
    'Take a product off sale (unlist) via the Seller Centre product list switch.',
    { item_id: z.string().min(1).describe('The product/item id') },
    async ({ item_id }) => {
      return withErrorHandling(async () => {
        const text = await setItemListing(item_id, false);
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'list_item',
    'Put a product back on sale (list) via the Seller Centre product list switch.',
    { item_id: z.string().min(1).describe('The product/item id') },
    async ({ item_id }) => {
      return withErrorHandling(async () => {
        const text = await setItemListing(item_id, true);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
