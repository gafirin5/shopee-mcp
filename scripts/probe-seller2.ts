/**
 * Direct portal-API probe from inside the page context (cookies + SPC_CDS,
 * no anti-fraud signature needed). Discovers the REAL portal page paths via
 * the sidebar menu, and demonstrates the direct-fetch read pattern.
 *
 *   npx tsx scripts/probe-seller2.ts
 */
import 'dotenv/config';
import { withBrowserLock, closeContext } from '../src/browser/session.js';
import { SELLER_BASE_URL } from '../src/browser/session.js';

async function main(): Promise<void> {
  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('seller');
    // Any page on the seller subdomain gives us the cookies; the shell loads even on 404.
    await page.goto(`${SELLER_BASE_URL}/portal/id-onboarding/qr-code`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(5000);

    const cds = await page.evaluate(() => {
      const m = document.cookie.match(/SPC_CDS=([^;]+)/);
      return m ? m[1] : null;
    });
    console.log(`SPC_CDS: ${cds ? cds.slice(0, 8) + '…' : 'NOT FOUND'}`);
    if (!cds) return;

    const callApi = (path: string): Promise<unknown> =>
      page.evaluate(
        async ({ p, cds }) => {
          const res = await fetch(`${p}?SPC_CDS=${cds}&SPC_CDS_VER=2`, {
            credentials: 'include',
          });
          return res.json();
        },
        { p: path, cds },
      );

    // 1. Sidebar menu — should carry the real page paths.
    try {
      const menu = await callApi('/api/sellermisc/sc_sidebar/user_menu_list/');
      console.log('\n■ SIDEBAR MENU');
      console.log(JSON.stringify(menu, null, 1).slice(0, 7000));
    } catch (e) {
      console.log(`\n■ SIDEBAR MENU failed: ${e instanceof Error ? e.message : e}`);
    }

    // 2. Account info for completeness.
    try {
      const ui = await callApi('/api/selleraccount/user_info/');
      console.log('\n■ USER INFO');
      console.log(JSON.stringify(ui, null, 1).slice(0, 1500));
    } catch (e) {
      console.log(`\n■ USER INFO failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('probe-seller2 failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
