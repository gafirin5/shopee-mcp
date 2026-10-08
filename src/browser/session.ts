import { launchPersistentContext } from 'cloakbrowser';
import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Response } from 'playwright';
import { createSafetyGate } from '../utils/rate-limit.js';

// ─── Configuration ────────────────────────────────────────────────────────────

export const DOMAIN = process.env.SHOPEE_DOMAIN || 'shopee.co.id';
export const BASE_URL = `https://${DOMAIN}`;

// The Seller Centre lives on its own subdomain with its own portal app. It is
// still one Shopee account, so we reuse the same browser profile and let
// Shopee's wildcard-domain cookies SSO us in — no second login, and no separate
// profile directory to configure.
export const SELLER_BASE_URL = `https://seller.${DOMAIN}`;

// Shopee tailors its web app to the visitor's region, so the browser's locale and
// timezone must match the domain we're browsing — a Malaysian store opened with an
// id-ID/Asia/Jakarta browser is an inconsistency the anti-bot gate can notice.
// Keyed by domain suffix; `SHOPEE_LOCALE` / `SHOPEE_TIMEZONE` override either one.
// `currency` is here because Shopee's newer search cards omit any per-item
// currency field (the old `item_basic.currency`), so the region is the only
// thing left to infer it from.
export interface Region {
  locale: string;
  timezone: string;
  currency: string;
}

const REGION_DEFAULTS: Record<string, Region> = {
  '.id': { locale: 'id-ID', timezone: 'Asia/Jakarta', currency: 'IDR' },
  '.my': { locale: 'en-MY', timezone: 'Asia/Kuala_Lumpur', currency: 'MYR' },
  '.sg': { locale: 'en-SG', timezone: 'Asia/Singapore', currency: 'SGD' },
  '.tw': { locale: 'zh-TW', timezone: 'Asia/Taipei', currency: 'TWD' },
};

// Falls back to the Indonesian defaults, matching the default SHOPEE_DOMAIN.
const FALLBACK_REGION = REGION_DEFAULTS['.id'];

/** Region defaults for a Shopee domain, chosen by its TLD suffix. */
export function regionFor(domain: string): Region {
  const suffix = Object.keys(REGION_DEFAULTS).find((s) => domain.endsWith(s));
  return suffix ? REGION_DEFAULTS[suffix] : FALLBACK_REGION;
}

const region = regionFor(DOMAIN);
export const LOCALE = process.env.SHOPEE_LOCALE || region.locale;
export const TIMEZONE = process.env.SHOPEE_TIMEZONE || region.timezone;
export const CURRENCY = region.currency;

export const PROFILE_DIR =
  process.env.SHOPEE_PROFILE_DIR || path.join(os.homedir(), '.shopee-mcp', 'chrome-profile');

// Shopee detects headless even with fingerprint patches, so we run HEADED by
// default (needs a display: WSLg, a desktop X server, or xvfb for servers).
// Set SHOPEE_HEADLESS=true only to experiment.
const HEADLESS = process.env.SHOPEE_HEADLESS === 'true';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Verbose logging is opt-in: only an explicit "true" enables it, so an unset,
// empty or malformed DEBUG leaves it off. Resolved once, and exported so every
// caller shares one definition of "is debugging on" rather than re-reading env.
export const DEBUG = process.env.DEBUG === 'true';

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[shopee-mcp] ${msg}\n`);
}

// ─── Context singleton ────────────────────────────────────────────────────────
//
// Shopee gates product data behind per-request anti-fraud signatures that only
// its own SDK, running in a non-detected browser, can mint. So we drive
// CloakBrowser (a fingerprint-patched Chromium) against a persistent profile the
// user logs into once (npm run login). We never hand-craft the signed request —
// instead we navigate to the relevant page and intercept the response Shopee's
// app fires (see captureJson).

// Account-safety gate: spacing, budgets, the anti-bot circuit breaker, and the
// request counter for EVERY browser operation (see src/utils/rate-limit.ts).
// One account + one IP means behaviour is the ban trigger — so all traffic
// funnels through here. Declared before createContext so the context-level
// response listener below can feed it.
const safety = createSafetyGate();

/** Shopee API paths — /api/v4/pdp/get_pc, /api/v2/item/get_ratings, … */
const SHOPEE_API_RE = /\/api\/v\d+\//;

let contextPromise: Promise<BrowserContext> | null = null;

async function createContext(headless: boolean): Promise<BrowserContext> {
  debug(
    `Launching CloakBrowser (headless=${headless}, locale=${LOCALE}, tz=${TIMEZONE}) ` +
      `with profile: ${PROFILE_DIR}`,
  );
  const ctx = (await launchPersistentContext({
    userDataDir: PROFILE_DIR,
    headless,
    userAgent: USER_AGENT,
    locale: LOCALE,
    timezone: TIMEZONE,
    viewport: { width: 1366, height: 768 },
    humanize: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })) as unknown as BrowserContext;

  // Count every Shopee API request the browser makes, at the context level so
  // it covers every page and every code path (captures, UI clicks, portal
  // fetches). One "op" is rarely one request — this is the number that reflects
  // actual traffic to Shopee, and it is what safety_status reports.
  //
  // Guarded rather than assumed: CloakBrowser hands back its own context
  // wrapper, and a missing event emitter must degrade to "no request counter",
  // never to a browser that cannot start.
  if (typeof ctx.on === 'function') {
    ctx.on('response', (resp: Response) => {
      if (SHOPEE_API_RE.test(resp.url())) safety.noteApiRequest();
    });
  } else {
    debug('Context does not expose events — Shopee API requests will not be counted');
  }

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
export async function getPageFor(realm: Realm): Promise<Page> {
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
 * Serialize a callback against all other browser traffic, gated by the
 * account-safety rate limiter. `kind` selects the limits: captures and
 * direct API calls are 'read'; UI write actions are 'write'.
 */
export async function withBrowserLock<T>(
  fn: () => Promise<T>,
  kind: 'read' | 'write' = 'read',
): Promise<T> {
  await safety.acquire(kind);
  const run = withLock(fn);
  try {
    const result = await run;
    safety.reportSuccess();
    return result;
  } catch (err) {
    safety.reportFailure(err);
    throw err;
  }
}

/** Live safety status (for the safety_status tool and diagnostics). */
export function safetyStatus() {
  return safety.status();
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
 *
 * The body is read inside the response handler the moment the response
 * arrives: on pages that immediately redirect (e.g. a new shop bounced to
 * onboarding), Playwright evicts the response resource from the network
 * buffer before a `waitForResponse(...).json()` would get to read it
 * ("No resource with given identifier found"). If the body is nonetheless
 * unreadable, the handler keeps listening for the next matching response.
 */
export async function captureJson<T>(
  pageUrl: string,
  opts: CaptureOptions,
): Promise<CaptureResult<T>> {
  // 60s, not 30s: Shopee's search page only fires its `search_items` request at
  // ~28-30s, so a 30s budget lost the race often enough to trigger the retry in
  // shopeeCapture — turning a healthy-but-slow page into a 60s+ round trip.
  const timeoutMs = opts.timeoutMs ?? 60000;
  const matchLabel = Array.isArray(opts.apiMatch) ? opts.apiMatch.join('|') : opts.apiMatch;
  return withBrowserLock(async () => {
    const page = await getPageFor(opts.realm ?? 'buyer');

    return new Promise<CaptureResult<T>>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        page.off('response', handler);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`Timeout ${timeoutMs}ms exceeded waiting for ${matchLabel}`)),
        );
      }, timeoutMs);

      const handler = (resp: Response): void => {
        if (!matchUrl(resp.url(), opts)) return;
        void resp
          .text()
          .then((text) => {
            try {
              const json = JSON.parse(text) as T;
              finish(() => resolve({ json, matchedUrl: resp.url() }));
            } catch {
              // Unreadable/evicted body or non-JSON — keep listening for the next match.
            }
          })
          .catch(() => {
            // Body gone (redirect raced us) — keep listening.
          });
      };
      page.on('response', handler);

      page
        .goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        .then(async () => {
          if (opts.trigger) {
            try {
              await opts.trigger(page);
            } catch (err) {
              debug(`capture trigger failed (continuing to wait): ${err}`);
            }
          }
        })
        .catch((err) => finish(() => reject(err)));
    });
  });
}

export interface SelectionOptions<P> {
  /** Substring identifying the page's main /api/v4 response. */
  apiMatch: string;
  /** Substring identifying the response each selection fires. */
  selectionApiMatch: string;
  /** Labels to click, derived from the main response. */
  labelsFrom: (primary: P) => string[];
  /** Cap on how many selections to click; the rest are left ungathered. */
  maxSelections?: number;
  /**
   * Wall-clock budget for the whole call. Selections stop once it's spent, so a
   * slow network or a long option list can't push the tool past the ~60s request
   * timeout most MCP clients default to. Partial results beat a dead request.
   */
  deadlineMs?: number;
  timeoutMs?: number;
}

/**
 * Like captureJson, but afterwards clicks a set of on-page options and captures
 * the response each one fires — for data Shopee reveals only on interaction
 * (per-variant stock lives in cart_panel/select_variation_pc, never in get_pc).
 *
 * One navigation serves both halves. Clicks go through a plain DOM `click()`
 * rather than Playwright's: CloakBrowser's humanised pointer path first scrolls
 * the element into view, which throws on Shopee's virtualised variant list.
 */
export async function captureWithSelections<P, S>(
  pageUrl: string,
  opts: SelectionOptions<P>,
): Promise<{ primary: P; selections: Map<string, S> }> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const deadline = Date.now() + (opts.deadlineMs ?? 50000);
  return withBrowserLock(async () => {
    const page = await getPage();

    const matched = page.waitForResponse(
      (r: Response) => r.url().includes('/api/v4/') && r.url().includes(opts.apiMatch),
      { timeout: timeoutMs },
    );
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const primary = (await (await matched).json()) as P;

    const selections = new Map<string, S>();
    const labels = opts.labelsFrom(primary).slice(0, opts.maxSelections ?? 12);
    if (labels.length === 0) return { primary, selections };

    // The payload lands before React paints the options; wait for one to exist.
    await page
      .waitForFunction(
        (ls: string[]) =>
          ls.some((l) =>
            Array.from(document.querySelectorAll('button')).some(
              (b) => (b.textContent || '').trim() === l,
            ),
          ),
        labels,
        { timeout: 30000 },
      )
      .catch(() => debug('Variant options never rendered; skipping selections'));

    for (const label of labels) {
      // Each selection is a full round trip, so check the budget before starting
      // another rather than discovering mid-flight that we've overrun.
      const remaining = deadline - Date.now();
      if (remaining < 6000) {
        debug(`Selection budget spent; ${selections.size}/${labels.length} gathered`);
        break;
      }

      const fired = page
        .waitForResponse((r: Response) => r.url().includes(opts.selectionApiMatch), {
          timeout: Math.min(12000, remaining),
        })
        .catch(() => null);

      const clicked = await page.evaluate((l: string) => {
        const b = Array.from(document.querySelectorAll('button')).find(
          (x) => (x.textContent || '').trim() === l,
        );
        if (!b) return false;
        b.click();
        return true;
      }, label);

      if (!clicked) {
        debug(`No option button for "${label}"`);
        continue;
      }
      const resp = await fired;
      if (!resp) {
        debug(`No ${opts.selectionApiMatch} response for "${label}"`);
        continue;
      }
      try {
        selections.set(label, (await resp.json()) as S);
      } catch {
        debug(`Unparsable ${opts.selectionApiMatch} response for "${label}"`);
      }
    }

    return { primary, selections };
  });
}

/**
 * Run a browser operation against the shared logged-in page, holding the same
 * lock as captureJson so it can't interleave with another tool's navigation.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return withBrowserLock(async () => fn(await getPage()));
}

/** One JSON response gathered by captureAll. */
export interface CollectedResponse {
  url: string;
  /** The request body, for telling apart calls to one endpoint (e.g. cart/update actions). */
  postData: string;
  json: unknown;
}

export interface CollectOptions {
  /** A response is collected when its URL contains any of these substrings. */
  apiMatches: string[];
  /**
   * Drives the page after navigation (scrolling, clicking filters, paging) while
   * responses keep being collected. `collected` fills in live, so the callback
   * can wait on it with waitForCollected.
   */
  interact?: (page: Page, collected: CollectedResponse[]) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Navigate to `pageUrl` and collect every matching API response fired while the
 * page loads and `interact` runs — for data Shopee only fetches on scroll or
 * click (reviews, flash-sale batches), which a single captureJson can't reach.
 *
 * Matches any `/api/vN/` path, not just v4: reviews still live on /api/v2.
 */
export async function captureAll(
  pageUrl: string,
  opts: CollectOptions,
): Promise<CollectedResponse[]> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  return withBrowserLock(async () => {
    const page = await getPage();
    const collected: CollectedResponse[] = [];
    const pending: Promise<void>[] = [];

    const onResponse = (r: Response): void => {
      const url = r.url();
      if (!/\/api\/v\d+\//.test(url) || !opts.apiMatches.some((m) => url.includes(m))) return;
      const postData = r.request().postData() ?? '';
      pending.push(
        r
          .json()
          .then((json: unknown) => {
            collected.push({ url, postData, json });
          })
          .catch(() => debug(`Unparsable response from ${url}`)),
      );
    };

    page.on('response', onResponse);
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (opts.interact) await opts.interact(page, collected);
      await Promise.all(pending);
    } finally {
      page.off('response', onResponse);
    }
    return collected;
  });
}

/**
 * Poll until `collected` satisfies `done`, or the timeout passes. Resolves to
 * whether it was satisfied; `tick` runs between polls (e.g. to keep scrolling).
 */
export async function waitForCollected(
  collected: CollectedResponse[],
  done: (c: CollectedResponse[]) => boolean,
  timeoutMs: number,
  tick?: () => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(collected)) return true;
    if (tick) await tick();
    await new Promise((r) => setTimeout(r, 500));
  }
  return done(collected);
}

/** Warm the session once (loads Shopee so the anti-fraud SDK initialises). */
export async function warm(): Promise<void> {
  await withBrowserLock(async () => {
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
  return withBrowserLock(async () => {
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
