/**
 * Find the REAL data endpoints of the 2026 shop page.
 *   npx tsx scripts/probe-shoppage.ts
 */
import 'dotenv/config';
import type { Response } from 'playwright';
import { withBrowserLock, closeContext, BASE_URL } from '../src/browser/session.js';

async function main(): Promise<void> {
  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('buyer');
    const urls = new Set<string>();
    const onResp = (r: Response): void => {
      const u = r.url();
      if (
        /\/api\//.test(u) &&
        !/mmf-report|chatbot|experiment|log\?|tracking|beacon|subcart|payment_info|get_web_experiments|account\/basic|webchat/.test(
          u,
        )
      ) {
        urls.add(u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]);
      }
    };
    page.on('response', onResp);
    await page.goto(`${BASE_URL}/shop/1643579153/search?page=0`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(12000);
    console.log(`final: ${page.url()}`);
    console.log('APIs:');
    for (const u of urls) console.log(`  ${u}`);
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
