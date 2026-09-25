/**
 * Open the Shopee login page in the persistent profile and POLL for login
 * (no Enter-press needed — just sign in in the window). After buyer login it
 * also checks whether the Seller Centre portal SSOs in automatically.
 *
 *   npx tsx scripts/open-login.ts [timeout_seconds]
 */
import 'dotenv/config';
import {
  getContext,
  isLoggedIn,
  isSellerLoggedIn,
  closeContext,
  BASE_URL,
  PROFILE_DIR,
} from '../src/browser/session.js';

const timeoutS = parseInt(process.argv[2] ?? '240', 10);

async function main(): Promise<void> {
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log('Opening Shopee login page…');
  const ctx = await getContext(false);
  const page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
  await page.goto(`${BASE_URL}/buyer/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const deadline = Date.now() + timeoutS * 1000;
  let buyer = false;
  while (Date.now() < deadline) {
    buyer = await isLoggedIn().catch(() => false);
    if (buyer) break;
    process.stdout.write(
      `⏳ Waiting for login… (${timeoutS - Math.round((deadline - Date.now()) / 1000)}s)\n`,
    );
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!buyer) {
    console.log(
      `\n🔒 No buyer login detected within ${timeoutS}s. Session profile is saved — re-run anytime.`,
    );
    return;
  }

  console.log('\n✅ Buyer login detected! Checking Seller Centre SSO…');
  const seller = await isSellerLoggedIn().catch(() => false);
  console.log(
    seller
      ? '✅ Seller Centre portal SSOs in automatically — seller tools are ready.'
      : 'ℹ️ Seller Centre needs its own login — run `npm run login:seller` after this.',
  );
}

main()
  .catch((err) => {
    console.error('open-login failed:', err);
    process.exitCode = 1;
  })
  .finally(() =>
    closeContext()
      .catch(() => {})
      .then(() => process.exit(process.exitCode ?? 0)),
  );
