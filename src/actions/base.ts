import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Page } from 'playwright';
import { withBrowserLock } from '../browser/session.js';
import { audit } from '../utils/audit.js';

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Per-step navigation/interaction timeout for UI actions. */
export const ACTION_TIMEOUT_MS = parseInt(process.env.SHOPEE_ACTION_TIMEOUT_MS ?? '60000', 10);

/**
 * Base politeness delay between UI steps inside an action, jittered by
 * stepDelay() — a fixed cadence is itself a bot signature, so every step
 * waits a random 0.8–1.8× of this.
 */
export const ACTION_STEP_DELAY_MS = parseInt(process.env.SHOPEE_ACTION_DELAY_MS ?? '2000', 10);

/** Debug screenshots land here (kept on disk for post-mortem, never uploaded). */
export const DEBUG_SHOT_DIR = path.join(os.homedir(), '.shopee-mcp', 'debug');

/**
 * All seller-side write actions (portal edits, chat replies) are disabled
 * unless explicitly enabled — the shop is parked pending onboarding, and a
 * disabled-by-default switch prevents an AI client from writing to the shop
 * uninvited. Buyer-realm writes (Shopee Video posting) are not affected.
 */
export function sellerWritesEnabled(): boolean {
  return process.env.SHOPEE_ENABLE_SELLER_WRITES === 'true';
}

export function assertSellerWritesEnabled(tool: string): void {
  if (!sellerWritesEnabled()) {
    throw new Error(
      `🚫 Seller write actions are disabled (SHOPEE_ENABLE_SELLER_WRITES is not "true").\n` +
        `The seller realm is parked — enable it in .env only when you intend to let ` +
        `automation modify your shop (${tool}).`,
    );
  }
}

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

/** Random 0.8–1.8× factor — human-ish, never a fixed rhythm. */
export function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random()));
}

export function stepDelay(): Promise<void> {
  return sleep(jitter(ACTION_STEP_DELAY_MS));
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
 * Run a UI write action, serialized with all other browser traffic by the
 * account-safety gate ('write' limits), and audit the outcome to
 * ~/.shopee-mcp/audit.log. On failure the page state is screenshotted to
 * ~/.shopee-mcp/debug so the selector can be diagnosed from evidence.
 */
export async function withSellerAction<T>(
  name: string,
  fn: (page: Page) => Promise<T>,
  meta?: string,
): Promise<T> {
  return withRealmAction(name, 'seller', 'write', fn, meta);
}

/**
 * Read-only work on the seller realm, such as reading a chat thread. It takes the
 * same browser lock and leaves the same debug screenshot on failure, but it spends
 * the read budget and writes no audit entry: it changes nothing, so it must not
 * count as a write.
 */
export async function withSellerRead<T>(
  name: string,
  fn: (page: Page) => Promise<T>,
  meta?: string,
): Promise<T> {
  return withRealmAction(name, 'seller', 'read', fn, meta);
}

/** Same contract as withSellerAction, for write actions on the buyer realm. */
export async function withBuyerAction<T>(
  name: string,
  fn: (page: Page) => Promise<T>,
  meta?: string,
): Promise<T> {
  return withRealmAction(name, 'buyer', 'write', fn, meta);
}

/** Read-only work on the buyer realm. See withSellerRead. */
export async function withBuyerRead<T>(
  name: string,
  fn: (page: Page) => Promise<T>,
  meta?: string,
): Promise<T> {
  return withRealmAction(name, 'buyer', 'read', fn, meta);
}

async function withRealmAction<T>(
  name: string,
  realm: 'buyer' | 'seller',
  kind: 'read' | 'write',
  fn: (page: Page) => Promise<T>,
  meta?: string,
): Promise<T> {
  return withBrowserLock(async () => {
    // Imported lazily to avoid a circular import: session → (nothing), actions → session.
    const { getPageFor } = await import('../browser/session.js');
    const page = await getPageFor(realm);
    try {
      const result = await fn(page);
      if (kind === 'write') {
        audit({ kind: 'write', tool: `${realm}:${name}`, ok: true, detail: meta });
      }
      return result;
    } catch (err) {
      const shot = await debugShot(page, name);
      const detail = err instanceof Error ? err.message : String(err);
      if (kind === 'write') {
        audit({
          kind: 'write',
          tool: `${realm}:${name}`,
          ok: false,
          detail: meta,
          error: detail.slice(0, 300),
        });
      }
      throw new ActionError(`${detail}${shot ? `\n📸 Screenshot: ${shot}` : ''}`, shot);
    }
  }, kind);
}
