import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Page, Response } from 'playwright';

// ─── Configuration ────────────────────────────────────────────────────────────

export const DOMAIN = process.env.SHOPEE_DOMAIN || 'shopee.co.id';
export const BASE_URL = `https://${DOMAIN}`;

// The Seller Centre lives on its own subdomain with its own portal app. It is
// still one Shopee account, so by default we reuse the same browser profile and
// let Shopee's wildcard-domain cookies SSO us in — no second login needed.
// Point SHOPEE_SELLER_PROFILE_DIR at a separate directory only if you want the
// seller realm isolated in its own login.
export const SELLER_BASE_URL = `https://seller.${DOMAIN}`;

export const PROFILE_DIR =
  process.env.SHOPEE_PROFILE_DIR || path.join(os.homedir(), '.shopee-mcp', 'chrome-profile');

// Shopee detects headless even with fingerprint patches, so we run HEADED by
// default (needs a display: WSLg, a desktop X server, or xvfb for servers).
// Set SHOPEE_HEADLESS=true only to experiment.
const HEADLESS = process.env.SHOPEE_HEADLESS === 'true';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function debug(msg: string): void {
  if (process.env.DEBUG === 'true') process.stderr.write(`[shopee-mcp] ${msg}\n`);
}

// ─── Context singleton ────────────────────────────────────────────────────────
//
// Shopee gates product data behind per-request anti-fraud signatures that only
// its own SDK, running in a non-detected browser, can mint. So we drive
// CloakBrowser (a fingerprint-patched Chromium) against a persistent profile the
// user logs into once (npm run login). We never hand-craft the signed request —
// instead we navigate to the relevant page and intercept the response Shopee's
// app fires (see captureJson).

let contextPromise: Promise<BrowserContext> | null = null;

async function createContext(headless: boolean): Promise<BrowserContext> {
  debug(`Launching CloakBrowser (headless=${headless}) with profile: ${PROFILE_DIR}`);
  const ctx = (await launchPersistentContext({
    userDataDir: PROFILE_DIR,
    headless,
    userAgent: USER_AGENT,
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    viewport: { width: 1366, height: 768 },
    humanize: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })) as unknown as BrowserContext;
  return ctx;
}

/**
 * Get the shared browser context, launching it on first use.
 * `headless` overrides the env default (the login flow forces a visible window).
 */
export async function getContext(headless: boolean = HEADLESS): Promise<BrowserContext> {
  if (!contextPromise) contextPromise = createContext(headless);
  return contextPromise;
}

// ─── Realm-scoped pages ───────────────────────────────────────────────────────

export type Realm = 'buyer' | 'seller';

function pageBelongsTo(p: Page, realm: Realm): boolean {
  const url = p.url();
  if (realm === 'seller') return url.includes(`seller.${DOMAIN}`);
  // The seller subdomain contains the buyer domain as a substring, so the
  // buyer check must explicitly exclude it.
  return url.includes(DOMAIN) && !url.includes(`seller.${DOMAIN}`);
}

/** The page reused for a given realm — buyer and seller traffic never share one. */
async function getPageFor(realm: Realm): Promise<Page> {
  const ctx = await getContext();
  const open = ctx.pages().filter((p) => !p.isClosed());
  const owned = open.filter((p) => pageBelongsTo(p, realm));
  if (owned.length) return owned[0];
  // A brand-new tab starts at about:blank and can be adopted by either realm.
  const fresh = open.filter((p) => p.url() === 'about:blank' || p.url() === '');
  if (fresh.length) return fresh[0];
  return ctx.newPage();
}

/** The single reused page for the buyer (marketplace) realm. */
export async function getPage(): Promise<Page> {
  return getPageFor('buyer');
}

/** The single reused page for the Seller Centre realm. */
export async function getSellerPage(): Promise<Page> {
  return getPageFor('seller');
}

// ─── Serialized navigation + interception ──────────────────────────────────────
//
// One global lock covers every realm and every action (reads and writes): a
// single Chromium profile can only drive so much concurrent navigation, and a
// write action in flight must not be interrupted by a read capture.

let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/**
 * Serialize a callback against all other browser traffic. Used by the UI-action
 * layer (src/actions) so writes and captures can never interleave.
 */
export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(fn);
}

export interface CaptureOptions {
  /** Substring (or list of substrings) the target response URL must contain. */
  apiMatch: string | string[];
  /** Max time to wait for the matching response (ms). */
  timeoutMs?: number;
  /** Which realm's page to navigate — defaults to the buyer marketplace. */
  realm?: Realm;
  /** Extra predicate the matching response URL must satisfy. */
  urlFilter?: (url: string) => boolean;
  /**
   * Runs after `goto` while the response is already being waited on — use it to
   * poke the page (scroll to a lazy section, click a tab) so the app fires the
   * target request.
   */
  trigger?: (page: Page) => Promise<void>;
}

function matchUrl(url: string, opts: CaptureOptions): boolean {
  const matches = Array.isArray(opts.apiMatch) ? opts.apiMatch : [opts.apiMatch];
  return matches.some((m) => url.includes(m)) && (opts.urlFilter ? opts.urlFilter(url) : true);
}

export interface CaptureResult<T> {
  json: T;
  /** The URL of the response that matched — tells you which candidate fired. */
  matchedUrl: string;
}

/**
 * Navigate to `pageUrl` and return the JSON body of the first API response
 * whose URL matches `apiMatch` — i.e. the request Shopee's own app fires
 * (carrying the valid anti-fraud signature). Returns the raw parsed JSON;
 * callers inspect its `error` field.
 */
export async function captureJson<T>(
  pageUrl: string,
  opts: CaptureOptions,
): Promise<CaptureResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  return withLock(async () => {
    const page = await getPageFor(opts.realm ?? 'buyer');

    const matched = page.waitForResponse((r: Response) => matchUrl(r.url(), opts), {
      timeout: timeoutMs,
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    if (opts.trigger) {
      try {
        await opts.trigger(page);
      } catch (err) {
        debug(`capture trigger failed (continuing to wait): ${err}`);
      }
    }

    const resp = await matched;
    const json = (await resp.json()) as T;
    return { json, matchedUrl: resp.url() };
  });
}

/** Warm the session once (loads Shopee so the anti-fraud SDK initialises). */
export async function warm(): Promise<void> {
  await withLock(async () => {
    const page = await getPageFor('buyer');
    if (!page.url().includes(DOMAIN)) {
      debug('Warming session on Shopee homepage…');
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);
    }
  });
}

/** Best-effort check that the saved profile is logged in. */
export async function isLoggedIn(): Promise<boolean> {
  const ctx = await getContext();
  const cookies = await ctx.cookies(BASE_URL);
  // Shopee sets SPC_U (user id) and SPC_EC (encrypted session) once authenticated.
  return cookies.some((c) => (c.name === 'SPC_U' || c.name === 'SPC_EC') && c.value.length > 4);
}

/**
 * Best-effort check that the Seller Centre portal is reachable with the current
 * session. Navigates to the portal and inspects where we land: the sign-in page
 * means the realm needs a manual login (npm run login:seller).
 */
export async function isSellerLoggedIn(): Promise<boolean> {
  return withLock(async () => {
    const page = await getPageFor('seller');
    await page.goto(`${SELLER_BASE_URL}/portal/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(3000);
    const url = page.url();
    debug(`Seller portal landed on: ${url}`);
    return !/signin|\/login|account\/sign/i.test(url);
  });
}

/** Cleanly close the browser (used on shutdown / after login). */
export async function closeContext(): Promise<void> {
  if (contextPromise) {
    const ctx = await contextPromise;
    await ctx.close();
    contextPromise = null;
  }
}
