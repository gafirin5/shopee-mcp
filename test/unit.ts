/**
 * Offline unit tests for pure helpers — no browser, no login, no network.
 * Unlike test/smoke.ts (live), this is safe to run in CI on every push.
 *
 * Run with: npm run test:unit
 */
import assert from 'node:assert/strict';
import { flattenSearchCards, flattenSearchItems, formatPrice } from '../src/tools/search.js';
import { parseProductUrl } from '../src/tools/product.js';
import { shopeeCapture, ShopeeAuthRequiredError } from '../src/api/client.js';
import { cache } from '../src/utils/cache.js';
import { findArray, previewRow, formatSellerPayload } from '../src/tools/seller/format.js';
import { findVideoInfo } from '../src/utils/media.js';
import { summarizeJson } from '../src/utils/json.js';
import { parseProductRef } from '../src/tools/research.js';
import type { SearchItem, ItemBasic } from '../src/api/types.js';

let failures = 0;
const pending: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  pending.push({ name, fn });
}

async function runTests(): Promise<void> {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (err) {
      failures++;
      console.log(`❌ ${name}`);
      console.log(`   ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function fakeItemBasic(overrides: Partial<ItemBasic> = {}): ItemBasic {
  return {
    itemid: 1,
    shopid: 1,
    name: 'Test Product',
    price: 1000000,
    price_min: 1000000,
    price_max: 1000000,
    price_before_discount: 0,
    currency: 'IDR',
    stock: 10,
    sold: 5,
    historical_sold: 5,
    liked_count: 0,
    item_rating: { rating_star: 4.5, rating_count: [] },
    shop_location: 'Jakarta',
    is_official_shop: false,
    shopee_verified: false,
    image: '',
    ...overrides,
  };
}

// ─── flattenSearchItems (the #25 fix) ──────────────────────────────────────

test('flattenSearchItems: passes through plain cards with item_basic', () => {
  const b = fakeItemBasic({ itemid: 1 });
  const items: SearchItem[] = [{ itemid: 1, shopid: 1, item_basic: b }];
  assert.deepEqual(flattenSearchItems(items), [b]);
});

test('flattenSearchItems: flattens a recommendation/ads card with real_items', () => {
  // Reproduces the exact crash from #25: a card with no top-level item_basic,
  // whose real products are nested under real_items.
  const b1 = fakeItemBasic({ itemid: 1 });
  const b2 = fakeItemBasic({ itemid: 2 });
  const adsCard = {
    itemid: 0,
    shopid: 0,
    item_basic: null as unknown as ItemBasic,
    real_items: [{ item_basic: b1 }, { item_basic: b2 }],
  };
  assert.deepEqual(flattenSearchItems([adsCard]), [b1, b2]);
});

test('flattenSearchItems: mixes plain and ads cards in order', () => {
  const plain = fakeItemBasic({ itemid: 1 });
  const nested = fakeItemBasic({ itemid: 2 });
  const items = [
    { itemid: 1, shopid: 1, item_basic: plain },
    {
      itemid: 0,
      shopid: 0,
      item_basic: null as unknown as ItemBasic,
      real_items: [{ item_basic: nested }],
    },
  ];
  assert.deepEqual(flattenSearchItems(items), [plain, nested]);
});

test('flattenSearchItems: drops a card with neither item_basic nor real_items', () => {
  const dead = { itemid: 0, shopid: 0, item_basic: null as unknown as ItemBasic };
  assert.deepEqual(flattenSearchItems([dead]), []);
});

test('flattenSearchItems: drops null item_basic entries nested in real_items', () => {
  const good = fakeItemBasic({ itemid: 1 });
  const card = {
    itemid: 0,
    shopid: 0,
    item_basic: null as unknown as ItemBasic,
    real_items: [{ item_basic: good }, { item_basic: null as unknown as ItemBasic }],
  };
  assert.deepEqual(flattenSearchItems([card]), [good]);
});

test('flattenSearchItems: handles null/undefined items list', () => {
  assert.deepEqual(flattenSearchItems(null), []);
  assert.deepEqual(flattenSearchItems(undefined), []);
});

// ─── flattenSearchCards (2026 item_data shape, verified live) ───────────────

test('flattenSearchCards: maps the new item_data card (name left empty for DOM fill)', () => {
  const card = {
    itemid: 1,
    shopid: 1,
    item_basic: null as never,
    item_data: {
      itemid: 50068259700,
      shopid: 1643579153,
      item_card_display_price: {
        price: 3450000000,
        strikethrough_price: 12000000000,
        discount: 71,
      },
      item_card_display_sold_count: { historical_sold_count: 0, monthly_sold_count: 0 },
      item_rating: { rating_star: 0 },
      shop_data: { shop_name: 'CAVALARY' },
    },
  };
  const hits = flattenSearchCards([card]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].itemid, 50068259700);
  assert.equal(hits[0].price, 3450000000);
  assert.equal(hits[0].priceBefore, 12000000000);
  assert.equal(hits[0].shopLocation, 'CAVALARY');
  assert.equal(hits[0].name, '');
});

test('flattenSearchCards: still maps the legacy item_basic shape', () => {
  const b = fakeItemBasic({ itemid: 7, name: 'Kaos' });
  const hits = flattenSearchCards([{ itemid: 7, shopid: 1, item_basic: b }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Kaos');
  assert.equal(hits[0].sold, 5);
});

test('flattenSearchCards: unwraps real_items ads cards', () => {
  const b1 = fakeItemBasic({ itemid: 1 });
  const card = {
    itemid: 0,
    shopid: 0,
    item_basic: null as never,
    real_items: [{ item_basic: b1 }],
  };
  const hits = flattenSearchCards([card]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].itemid, 1);
});

test('flattenSearchCards: drops dead cards', () => {
  const dead = { itemid: 0, shopid: 0, item_basic: null as never };
  assert.deepEqual(flattenSearchCards([dead, null]), []);
});

// ─── formatPrice ────────────────────────────────────────────────────────────

test('formatPrice: divides by 100000 and formats IDR with Rp prefix', () => {
  assert.equal(formatPrice(15000000000), 'Rp150.000');
});

test('formatPrice: rounds fractional amounts', () => {
  assert.equal(formatPrice(15000050000), 'Rp150.001');
});

test('formatPrice: falls back to "CURRENCY amount" for non-IDR', () => {
  assert.equal(formatPrice(500000000, 'USD'), 'USD 5.000');
});

// ─── parseProductUrl ────────────────────────────────────────────────────────

test('parseProductUrl: parses /product/<shopid>/<itemid> form', () => {
  assert.deepEqual(parseProductUrl('https://shopee.co.id/product/78730497/47060432055'), {
    shopId: '78730497',
    itemId: '47060432055',
  });
});

test('parseProductUrl: parses "-i.<shopid>.<itemid>" slug form', () => {
  assert.deepEqual(
    parseProductUrl('https://shopee.co.id/Some-Product-Name-i.78730497.47060432055'),
    { shopId: '78730497', itemId: '47060432055' },
  );
});

test('parseProductUrl: returns null for an unrelated URL', () => {
  assert.equal(parseProductUrl('https://shopee.co.id/'), null);
});

// ─── cache ──────────────────────────────────────────────────────────────────

test('cache: set/get round-trips within TTL', () => {
  cache.set('unit-test-key', 'value');
  assert.equal(cache.get('unit-test-key'), 'value');
});

test('cache: get returns undefined for a missing key', () => {
  assert.equal(cache.get('never-set-key'), undefined);
});

test('cache: key() joins parts with ":"', () => {
  assert.equal(cache.key('search', 'shoes', 1, 20, 'relevance'), 'search:shoes:1:20:relevance');
});

// ─── shopeeCapture retry-on-timeout ─────────────────────────────────────────

test('shopeeCapture: recovers from a single timeout via retry, no auth error', async () => {
  let calls = 0;
  const flakyCapture = async () => {
    calls++;
    if (calls === 1) throw new Error('Timeout 30000ms exceeded');
    return { json: { error: 0, items: [] }, matchedUrl: 'https://x/api/v4/search' };
  };
  const result = await shopeeCapture(
    'https://x',
    'search/search_items',
    undefined,
    false,
    flakyCapture,
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { error: 0, items: [] });
});

test('shopeeCapture: reports auth-required only after a second consecutive timeout', async () => {
  let calls = 0;
  const alwaysTimesOut = async () => {
    calls++;
    throw new Error('Timeout 30000ms exceeded');
  };
  await assert.rejects(
    () => shopeeCapture('https://x', 'search/search_items', undefined, false, alwaysTimesOut),
    ShopeeAuthRequiredError,
  );
  assert.equal(calls, 2);
});

// ─── seller list formatting (findArray / previewRow / formatSellerPayload) ──

test('findArray: finds the array under a known key', () => {
  const payload = { error: 0, data: { order_list: [{ order_id: 1 }] } };
  assert.deepEqual(findArray(payload, ['orders', 'order_list']), [{ order_id: 1 }]);
});

test('findArray: searches wrapper objects when the key misses at the root', () => {
  const payload = { result: { content: [{ id: 9 }] } };
  assert.deepEqual(findArray(payload, ['list', 'content']), [{ id: 9 }]);
});

test('findArray: returns undefined for array-less payloads', () => {
  assert.equal(findArray({ error: 0 }, ['list']), undefined);
  assert.equal(findArray(null, ['list']), undefined);
});

test('previewRow: renders the common fields it finds', () => {
  const line = previewRow({
    order_id: 123,
    item_name: 'Kaos Polos',
    order_status: 'UNPAID',
    total_amount: 150000,
    quantity: 2,
  });
  assert.match(line, /Kaos Polos/);
  assert.match(line, /#123/);
  assert.match(line, /UNPAID/);
  assert.match(line, /amount=150000/);
  assert.match(line, /qty=2/);
});

test('previewRow: falls back to a JSON snippet for unknown shapes', () => {
  const line = previewRow({ weird_field: true });
  assert.match(line, /weird_field/);
});

test('previewRow: handles non-object rows', () => {
  assert.match(previewRow('plain string'), /plain string/);
});

test('formatSellerPayload: renders rows when a list is found', () => {
  const text = formatSellerPayload(
    '📦 Orders',
    { data: { order_list: [{ order_id: 1 }, { order_id: 2 }] } },
    ['order_list'],
  );
  assert.match(text, /📦 Orders/);
  assert.match(text, /#1/);
  assert.match(text, /#2/);
});

test('formatSellerPayload: falls back to a raw preview when no list exists', () => {
  const text = formatSellerPayload('🏪 Shop', { shop_name: 'Toko' }, ['list']);
  assert.match(text, /shop_name/);
});

// ─── video detection (findVideoInfo) ────────────────────────────────────────

test('findVideoInfo: finds video_url under video_info', () => {
  const payload = {
    error: 0,
    data: {
      video_info: {
        video_url: '//cf.shopee.co.id/video.mp4',
        video_cover: '//cf.shopee.co.id/cover.jpg',
      },
    },
  };
  const info = findVideoInfo(payload);
  assert.ok(info);
  assert.equal(info.url, 'https://cf.shopee.co.id/video.mp4');
  assert.equal(info.cover, 'https://cf.shopee.co.id/cover.jpg');
  assert.match(info.foundAt, /video_info/);
});

test('findVideoInfo: treats a bare video URL string as a hit', () => {
  const info = findVideoInfo({ data: { video: 'https://x.example/v.mp4' } });
  assert.ok(info);
  assert.equal(info.url, 'https://x.example/v.mp4');
});

test('findVideoInfo: reports a video-keyed object even without a URL', () => {
  const info = findVideoInfo({ data: { video_metadata: { duration: 12 } } });
  assert.ok(info);
  assert.equal(info.url, undefined);
  assert.match(info.foundAt, /video_metadata/);
});

test('findVideoInfo: returns undefined when no video keys exist', () => {
  assert.equal(findVideoInfo({ data: { name: 'Kaos', price: 1 } }), undefined);
});

// ─── summarizeJson ──────────────────────────────────────────────────────────

test('summarizeJson: passes short JSON through untouched', () => {
  assert.equal(summarizeJson({ a: 1 }), '{\n  "a": 1\n}');
});

test('summarizeJson: truncates long payloads with a note', () => {
  const text = summarizeJson({ blob: 'x'.repeat(10000) }, 500);
  assert.match(text, /truncated, \d+ chars total/);
});

// ─── parseProductRef (compare_prices input) ─────────────────────────────────

test('parseProductRef: parses a full marketplace URL', () => {
  assert.deepEqual(parseProductRef('https://shopee.co.id/Product-i.78730497.47060432055'), {
    shopId: '78730497',
    itemId: '47060432055',
  });
});

test('parseProductRef: parses a shopid:itemid pair', () => {
  assert.deepEqual(parseProductRef('78730497:47060432055'), {
    shopId: '78730497',
    itemId: '47060432055',
  });
});

test('parseProductRef: pairs tolerate spaces and | separators', () => {
  assert.deepEqual(parseProductRef(' 78730497 | 47060432055 '), {
    shopId: '78730497',
    itemId: '47060432055',
  });
});

test('parseProductRef: a bare itemid needs a default shop id', () => {
  assert.equal(parseProductRef('47060432055'), null);
  assert.deepEqual(parseProductRef('47060432055', '78730497'), {
    shopId: '78730497',
    itemId: '47060432055',
  });
});

test('parseProductRef: rejects garbage', () => {
  assert.equal(parseProductRef('not-a-product'), null);
});

await runTests();
console.log(
  `\n${failures === 0 ? '✅ All unit tests passed' : `❌ ${failures} unit test(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
