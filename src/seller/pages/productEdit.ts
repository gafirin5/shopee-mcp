import type { Locator, Page } from 'playwright';
import { ACTION_TIMEOUT_MS } from '../../actions/base.js';
import { SELLER_PATHS } from '../urls.js';

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
  /** Upload progress percent text. */
  progressText: 'text=/100\\s*%|selesai|complete/i',
  /** Save button (id-ID portal: "Simpan"; fallbacks for en/zh). */
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
  await page.goto(`${SELLER_PATHS.productEdit(itemId)}`, {
    waitUntil: 'domcontentloaded',
    timeout: ACTION_TIMEOUT_MS,
  });
  // The edit page is a heavy SPA — give the media section a beat to mount.
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

function videoInputCandidates(page: Page): Locator[] {
  return [
    page.locator(SEL.videoFileInput),
    page.locator(SEL.videoInputNearVideoContainer),
    page.locator(SEL.anyFileInput),
  ];
}

/**
 * Locate the video file input. Returns the first visible-or-attached candidate;
 * throws a selector-diagnostic error if none exist (e.g. we're on the wrong page).
 */
export async function findVideoInput(page: Page): Promise<Locator> {
  for (const loc of videoInputCandidates(page)) {
    try {
      if (await loc.first().count()) return loc.first();
    } catch {
      // invalid selector on this DOM — try the next candidate
    }
  }
  throw new Error(
    'No video file input found on the product edit page. ' +
      'The portal UI may have drifted — check the debug screenshot, update SEL selectors, ' +
      'or pass an explicit edit_path override.',
  );
}

/**
 * Wait until the uploaded video is rendered (preview node present) and the
 * progress indicator is gone or reads complete. Video transcoding on Shopee's
 * side can take a while — timeoutMs covers the whole upload+process window.
 */
export async function waitForVideoReady(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const preview = page.locator(SEL.videoPreview);
    const hasPreview = (await preview.count()) > 0;
    if (hasPreview) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

/** Click the portal Save button and wait for a success toast. */
export async function saveProduct(page: Page): Promise<boolean> {
  const save = page.locator(SEL.saveButton).first();
  await save.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await save.click();
  try {
    await page.locator(SEL.successToast).first().waitFor({ state: 'visible', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
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
