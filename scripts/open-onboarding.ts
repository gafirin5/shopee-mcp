/**
 * Open the seller-verification QR page and poll the onboarding API until the
 * shop is verified (is_onboarded === 1) — then report. The QR may refresh
 * itself; leave this window open while you scan with the Shopee app.
 *   npx tsx scripts/open-onboarding.ts [timeout_seconds]
 */
import 'dotenv/config';
import { portalApi } from '../src/seller/api.js';
import { withBrowserLock, closeContext, SELLER_BASE_URL } from '../src/browser/session.js';

const timeoutS = parseInt(process.argv[2] ?? '900', 10);

interface OnboardingInfo {
  code?: number;
  data?: { is_onboarded?: number; pc_web_redirect_uri?: string };
}

async function main(): Promise<void> {
  console.log('Opening the verification QR page…');
  console.log('👉 Scan the QR with the Shopee app on your phone, then approve there.');

  await withBrowserLock(async () => {
    const { getPageFor } = await import('../src/browser/session.js');
    const page = await getPageFor('seller');
    await page.goto(`${SELLER_BASE_URL}/portal/id-onboarding/qr-code`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  });

  const deadline = Date.now() + timeoutS * 1000;
  let onboarded = false;
  while (Date.now() < deadline) {
    try {
      const info = await portalApi<OnboardingInfo>('/api/selleraccount/get_shop_onboarding_info/');
      const state = info.data?.is_onboarded;
      if (state === 1) {
        onboarded = true;
        break;
      }
    } catch {
      // transient — keep polling
    }
    const left = Math.round((deadline - Date.now()) / 1000);
    process.stdout.write(`⏳ Waiting for verification… (${left}s left)\n`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (onboarded) {
    console.log(
      '\n🎉 VERIFIED! is_onboarded=1 — all Seller Centre & creator-center features are now open.',
    );
    console.log('   Next: test upload_product_video and the seller tools from the MCP client.');
  } else {
    console.log(
      `\n🔒 Not verified within ${timeoutS}s. The QR may have expired — re-run to get a fresh one.`,
    );
  }
}

main()
  .catch((err) => {
    console.error('failed:', err);
    process.exitCode = 1;
  })
  .finally(() =>
    closeContext()
      .catch(() => {})
      .then(() => process.exit(process.exitCode ?? 0)),
  );
