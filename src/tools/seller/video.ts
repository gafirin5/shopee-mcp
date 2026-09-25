import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shopeeCapture, shopeeUrl } from '../../api/client.js';
import { uploadProductVideo, removeProductVideo } from '../../seller/actions/video.js';
import { withErrorHandling } from '../../utils/errors.js';
import { findVideoInfo } from '../../utils/media.js';
import { parseProductUrl } from '../product.js';

export function registerSellerVideoTools(server: McpServer): void {
  server.tool(
    'upload_product_video',
    'Upload a video file to a product listing via the Shopee Seller Centre edit page, ' +
      'then save. One action per call, on your own shop. MP4/MOV; large files may take ' +
      'a while to transcode — the tool waits for the preview before saving.',
    {
      item_id: z.string().min(1).describe('The product/item id (same id as the marketplace URL)'),
      video_path: z
        .string()
        .min(1)
        .describe('Absolute or workspace-relative path to the video file (.mp4/.mov)'),
      process_timeout_ms: z
        .number()
        .int()
        .min(30000)
        .max(600000)
        .default(180000)
        .describe('How long to wait for upload+transcoding before giving up (ms, default 180s)'),
      skip_save: z
        .boolean()
        .default(false)
        .describe('Upload the video but do not click Save (dry preview)'),
    },
    async ({ item_id, video_path, process_timeout_ms, skip_save }) => {
      return withErrorHandling(async () => {
        const text = await uploadProductVideo({
          itemId: item_id,
          videoPath: video_path,
          processTimeoutMs: process_timeout_ms,
          skipSave: skip_save,
        });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'remove_product_video',
    'Remove the video attached to a product listing via the Seller Centre edit page, then save.',
    {
      item_id: z.string().min(1).describe('The product/item id'),
    },
    async ({ item_id }) => {
      return withErrorHandling(async () => {
        const text = await removeProductVideo({ itemId: item_id });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'check_product_video',
    'Read-only check of whether a product currently has a video attached, as seen by the ' +
      'buyer-facing marketplace (no seller session needed). Useful to verify an upload landed.',
    {
      shop_id: z.string().optional().describe('Numeric shop id (or give url instead)'),
      item_id: z.string().optional().describe('Numeric item id (or give url instead)'),
      url: z.string().url().optional().describe('Full marketplace product URL'),
    },
    async ({ shop_id, item_id, url }) => {
      return withErrorHandling(async () => {
        let sid = shop_id;
        let iid = item_id;
        if (!sid || !iid) {
          const parsed = url ? parseProductUrl(url) : null;
          if (parsed) {
            sid = parsed.shopId;
            iid = parsed.itemId;
          }
        }
        if (!sid || !iid) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Provide both `shop_id` and `item_id`, or a full product `url`.',
              },
            ],
          };
        }
        const pageUrl = shopeeUrl(`/product/${sid}/${iid}`);
        const data = await shopeeCapture<{ itemid?: number; error?: number; error_msg?: string }>(
          pageUrl,
          'pdp/get_pc',
        );
        const video = findVideoInfo(data);
        const text = video
          ? `🎬 Product ${iid} HAS video media (found at ${video.foundAt})\n` +
            `${video.url ? `URL: ${video.url}\n` : ''}${video.cover ? `Cover: ${video.cover}` : ''}`
          : `🎬 Product ${iid} has no video media in its PDP data (as of now).`;
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
