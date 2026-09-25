/**
 * Live status check — launches the real CloakBrowser session and reports
 * whether the buyer marketplace and the Seller Centre portal are reachable.
 * No interaction needed: safe to run before any login.
 *
 *   npx tsx scripts/live-status.ts
 */
import 'dotenv/config';
import { getContext, isLoggedIn, isSellerLoggedIn, closeContext } from '../src/browser/session.js';

async function main(): Promise<void> {
  console.log('Launching CloakBrowser (a window will appear)…');
  await getContext(false);
  const buyer = await isLoggedIn()
    .then((ok) => (ok ? 'LOGGED IN' : 'not logged in'))
    .catch((e) => `ERROR: ${e instanceof Error ? e.message : e}`);
  const seller = await isSellerLoggedIn()
    .then((ok) => (ok ? 'REACHABLE' : 'needs login'))
    .catch((e) => `ERROR: ${e instanceof Error ? e.message : e}`);
  console.log(`\nBuyer marketplace (shopee.co.id):        ${buyer}`);
  console.log(`Seller Centre portal (seller.…):         ${seller}`);
  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('live-status failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
