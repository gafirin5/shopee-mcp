/**
 * Extract every sidebar inner_url (the real portal page paths).
 *   npx tsx scripts/probe-seller3.ts
 */
import 'dotenv/config';
import { withBrowserLock, closeContext, SELLER_BASE_URL } from '../src/browser/session.js';

interface MenuItem {
  key?: string;
  inner_url?: string;
  sub_menu_list?: MenuItem[];
}

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
    const menu = (await page.evaluate(
      async ({ cds }) => {
        const res = await fetch(
          `/api/sellermisc/sc_sidebar/user_menu_list/?SPC_CDS=${cds}&SPC_CDS_VER=2`,
          { credentials: 'include' },
        );
        return res.json();
      },
      { cds },
    )) as { data?: MenuItem[] };

    const out: string[] = [];
    const walk = (items: MenuItem[], depth: number): void => {
      for (const it of items ?? []) {
        if (it.inner_url) out.push(`${'  '.repeat(depth)}${it.key ?? '?'} → ${it.inner_url}`);
        if (it.sub_menu_list) walk(it.sub_menu_list, depth + 1);
      }
    };
    walk(menu.data ?? [], 0);
    console.log(out.join('\n'));
  });
  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
