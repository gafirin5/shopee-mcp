import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  updateProductPrice,
  updateProductStock,
  setItemListing,
} from '../../seller/actions/product.js';
import { assertSellerWritesEnabled } from '../../actions/base.js';
import { withErrorHandling } from '../../utils/errors.js';
import { confirmGate } from '../../utils/confirm.js';

const numericArgs = {
  item_id: z.string().min(1).describe('The product/item id'),
  variation_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Which variation row to edit (0 = the first on the page). Required for listings with ' +
        'several variants — the tool refuses to guess rather than edit the wrong one.',
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe('Must be true to execute the write; false returns a preview only'),
};

export function registerSellerModifyTools(server: McpServer): void {
  server.tool(
    'update_price',
    'Set a product price via the Seller Centre edit page, then save. The price is a plain ' +
      'number in the currency the portal is showing (no separators or symbol). ' +
      'Requires confirm=true; without it returns a preview. Rate-limited like every write.',
    {
      ...numericArgs,
      price: z
        .number()
        .int()
        .min(1)
        .describe('New price as a whole number in the shop currency, e.g. 150000'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ item_id, variation_index, price, confirm }) => {
      return withErrorHandling(async () => {
        assertSellerWritesEnabled('update_price');
        const gate = confirmGate(
          confirm,
          `Set price of product \`${item_id}\`${variation_index !== undefined ? ` (variation ${variation_index})` : ''} → **${price.toLocaleString('en-US')}**, then save.`,
        );
        if (gate) return gate;
        const text = await updateProductPrice({
          itemId: item_id,
          value: price,
          variationIndex: variation_index,
        });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'update_stock',
    'Set a product stock level via the Seller Centre edit page, then save. ' +
      'Requires confirm=true; without it returns a preview. Rate-limited like every write.',
    { ...numericArgs, stock: z.number().int().min(0).describe('New stock quantity') },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ item_id, variation_index, stock, confirm }) => {
      return withErrorHandling(async () => {
        assertSellerWritesEnabled('update_stock');
        const gate = confirmGate(
          confirm,
          `Set stock of product \`${item_id}\`${variation_index !== undefined ? ` (variation ${variation_index})` : ''} → **${stock}**, then save.`,
        );
        if (gate) return gate;
        const text = await updateProductStock({
          itemId: item_id,
          value: stock,
          variationIndex: variation_index,
        });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'unlist_item',
    'Take a product off sale (unlist) via the Seller Centre product list switch. ' +
      'Requires confirm=true; without it returns a preview.',
    {
      item_id: z.string().min(1).describe('The product/item id'),
      confirm: z.boolean().default(false).describe('Must be true to execute'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async ({ item_id, confirm }) => {
      return withErrorHandling(async () => {
        assertSellerWritesEnabled('unlist_item');
        const gate = confirmGate(confirm, `Take product \`${item_id}\` **off sale** (unlist).`);
        if (gate) return gate;
        const text = await setItemListing(item_id, false);
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'list_item',
    'Put a product back on sale (list) via the Seller Centre product list switch. ' +
      'Requires confirm=true; without it returns a preview.',
    {
      item_id: z.string().min(1).describe('The product/item id'),
      confirm: z.boolean().default(false).describe('Must be true to execute'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ item_id, confirm }) => {
      return withErrorHandling(async () => {
        assertSellerWritesEnabled('list_item');
        const gate = confirmGate(confirm, `Put product \`${item_id}\` back **on sale** (list).`);
        if (gate) return gate;
        const text = await setItemListing(item_id, true);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
