/**
 * Browser tests for the Seller Centre write actions, run against a local fixture
 * of the portal instead of the live site.
 *
 *  - Nothing leaves the machine: requests to any host other than the fixtures are
 *    aborted, and everything the server writes (profile, budgets, audit log,
 *    debug screenshots) goes under a throwaway HOME.
 *  - It drives the real code path (session.ts → CloakBrowser → Playwright), so the
 *    selectors, the typed-value check, Save, and the fresh-load re-read all run for
 *    real. What it cannot show is that the fixture matches Shopee's current DOM;
 *    that still needs one look at the live edit page.
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
  SHOPEE_READ_MAX_PER_HOUR: '1000',
  SHOPEE_READ_SPREAD_MS: '0',
  SHOPEE_WRITE_SPACING_MS: '0',
  SHOPEE_WRITE_SPREAD_MS: '0',
  SHOPEE_WRITE_MAX_PER_HOUR: '1000',
  SHOPEE_WRITE_MAX_PER_DAY: '1000',
});

const { getContext, getSellerPage, safetyStatus, closeContext, captureAll, captureAccountWrite } =
  await import('../src/browser/session.js');
const { updateProductPrice, updateProductStock, setItemListing } =
  await import('../src/seller/actions/product.js');
const { uploadProductVideo, removeProductVideo } = await import('../src/seller/actions/video.js');
const { registerSellerChatTools } = await import('../src/tools/seller/chat.js');

const FIXTURE_HOST = 'seller.shopee.test';
const BUYER_HOST = 'shopee.test';
const BUYER_BASE = `https://${BUYER_HOST}`;
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
  /** The editor URL changes to another product's editor before the page settles. */
  redirectTo?: string;
  /** Save shows the success toast but stores nothing. */
  saveDrops?: boolean;
  /** Stock inputs revert any value above this, like a portal with a hard cap. */
  stockMax?: number;
  /** Save stores the value but never shows a success toast. */
  noToast?: boolean;
  /** The edit page has a "Simpan Draf" button and no exact "Simpan" button. */
  onlyDraftSave?: boolean;
  /** The product already has a video attached. */
  video?: 'ready' | 'processing';
  /** How an upload behaves: processing time, whether the preview shows before processing ends, or never ends. */
  videoUpload?: { processMs?: number; previewEarly?: boolean; stuck?: boolean };
  /** The edit page has an image uploader but no video input. */
  noVideoInput?: boolean;
  /** A no-op control sits before the real delete button, so a selector that takes the first match picks it. */
  videoDeleteDecoy?: boolean;
  /** Once the product is saved, the edit page stops rendering (a 500), as if the reload failed. */
  breakOnReloadAfterSave?: boolean;
  /** Set by the save above: the edit page now returns a 500. */
  reloadBroken?: boolean;
}

const PRISTINE: Record<string, Listing> = {
  '1001': { name: 'Plain T-shirt', price: [150000], stock: [7], listed: true, stockMax: 99 },
  '2002': { name: 'Running shoes', price: [100000, 120000], stock: [3, 4], listed: true },
  '3003': { name: 'Backpack', price: [80000], stock: [1], listed: true, redirectTo: '9999' },
  '4004': { name: 'Cap', price: [90000], stock: [2], listed: true, saveDrops: true },
  '4141': { name: 'Socks', price: [25000], stock: [10], listed: true, onlyDraftSave: true },
  '5005': { name: 'Hoodie', price: [70000], stock: [5], listed: true, classOnlySwitch: true },
  '6006': { name: 'Sandals', price: [45000], stock: [4], listed: true, noToast: true },
  // Listed in DOM order before 777 on purpose: a substring match on "777" hits this row first.
  '7777': { name: 'Coffee cup', price: [61000], stock: [8], listed: false },
  '777': { name: 'Ceramic mug', price: [60000], stock: [6], listed: false },
  '8008': { name: 'Umbrella', price: [40000], stock: [2], listed: false, wrappedSwitch: true },
  '9999': { name: 'Water bottle', price: [50000], stock: [9], listed: true },
};

interface ChatThread {
  id: string;
  buyer: string;
  messages: string[];
}

// Listed with the longer name first on purpose: a substring match on "Budi" opens this row first.
const PRISTINE_CHATS: ChatThread[] = [
  { id: 'c2', buyer: 'Budi Santoso', messages: ['Mau tanya ongkir ke Bandung'] },
  { id: 'c1', buyer: 'Budi', messages: ['Halo kak, stok ready?'] },
];

const portal = {
  products: structuredClone(PRISTINE),
  saves: [] as string[],
  toggles: [] as string[],
  decoyClicks: 0,
  draftClicks: 0,
  imageUploads: 0,
  videoDecoyClicks: 0,
  chats: structuredClone(PRISTINE_CHATS),
  chatSends: [] as Array<{ chat: string; text: string }>,
  chatDropReplies: false,
};

function resetPortal(): void {
  portal.products = structuredClone(PRISTINE);
  portal.saves = [];
  portal.toggles = [];
  portal.decoyClicks = 0;
  portal.draftClicks = 0;
  portal.imageUploads = 0;
  portal.videoDecoyClicks = 0;
  portal.chats = structuredClone(PRISTINE_CHATS);
  portal.chatSends = [];
  portal.chatDropReplies = false;
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
const uploadCfg = JSON.parse(document.body.dataset.videoUpload || '{}');
let videoState = document.body.dataset.video || null;
let uploading = null;
const videoHost = document.getElementById('video-host');
function renderVideo() {
  if (!videoHost) return;
  if (!videoState && !uploading) {
    videoHost.innerHTML = '';
    return;
  }
  const showProgress = (uploading && uploading.progress) || videoState === 'processing';
  const showPreview = videoState === 'ready' || (uploading && uploading.preview);
  videoHost.innerHTML =
    '<div class="video-tile">' +
    (showProgress ? '<div class="upload-progress" role="progressbar" aria-valuenow="40">40%</div>' : '') +
    (showPreview ? '<video src="/media/clip.mp4" width="200" height="120"></video>' : '') +
    (document.body.dataset.videoDecoy ? '<button class="video-close-hint" type="button">Tutup</button>' : '') +
    '<button class="video-delete" type="button" aria-label="Hapus video">x</button>' +
    '</div>';
  videoHost.querySelector('.video-delete').addEventListener('click', () => {
    videoState = null;
    uploading = null;
    renderVideo();
  });
  const decoy = videoHost.querySelector('.video-close-hint');
  if (decoy) decoy.addEventListener('click', () => fetch('/__video-decoy', { method: 'POST' }));
}
const videoInput = document.getElementById('video-input');
if (videoInput) videoInput.addEventListener('change', () => {
  if (!videoInput.files || !videoInput.files.length) return;
  videoState = 'processing';
  uploading = { progress: true, preview: !!uploadCfg.previewEarly };
  renderVideo();
  if (uploadCfg.stuck) return;
  setTimeout(() => {
    uploading = null;
    videoState = 'ready';
    renderVideo();
  }, uploadCfg.processMs || 0);
});
const imageInput = document.getElementById('image-input');
if (imageInput) imageInput.addEventListener('change', () => {
  if (imageInput.files && imageInput.files.length) fetch('/__image-upload', { method: 'POST' });
});
renderVideo();
const saveBtn = document.getElementById('save-btn');
if (saveBtn) saveBtn.addEventListener('click', async () => {
  await fetch('/__save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PID, price: read('price'), stock: read('stock'), video: videoState }) });
  if (!document.body.dataset.noToast) document.getElementById('toast').style.display = 'block';
});
`;

function listPage(): string {
  const rows = Object.entries(portal.products)
    // Longer ids first: "7777" is listed above "777", so a substring match hits the wrong row first.
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
  // Listed before the real Save on purpose: a substring match on "Simpan" picks this one first.
  const draft = `<button id="draft-btn" type="button" onclick="fetch('/__draft', { method: 'POST' })">Simpan Draf</button>`;
  const save = p.onlyDraftSave ? '' : `<button id="save-btn" type="button">Simpan</button>`;
  const videoInput = p.noVideoInput
    ? ''
    : '<input type="file" id="video-input" accept="video/mp4,.mov">';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Edit ${id}</title></head><body data-pid="${id}"${
    p.noToast ? ' data-no-toast="1"' : ''
  }${videoBodyAttrs(p)}>
<h1>${p.name}</h1>
${landing}
<section class="image-section"><input type="file" id="image-input" accept="image/*"></section>
<section class="video-section">${videoInput}<div id="video-host"></div></section>
<section class="price-section">${price}</section>
<section class="stock-section">${stock}</section>
${draft}
${save}
<div id="toast" class="toast" style="display:none">Berhasil disimpan</div>
<script>${EDIT_SCRIPT}</script>
</body></html>`;
}

/** Body attributes that tell the edit page's upload stub how to behave (see EDIT_SCRIPT). */
function videoBodyAttrs(p: Listing): string {
  return [
    p.video ? ` data-video="${p.video}"` : '',
    ` data-video-upload='${JSON.stringify(p.videoUpload ?? {})}'`,
    p.videoDeleteDecoy ? ' data-video-decoy="1"' : '',
  ].join('');
}

const CHAT_SCRIPT = String.raw`
let openId = null;
const composer = document.getElementById('composer');
const thread = document.getElementById('thread');
function bubble(kind, text) {
  const el = document.createElement('div');
  el.className = 'message-item ' + kind;
  el.textContent = text;
  thread.appendChild(el);
}
function openChat(id) {
  openId = id;
  const c = CHATS.find((x) => x.id === id);
  thread.innerHTML = '';
  c.messages.forEach((m) => bubble('incoming', m));
}
function send() {
  const text = composer.innerText.trim();
  if (!openId || !text) return;
  if (DROP) {
    bubble('incoming', 'Terima kasih kak');
    return;
  }
  fetch('/__chat-send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: openId, text: text }) });
  bubble('outgoing', text);
  composer.innerText = '';
}
composer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
document.getElementById('send').addEventListener('click', send);
document.querySelectorAll('.conversation-item').forEach((el) => {
  el.addEventListener('click', () => openChat(el.dataset.chat));
});
`;

/** The seller chat app: a conversation list, a thread, and a composer that sends on Enter. */
function chatPage(): string {
  const items = portal.chats
    .map(
      (c) =>
        `<div class="conversation-item" data-chat="${c.id}"><span class="buyer">${c.buyer}</span></div>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Chat</title><style>.conversation-item { display: block; width: 260px; height: 44px; cursor: pointer; } .message-item { display: block; width: 300px; min-height: 20px; } .input-box { display: block; width: 300px; height: 40px; border: 1px solid #999; } .send-btn { display: inline-block; width: 80px; height: 30px; }</style></head><body>
<div class="conversation-list">
${items}
</div>
<div class="thread" id="thread"></div>
<div class="composer"><div class="input-box" id="composer" contenteditable="true"></div><button class="send-btn" id="send" type="button">Kirim</button></div>
<script>const CHATS = ${JSON.stringify(portal.chats)}; const DROP = ${portal.chatDropReplies ? 'true' : 'false'};</script>
<script>${CHAT_SCRIPT}</script>
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
      video?: string | null;
    };
    portal.saves.push(body.id);
    const item = portal.products[body.id];
    if (item?.breakOnReloadAfterSave) item.reloadBroken = true;
    if (item && !item.saveDrops) {
      item.price = body.price;
      item.stock = body.stock;
      if (body.video === 'ready' || body.video === 'processing') item.video = body.video;
      else delete item.video;
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
  if (p === '/__image-upload') {
    portal.imageUploads++;
    return reply(route, 200, '{}', 'application/json');
  }
  if (p === '/__video-decoy') {
    portal.videoDecoyClicks++;
    return reply(route, 200, '{}', 'application/json');
  }
  if (p === '/__chat-send') {
    const body = JSON.parse(req.postData() ?? '{}') as { chat: string; text: string };
    portal.chatSends.push(body);
    return reply(route, 200, '{}', 'application/json');
  }
  if (p === '/portal/chat-management') return reply(route, 200, chatPage());
  if (p === '/__draft') {
    portal.draftClicks++;
    return reply(route, 200, '{}', 'application/json');
  }
  if (p.startsWith('/api/')) return reply(route, 200, '{"error":0,"data":{}}', 'application/json');
  if (p === '/portal/product/list/live/all') return reply(route, 200, listPage());

  const m = /^\/portal\/product\/(\d+)$/.exec(p);
  if (m) {
    const item = portal.products[m[1]];
    if (!item) return reply(route, 404, 'not found');
    if (item.reloadBroken)
      return reply(
        route,
        500,
        '<!doctype html><html><body><h1>Service unavailable</h1></body></html>',
      );
    return reply(route, 200, editPage(m[1], item));
  }
  return reply(route, 404, 'not found');
}

/** The buyer side only needs one product page and one API endpoint for the account-write checks. */
async function routeBuyer(route: Route, req: Request): Promise<void> {
  const p = new URL(req.url()).pathname;
  if (p.startsWith('/api/')) return reply(route, 200, '{"error":0,"data":{}}', 'application/json');
  return reply(
    route,
    200,
    '<!doctype html><html><head><meta charset="utf-8"><title>Produk</title></head><body><h1>Water bottle</h1></body></html>',
  );
}

async function setup(): Promise<void> {
  const ctx: BrowserContext = await getContext(true);
  // Registered first, so it is the fallback: anything off the fixture hosts is aborted.
  await ctx.route(
    (url: URL) => url.hostname !== FIXTURE_HOST && url.hostname !== BUYER_HOST,
    (route: Route) => route.abort(),
  );
  await ctx.route(
    (url: URL) => url.hostname === FIXTURE_HOST,
    (route: Route, req: Request) => routeSeller(route, req),
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

const chatTools = recordTools(registerSellerChatTools);

/** Call a tool the way the SDK does: arguments are parsed with its shape first, so defaults apply. */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = chatTools.get(name);
  assert.ok(tool, `${name} should be registered`);
  const parsed = z.object(tool.shape as Record<string, z.ZodType>).parse(args);
  const result = await tool.handler(parsed);
  return result.content[0].text;
}

/** A small file for the upload checks to point at. Its contents are never read. */
const VIDEO_FILE = path.join(HOME, 'clip.mp4');

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

check(
  'save presses the button labelled exactly Simpan, not the look-alike Simpan Draf',
  async () => {
    const out = await updateProductPrice({ itemId: '1001', value: 165000 });
    assert.match(out, /set to 165,000 and saved/);
    assert.deepEqual(portal.products['1001'].price, [165000]);
    assert.equal(portal.draftClicks, 0, 'the draft button must not be pressed');
  },
);

check('a save that persists without a success toast is reported from the re-read', async () => {
  const out = await updateProductPrice({ itemId: '6006', value: 47000 });
  assert.match(out, /set to 47,000 and saved/);
  assert.match(out, /No success toast/);
  assert.deepEqual(portal.products['6006'].price, [47000]);
});

check('with no exact Save button, nothing is clicked and nothing is saved', async () => {
  await assert.rejects(updateProductPrice({ itemId: '4141', value: 26000 }), /No Save button/);
  assert.equal(portal.draftClicks, 0, 'the look-alike draft button must not be pressed');
  assert.deepEqual(portal.products['4141'].price, [25000]);
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
  const entries = await readAudit();
  assert.ok(entries.some((e) => e.tool === 'seller:update-stock' && e.ok === false));
  assert.ok(entries.some((e) => e.tool === 'seller:update-price' && e.ok === true));
});

check('an account write spends the write budget and is audited', async () => {
  const before = safetyStatus().writesLastHour;
  await captureAccountWrite('like_product', `${BUYER_BASE}/product/1/2`, {
    apiMatches: ['pdp/like_items'],
    timeoutMs: 15000,
    interact: async (page) => {
      await page.evaluate(() =>
        fetch('/api/v4/pdp/like_items', { method: 'POST' }).then((r) => r.text()),
      );
    },
  });
  assert.equal(safetyStatus().writesLastHour, before + 1, 'an account write must count as a write');
  const entries = await readAudit();
  assert.ok(
    entries.some((e) => e.kind === 'write' && e.tool === 'like_product' && e.ok === true),
    'an account write must be audited',
  );
});

check('a read capture does not spend the write budget', async () => {
  const before = safetyStatus().writesLastHour;
  await captureAll(`${BUYER_BASE}/product/1/2`, {
    apiMatches: ['pdp/like_items'],
    timeoutMs: 15000,
    interact: async (page) => {
      await page.evaluate(() => fetch('/api/v4/pdp/like_items').then((r) => r.text()));
    },
  });
  assert.equal(safetyStatus().writesLastHour, before);
});

// Video: upload and remove a product's video through the edit page.

check('upload: attaches the video, waits for it, saves, and the saved video is ready', async () => {
  const out = await uploadProductVideo({ itemId: '1001', videoPath: VIDEO_FILE });
  assert.match(out, /Saved/);
  assert.equal(portal.products['1001'].video, 'ready');
  assert.deepEqual(portal.saves, ['1001']);
});

check('upload: a video still processing is not saved as if it were ready', async () => {
  // The preview appears before processing ends, so only the progress bar says "not yet".
  portal.products['1001'].videoUpload = { processMs: 3000, previewEarly: true };
  await uploadProductVideo({ itemId: '1001', videoPath: VIDEO_FILE, processTimeoutMs: 60000 });
  assert.equal(portal.products['1001'].video, 'ready');
});

check('upload: a video that never finishes processing is refused and not saved', async () => {
  portal.products['1001'].videoUpload = { stuck: true, previewEarly: true };
  await assert.rejects(
    uploadProductVideo({ itemId: '1001', videoPath: VIDEO_FILE, processTimeoutMs: 4000 }),
    /did not finish processing/,
  );
  assert.deepEqual(portal.saves, []);
});

check(
  'upload: with only an image uploader on the page, the video is refused, not sent to it',
  async () => {
    portal.products['1001'].noVideoInput = true;
    await assert.rejects(
      uploadProductVideo({ itemId: '1001', videoPath: VIDEO_FILE, processTimeoutMs: 4000 }),
      /No video file input found/,
    );
    assert.equal(portal.imageUploads, 0, 'the video must not be attached to the image uploader');
    assert.deepEqual(portal.saves, []);
  },
);

check('remove: deletes the video, saves, and the reloaded page confirms it is gone', async () => {
  portal.products['1001'].video = 'ready';
  const out = await removeProductVideo({ itemId: '1001' });
  assert.match(out, /Video deleted and product 1001 saved/);
  assert.equal(portal.products['1001'].video, undefined);
});

check('remove: a control that deletes nothing is not reported as a deletion', async () => {
  portal.products['1001'].video = 'ready';
  portal.products['1001'].videoDeleteDecoy = true;
  await assert.rejects(removeProductVideo({ itemId: '1001' }), /still attached/);
  assert.equal(portal.videoDecoyClicks, 1);
  assert.equal(portal.products['1001'].video, 'ready');
});

check(
  'remove: if the edit page does not render after saving, the removal is not reported as confirmed',
  async () => {
    portal.products['1001'].video = 'ready';
    portal.products['1001'].breakOnReloadAfterSave = true;
    await assert.rejects(removeProductVideo({ itemId: '1001' }), /could not be checked/);
    assert.deepEqual(portal.saves, ['1001']);
  },
);

check('remove: a product with no video says so and saves nothing', async () => {
  await assert.rejects(removeProductVideo({ itemId: '1001' }), /No video delete control found/);
  assert.deepEqual(portal.saves, []);
});

check('upload: a file that is not MP4 or MOV is refused before the browser is used', async () => {
  const wrong = path.join(HOME, 'clip.avi');
  await fs.writeFile(wrong, Buffer.alloc(16));
  await assert.rejects(
    uploadProductVideo({ itemId: '1001', videoPath: wrong }),
    /Unsupported video extension/,
  );
  assert.deepEqual(portal.saves, []);
});

// Chat: read a thread and send a reply through the seller chat app.

check('read_chat: reading a thread does not spend the write budget', async () => {
  const before = safetyStatus().writesLastHour;
  const out = await callTool('read_chat', { match: 'Budi' });
  assert.match(out, /Thread/);
  assert.equal(safetyStatus().writesLastHour, before, 'a read must not count as a write');
});

check('read_chat: a name that is part of another buyer’s name opens the exact buyer', async () => {
  const out = await callTool('read_chat', { match: 'Budi' });
  assert.match(out, /Halo kak, stok ready\?/);
  assert.doesNotMatch(out, /ongkir/);
});

check(
  'send_chat_reply: sends to the exact buyer, not the first name containing the match',
  async () => {
    const out = await callTool('send_chat_reply', {
      match: 'Budi',
      message: 'Stok ready kak',
      confirm: true,
    });
    assert.match(out, /Reply sent to "Budi"/);
    assert.deepEqual(portal.chatSends, [{ chat: 'c1', text: 'Stok ready kak' }]);
  },
);

check('send_chat_reply: two buyers with the same name are not guessed between', async () => {
  portal.chats = [
    { id: 's1', buyer: 'Sari', messages: ['Halo'] },
    { id: 's2', buyer: 'Sari', messages: ['Pesan lain'] },
  ];
  const out = await callTool('send_chat_reply', {
    match: 'Sari',
    message: 'Halo juga',
    confirm: true,
  });
  assert.match(out, /2 conversations match "Sari"/);
  assert.deepEqual(portal.chatSends, []);
});

check(
  'send_chat_reply: a reply is reported as sent only when its text shows in the thread',
  async () => {
    portal.chatDropReplies = true;
    const out = await callTool('send_chat_reply', {
      match: 'Budi Santoso',
      message: 'Stok ready kak',
      confirm: true,
    });
    assert.doesNotMatch(out, /Reply sent/);
    assert.match(out, /verify/);
    assert.deepEqual(portal.chatSends, []);
  },
);

check('send_chat_reply: a multi-line reply is refused, not sent line by line', async () => {
  const out = await callTool('send_chat_reply', {
    match: 'Budi Santoso',
    message: 'Halo\nSaya bantu',
    confirm: true,
  });
  assert.match(out, /one line/);
  assert.deepEqual(portal.chatSends, []);
});

check('send_chat_reply: a blank reply is refused before anything is typed', async () => {
  const out = await callTool('send_chat_reply', {
    match: 'Budi Santoso',
    message: '   ',
    confirm: true,
  });
  assert.match(out, /reply is blank/);
  assert.deepEqual(portal.chatSends, []);
});

check('send_chat_reply: a plain reply is sent and confirmed in the thread', async () => {
  const out = await callTool('send_chat_reply', {
    match: 'Budi Santoso',
    message: 'Stok ready kak',
    confirm: true,
  });
  assert.match(out, /Reply sent to "Budi Santoso"/);
  assert.deepEqual(portal.chatSends, [{ chat: 'c2', text: 'Stok ready kak' }]);
});

check('send_chat_reply: without confirm it previews and types nothing', async () => {
  const out = await callTool('send_chat_reply', {
    match: 'Budi Santoso',
    message: 'Stok ready kak',
  });
  assert.match(out, /WRITE PREVIEW/);
  assert.deepEqual(portal.chatSends, []);
});

check('send_chat_reply: refused while seller writes are disabled', async () => {
  process.env.SHOPEE_ENABLE_SELLER_WRITES = 'false';
  try {
    const out = await callTool('send_chat_reply', {
      match: 'Budi Santoso',
      message: 'Stok ready kak',
      confirm: true,
    });
    assert.match(out, /Seller write actions are disabled/);
  } finally {
    process.env.SHOPEE_ENABLE_SELLER_WRITES = 'true';
  }
  assert.deepEqual(portal.chatSends, []);
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

  await fs.writeFile(VIDEO_FILE, Buffer.alloc(4096));
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
