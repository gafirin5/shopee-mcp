/**
 * Investigate the shop onboarding gate: what verification does it actually
 * require? Grabs the structured onboarding status + the rendered page text +
 * a screenshot for visual inspection.
 *   npx tsx scripts/probe-onboarding.ts
 */
import 'dotenv/config';
import { portalApi } from '../src/seller/api.js';
import { withBrowserLock, closeContext, SELLER_BASE_URL } from '../src/browser/session.js';
import { debugShot } from '../src/actions/base.js';

async function main(): Promise<void> {
  // 1. Structured status from the onboarding API.
  for (const path of [
    '/api/selleraccount/get_shop_onboarding_info/',
    '/api/miscellaneous/get_top_bar_onboarding_entry/',
  ]) {
    try {
      const json = await portalApi<unknown>(path);
      console.log(`\n■ ${path}`);
      console.log(JSON.stringify(json, null, 1).slice(0, 2500));
    } catch (e) {
      console.log(`\n■ ${path} FAILED: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }

  // 2. What does the QR page actually SAY?
  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('seller');
    await page.goto(`${SELLER_BASE_URL}/portal/id-onboarding/qr-code`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    console.log(`\n■ final URL: ${page.url()}`);
    console.log(`■ title: ${await page.title().catch(() => '?')}`);
    const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim());
    console.log(`\n■ PAGE TEXT:\n${text.slice(0, 2500)}`);

    const qrImg = await page.locator('img[src*="qr"], img[class*="qr" i], canvas').count();
    console.log(`\n■ QR-ish elements: ${qrImg}`);

    const shot = await debugShot(page, 'onboarding-qr');
    console.log(`■ screenshot: ${shot}`);
  });

  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
