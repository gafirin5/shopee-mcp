/**
 * Diagnostic probe — listens to EVERY XHR a page fires and reports the final
 * URL + API surface. Used to correct SELLER_PATHS / apiMatch candidates after
 * a Shopee UI drift.
 *
 *   npx tsx scripts/diagnose.ts
 */
import 'dotenv/config';
import type { Response } from 'playwright';
import { getContext, closeContext } from '../src/browser/session.js';
import { BASE_URL } from '../src/browser/session.js';

const PAGES: Array<[string, string]> = [
  ['buyer search', `${BASE_URL}/search?keyword=kaos%20polos&page=0`],
  ['seller home', 'PORTAL_ROOT'],
  ['seller orderList guess', 'PORTAL_ORDER'],
  ['seller productList guess', 'PORTAL_PRODUCT'],
];

async function main(): Promise<void> {
  const ctx = await getContext(false);
  const page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());

  for (const [label, rawUrl] of PAGES) {
    const url = rawUrl
      .replace('PORTAL_ROOT', 'https://seller.shopee.co.id/portal/')
      .replace('PORTAL_ORDER', 'https://seller.shopee.co.id/portal/order/list')
      .replace('PORTAL_PRODUCT', 'https://seller.shopee.co.id/portal/product/list');

    const apiUrls = new Set<string>();
    const searchCounts: string[] = [];
    const onResp = (r: Response): void => {
      const u = r.url();
      if (/\/api\//.test(u)) apiUrls.add(u.split('?')[0]);
      if (/search_items/.test(u)) {
        r.json()
          .then((j: { items?: unknown[]; total_count?: number }) => {
            searchCounts.push(
              `  ${u.slice(0, 110)} → items=${j.items?.length} total=${j.total_count}`,
            );
          })
          .catch(() => searchCounts.push(`  ${u.slice(0, 110)} → (non-JSON)`));
      }
    };
    page.on('response', onResp);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(12000);
    } catch (e) {
      console.log(
        `⚠️ ${label}: navigation issue — ${e instanceof Error ? e.message.split('\n')[0] : e}`,
      );
    }
    page.off('response', onResp);

    console.log(`\n■ ${label}`);
    console.log(`  final URL: ${page.url()}`);
    if (searchCounts.length) console.log('  search_items responses:');
    for (const s of searchCounts.slice(0, 6)) console.log(s);
    console.log(`  API endpoints seen (${apiUrls.size}):`);
    for (const u of [...apiUrls].slice(0, 20)) console.log(`   - ${u}`);
  }

  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('diagnose failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
