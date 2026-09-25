/**
 * Probe the Shopee CREATOR CENTER (/creator-center) for a video upload path.
 *   npx tsx scripts/probe-creator.ts
 */
import 'dotenv/config';
import type { Response } from 'playwright';
import { withBrowserLock, closeContext, BASE_URL } from '../src/browser/session.js';

async function main(): Promise<void> {
  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('seller');
    const urls = new Set<string>();
    const onResp = (r: Response): void => {
      const u = r.url();
      if (/\/api\//.test(u) && !/mmf-report|chatbot|experiment|log\?|tracking|beacon/.test(u)) {
        urls.add(u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]);
      }
    };
    page.on('response', onResp);
    await page.goto(`https://seller.shopee.co.id/creator-center`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) =>
      console.log('nav warn:', e instanceof Error ? e.message.split('\n')[0] : e),
    );
    await page.waitForTimeout(10000);

    const inputCount = await page.locator('input[type="file"][accept*="video"], input[type="file"][accept*="mp4"]').count();
    const anyInput = await page.locator('input[type="file"]').count();
    const uploadTexts = await page
      .locator('button:has-text("Unggah"), button:has-text("Upload"), a:has-text("Unggah"), a:has-text("Upload"), [class*="upload" i]')
      .count();
    console.log(`final URL: ${page.url()}`);
    console.log(`video file input: ${inputCount} | any file input: ${anyInput} | upload-affordance nodes: ${uploadTexts}`);
    console.log(`title: ${await page.title().catch(() => '?')}`);
    console.log('API endpoints seen:');
    for (const u of [...urls].slice(0, 15)) console.log(`  ${u}`);
    page.off('response', onResp);
  });
  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
