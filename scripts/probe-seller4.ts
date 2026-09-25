/**
 * Capture the DATA endpoints each real portal page fires (noise-filtered).
 *   npx tsx scripts/probe-seller4.ts
 */
import 'dotenv/config';
import type { Response } from 'playwright';
import { withBrowserLock, closeContext } from '../src/browser/session.js';

const NOISE =
  /mmf-report|chatbot|experiment|feature_toggle|sc_conf|sidebar|user_menu|topbar|feedback|remote-component|login|logout|report\.|webchat\/api\/coreapi|abtest|payment_info|subcart|tracking|beacon|saturn|push|log\?/;

const PAGES: Array<[string, string]> = [
  ['orders', 'https://seller.shopee.co.id/portal/sale/order'],
  ['products', 'https://seller.shopee.co.id/portal/product/list/live/all'],
  ['chat', 'https://seller.shopee.co.id/portal/chat-management'],
];

async function main(): Promise<void> {
  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('seller');
    for (const [label, url] of PAGES) {
      const urls = new Set<string>();
      const onResp = (r: Response): void => {
        const u = r.url();
        if (/seller\.shopee\.co\.id\/api\//.test(u) && !NOISE.test(u)) {
          urls.add(u.replace('https://seller.shopee.co.id', '').split('?')[0]);
        }
      };
      page.on('response', onResp);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(10000);
      } catch (e) {
        console.log(`⚠️ ${label}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      }
      page.off('response', onResp);
      console.log(`\n■ ${label} (final: ${page.url().slice(0, 90)})`);
      for (const u of urls) console.log(`   ${u}`);
    }
  });
  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
