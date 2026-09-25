import { captureJson, BASE_URL } from '../browser/session.js';
import type { CaptureOptions, CaptureResult } from '../browser/session.js';

type CaptureFn = <T>(pageUrl: string, opts: CaptureOptions) => Promise<CaptureResult<T>>;

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
 * @param pageUrl   the Shopee page to load (its app fires the API call)
 * @param apiMatch  substring (or substrings) identifying the target response
 * @param capture   injectable for tests; defaults to the real browser capture
 */
export async function shopeeCapture<T extends { error?: number; error_msg?: string }>(
  pageUrl: string,
  apiMatch: string | string[],
  timeoutMs?: number,
  isRetry = false,
  capture: CaptureFn = captureJson,
): Promise<T> {
  let json: T;
  try {
    const result = await capture<T>(pageUrl, { apiMatch, timeoutMs });
    json = result.json;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout/i.test(msg)) {
      // A timeout usually means the anti-bot gate silently dropped the request, but a
      // slow page load or transient network blip looks identical. Retry once before
      // reporting "not logged in" so we don't misdiagnose a one-off hiccup.
      if (!isRetry) return shopeeCapture<T>(pageUrl, apiMatch, timeoutMs, true, capture);
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
