/**
 * Record the EXACT request (method, post data, headers) the portal app makes
 * to its product/order data APIs, plus the response body — the contract to
 * replicate in direct calls.
 *   npx tsx scripts/probe-seller6.ts
 */
import 'dotenv/config';
import type { Request, Response } from 'playwright';
import { withBrowserLock, closeContext } from '../src/browser/session.js';

const TARGETS = [/get_product_list/, /search_product_list/, /order/];

async function main(): Promise<void> {
  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('seller');
    const seen = new Set<string>();

    const onRequest = (req: Request): void => {
      const u = req.url();
      if (!/seller\.shopee\.co\.id\/api\//.test(u)) return;
      if (!TARGETS.some((re) => re.test(u))) return;
      const key = `${req.method()} ${u.split('?')[0]}`;
      if (seen.has(key)) return;
      seen.add(key);
      console.log(`\n■ REQUEST ${key}`);
      console.log(`   headers: ${JSON.stringify(req.headers()).slice(0, 400)}`);
      console.log(`   post: ${req.postData()?.slice(0, 500) ?? '(none)'}`);
    };
    const onResponse = async (resp: Response): Promise<void> => {
      const u = resp.url();
      if (!TARGETS.some((re) => re.test(u)) || !/seller\.shopee\.co\.id\/api\//.test(u)) return;
      try {
        const body = await resp.text();
        console.log(
          `   ↳ RESPONSE ${resp.status()} ${u.split('?')[0]}: ${body.slice(0, 700).replace(/\n/g, ' ')}`,
        );
      } catch {
        console.log(`   ↳ RESPONSE ${resp.status()} (body unavailable)`);
      }
    };
    page.on('request', onRequest);
    page.on('response', (r) => void onResponse(r));

    for (const url of [
      'https://seller.shopee.co.id/portal/product/list/live/all',
      'https://seller.shopee.co.id/portal/sale/order',
    ]) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(12000);
      } catch (e) {
        console.log(`⚠️ nav: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      }
    }
    page.off('request', onRequest);
  });
  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
