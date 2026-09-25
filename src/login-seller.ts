#!/usr/bin/env node
/**
 * One-time Shopee Seller Centre login.
 *
 * Opens a visible Chromium window bound to the persistent profile and lets you
 * sign into the Seller Centre portal by hand. If your profile is already logged
 * into the marketplace with a seller account, the portal usually SSOs you in
 * automatically — in that case nothing to do.
 *
 *   npm run login:seller        (dev)   or   shopee-mcp-seller-login   (installed)
 */
import 'dotenv/config';
import readline from 'node:readline';
import {
  getContext,
  isSellerLoggedIn,
  closeContext,
  SELLER_BASE_URL,
  PROFILE_DIR,
} from './browser/session.js';

function prompt(question: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, () => {
      rl.close();
      resolve();
    }),
  );
}

async function main() {
  console.log('\n🏬 Shopee MCP — Seller Centre login\n');
  console.log(`Profile directory: ${PROFILE_DIR}`);
  console.log('Opening a Chromium window…\n');

  // Force a visible window regardless of SHOPEE_HEADLESS.
  const ctx = await getContext(false);
  const page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());

  await page.goto(`${SELLER_BASE_URL}/account/signin`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  if (await isSellerLoggedIn()) {
    console.log(
      '✅ Seller Centre is already reachable (SSO from the marketplace session). Nothing to do.\n',
    );
    await closeContext();
    return;
  }

  console.log('👉 In the Chromium window: log into your Shopee seller account.');
  console.log('   Complete any OTP / captcha Shopee shows.');
  await prompt('\nWhen the Seller Centre portal is open, press Enter here to save… ');

  const ok = await isSellerLoggedIn();
  if (ok) {
    console.log('\n✅ Seller session detected. You can close this and start the MCP server.\n');
  } else {
    console.log(
      '\n⚠️  Could not confirm the Seller Centre portal. The session is still saved to the profile —\n' +
        '   try `check_seller_login` anyway, or re-run `npm run login:seller`.\n',
    );
  }

  await closeContext();
}

main().catch(async (err) => {
  console.error('Seller login failed:', err);
  await closeContext().catch(() => {});
  process.exit(1);
});
