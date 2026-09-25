import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Page } from 'playwright';
import { withBrowserLock } from '../browser/session.js';

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Per-step navigation/interaction timeout for UI actions. */
export const ACTION_TIMEOUT_MS = parseInt(process.env.SHOPEE_ACTION_TIMEOUT_MS ?? '60000', 10);

/**
 * Politeness delay between UI steps inside an action. Write actions touch the
 * user's own account — crawl-pace them instead of bursting.
 */
export const ACTION_STEP_DELAY_MS = parseInt(process.env.SHOPEE_ACTION_DELAY_MS ?? '1500', 10);

/** Debug screenshots land here (kept on disk for post-mortem, never uploaded). */
export const DEBUG_SHOT_DIR = path.join(os.homedir(), '.shopee-mcp', 'debug');

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ActionError extends Error {
  constructor(
    message: string,
    public readonly screenshotPath?: string,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stepDelay(): Promise<void> {
  return sleep(ACTION_STEP_DELAY_MS);
}

/** Capture a screenshot for debugging; best-effort, never throws. */
export async function debugShot(page: Page, name: string): Promise<string | undefined> {
  try {
    await fs.mkdir(DEBUG_SHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DEBUG_SHOT_DIR, `${stamp}-${name}.png`);
    await page.screenshot({ path: file, timeout: 10000 });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Run a UI write action against the Seller Centre page, serialized with all
 * other browser traffic (captures, other actions) by the global browser lock.
 *
 * On failure the page state is screenshotted to ~/.shopee-mcp/debug so the
 * selector can be diagnosed from evidence instead of a blind error message.
 */
export async function withSellerAction<T>(
  name: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  return withRealmAction(name, 'seller', fn);
}

/** Same contract as withSellerAction, for write actions on the buyer realm. */
export async function withBuyerAction<T>(name: string, fn: (page: Page) => Promise<T>): Promise<T> {
  return withRealmAction(name, 'buyer', fn);
}

async function withRealmAction<T>(
  name: string,
  realm: 'buyer' | 'seller',
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  return withBrowserLock(async () => {
    // Imported lazily to avoid a circular import: session → (nothing), actions → session.
    const { getPageFor } = await import('../browser/session.js');
    const page = await getPageFor(realm);
    try {
      return await fn(page);
    } catch (err) {
      const shot = await debugShot(page, name);
      const detail = err instanceof Error ? err.message : String(err);
      throw new ActionError(`${detail}${shot ? `\n📸 Screenshot: ${shot}` : ''}`, shot);
    }
  });
}
