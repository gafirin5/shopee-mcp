import type { Locator, Page } from 'playwright';
import { ACTION_TIMEOUT_MS } from '../../actions/base.js';
import { SELLER_PATHS, sellerUrl } from '../urls.js';

/**
 * Selectors for the Seller Centre product edit page (Media section).
 *
 * Shopee's portal is a moving target; every selector lives here so a UI drift
 * is a one-line fix. When one breaks, the failing action's debug screenshot
 * (see withSellerAction) shows the live DOM — update the constant, nothing else.
 */
export const SEL = {
  /** File input that accepts video (the portal exposes it after you click the video add-tile). */
  videoFileInput:
    'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], input[type="file"][accept*=".mov"]',
  /** Fallback: any file input inside a container whose class hints at video. */
  videoInputNearVideoContainer:
    '[class*="video" i] input[type="file"], [class*="Video" i] input[type="file"]',
  /** Any file input at all (last resort — the page's media inputs). */
  anyFileInput: 'input[type="file"]',
  /** The "add video" tile that reveals the file chooser. */
  addVideoTile: '[class*="video" i] [class*="add" i], [data-testid*="video" i] [class*="add" i]',
  /** A rendered video preview (uploaded state) inside the media section. */
  videoPreview: 'video, [class*="video" i] source, [class*="video" i] [class*="thumb" i] img',
  /** A progress bar still moving inside the video area: the upload or transcode is not finished. */
  videoProgress: '[class*="video" i] [role="progressbar"]',
  /** Upload progress percent text. */
  progressText: 'text=/100\\s*%|selesai|complete/i',
  /** Save button candidates (id-ID "Simpan"; en/zh fallbacks). Substring match only: the label is checked exactly in findSaveButton. */
  saveButton: 'button:has-text("Simpan"), button:has-text("Save"), button:has-text("保存")',
  /** Success toast after saving. */
  successToast: 'text=/berhasil|success|saved|tersimpan|更新成功/i',
  /** Price inputs on the edit page (base price first; variation rows follow). */
  priceInput: '[class*="price" i] input[type="text"], [class*="price" i] input:not([type])',
  /** Stock inputs on the edit page (per model when variations exist). */
  stockInput: '[class*="stock" i] input[type="text"], [class*="stock" i] input:not([type])',
} as const;

/** Open the product edit page for a marketplace itemid. */
export async function openProductEdit(page: Page, itemId: string): Promise<void> {
  // Absolute on purpose — see openProductList: a bare path cannot be navigated to.
  await page.goto(sellerUrl(SELLER_PATHS.productEdit(itemId)), {
    waitUntil: 'domcontentloaded',
    timeout: ACTION_TIMEOUT_MS,
  });
  // The edit page is a heavy SPA — give the media section a beat to mount.
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

/**
 * Accept types that name a video format. A fallback input has to declare one: the media
 * section also holds image uploaders, and a video sent to one of those is a misdirected
 * write.
 */
const VIDEO_ACCEPT = /video|\.mp4|\.mov|\.m4v/i;

/**
 * Locate the video file input. The specific selector comes first. The fallbacks match
 * looser selectors, so they count only when their input declares a video type. Throws a
 * selector-diagnostic error if none exist (e.g. we're on the wrong page).
 */
export async function findVideoInput(page: Page): Promise<Locator> {
  const specific = page.locator(SEL.videoFileInput).first();
  if ((await specific.count().catch(() => 0)) > 0) return specific;
  for (const selector of [SEL.videoInputNearVideoContainer, SEL.anyFileInput]) {
    const inputs = page.locator(selector);
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const accept = (await inputs.nth(i).getAttribute('accept')) ?? '';
      if (VIDEO_ACCEPT.test(accept)) return inputs.nth(i);
    }
  }
  throw new Error(
    'No video file input found on the product edit page. ' +
      'The portal UI may have drifted — check the debug screenshot, update SEL selectors, ' +
      'or pass an explicit edit_path override.',
  );
}

/** Whether the page shows a video preview. */
async function hasVideoPreview(page: Page): Promise<boolean> {
  return (await page.locator(SEL.videoPreview).count()) > 0;
}

/** Whether an upload or transcode is still moving in the video area. */
async function videoStillProcessing(page: Page): Promise<boolean> {
  const bars = page.locator(SEL.videoProgress);
  const n = await bars.count();
  for (let i = 0; i < n; i++) {
    const bar = bars.nth(i);
    if (!(await bar.isVisible().catch(() => false))) continue;
    const value = await bar.getAttribute('aria-valuenow');
    const text = ((await bar.innerText().catch(() => '')) || '').trim();
    if (value !== '100' && !/^100\s*%$/.test(text)) return true;
  }
  return false;
}

/**
 * Wait until the uploaded video is rendered and no progress bar is still moving.
 *
 * A preview can render before processing ends, so the preview alone is not enough.
 * Video transcoding on Shopee's side can take a while — timeoutMs covers the whole
 * upload+process window.
 */
export async function waitForVideoReady(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await hasVideoPreview(page)) && !(await videoStillProcessing(page))) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

/** What a freshly loaded edit page shows about the video. */
export type VideoOnReload = 'confirmed' | 'contradicted' | 'unknown';

/**
 * On a freshly loaded edit page, wait until the video preview is present (`wantPresent`)
 * or absent. After Save, the reloaded page is the evidence, not the toast. Returns
 * 'unknown' when the editor never rendered: a blank page would otherwise look like
 * "no video".
 */
export async function waitForVideoOnReload(
  page: Page,
  wantPresent: boolean,
  timeoutMs: number,
): Promise<VideoOnReload> {
  const rendered = await page
    .locator(SEL.saveButton)
    .first()
    .waitFor({ state: 'attached', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!rendered) return 'unknown';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await hasVideoPreview(page)) === wantPresent) return 'confirmed';
    if (Date.now() >= deadline) return 'contradicted';
    await page.waitForTimeout(1000);
  }
}

/**
 * The Save button's exact label, compared after trimming and lower-casing.
 *
 * SEL.saveButton is a substring match, and that is not enough on its own:
 * "Simpan Draf" (save as draft) contains "Simpan" and can come first in the DOM,
 * so `.first()` on the selector presses the draft button. When the portal
 * renames Save, change this list rather than loosening the selector.
 */
const SAVE_LABELS = ['simpan', 'save', '保存'];

/** The visible button whose exact label is a save label, polling until timeoutMs. */
async function findSaveButton(page: Page, timeoutMs: number): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidates = page.locator(SEL.saveButton);
    const n = await candidates.count();
    for (let i = 0; i < n; i++) {
      const button = candidates.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const label = (await button.innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (SAVE_LABELS.includes(label)) return button;
    }
    if (Date.now() >= deadline) return undefined;
    await page.waitForTimeout(250);
  }
}

/**
 * Click the portal's Save button and report whether a success toast appeared.
 *
 * The toast is a hint, not proof: its text match is page-wide, so an unrelated
 * "berhasil" can show, and a save that worked can show nothing. Callers that
 * need certainty re-read the saved value from a freshly loaded page.
 */
export async function saveProduct(page: Page): Promise<{ toastSeen: boolean }> {
  const save = await findSaveButton(page, ACTION_TIMEOUT_MS);
  if (!save) {
    throw new Error(
      'No Save button labelled "Simpan" or "Save" is visible on the edit page, so nothing was saved. ' +
        'The portal may have renamed it; check the debug screenshot.',
    );
  }
  await save.click();
  const toastSeen = await page
    .locator(SEL.successToast)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  return { toastSeen };
}

/**
 * Locate the price inputs. Index 0 is the base price on simple products; on
 * variation products the inputs map to variation rows in DOM order.
 */
export async function getPriceInputs(page: Page): Promise<Locator[]> {
  const loc = page.locator(SEL.priceInput);
  const n = await loc.count();
  if (!n) throw new Error('No price input found — selector drift or wrong page (see screenshot).');
  return Array.from({ length: n }, (_, i) => loc.nth(i));
}

/** Locate the stock inputs, same mapping as getPriceInputs. */
export async function getStockInputs(page: Page): Promise<Locator[]> {
  const loc = page.locator(SEL.stockInput);
  const n = await loc.count();
  if (!n) throw new Error('No stock input found — selector drift or wrong page (see screenshot).');
  return Array.from({ length: n }, (_, i) => loc.nth(i));
}
