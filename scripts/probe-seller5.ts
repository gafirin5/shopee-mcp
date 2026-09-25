/**
 * Test portal DATA APIs via direct fetch (do they bypass the onboarding gate?).
 *   npx tsx scripts/probe-seller5.ts
 */
import 'dotenv/config';
import { withBrowserLock, closeContext, SELLER_BASE_URL } from '../src/browser/session.js';

async function main(): Promise<void> {
  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('seller');
    await page.goto(`${SELLER_BASE_URL}/portal/id-onboarding/qr-code`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(4000);
    const cds = await page.evaluate(() => document.cookie.match(/SPC_CDS=([^;]+)/)?.[1] ?? null);
    if (!cds) {
      console.log('SPC_CDS not found');
      return;
    }

    const call = async (
      label: string,
      path: string,
      init?: { method?: string; body?: unknown },
    ): Promise<void> => {
      try {
        const out = await page.evaluate(
          async ({ p, cds, method, body }) => {
            const res = await fetch(
              `${p}${p.includes('?') ? '&' : '?'}SPC_CDS=${cds}&SPC_CDS_VER=2`,
              {
                method: method ?? 'GET',
                credentials: 'include',
                headers: body ? { 'content-type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined,
              },
            );
            const text = await res.text();
            return { status: res.status, text: text.slice(0, 600) };
          },
          { p: path, cds, method: init?.method, body: init?.body },
        );
        console.log(
          `\n■ ${label} → HTTP ${out.status}\n   ${out.text.replace(/\n/g, ' ').slice(0, 550)}`,
        );
      } catch (e) {
        console.log(`\n■ ${label} → FAILED: ${e instanceof Error ? e.message : e}`);
      }
    };

    await call('product list v3', '/api/v3/opt/mpsku/list/v2/get_product_list/', {
      method: 'POST',
      body: { offset: 0, limit: 10, need_activity_info: false, need_image_info: false },
    });
    await call('product list search', '/api/v3/opt/mpsku/list/v2/search_product_list/', {
      method: 'POST',
      body: { offset: 0, limit: 10, search_type: 'all' },
    });
    await call('order list v2', '/api/v2/order/get_order_list/', {
      method: 'POST',
      body: { offset: 0, limit: 10 },
    });
    await call('order list v1', '/api/v1/orders/', { method: 'GET' });
    await call('income summary', '/api/v2/income/get_income_summary/', { method: 'GET' });
  });

  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
