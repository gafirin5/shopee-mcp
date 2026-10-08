/**
 * Browser tests for the buyer-side account actions: like, follow, claim a shop
 * voucher, add to cart, and edit the cart. They run against a local fixture of the
 * storefront instead of the live site.
 *
 *  - Nothing leaves the machine: requests to any host other than the fixture are
 *    aborted, and everything the server writes goes under a throwaway HOME.
 *  - The tools are called through their registered handlers, with the SDK's zod
 *    defaults applied, so the confirm gates, the page-driving code, the Shopee
 *    response checks, the write budget and the audit log all run for real.
 *  - The fixture implements what src/tools/* expects from Shopee's pages and API
 *    (field names, button labels, request bodies). It cannot show that those match
 *    Shopee's current site; that needs one look at the live pages.
 *
 * Needs a Chromium binary the CloakBrowser wrapper can launch:
 *
 *   CLOAKBROWSER_BINARY_PATH=/path/to/chromium npm run test:browser
 *
 * Without the variable the file prints SKIPPED and exits 0, so CI is unaffected.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Request, Route } from 'playwright';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const BINARY = process.env.CLOAKBROWSER_BINARY_PATH;
if (!BINARY) {
  console.log(
    '⏭  test:browser (buyer) SKIPPED — set CLOAKBROWSER_BINARY_PATH to a Chromium binary to run it.',
  );
  process.exit(0);
}

// Set before importing src/: several modules compute their paths when they load.
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'shopee-mcp-buyer-'));
Object.assign(process.env, {
  HOME,
  SHOPEE_PROFILE_DIR: path.join(HOME, 'profile'),
  SHOPEE_DOMAIN: 'shopee.test',
  SHOPEE_HEADLESS: 'true',
  SHOPEE_ENABLE_SELLER_WRITES: 'true',
  SHOPEE_ACTION_TIMEOUT_MS: '10000',
  SHOPEE_ACTION_DELAY_MS: '0',
  SHOPEE_READ_SPACING_MS: '0',
  SHOPEE_READ_SPREAD_MS: '0',
  SHOPEE_READ_MAX_PER_HOUR: '1000',
  SHOPEE_WRITE_SPACING_MS: '0',
  SHOPEE_WRITE_SPREAD_MS: '0',
  SHOPEE_WRITE_MAX_PER_HOUR: '1000',
  SHOPEE_WRITE_MAX_PER_DAY: '1000',
});

const { getContext, safetyStatus, closeContext } = await import('../src/browser/session.js');
const { registerActionTools } = await import('../src/tools/actions.js');
const { registerCartTools } = await import('../src/tools/cart.js');
const { registerShopeeVideoTools } = await import('../src/tools/shopeeVideo.js');

const BUYER_HOST = 'shopee.test';
const BUYER_BASE = `https://${BUYER_HOST}`;
const SHOP_ID = '500001';

// ─── Tool access ──────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Collect the handlers a register function declares, the way the SDK would see them. */
function recordTools(
  register: (server: McpServer) => void,
): Map<string, { shape: Record<string, unknown>; handler: ToolHandler }> {
  const found = new Map<string, { shape: Record<string, unknown>; handler: ToolHandler }>();
  const fake = {
    tool(
      name: string,
      _description: string,
      shape: Record<string, unknown>,
      _annotations: unknown,
      handler: ToolHandler,
    ) {
      found.set(name, { shape, handler });
      return { enabled: true };
    },
  };
  register(fake as unknown as McpServer);
  return found;
}

const tools = new Map([
  ...recordTools(registerActionTools),
  ...recordTools(registerCartTools),
  ...recordTools(registerShopeeVideoTools),
]);

/** Call a tool the way the SDK does: arguments are parsed with its shape first, so defaults apply. */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name);
  assert.ok(tool, `${name} should be registered`);
  const parsed = z.object(tool.shape as Record<string, z.ZodType>).parse(args);
  const result = await tool.handler(parsed);
  return result.content[0].text;
}

// ─── Fixture state ────────────────────────────────────────────────────────────

interface BuyerModel {
  model_id: number;
  name: string;
  price: number;
  has_stock: boolean;
  extinfo: { tier_index: number[] };
}

interface BuyerProduct {
  itemid: string;
  shopid: string;
  title: string;
  liked: boolean;
  tiers: Array<{ name: string; options: string[] }>;
  models: BuyerModel[];
  /** The product page has no heart button. */
  noLikeButton?: boolean;
  /** Shopee rejects the like / unlike call. */
  likeError?: boolean;
  /** The page's quantity box cannot go above this. */
  maxQty?: number;
  /** Shopee rejects add_to_cart. */
  addError?: boolean;
}

interface BuyerVoucher {
  promotionid: number;
  voucher_code: string;
  discount_value?: number;
  discount_percentage?: number;
  discount_cap?: number;
  min_spend?: number;
  is_claimed_before: boolean;
  /** The page shows "Use" for this voucher even though it is not claimed. */
  usedUp?: boolean;
}

interface BuyerShop {
  name: string;
  followed: boolean;
  vouchers: BuyerVoucher[];
  noFollowButton?: boolean;
  followError?: boolean;
  /** The page has a second \"Claim\" button outside the voucher strip. */
  extraClaimButton?: boolean;
  saveError?: boolean;
  /** Shopee saves this code instead of the one asked for. */
  saveReturnsCode?: string;
}

interface BuyerLine {
  itemid: number;
  shopid: number;
  modelid: number;
  name: string;
  model_name: string | null;
  price: number;
  quantity: number;
  /** The cart row's quantity box cannot go above this. */
  maxQty?: number;
}

interface BuyerState {
  products: Record<string, BuyerProduct>;
  shops: Record<string, BuyerShop>;
  cart: BuyerLine[];
  /** Shopee rejects every cart/update call. */
  cartUpdateError: boolean;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  /** Storefront pages the browser asked for (not API calls). */
  pageViews: string[];
}

// Prices are Shopee's amount × 100000.
const PRISTINE: BuyerState = {
  products: {
    '9000001': {
      itemid: '9000001',
      shopid: SHOP_ID,
      title: 'Water bottle',
      liked: false,
      tiers: [],
      models: [
        {
          model_id: 1000001,
          name: 'Default',
          price: 4500000000,
          has_stock: true,
          extinfo: { tier_index: [] },
        },
      ],
    },
    '9000002': {
      itemid: '9000002',
      shopid: SHOP_ID,
      title: 'Sneakers',
      liked: true,
      tiers: [
        { name: 'Warna', options: ['Merah', 'Biru'] },
        { name: 'Ukuran', options: ['39', '40'] },
      ],
      models: [
        {
          model_id: 2000001,
          name: 'Merah, 39',
          price: 8500000000,
          has_stock: true,
          extinfo: { tier_index: [0, 0] },
        },
        {
          model_id: 2000002,
          name: 'Merah, 40',
          price: 8500000000,
          has_stock: true,
          extinfo: { tier_index: [0, 1] },
        },
        {
          model_id: 2000003,
          name: 'Biru, 39',
          price: 8800000000,
          has_stock: true,
          extinfo: { tier_index: [1, 0] },
        },
        {
          model_id: 2000004,
          name: 'Biru, 40',
          price: 8800000000,
          has_stock: false,
          extinfo: { tier_index: [1, 1] },
        },
      ],
    },
    '9000003': {
      itemid: '9000003',
      shopid: SHOP_ID,
      title: 'Hoodie',
      liked: false,
      tiers: [],
      models: [
        {
          model_id: 3000001,
          name: 'Default',
          price: 12000000000,
          has_stock: false,
          extinfo: { tier_index: [] },
        },
      ],
    },
  },
  shops: {
    [SHOP_ID]: {
      name: 'Toko Contoh',
      followed: false,
      vouchers: [
        {
          promotionid: 1,
          voucher_code: 'SHIP5',
          discount_value: 500000000,
          min_spend: 5000000000,
          is_claimed_before: false,
        },
        {
          promotionid: 2,
          voucher_code: 'DISC10',
          discount_percentage: 10,
          discount_cap: 2000000000,
          min_spend: 10000000000,
          is_claimed_before: false,
        },
        {
          promotionid: 3,
          voucher_code: 'OLD7',
          discount_percentage: 7,
          is_claimed_before: true,
        },
      ],
    },
  },
  cart: [
    {
      itemid: 9000001,
      shopid: 500001,
      modelid: 1000001,
      name: 'Water bottle',
      model_name: null,
      price: 4500000000,
      quantity: 1,
    },
    {
      itemid: 9000002,
      shopid: 500001,
      modelid: 2000001,
      name: 'Sneakers',
      model_name: 'Merah, 39',
      price: 8500000000,
      quantity: 1,
    },
    {
      itemid: 9000002,
      shopid: 500001,
      modelid: 2000003,
      name: 'Sneakers',
      model_name: 'Biru, 39',
      price: 8800000000,
      quantity: 2,
    },
    {
      itemid: 9000003,
      shopid: 500001,
      modelid: 3000001,
      name: 'Hoodie',
      model_name: null,
      price: 12000000000,
      quantity: 1,
      maxQty: 3,
    },
  ],
  cartUpdateError: false,
  calls: [],
  pageViews: [],
};

let buyer: BuyerState = structuredClone(PRISTINE);
const resetBuyer = (): void => {
  buyer = structuredClone(PRISTINE);
};

const callsTo = (p: string): number => buyer.calls.filter((c) => c.path === p).length;
const shop = (): BuyerShop => buyer.shops[SHOP_ID];
const product = (id: string): BuyerProduct => buyer.products[id];
const lineFor = (itemid: number, modelid: number): BuyerLine | undefined =>
  buyer.cart.find((l) => l.itemid === itemid && l.modelid === modelid);

// ─── Pages ────────────────────────────────────────────────────────────────────

// The page scripts are plain strings. Keep backticks and template placeholders out of them.

const PDP_SCRIPT = String.raw`
const ITEM = document.body.dataset.item;
const SHOP = document.body.dataset.shop;
const MAX = Number(document.body.dataset.maxQty || 99);
const JSON_HEADERS = { 'content-type': 'application/json' };
const qtyInput = document.getElementById('qty');
const incBtn = document.querySelector('button[aria-label="Increase"]');
const decBtn = document.querySelector('button[aria-label="Decrease"]');
let product = null;
let liked = false;
let selected = [];
function setQty(n) {
  qtyInput.value = String(n);
  incBtn.disabled = n >= MAX;
  decBtn.disabled = n <= 1;
}
incBtn.addEventListener('click', () => setQty(Number(qtyInput.value) + 1));
decBtn.addEventListener('click', () => setQty(Number(qtyInput.value) - 1));
setQty(1);
function findModel() {
  const models = product.models || [];
  if ((product.tier_variations || []).length === 0) return models[0] || null;
  return models.find((m) => JSON.stringify(m.extinfo.tier_index) === JSON.stringify(selected)) || null;
}
function choose(ti, oi) {
  selected[ti] = oi;
  setQty(1);
  fetch('/api/v4/cart_panel/select_variation_pc', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ itemid: Number(ITEM), selected: selected }) });
}
function render() {
  const holder = document.getElementById('variations');
  holder.innerHTML = '';
  (product.tier_variations || []).forEach((tier, ti) => {
    tier.options.forEach((opt, oi) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt;
      b.setAttribute('aria-label', opt);
      b.addEventListener('click', () => choose(ti, oi));
      holder.appendChild(b);
    });
  });
}
const likeBtn = document.getElementById('like-btn');
if (likeBtn) likeBtn.addEventListener('click', async () => {
  const path = liked ? '/api/v4/pages/unlike_items' : '/api/v4/pages/like_items';
  const r = await fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ itemid: Number(ITEM) }) });
  const j = await r.json();
  if (!j.error) liked = !liked;
});
document.getElementById('add').addEventListener('click', async () => {
  const model = findModel();
  const r = await fetch('/api/v4/cart/add_to_cart', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ itemid: Number(ITEM), modelid: model ? model.model_id : 0, quantity: Number(qtyInput.value) }) });
  await r.json();
});
fetch('/api/v4/pdp/get_pc?itemid=' + ITEM + '&shopid=' + SHOP).then((r) => r.json()).then((j) => {
  product = j.data.item;
  liked = !!j.data.product_review.liked;
  render();
});
`;

const SHOP_SCRIPT = String.raw`
const SHOP = document.body.dataset.shop;
const JSON_HEADERS = { 'content-type': 'application/json' };
let followed = false;
let vouchers = [];
const followBtn = document.getElementById('follow-btn');
function renderVouchers() {
  const strip = document.getElementById('vouchers');
  strip.innerHTML = '';
  vouchers.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = v.is_claimed_before || v.usedUp ? 'Use' : 'Claim';
    b.addEventListener('click', () => claim(v));
    strip.appendChild(b);
  });
}
async function claim(v) {
  const r = await fetch('/api/v4/voucher_wallet/save_voucher', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ voucher_code: v.voucher_code }) });
  const j = await r.json();
  if (!j.error) {
    v.is_claimed_before = true;
    renderVouchers();
  }
}
if (followBtn) followBtn.addEventListener('click', async () => {
  const path = followed ? '/api/v4/shop/unfollow' : '/api/v4/shop/follow';
  const r = await fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ shopid: Number(SHOP) }) });
  const j = await r.json();
  if (!j.error) {
    followed = !followed;
    followBtn.textContent = followed ? 'Following' : 'Follow';
  }
});
fetch('/api/v4/shop/get_shop_base_v2?shopid=' + SHOP).then((r) => r.json()).then((j) => {
  followed = !!j.data.followed;
  document.getElementById('shop-name').textContent = j.data.name;
  if (followBtn) followBtn.textContent = followed ? 'Following' : 'Follow';
});
fetch('/api/v4/shop/get_shop_tab?shopid=' + SHOP + '&tab=voucher').then((r) => r.json()).then((j) => {
  vouchers = (j.data.decoration || []).flatMap((d) => (d.shop_voucher && d.shop_voucher.voucher_list) || []);
  renderVouchers();
});
`;

const CART_SCRIPT = String.raw`
const JSON_HEADERS = { 'content-type': 'application/json' };
let lines = [];
function render() {
  const holder = document.getElementById('cart');
  holder.innerHTML = '';
  lines.forEach((line) => {
    const row = document.createElement('div');
    row.className = 'cart-row';
    const link = document.createElement('a');
    link.href = '/Item-i.' + line.shopid + '.' + line.itemid;
    link.textContent = line.name;
    const variant = document.createElement('span');
    variant.textContent = line.model_name ? 'Variations:' + line.model_name : '';
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.setAttribute('aria-label', 'Decrease');
    dec.textContent = '-';
    dec.disabled = line.quantity <= 1;
    const input = document.createElement('input');
    input.value = String(line.quantity);
    input.readOnly = true;
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.setAttribute('aria-label', 'Increase');
    inc.textContent = '+';
    inc.disabled = line.quantity >= (line.maxQty || 99);
    const del = document.createElement('button');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete');
    del.textContent = 'Hapus';
    dec.addEventListener('click', () => change(line, line.quantity - 1));
    inc.addEventListener('click', () => change(line, line.quantity + 1));
    del.addEventListener('click', () => remove(line));
    row.append(link, variant, dec, input, inc, del);
    holder.appendChild(row);
  });
}
async function change(line, quantity) {
  const r = await fetch('/api/v4/cart/update', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action_type: 1, itemid: line.itemid, modelid: line.modelid, quantity: quantity }) });
  const j = await r.json();
  if (!j.error) {
    line.quantity = quantity;
    render();
  }
}
async function remove(line) {
  const r = await fetch('/api/v4/cart/update', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action_type: 2, itemid: line.itemid, modelid: line.modelid }) });
  const j = await r.json();
  if (!j.error) {
    lines = lines.filter((x) => x !== line);
    render();
  }
}
fetch('/api/v4/cart/get').then((r) => r.json()).then((j) => {
  lines = (j.data.cart_blocks || []).flatMap((b) => b.items || []);
  render();
});
`;

function productPage(itemId: string, shopId: string): string {
  const p = product(itemId);
  const like = p.noLikeButton ? '' : '<button type="button" id="like-btn">Favorite (6,3k)</button>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${p.title}</title></head><body data-item="${itemId}" data-shop="${shopId}"${
    p.maxQty ? ` data-max-qty="${p.maxQty}"` : ''
  }>
<h1>${p.title}</h1>
<div id="variations"></div>
<div class="qty"><button type="button" aria-label="Decrease">-</button><input id="qty" value="1" readonly><button type="button" aria-label="Increase">+</button></div>
${like}
<button type="button" id="add">Add to Cart</button>
<script>${PDP_SCRIPT}</script>
</body></html>`;
}

function shopPage(shopId: string): string {
  const s = shop();
  const follow = s.noFollowButton ? '' : '<button type="button" id="follow-btn">Follow</button>';
  const extra = s.extraClaimButton ? '<button type="button">Claim</button>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${s.name}</title></head><body data-shop="${shopId}">
<h1 id="shop-name"></h1>
${follow}
<div id="vouchers"></div>
${extra}
<script>${SHOP_SCRIPT}</script>
</body></html>`;
}

function cartPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Keranjang</title></head><body>
<div id="cart"></div>
<script>${CART_SCRIPT}</script>
</body></html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

function reply(
  route: Route,
  status: number,
  body: string,
  contentType = 'text/html; charset=utf-8',
) {
  return route.fulfill({ status, body, contentType });
}

function apiReply(route: Route, p: string, url: URL, body: Record<string, unknown>): Promise<void> {
  const ok = (data: unknown = {}) =>
    reply(route, 200, JSON.stringify({ error: 0, data }), 'application/json');
  const fail = (error: number, msg: string) =>
    reply(route, 200, JSON.stringify({ error, error_msg: msg }), 'application/json');
  const itemKey = String(body.itemid ?? url.searchParams.get('itemid') ?? '');

  switch (p) {
    case '/api/v4/pdp/get_pc': {
      const prod = buyer.products[url.searchParams.get('itemid') ?? ''];
      if (!prod) return fail(1, 'no such item');
      return ok({
        item: {
          item_id: Number(prod.itemid),
          shop_id: Number(prod.shopid),
          title: prod.title,
          currency: 'IDR',
          models: prod.models,
          tier_variations: prod.tiers,
        },
        product_price: {
          price: {
            single_value: prod.models[0].price,
            range_min: prod.models[0].price,
            range_max: prod.models[0].price,
          },
        },
        product_review: { liked: prod.liked },
      });
    }
    case '/api/v4/pages/like_items':
    case '/api/v4/pages/unlike_items': {
      const prod = buyer.products[itemKey];
      if (!prod) return fail(1, 'no such item');
      if (prod.likeError) return fail(1, 'Gagal menyukai produk');
      prod.liked = !p.endsWith('/unlike_items');
      return ok();
    }
    case '/api/v4/cart_panel/select_variation_pc':
      return ok();
    case '/api/v4/cart/add_to_cart': {
      const prod = buyer.products[itemKey];
      if (!prod) return fail(1, 'no such item');
      if (prod.addError) return fail(1234, 'Stok habis');
      const model = prod.models.find((m) => m.model_id === Number(body.modelid));
      if (!model) return fail(1, 'no such model');
      const quantity = Number(body.quantity);
      const line = lineFor(Number(prod.itemid), model.model_id);
      if (line) line.quantity += quantity;
      else
        buyer.cart.push({
          itemid: Number(prod.itemid),
          shopid: Number(prod.shopid),
          modelid: model.model_id,
          name: prod.title,
          model_name: model.name,
          price: model.price,
          quantity,
        });
      return ok();
    }
    case '/api/v4/cart/get':
      return ok({
        cart_blocks: [{ shops: [{ shopname: 'Toko Contoh', shopid: 500001 }], items: buyer.cart }],
      });
    case '/api/v4/cart/update': {
      if (buyer.cartUpdateError) return fail(1, 'Stok tidak cukup');
      const line = lineFor(Number(body.itemid), Number(body.modelid));
      if (!line) return fail(1, 'no such cart line');
      if (body.action_type === 2) buyer.cart = buyer.cart.filter((l) => l !== line);
      else line.quantity = Number(body.quantity);
      return ok();
    }
    case '/api/v4/shop/get_shop_base_v2': {
      const s = buyer.shops[url.searchParams.get('shopid') ?? ''];
      if (!s) return fail(1, 'no such shop');
      return ok({ name: s.name, followed: s.followed });
    }
    case '/api/v4/shop/follow':
    case '/api/v4/shop/unfollow': {
      const s = buyer.shops[String(body.shopid)];
      if (!s) return fail(1, 'no such shop');
      if (s.followError) return fail(1, 'Gagal mengikuti toko');
      s.followed = !p.endsWith('/unfollow');
      return ok();
    }
    case '/api/v4/shop/get_shop_tab': {
      const s = buyer.shops[url.searchParams.get('shopid') ?? ''];
      if (!s) return fail(1, 'no such shop');
      return ok({ decoration: [{ shop_voucher: { voucher_list: s.vouchers } }] });
    }
    case '/api/v4/voucher_wallet/save_voucher': {
      const s = shop();
      if (s.saveError) return fail(1, 'Voucher tidak tersedia');
      const code = String(body.voucher_code);
      const v = s.vouchers.find((x) => x.voucher_code === code);
      if (!v) return fail(1, 'no such voucher');
      v.is_claimed_before = true;
      return ok({ voucher: { voucher_code: s.saveReturnsCode ?? code } });
    }
    default:
      return fail(404, `unknown endpoint ${p}`);
  }
}

async function routeBuyer(route: Route, req: Request): Promise<void> {
  const url = new URL(req.url());
  const p = url.pathname;
  const raw = req.postData();
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (p.startsWith('/api/')) {
    buyer.calls.push({ path: p, body });
    return apiReply(route, p, url, body);
  }
  buyer.pageViews.push(p);
  const pdp = /^\/product\/(\d+)\/(\d+)$/.exec(p);
  if (pdp && buyer.products[pdp[2]]) return reply(route, 200, productPage(pdp[2], pdp[1]));
  const shopMatch = /^\/shop\/(\d+)$/.exec(p);
  if (shopMatch && buyer.shops[shopMatch[1]]) {
    return reply(route, 200, shopPage(shopMatch[1]));
  }
  if (p === '/cart') return reply(route, 200, cartPage());
  return reply(route, 404, 'not found');
}

async function setup(): Promise<void> {
  const ctx: BrowserContext = await getContext(true);
  // The account tools only run while the saved session looks logged in.
  await ctx.addCookies([{ name: 'SPC_U', value: '424242', url: BUYER_BASE }]);
  // Registered first, so it is the fallback: anything off the fixture host is aborted.
  await ctx.route(
    (url: URL) => url.hostname !== BUYER_HOST,
    (route: Route) => route.abort(),
  );
  await ctx.route(
    (url: URL) => url.hostname === BUYER_HOST,
    (route: Route, req: Request) => routeBuyer(route, req),
  );
}

async function readAudit(): Promise<
  Array<{ kind: string; tool: string; ok: boolean; error?: string }>
> {
  const text = await fs
    .readFile(path.join(HOME, '.shopee-mcp', 'audit.log'), 'utf8')
    .catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; tool: string; ok: boolean; error?: string });
}

// ─── Checks ───────────────────────────────────────────────────────────────────

const checks: Array<{ name: string; run: () => Promise<void> }> = [];
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run });
};

// Likes

check(
  'like: likes a product that is not yet liked, and reports what Shopee confirmed',
  async () => {
    const before = safetyStatus().writesLastHour;
    const out = await callTool('like_product', {
      shopId: SHOP_ID,
      itemId: '9000001',
      confirm: true,
    });
    assert.match(out, /Liked the product/);
    assert.equal(product('9000001').liked, true);
    assert.equal(callsTo('/api/v4/pages/like_items'), 1);
    assert.equal(safetyStatus().writesLastHour, before + 1, 'a like must spend one write');
    const entries = await readAudit();
    assert.ok(entries.some((e) => e.kind === 'write' && e.tool === 'like_product' && e.ok));
  },
);

check('like: a product that is already liked is left alone', async () => {
  const out = await callTool('like_product', { shopId: SHOP_ID, itemId: '9000002', confirm: true });
  assert.match(out, /Already liked/);
  assert.equal(callsTo('/api/v4/pages/like_items'), 0);
});

check('unlike: removes a like and reports it', async () => {
  const out = await callTool('like_product', {
    shopId: SHOP_ID,
    itemId: '9000002',
    like: false,
    confirm: true,
  });
  assert.match(out, /Unliked the product/);
  assert.equal(product('9000002').liked, false);
  assert.equal(callsTo('/api/v4/pages/unlike_items'), 1);
});

check('like: refuses to guess when the heart button is missing', async () => {
  product('9000001').noLikeButton = true;
  const out = await callTool('like_product', { shopId: SHOP_ID, itemId: '9000001', confirm: true });
  assert.match(out, /Could not find the like button/);
  assert.equal(product('9000001').liked, false);
  assert.equal(callsTo('/api/v4/pages/like_items'), 0);
});

check('like: a Shopee rejection is reported as not confirmed', async () => {
  product('9000001').likeError = true;
  const out = await callTool('like_product', { shopId: SHOP_ID, itemId: '9000001', confirm: true });
  assert.match(out, /did not confirm the like/);
  assert.equal(product('9000001').liked, false);
});

check('like: without confirm it previews and touches nothing', async () => {
  const before = safetyStatus().writesLastHour;
  const out = await callTool('like_product', { shopId: SHOP_ID, itemId: '9000001' });
  assert.match(out, /WRITE PREVIEW/);
  assert.equal(callsTo('/api/v4/pages/like_items'), 0);
  assert.equal(safetyStatus().writesLastHour, before);
});

// Follows

check('follow: follows a shop and names it', async () => {
  const out = await callTool('follow_shop', { shopId: SHOP_ID, confirm: true });
  assert.match(out, /Now following Toko Contoh/);
  assert.equal(shop().followed, true);
  assert.equal(callsTo('/api/v4/shop/follow'), 1);
});

check('follow: a shop that is already followed is left alone', async () => {
  shop().followed = true;
  const out = await callTool('follow_shop', { shopId: SHOP_ID, confirm: true });
  assert.match(out, /Already following Toko Contoh/);
  assert.equal(callsTo('/api/v4/shop/follow'), 0);
});

check('unfollow: unfollows a followed shop', async () => {
  shop().followed = true;
  const out = await callTool('follow_shop', { shopId: SHOP_ID, follow: false, confirm: true });
  assert.match(out, /Unfollowed Toko Contoh/);
  assert.equal(shop().followed, false);
});

check('follow: a Shopee rejection is reported as not confirmed', async () => {
  shop().followError = true;
  const out = await callTool('follow_shop', { shopId: SHOP_ID, confirm: true });
  assert.match(out, /did not confirm the follow/);
  assert.equal(shop().followed, false);
});

check('follow: refuses to guess when the Follow button is missing', async () => {
  shop().noFollowButton = true;
  const out = await callTool('follow_shop', { shopId: SHOP_ID, confirm: true });
  assert.match(out, /Could not find the Follow button/);
  assert.equal(shop().followed, false);
});

// Vouchers

check(
  'get_shop_vouchers lists the codes, marks the claimed ones, and spends no write',
  async () => {
    const before = safetyStatus().writesLastHour;
    const out = await callTool('get_shop_vouchers', { shopId: SHOP_ID });
    assert.match(out, /`DISC10`/);
    assert.match(out, /`SHIP5`/);
    assert.match(out, /✅ claimed/);
    assert.equal(safetyStatus().writesLastHour, before, 'a read must not count as a write');
  },
);

check('claim: claims the code asked for, not the voucher beside it', async () => {
  const out = await callTool('claim_shop_voucher', {
    shopId: SHOP_ID,
    voucherCode: 'DISC10',
    confirm: true,
  });
  assert.match(out, /Claimed `DISC10`/);
  assert.equal(callsTo('/api/v4/voucher_wallet/save_voucher'), 1);
  const saved = buyer.calls.find((c) => c.path === '/api/v4/voucher_wallet/save_voucher');
  assert.equal(saved?.body.voucher_code, 'DISC10');
  assert.equal(shop().vouchers.find((v) => v.voucher_code === 'DISC10')?.is_claimed_before, true);
  assert.equal(shop().vouchers.find((v) => v.voucher_code === 'SHIP5')?.is_claimed_before, false);
});

check('claim: a voucher already in the wallet is not clicked again', async () => {
  const out = await callTool('claim_shop_voucher', {
    shopId: SHOP_ID,
    voucherCode: 'OLD7',
    confirm: true,
  });
  assert.match(out, /already claimed/);
  assert.equal(callsTo('/api/v4/voucher_wallet/save_voucher'), 0);
});

check('claim: a code the shop no longer lists is refused', async () => {
  const out = await callTool('claim_shop_voucher', {
    shopId: SHOP_ID,
    voucherCode: 'NOPE',
    confirm: true,
  });
  assert.match(out, /has no voucher `NOPE`/);
  assert.equal(callsTo('/api/v4/voucher_wallet/save_voucher'), 0);
});

check(
  'claim: a page whose buttons do not line up with the voucher list clicks nothing',
  async () => {
    shop().extraClaimButton = true;
    const out = await callTool('claim_shop_voucher', {
      shopId: SHOP_ID,
      voucherCode: 'DISC10',
      confirm: true,
    });
    assert.match(out, /line up/);
    assert.equal(callsTo('/api/v4/voucher_wallet/save_voucher'), 0);
  },
);

check('claim: a voucher whose button cannot be claimed is not clicked', async () => {
  shop().vouchers[0].usedUp = true;
  const out = await callTool('claim_shop_voucher', {
    shopId: SHOP_ID,
    voucherCode: 'SHIP5',
    confirm: true,
  });
  assert.match(out, /is not claimable/);
  assert.equal(callsTo('/api/v4/voucher_wallet/save_voucher'), 0);
});

check(
  'claim: a different code saved by Shopee is flagged, not reported as the one asked for',
  async () => {
    shop().saveReturnsCode = 'OTHER1';
    const out = await callTool('claim_shop_voucher', {
      shopId: SHOP_ID,
      voucherCode: 'DISC10',
      confirm: true,
    });
    assert.match(out, /Shopee saved `OTHER1`, not `DISC10`/);
  },
);

check('claim: a Shopee rejection is reported as not confirmed', async () => {
  shop().saveError = true;
  const out = await callTool('claim_shop_voucher', {
    shopId: SHOP_ID,
    voucherCode: 'DISC10',
    confirm: true,
  });
  assert.match(out, /did not confirm claiming `DISC10`/);
  assert.equal(shop().vouchers.find((v) => v.voucher_code === 'DISC10')?.is_claimed_before, false);
});

check('claim: without confirm it previews and claims nothing', async () => {
  const out = await callTool('claim_shop_voucher', { shopId: SHOP_ID, voucherCode: 'DISC10' });
  assert.match(out, /WRITE PREVIEW/);
  assert.equal(callsTo('/api/v4/voucher_wallet/save_voucher'), 0);
});

// Add to cart

check('add to cart: adds the quantity asked for', async () => {
  buyer.cart = [];
  const out = await callTool('add_to_cart', {
    shopId: SHOP_ID,
    itemId: '9000001',
    quantity: 2,
    confirm: true,
  });
  assert.match(out, /Added to your Shopee cart/);
  assert.match(out, /Quantity: 2/);
  assert.equal(lineFor(9000001, 1000001)?.quantity, 2);
  const add = buyer.calls.find((c) => c.path === '/api/v4/cart/add_to_cart');
  assert.equal(add?.body.modelid, 1000001);
  assert.equal(add?.body.quantity, 2);
});

check(
  'add to cart: a variant is chosen option by option, and the model recorded is the one asked for',
  async () => {
    buyer.cart = [];
    const out = await callTool('add_to_cart', {
      shopId: SHOP_ID,
      itemId: '9000002',
      modelId: '2000003',
      quantity: 1,
      confirm: true,
    });
    assert.match(out, /Added to your Shopee cart/);
    assert.doesNotMatch(out, /recorded model_id/);
    assert.equal(callsTo('/api/v4/cart_panel/select_variation_pc'), 2);
    assert.equal(lineFor(9000002, 2000003)?.quantity, 1);
  },
);

check('add to cart: refuses to guess a variant when none is given', async () => {
  const before = structuredClone(buyer.cart);
  const out = await callTool('add_to_cart', {
    shopId: SHOP_ID,
    itemId: '9000002',
    confirm: true,
  });
  assert.match(out, /This listing has 4 variants/);
  assert.equal(callsTo('/api/v4/cart/add_to_cart'), 0);
  assert.deepEqual(buyer.cart, before);
});

check('add to cart: an out-of-stock variant is refused before the page is used', async () => {
  const out = await callTool('add_to_cart', {
    shopId: SHOP_ID,
    itemId: '9000002',
    modelId: '2000004',
    confirm: true,
  });
  assert.match(out, /is out of stock/);
  assert.equal(callsTo('/api/v4/cart_panel/select_variation_pc'), 0);
  assert.equal(callsTo('/api/v4/cart/add_to_cart'), 0);
});

check('add to cart: a model id that is not a variant of the listing is refused', async () => {
  const out = await callTool('add_to_cart', {
    shopId: SHOP_ID,
    itemId: '9000002',
    modelId: '999',
    confirm: true,
  });
  assert.match(out, /is not a variant of this listing/);
  assert.equal(callsTo('/api/v4/cart/add_to_cart'), 0);
});

check('add to cart: a quantity the page cannot reach adds nothing', async () => {
  product('9000001').maxQty = 2;
  const before = structuredClone(buyer.cart);
  const out = await callTool('add_to_cart', {
    shopId: SHOP_ID,
    itemId: '9000001',
    quantity: 5,
    confirm: true,
  });
  assert.match(out, /Could not set the quantity to 5/);
  assert.equal(callsTo('/api/v4/cart/add_to_cart'), 0);
  assert.deepEqual(buyer.cart, before);
});

check('add to cart: a Shopee rejection is shown and the cart is unchanged', async () => {
  product('9000001').addError = true;
  const before = structuredClone(buyer.cart);
  const out = await callTool('add_to_cart', {
    shopId: SHOP_ID,
    itemId: '9000001',
    confirm: true,
  });
  assert.match(out, /Shopee rejected the cart update: Stok habis/);
  assert.deepEqual(buyer.cart, before);
});

check('add to cart: without confirm it previews and adds nothing', async () => {
  const out = await callTool('add_to_cart', { shopId: SHOP_ID, itemId: '9000001' });
  assert.match(out, /WRITE PREVIEW/);
  assert.equal(callsTo('/api/v4/cart/add_to_cart'), 0);
});

// Edit cart

check('update cart: raises a line one step at a time and reports the new quantity', async () => {
  const out = await callTool('update_cart_item', {
    itemId: '9000001',
    quantity: 3,
    confirm: true,
  });
  assert.match(out, /quantity 1 → 3/);
  assert.equal(lineFor(9000001, 1000001)?.quantity, 3);
  assert.equal(callsTo('/api/v4/cart/update'), 2);
});

check('update cart: lowers the variant asked for and leaves its sibling alone', async () => {
  const out = await callTool('update_cart_item', {
    itemId: '9000002',
    modelId: '2000003',
    quantity: 1,
    confirm: true,
  });
  assert.match(out, /quantity 2 → 1/);
  assert.equal(lineFor(9000002, 2000003)?.quantity, 1);
  assert.equal(lineFor(9000002, 2000001)?.quantity, 1);
});

check('update cart: quantity 0 removes the line', async () => {
  const out = await callTool('update_cart_item', { itemId: '9000001', quantity: 0, confirm: true });
  assert.match(out, /Removed from your cart/);
  assert.equal(lineFor(9000001, 1000001), undefined);
});

check('update cart: an item in several variants needs a modelId', async () => {
  const out = await callTool('update_cart_item', { itemId: '9000002', quantity: 1, confirm: true });
  assert.match(out, /in your cart in 2 variants/);
  assert.equal(callsTo('/api/v4/cart/update'), 0);
});

check('update cart: an item that is not in the cart is reported, not guessed', async () => {
  const out = await callTool('update_cart_item', { itemId: '9999999', quantity: 1, confirm: true });
  assert.match(out, /is not in your cart/);
  assert.equal(callsTo('/api/v4/cart/update'), 0);
});

check('update cart: a change larger than the per-call step is refused', async () => {
  const out = await callTool('update_cart_item', {
    itemId: '9000001',
    quantity: 31,
    confirm: true,
  });
  assert.match(out, /changes the quantity by 30/);
  assert.equal(callsTo('/api/v4/cart/update'), 0);
});

check('update cart: the same quantity changes nothing', async () => {
  const out = await callTool('update_cart_item', { itemId: '9000001', quantity: 1, confirm: true });
  assert.match(out, /already 1/);
  assert.equal(callsTo('/api/v4/cart/update'), 0);
});

check('update cart: a line the page caps reports how far it got', async () => {
  const out = await callTool('update_cart_item', { itemId: '9000003', quantity: 5, confirm: true });
  assert.match(out, /only reached quantity 3 of 5/);
  assert.equal(lineFor(9000003, 3000001)?.quantity, 3);
});

check('update cart: a Shopee rejection is not reported as a change', async () => {
  buyer.cartUpdateError = true;
  const out = await callTool('update_cart_item', { itemId: '9000001', quantity: 3, confirm: true });
  assert.match(out, /did not confirm/);
  assert.doesNotMatch(out, /✅/);
  assert.equal(lineFor(9000001, 1000001)?.quantity, 1);
});

check('update cart: without confirm it previews and changes nothing', async () => {
  const out = await callTool('update_cart_item', { itemId: '9000001', quantity: 0 });
  assert.match(out, /WRITE PREVIEW/);
  assert.equal(callsTo('/api/v4/cart/update'), 0);
});

// The Shopee Video post takes a path from the caller, so it has to check the file first.

check(
  'post_shopee_video: refuses a file that is not a video before the browser is used',
  async () => {
    const notVideo = path.join(HOME, 'notes.txt');
    await fs.writeFile(notVideo, 'not a video');
    const out = await callTool('post_shopee_video', {
      video_path: notVideo,
      caption: 'Cek ini',
      confirm: true,
    });
    assert.match(out, /Unsupported video extension/);
    assert.deepEqual(buyer.pageViews, [], 'no Shopee page should be opened for a refused file');
  },
);

check(
  'post_shopee_video: a video file passes the check and reaches the Shopee Video pages',
  async () => {
    const clip = path.join(HOME, 'clip.mp4');
    await fs.writeFile(clip, Buffer.alloc(2048));
    const out = await callTool('post_shopee_video', {
      video_path: clip,
      caption: 'Cek ini',
      confirm: true,
    });
    assert.match(out, /not available on the web right now/);
    assert.ok(buyer.pageViews.length > 0, 'the video pages should have been opened');
  },
);

// A probe only reads the storefront, so it must not be metered or audited as a write.

check(
  'shopee_video_probe: a read of the video web build does not spend the write budget',
  async () => {
    const before = safetyStatus().writesLastHour;
    const out = await callTool('shopee_video_probe', {});
    assert.match(out, /Shopee Video web probe/);
    assert.equal(safetyStatus().writesLastHour, before, 'a probe is a read');
  },
);

// ─── Runner ───────────────────────────────────────────────────────────────────

const CHECK_DEADLINE_MS = 120_000;

/** Fail a check that never settles, so a hang shows up as a red line instead of a stalled run. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no result after ${ms / 1000}s — hung?`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function main(): Promise<number> {
  console.log(`Chromium: ${BINARY}`);
  try {
    await setup();
  } catch (err) {
    console.log(
      `❌ could not start the browser: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  let failed = 0;
  for (const c of checks) {
    resetBuyer();
    try {
      await withDeadline(c.run(), CHECK_DEADLINE_MS);
      console.log(`✅ ${c.name}`);
    } catch (err) {
      failed++;
      console.log(`❌ ${c.name}`);
      const detail = (err instanceof Error ? err.message : String(err)).trim().slice(0, 900);
      for (const line of detail.split('\n')) console.log(`   ${line}`);
    }
  }
  await closeContext().catch(() => {});

  if (failed) {
    console.log(
      `\n${failed} of ${checks.length} buyer browser tests failed. Artifacts kept in ${HOME}`,
    );
    return 1;
  }
  await fs.rm(HOME, { recursive: true, force: true });
  console.log(`\n✅ All ${checks.length} buyer browser tests passed.`);
  return 0;
}

process.exit(await main());
