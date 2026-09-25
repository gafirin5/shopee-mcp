import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { withSellerAction, stepDelay, ActionError, ACTION_TIMEOUT_MS } from '../../actions/base.js';
import {
  openProductEdit,
  findVideoInput,
  waitForVideoReady,
  saveProduct,
} from '../pages/productEdit.js';

const VIDEO_EXT_OK = new Set(['.mp4', '.mov', '.m4v']);

export interface UploadVideoArgs {
  itemId: string;
  videoPath: string;
  /** Timeout for the whole upload + processing window (ms). */
  processTimeoutMs?: number;
  /** Skip the Save click (dry preview of the upload step only). */
  skipSave?: boolean;
}

async function validateVideoFile(videoPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(videoPath);
  } catch {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${videoPath}`);
  const ext = path.extname(videoPath).toLowerCase();
  if (!VIDEO_EXT_OK.has(ext)) {
    throw new Error(
      `Unsupported video extension "${ext}". Shopee accepts ${[...VIDEO_EXT_OK].join(', ')} ` +
        `(prefer MP4 H.264).`,
    );
  }
  const maxBytes = parseInt(process.env.SHOPEE_VIDEO_MAX_MB ?? '200', 10) * 1024 * 1024;
  if (stat.size > maxBytes) {
    throw new Error(
      `Video is ${(stat.size / 1024 / 1024).toFixed(0)} MB — over the ${maxBytes / 1024 / 1024} MB guard. ` +
        'Compress it first (Shopee portals typically cap well below this).',
    );
  }
}

/**
 * Upload a video to a product listing via the Seller Centre edit page.
 *
 * One action per tool call, step-delayed, serialized by the global browser
 * lock. The result message reports each step so a partial failure is
 * diagnosable from the transcript alone.
 */
export async function uploadProductVideo(args: UploadVideoArgs): Promise<string> {
  const { itemId, videoPath } = args;
  const processTimeoutMs = args.processTimeoutMs ?? 180000;
  await validateVideoFile(videoPath);
  const absPath = path.resolve(videoPath);

  return withSellerAction('upload-product-video', async (page: Page) => {
    const steps: string[] = [];

    // 1. Open the edit page.
    await openProductEdit(page, itemId);
    steps.push(`✅ Opened edit page for product ${itemId}`);

    // 2. Locate the video file input (portal reveals it inside the Media section).
    const input = await findVideoInput(page);
    await stepDelay();

    // 3. Attach the file — Playwright feeds the input directly, no OS dialog.
    await input.setInputFiles(absPath);
    steps.push(`✅ Attached ${path.basename(absPath)}`);

    // 4. Wait for upload + transcoding to render a preview.
    const ready = await waitForVideoReady(page, processTimeoutMs);
    if (!ready) {
      throw new ActionError(
        `Video did not finish processing within ${Math.round(processTimeoutMs / 1000)}s. ` +
          'It may still be transcoding on Shopee — re-run check_product_video before retrying.',
      );
    }
    steps.push('✅ Video preview rendered (upload + processing done)');
    await stepDelay();

    // 5. Save.
    if (!args.skipSave) {
      const saved = await saveProduct(page);
      if (!saved) {
        throw new ActionError(
          'Save was clicked but no success toast appeared. Verify manually on the edit page ' +
            'before assuming the video is attached.',
        );
      }
      steps.push('✅ Saved — success toast shown');
    } else {
      steps.push('⏭️ skipSave=true — product not saved');
    }

    return `🎬 Upload video produk ${itemId}\n\n${steps.join('\n')}`;
  });
}

export interface RemoveVideoArgs {
  itemId: string;
  editPath?: string;
}

/**
 * Remove an existing product video: the delete affordance is a hover-revealed
 * "x" on the video tile, so we hover the preview first. Selectors are
 * intentionally tolerant; on failure the debug screenshot shows the live DOM.
 */
export async function removeProductVideo(args: RemoveVideoArgs): Promise<string> {
  const { itemId } = args;
  return withSellerAction('remove-product-video', async (page: Page) => {
    await openProductEdit(page, itemId);
    const preview = page
      .locator(
        '[class*="video" i] [class*="delete" i], [class*="video" i] [class*="remove" i], [class*="video" i] [class*="close" i]',
      )
      .first();
    const count = await preview.count();
    if (!count) {
      throw new ActionError(
        'No video delete control found — either the product has no video or the selector drifted. ' +
          'Check the debug screenshot and update productEdit selectors.',
      );
    }
    await preview.hover().catch(() => {});
    await stepDelay();
    await preview.click();
    await stepDelay();

    const saved = await saveProduct(page);
    return saved
      ? `🗑️ Video deleted and product ${itemId} saved.`
      : `🗑️ Video delete clicked on product ${itemId}, but no save toast appeared — verify manually.`;
  });
}

export const UPLOAD_DEFAULT_TIMEOUT = ACTION_TIMEOUT_MS;
