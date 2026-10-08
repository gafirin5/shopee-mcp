import { captureJson, isLoggedIn, BASE_URL } from '../browser/session.js';
import type { CaptureOptions, CaptureResult } from '../browser/session.js';
import { sleep } from '../actions/base.js';

export type CaptureFn = <T>(pageUrl: string, opts: CaptureOptions) => Promise<CaptureResult<T>>;
export type LoginCheckFn = () => Promise<boolean>;

/** Shopee's anti-bot/anti-fraud rejection — almost always means "not logged in / detected". */
export const SHOPEE_ANTIBOT_ERROR = 90309999;

export class ShopeeAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly endpoint?: string,
    public readonly shopeeError?: number,
  ) {
    super(message);
    this.name = 'ShopeeAPIError';
  }
}

/** Thrown specifically when the anti-bot gate blocks us (needs login / a fresher binary). */
export class ShopeeAuthRequiredError extends ShopeeAPIError {
  constructor(endpoint?: string) {
    super(
      'Shopee blocked this request with its anti-bot gate. Run `npm run login` (or ' +
        '`shopee-mcp-login`) once to sign in, then retry.',
      200,
      endpoint,
      SHOPEE_ANTIBOT_ERROR,
    );
    this.name = 'ShopeeAuthRequiredError';
  }
}

/**
 * Load a Shopee page and capture the JSON that its own app fetches from
 * `/api/v4/*` — the only way to obtain data past the per-request anti-fraud
 * signature (a hand-rolled fetch lacks the af-ac-enc-dat / x-sap-sec headers).
 *
 * @param pageUrl     the Shopee page to load (its app fires the API call)
 * @param apiMatch    substring (or substrings) identifying the target response
 * @param capture     injectable for tests; defaults to the real browser capture
 * @param checkLogin  injectable for tests; defaults to the real cookie check
 */
export async function shopeeCapture<T extends { error?: number; error_msg?: string }>(
  pageUrl: string,
  apiMatch: string | string[],
  timeoutMs?: number,
  isRetry = false,
  capture: CaptureFn = captureJson,
  checkLogin: LoginCheckFn = isLoggedIn,
): Promise<T> {
  // Cheap cookie check before spending the capture budget. Without it a signed-out
  // user waits for a full timeout (plus the retry below) only to be told to log in
  // — long enough that MCP clients abandon the request first and show their own
  // "request timed out" instead of our instructions.
  if (!isRetry && !(await checkLogin())) {
    throw new ShopeeAuthRequiredError(Array.isArray(apiMatch) ? apiMatch.join('|') : apiMatch);
  }

  let json: T;
  try {
    const result = await capture<T>(pageUrl, { apiMatch, timeoutMs });
    json = result.json;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout/i.test(msg)) {
      // A timeout usually means the anti-bot gate silently dropped the request, but a
      // A timeout usually means the anti-bot gate silently dropped the request, but a
      // slow page load or transient network blip looks identical. Retry once — after a
      // jittered 3–8 s pause, never instantly (an immediate identical retry is exactly
      // what a bot does) — and only while the session is still alive mid-request;
      // when it lapsed during the call, retrying just burns the capture budget.
      if (!isRetry) {
        await sleep(3000 + Math.random() * 5000);
        if (await checkLogin()) {
          return shopeeCapture<T>(pageUrl, apiMatch, timeoutMs, true, capture, checkLogin);
        }
      }
      throw new ShopeeAuthRequiredError(Array.isArray(apiMatch) ? apiMatch.join('|') : apiMatch);
    }
    throw new ShopeeAPIError(
      `Browser error loading ${Array.isArray(apiMatch) ? apiMatch.join('|') : apiMatch}: ${msg}`,
      undefined,
      Array.isArray(apiMatch) ? apiMatch.join('|') : apiMatch,
    );
  }

  if (json.error === SHOPEE_ANTIBOT_ERROR) {
    throw new ShopeeAuthRequiredError(Array.isArray(apiMatch) ? apiMatch.join('|') : apiMatch);
  }
  if (json.error !== undefined && json.error !== null && json.error !== 0) {
    throw new ShopeeAPIError(
      `Shopee API error ${json.error}${json.error_msg ? `: ${json.error_msg}` : ''} for ${
        Array.isArray(apiMatch) ? apiMatch.join('|') : apiMatch
      }`,
      200,
      Array.isArray(apiMatch) ? apiMatch.join('|') : apiMatch,
      json.error,
    );
  }
  return json;
}

/** Build an absolute Shopee URL from a path. */
export function shopeeUrl(pathAndQuery: string): string {
  return `${BASE_URL}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
}

/**
 * Fail fast when signed out. shopeeCapture does this itself; tools that drive
 * the page through captureAll call it first so a signed-out user gets the login
 * prompt immediately instead of after a full scroll-and-wait budget.
 */
export async function requireLogin(checkLogin: LoginCheckFn = isLoggedIn): Promise<void> {
  if (!(await checkLogin())) throw new ShopeeAuthRequiredError();
}
