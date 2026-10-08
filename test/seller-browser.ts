/**
 * Browser tests for the Seller Centre write actions, run against a local fixture
 * of the portal instead of the live site.
 *
 *  - Nothing leaves the machine: requests to any host other than the fixture are
 *    aborted, and everything the server writes (profile, budgets, audit log,
 *    debug screenshots) goes under a throwaway HOME.
 *  - It drives the real code path — session.ts → CloakBrowser → Playwright — so
 *    the selectors, the typed-value check, Save, and the fresh-load re-read all
 *    run for real. What it cannot show is that the fixture matches Shopee's
 *    current DOM; that still needs one look at the live edit page.
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

const BINARY = process.env.CLOAKBROWSER_BINARY_PATH;
if (!BINARY) {
  console.log(
    '⏭  test:browser SKIPPED — set CLOAKBROWSER_BINARY_PATH to a Chromium binary to run it.',
  );
  process.exit(0);
}

// Set before importing src/: several modules compute their paths when they load.
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'shopee-mcp-browser-'));
Object.assign(process.env, {
  HOME,
  SHOPEE_PROFILE_DIR: path.join(HOME, 'profile'),
  SHOPEE_DOMAIN: 'shopee.test',
  SHOPEE_HEADLESS: 'true',
  SHOPEE_ENABLE_SELLER_WRITES: 'true',
  SHOPEE_ACTION_TIMEOUT_MS: '10000',
  SHOPEE_ACTION_DELAY_MS: '0',
  // The production defaults pace writes a minute apart; a fixture run needs none of that.
  SHOPEE_READ_SPACING_MS: '0',
  SHOPEE_READ_SPREAD_MS: '0',
  SHOPEE_WRITE_SPACING_MS: '0',
  SHOPEE_WRITE_SPREAD_MS: '0',
  SHOPEE_WRITE_MAX_PER_HOUR: '1000',
  SHOPEE_WRITE_MAX_PER_DAY: '1000',
});

const { getContext, getSellerPage, safetyStatus, closeContext } =
  await import('../src/browser/session.js');
const { updateProductPrice, updateProductStock, setItemListing } =
  await import('../src/seller/actions/product.js');

const FIXTURE_HOST = 'seller.shopee.test';
const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// ─── Fixture portal ───────────────────────────────────────────────────────────

interface Listing {
  name: string;
  price: number[];
  stock: number[];
  listed: boolean;
  /** The switch carries its state only as a CSS class — no aria-checked anywhere. */
  classOnlySwitch?: boolean;
  /** A role=switch button inside a wrapper whose class also contains "switch". */
  wrappedSwitch?: boolean;
  /** The editor URL redirects to another product's editor. */
  redirectTo?: string;
  /** Save shows the success toast but stores nothing. */
  saveDrops?: boolean;
  /** Stock inputs revert any value above this, like a portal with a hard cap. */
  stockMax?: number;
}

const PRISTINE: Record<string, Listing> = {
  '1001': { name: 'Plain T-shirt', price: [150000], stock: [7], listed: true, stockMax: 99 },
  '2002': { name: 'Running shoes', price: [100000, 120000], stock: [3, 4], listed: true },
  '3003': { name: 'Backpack', price: [80000], stock: [1], listed: true, redirectTo: '9999' },
  '4004': { name: 'Cap', price: [90000], stock: [2], listed: true, saveDrops: true },
  '5005': { name: 'Hoodie', price: [70000], stock: [5], listed: true, classOnlySwitch: true },
  // Listed in DOM order before 777 on purpose: a substring match on "777" hits this row first.
  '7777': { name: 'Coffee cup', price: [61000], stock: [8], listed: false },
  '777': { name: 'Ceramic mug', price: [60000], stock: [6], listed: false },
  '8008': { name: 'Umbrella', price: [40000], stock: [2], listed: false, wrappedSwitch: true },
  '9999': { name: 'Water bottle', price: [50000], stock: [9], listed: true },
};

const portal = {
  products: structuredClone(PRISTINE),
  saves: [] as string[],
  toggles: [] as string[],
  decoyClicks: 0,
};

function resetPortal(): void {
  portal.products = structuredClone(PRISTINE);
  portal.saves = [];
  portal.toggles = [];
  portal.decoyClicks = 0;
}

const LIST_SCRIPT = String.raw`
async function setListed(id, listed) {
  await fetch('/__toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, listed: listed }) });
  const el = document.querySelector('[data-sw="' + id + '"]');
  el.dataset.on = listed ? '1' : '0';
  el.classList.toggle('on', listed);
  if (el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', String(listed));
}
function toggleRow(el) {
  const id = el.dataset.sw;
  if (el.dataset.on === '1') return openDialog(id);
  return setListed(id, true);
}
function openDialog(id) {
  const host = document.getElementById('dialog-host');
  host.innerHTML = '<div role="dialog"><p>Nonaktifkan produk ' + id + '?</p><button id="dlg-no" type="button">Tidak</button><button id="dlg-yes" type="button">Ya</button></div>';
  document.getElementById('dlg-no').onclick = () => { host.innerHTML = ''; };
  document.getElementById('dlg-yes').onclick = () => { host.innerHTML = ''; setListed(id, false); };
}
`;

const EDIT_SCRIPT = String.raw`
const PID = document.body.dataset.pid;
const digits = (s) => s.replace(/\D/g, '');
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
document.querySelectorAll('input').forEach((inp) => {
  inp.dataset.prev = inp.value;
  inp.addEventListener('input', () => {
    const max = Number(inp.dataset.max);
    if (max && Number(inp.value) > max) inp.value = inp.dataset.prev;
    else inp.dataset.prev = inp.value;
  });
  inp.addEventListener('blur', () => {
    if (digits(inp.value)) inp.value = fmt(Number(digits(inp.value)));
    inp.dataset.prev = inp.value;
  });
});
const read = (kind) => [...document.querySelectorAll('input[data-kind="' + kind + '"]')].map((i) => Number(digits(i.value)));
document.getElementById('save-btn').addEventListener('click', async () => {
  await fetch('/__save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PID, price: read('price'), stock: read('stock') }) });
  document.getElementById('toast').style.display = 'block';
});
`;

function listPage(): string {
  // Longer ids first: "7777" is listed above "777", so a substring match hits the wrong row first.
  const rows = Object.entries(portal.products)
    .sort(([a], [b]) => b.length - a.length)
    .map(([id, p]) => {
      const on = p.listed ? '1' : '0';
      const sw = p.wrappedSwitch
        ? `<div class="switch-wrap"><button class="toggle" type="button" role="switch" aria-checked="${p.listed}" data-sw="${id}" data-on="${on}" onclick="toggleRow(this)"></button></div>`
        : p.classOnlySwitch
          ? `<div class="switch${p.listed ? ' on' : ''}" data-sw="${id}" data-on="${on}" onclick="toggleRow(this)"></div>`
          : `<div class="switch" role="switch" aria-checked="${p.listed}" data-sw="${id}" data-on="${on}" onclick="toggleRow(this)"></div>`;
      return `<tr><td>${p.name} · ID ${id} · Stok ${p.stock[0]} · Rp ${fmt(p.price[0])}</td><td>${sw}</td></tr>`;
    })
    .join('\n');
  // The decoy sits before the dialog host in DOM order and contains "ya"
  // ("Layanan") — exactly what a substring selector like has-text("Ya") matches.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Produk</title><style>.switch, .toggle { display: inline-block; width: 40px; height: 20px; background: #bbb; } .switch.on { background: #2a2; }</style></head><body>
<button class="help" type="button" onclick="fetch('/__decoy', { method: 'POST' })">Bantuan Layanan</button>
<table><tbody>
${rows}
</tbody></table>
<div id="dialog-host"></div>
<script>${LIST_SCRIPT}</script>
</body></html>`;
}

function editPage(id: string, p: Listing): string {
  // A client-side router that swaps the URL to another product's editor, before the page settles.
  const landing = p.redirectTo
    ? `<script>history.replaceState(null, '', '/portal/product/${p.redirectTo}');</script>`
    : '';
  const price = p.price
    .map(
      (v, i) =>
        `<div class="price-field"><input type="text" data-kind="price" data-idx="${i}" value="${v}"></div>`,
    )
    .join('');
  const stock = p.stock
    .map(
      (v, i) =>
        `<div class="stock-field"><input type="text" data-kind="stock" data-idx="${i}" value="${v}"${
          p.stockMax ? ` data-max="${p.stockMax}"` : ''
        }></div>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Edit ${id}</title></head><body data-pid="${id}">
<h1>${p.name}</h1>
${landing}
<section class="price-section">${price}</section>
<section class="stock-section">${stock}</section>
<button id="save-btn" type="button">Simpan</button>
<div id="toast" class="toast" style="display:none">Berhasil disimpan</div>
<script>${EDIT_SCRIPT}</script>
</body></html>`;
}

function reply(
  route: Route,
  status: number,
  body: string,
  contentType = 'text/html; charset=utf-8',
) {
  return route.fulfill({ status, body, contentType });
}

async function routeSeller(route: Route, req: Request): Promise<void> {
  const url = new URL(req.url());
  const p = url.pathname;

  if (p === '/__save') {
    const body = JSON.parse(req.postData() ?? '{}') as {
      id: string;
      price: number[];
      stock: number[];
    };
    portal.saves.push(body.id);
    const item = portal.products[body.id];
    if (item && !item.saveDrops) {
      item.price = body.price;
      item.stock = body.stock;
    }
    return reply(route, 200, '{"ok":true}', 'application/json');
  }
  if (p === '/__toggle') {
    const body = JSON.parse(req.postData() ?? '{}') as { id: string; listed: boolean };
    portal.toggles.push(`${body.id}:${body.listed}`);
    portal.products[body.id].listed = body.listed;
    return reply(route, 200, '{"ok":true}', 'application/json');
  }
  if (p === '/__decoy') {
    portal.decoyClicks++;
    return reply(route, 200, '{}', 'application/json');
  }
  if (p.startsWith('/api/')) return reply(route, 200, '{"error":0,"data":{}}', 'application/json');
  if (p === '/portal/product/list/live/all') return reply(route, 200, listPage());

  const m = /^\/portal\/product\/(\d+)$/.exec(p);
  if (m) {
    const item = portal.products[m[1]];
    if (!item) return reply(route, 404, 'not found');
    return reply(route, 200, editPage(m[1], item));
  }
  return reply(route, 404, 'not found');
}

async function setup(): Promise<void> {
  const ctx: BrowserContext = await getContext(true);
  // Registered first, so it is the fallback: anything off the fixture host is aborted.
  await ctx.route(
    (url: URL) => url.hostname !== FIXTURE_HOST,
    (route: Route) => route.abort(),
  );
  await ctx.route(
    (url: URL) => url.hostname === FIXTURE_HOST,
    (route: Route, req: Request) => routeSeller(route, req),
  );
}

// ─── Checks ───────────────────────────────────────────────────────────────────

const checks: Array<{ name: string; run: () => Promise<void> }> = [];
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run });
};

check('price: types the value, saves, and confirms it on a fresh load', async () => {
  const out = await updateProductPrice({ itemId: '1001', value: 160000 });
  assert.match(out, /Price for product 1001 set to 160,000 and saved/);
  assert.deepEqual(portal.products['1001'].price, [160000]);
  assert.deepEqual(portal.products['1001'].stock, [7]);
  assert.deepEqual(portal.saves, ['1001']);
});

check('stock: a field that reverts the typed value is caught before Save', async () => {
  await assert.rejects(
    updateProductStock({ itemId: '1001', value: 150 }),
    /stock field still reads "\d+" after typing 150 — nothing was saved/,
  );
  assert.deepEqual(portal.products['1001'].stock, [7]);
  assert.deepEqual(portal.saves, []);
});

check('variation product: refuses to guess which row to edit', async () => {
  await assert.rejects(
    updateProductPrice({ itemId: '2002', value: 130000 }),
    /`variation_index` is required/,
  );
  assert.deepEqual(portal.products['2002'].price, [100000, 120000]);
  assert.deepEqual(portal.saves, []);
});

check('variation product: edits exactly the row asked for', async () => {
  const out = await updateProductPrice({ itemId: '2002', value: 130000, variationIndex: 1 });
  assert.match(out, /product 2002 \(variation 1\) set to 130,000 and saved/);
  assert.deepEqual(portal.products['2002'].price, [100000, 130000]);
  assert.deepEqual(portal.products['2002'].stock, [3, 4]);
});

check('variation product: an out-of-range row index is refused', async () => {
  await assert.rejects(
    updateProductPrice({ itemId: '2002', value: 1, variationIndex: 5 }),
    /out of range/,
  );
  assert.deepEqual(portal.products['2002'].price, [100000, 120000]);
});

check('an editor URL that lands on another product aborts before typing', async () => {
  await assert.rejects(
    updateProductPrice({ itemId: '3003', value: 1 }),
    /landed on a different product \(9999\)/,
  );
  assert.deepEqual(portal.products['9999'].price, [50000]);
  assert.deepEqual(portal.saves, []);
});

check('a Save that shows a toast but stores nothing is reported, not trusted', async () => {
  const out = await updateProductPrice({ itemId: '4004', value: 95000 });
  assert.match(out, /⚠️/);
  assert.match(out, /Check the product in Seller Centre/);
  assert.deepEqual(portal.saves, ['4004']);
  assert.deepEqual(portal.products['4004'].price, [90000]);
});

check('listing: a product already in the requested state is left alone', async () => {
  const out = await setItemListing('1001', true);
  assert.match(out, /already listed/);
  assert.deepEqual(portal.toggles, []);
});

check(
  'listing: switches the product asked for, not a row that merely contains its id',
  async () => {
    const out = await setItemListing('777', true);
    assert.match(out, /is now listed/);
    assert.deepEqual(portal.toggles, ['777:true']);
    assert.equal(portal.products['7777'].listed, false);
  },
);

check('unlisting confirms through the dialog, never a look-alike button', async () => {
  const out = await setItemListing('1001', false);
  assert.match(out, /is now unlisted/);
  assert.equal(portal.decoyClicks, 0);
});

check('listing never clicks a look-alike button when no dialog opens', async () => {
  await setItemListing('777', true);
  assert.equal(portal.decoyClicks, 0);
});

check('a switch whose state cannot be read is never toggled blindly', async () => {
  await assert.rejects(setItemListing('5005', false), /Nothing was clicked/);
  assert.deepEqual(portal.toggles, []);
  assert.equal(portal.products['5005'].listed, true);
});

check('listing finds the real switch when a wrapper also carries a switch class', async () => {
  const out = await setItemListing('8008', true);
  assert.match(out, /is now listed/);
  assert.equal(portal.products['8008'].listed, true);
});

check('the safety gate counts Shopee API responses the browser receives', async () => {
  const page = await getSellerPage();
  await page.goto(`https://${FIXTURE_HOST}/portal/product/list/live/all`, {
    waitUntil: 'domcontentloaded',
  });
  const before = safetyStatus().apiRequestsLastHour;
  await page.evaluate(() => fetch('/api/v4/fixture/ping').then((r) => r.text()));
  // The context-level response event is delivered asynchronously; poll briefly.
  let after = before;
  for (let i = 0; i < 30 && after <= before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = safetyStatus().apiRequestsLastHour;
  }
  assert.ok(
    after > before,
    `expected the request to be counted (before ${before}, after ${after})`,
  );
});

check('every write is audited, and a refused write keeps a screenshot', async () => {
  let refusal: (Error & { screenshotPath?: string }) | undefined;
  try {
    await updateProductStock({ itemId: '1001', value: 150 });
  } catch (err) {
    refusal = err as Error & { screenshotPath?: string };
  }
  assert.ok(refusal, 'the reverted stock value should have been refused');
  assert.ok(refusal.screenshotPath, 'a refused write should keep a screenshot');
  await fs.access(refusal.screenshotPath);

  await updateProductPrice({ itemId: '1001', value: 170000 });
  const entries = (await fs.readFile(path.join(HOME, '.shopee-mcp', 'audit.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { tool: string; ok: boolean });
  assert.ok(entries.some((e) => e.tool === 'seller:update-stock' && e.ok === false));
  assert.ok(entries.some((e) => e.tool === 'seller:update-price' && e.ok === true));
});

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
    resetPortal();
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
    console.log(`\n${failed} of ${checks.length} browser tests failed. Artifacts kept in ${HOME}`);
    return 1;
  }
  await fs.rm(HOME, { recursive: true, force: true });
  console.log(`\n✅ All ${checks.length} browser tests passed.`);
  return 0;
}

process.exit(await main());
