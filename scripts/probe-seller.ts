/**
 * Targeted seller-portal probe: captures the sidebar menu + shop info JSONs to
 * discover the REAL portal page paths and data endpoints on the live 2026 UI.
 *
 *   npx tsx scripts/probe-seller.ts
 */
import 'dotenv/config';
import { captureJson } from '../src/browser/session.js';
import { closeContext } from '../src/browser/session.js';

async function grab(
  label: string,
  pageUrl: string,
  match: string,
  maxChars: number,
): Promise<void> {
  try {
    const { json, matchedUrl } = await captureJson<unknown>(pageUrl, {
      apiMatch: match,
      timeoutMs: 30000,
      realm: 'seller',
    });
    console.log(`\n■ ${label} (via ${matchedUrl.slice(0, 130)})`);
    console.log(JSON.stringify(json, null, 1).slice(0, maxChars));
  } catch (e) {
    console.log(`\n■ ${label}: FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

async function main(): Promise<void> {
  // Any /portal/* page loads the shell app, which fires the sidebar + shop info calls.
  const portalPage = 'https://seller.shopee.co.id/portal/id-onboarding/qr-code';

  await grab('SIDEBAR MENU (real page paths)', portalPage, 'user_menu_list', 6000);
  await grab('SHOP INFO', portalPage, '/api/selleraccount/shop_info/', 2500);
  await grab('SHOP SETTINGS', portalPage, 'get_shop_settings', 2500);

  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('probe-seller failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
