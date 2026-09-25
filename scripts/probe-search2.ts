/**
 * One-shot: inspect the item_data card shape in search_items.
 *   npx tsx scripts/probe-search2.ts
 */
import 'dotenv/config';
import { shopeeCapture, shopeeUrl } from '../src/api/client.js';
import { closeContext } from '../src/browser/session.js';

interface Card {
  item_basic?: unknown;
  item_data?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const data = await shopeeCapture<{ items?: Card[] }>(
    shopeeUrl('/search?keyword=kaos%20polos&page=0'),
    'search/search_items',
  );
  const cards = data.items ?? [];
  const withData = cards.filter((c) => c?.item_data);
  const withBasic = cards.filter((c) => c?.item_basic);
  console.log(
    `cards=${cards.length} with item_data=${withData.length} with item_basic=${withBasic.length}`,
  );
  const sample = withData[0]?.item_data;
  if (sample) {
    console.log('ALL item_data keys:', Object.keys(sample).join(', '));
    for (const k of [
      'item_card_display_price',
      'item_card_display_sold_count',
      'shop_data',
      'item_rating',
      'global_brand',
    ]) {
      console.log(`\n${k}:`, JSON.stringify(sample[k])?.slice(0, 400));
    }
  }
  // Hunt for the product NAME: card top-level display fields + tracking JSON.
  const card = withData[0] as Record<string, unknown> | undefined;
  if (card) {
    console.log('\n--- name hunt on card ---');
    console.log('display_name:', JSON.stringify(card.display_name));
    for (const k of ['bff_item_tracking', 'search_item_tracking', 'item_card_label_groups']) {
      console.log(`${k}:`, JSON.stringify(card[k])?.slice(0, 500));
    }
    // json_data is base64 — try decoding and grep printable name-ish strings.
    const jd = card.json_data;
    if (typeof jd === 'string') {
      try {
        const decoded = Buffer.from(jd, 'base64').toString('utf-8');
        const printable = decoded.match(/[\x20-\x7E]{8,}/g)?.slice(0, 8);
        console.log('json_data printable strings:', printable);
      } catch {
        console.log('json_data: not base64');
      }
    }
  }
  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('probe failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
