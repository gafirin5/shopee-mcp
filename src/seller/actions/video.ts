import path from 'node:path';
import type { Page } from 'playwright';
import { validateVideoFile } from '../../utils/video-file.js';
import { withSellerAction, stepDelay, ActionError, ACTION_TIMEOUT_MS } from '../../actions/base.js';
import {
  openProductEdit,
  findVideoInput,
  waitForVideoReady,
  waitForVideoOnReload,
  saveProduct,
} from '../pages/productEdit.js';

export interface UploadVideoArgs {
  itemId: string;
  videoPath: string;
  /** Timeout for the whole upload + processing window (ms). */
  processTimeoutMs?: number;
  /** Skip the Save click (dry preview of the upload step only). */
  skipSave?: boolean;
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

  return withSellerAction(
    'upload-product-video',
    async (page: Page) => {
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

      // 5. Save, then reload the editor and look for the video. A success toast alone is
      // not proof: the page can toast without storing the video.
      if (!args.skipSave) {
        const { toastSeen } = await saveProduct(page);
        await openProductEdit(page, itemId);
        const onReload = await waitForVideoOnReload(page, true, 20000);
        if (onReload !== 'confirmed') {
          throw new ActionError(
            onReload === 'unknown'
              ? 'Save was clicked, but the edit page did not render after reloading, so the video ' +
                  'could not be checked. Verify manually on the edit page.'
              : 'Save was clicked, but the reloaded edit page shows no video. Verify manually on the ' +
                  'edit page before assuming the video is attached.',
          );
        }
        steps.push(
          toastSeen
            ? '✅ Saved — success toast shown'
            : '✅ Saved — no success toast, but the reloaded page shows the video',
        );
        steps.push('✅ Confirmed on a fresh load: video present');
      } else {
        steps.push('⏭️ skipSave=true — product not saved');
      }

      return `🎬 Upload video produk ${itemId}\n\n${steps.join('\n')}`;
    },
    `item ${itemId} video ← ${absPath}`,
  );
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
  return withSellerAction(
    'remove-product-video',
    async (page: Page) => {
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

      const { toastSeen } = await saveProduct(page);
      // Reload and check the video is gone. The toast is not proof, and a control that
      // deletes nothing still lets Save go through.
      await openProductEdit(page, itemId);
      const onReload = await waitForVideoOnReload(page, false, 20000);
      if (onReload !== 'confirmed') {
        throw new ActionError(
          onReload === 'unknown'
            ? `Save was clicked, but the edit page did not render after reloading, so the removal ` +
                `from product ${itemId} could not be checked. Verify manually.`
            : `Video is still attached to product ${itemId} after saving — nothing was removed. ` +
                'The delete control may have drifted; check the debug screenshot.',
        );
      }
      return toastSeen
        ? `🗑️ Video deleted and product ${itemId} saved.`
        : `🗑️ Video deleted and product ${itemId} saved. No success toast appeared, but the reloaded page shows no video.`;
    },
    `item ${itemId} remove video`,
  );
}

export const UPLOAD_DEFAULT_TIMEOUT = ACTION_TIMEOUT_MS;
