import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_URL } from '../browser/session.js';
import { withBuyerAction, stepDelay } from '../actions/base.js';
import { withErrorHandling } from '../utils/errors.js';

/**
 * Shopee Video (the short-video feed) is an app-first surface; the web build
 * may not expose an upload entry point at all. Rather than promising a flow we
 * cannot see, the probe reports what the live web actually offers and the post
 * tool refuses cleanly when there is no web entry point.
 */
const VIDEO_PATH_CANDIDATES = ['/shopee-video', '/video', '/tv', '/shopeevideo'];

const SEL = {
  videoInput:
    'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], input[type="file"][accept*=".mov"]',
  uploadEntry:
    '[class*="upload" i], button:has-text("Unggah"), button:has-text("Upload"), a:has-text("Unggah"), a:has-text("Upload")',
  caption:
    'textarea, [contenteditable="true"], input[placeholder*="caption" i], textarea[placeholder*="deskripsi" i]',
  postButton:
    'button:has-text("Posting"), button:has-text("Post"), button:has-text("Unggah"), button:has-text("Upload")',
  successToast: 'text=/terkirim|berhasil|posted|published|success/i',
} as const;

export function registerShopeeVideoTools(server: McpServer): void {
  server.tool(
    'shopee_video_probe',
    'Check whether the Shopee Video web build currently exposes an upload entry point ' +
      '(it is an app-first feature, so this can legitimately be "not available via web").',
    {},
    async () => {
      return withErrorHandling(async () => {
        const text = await withBuyerAction('shopee-video-probe', async (page) => {
          const findings: string[] = [];
          for (const p of VIDEO_PATH_CANDIDATES) {
            const url = `${BASE_URL}${p}`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            const finalUrl = page.url();
            const input = await page.locator(SEL.videoInput).count();
            const entry = await page.locator(SEL.uploadEntry).count();
            findings.push(
              `• ${p} → landed: ${finalUrl}\n` +
                `  upload entry point: ${entry > 0 ? 'yes' : 'no'} | video file input: ${input > 0 ? 'yes' : 'no'}`,
            );
          }
          const anyInput = findings.some((f) => f.includes('video file input: yes'));
          return (
            `🔎 Shopee Video web probe\n\n${findings.join('\n')}\n\n` +
            (anyInput
              ? '✅ An upload path exists on the web — post_shopee_video can be used.'
              : '⛔ No web upload entry point found — Shopee Video posting is app-first. ' +
                'post_shopee_video will refuse until Shopee ships a web uploader.')
          );
        });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'post_shopee_video',
    'Post a video to the Shopee Video feed from the web (caption supports product link text). ' +
      'Only works if shopee_video_probe finds a web upload entry point; refuses cleanly otherwise.',
    {
      video_path: z.string().min(1).describe('Path to the video file (.mp4/.mov)'),
      caption: z.string().max(2000).describe('Caption text (include product links if any)'),
    },
    async ({ video_path, caption }) => {
      return withErrorHandling(async () => {
        const text = await withBuyerAction('post-shopee-video', async (page) => {
          // 1. Find a live upload path.
          let opened = false;
          for (const p of VIDEO_PATH_CANDIDATES) {
            await page
              .goto(`${BASE_URL}${p}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
              .catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            if ((await page.locator(SEL.videoInput).count()) > 0) {
              opened = true;
              break;
            }
          }
          if (!opened) {
            return (
              '⛔ Shopee Video posting is not available on the web right now (app-first feature). ' +
              'Run shopee_video_probe for details; re-run later in case Shopee ships a web uploader.'
            );
          }

          // 2. Attach the video.
          const input = page.locator(SEL.videoInput).first();
          await input.setInputFiles(video_path);
          await page
            .locator(SEL.videoInput)
            .first()
            .waitFor({ state: 'attached', timeout: 120000 })
            .catch(() => {});
          await stepDelay();

          // 3. Caption.
          const cap = page.locator(SEL.caption).first();
          if (await cap.isVisible().catch(() => false)) {
            await cap.click().catch(() => {});
            await page.keyboard.type(caption, { delay: 20 });
            await stepDelay();
          }

          // 4. Post.
          const post = page.locator(SEL.postButton).first();
          if (!(await post.isVisible().catch(() => false))) {
            return '⚠️ Video attached but no post button found — check the debug screenshot and update SEL.postButton.';
          }
          await post.click();
          const ok = await page
            .locator(SEL.successToast)
            .first()
            .waitFor({ state: 'visible', timeout: 30000 })
            .then(() => true)
            .catch(() => false);
          return ok
            ? `✅ Video posted to Shopee Video:\n${caption}`
            : '⚠️ Post clicked but no success toast appeared — verify manually on the Shopee Video page.';
        });
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
