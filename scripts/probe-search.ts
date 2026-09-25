/**
 * One-shot shape probe: print the first search_items item card structure.
 *   npx tsx scripts/probe-search.ts
 */
import 'dotenv/config';
import { shopeeCapture, shopeeUrl } from '../src/api/client.js';
import { closeContext } from '../src/browser/session.js';

async function main(): Promise<void> {
  const data = await shopeeCapture<Record<string, unknown>>(
    shopeeUrl('/search?keyword=kaos%20polos&page=0'),
    'search/search_items',
  );
  console.log('top-level keys:', Object.keys(data).join(', '));
  const items = data.items as unknown[] | undefined;
  console.log('items length:', items?.length);
  const first = items?.[0];
  if (first && typeof first === 'object') {
    console.log('item[0] keys:', Object.keys(first).join(', '));
    console.log(JSON.stringify(first, null, 1).slice(0, 1200));
  }
  await closeContext().catch(() => {});
}

main()
  .catch((err) => {
    console.error('probe failed:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
