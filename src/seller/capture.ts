import type { Page } from 'playwright';
import { captureJson } from '../browser/session.js';
import { sellerUrl } from './urls.js';

export interface SellerCaptureResult<T> {
  json: T;
  matchedUrl: string;
}

export const SHOPEE_ANTIBOT_ERROR = 90309999;

export class SellerAuthRequiredError extends Error {
  constructor(endpoint: string) {
    super(
      'The Seller Centre session is not available. Run `npm run login:seller` once ' +
        `to sign in, then retry. (endpoint hint: ${endpoint})`,
    );
    this.name = 'SellerAuthRequiredError';
  }
}

/**
 * Navigate a Seller Centre path and return the first XHR response whose URL
 * matches `apiMatch` — raw, with no error-shape validation. The Seller Centre
 * app fires dozens of calls per page; `apiMatch` (substring or substrings)
 * picks out the one you want. `seller_api_probe` is the discovery tool for
 * finding those substrings against a live session.
 */
export async function sellerCaptureRaw<T>(
  pathAndQuery: string,
  apiMatch: string | string[],
  timeoutMs?: number,
  trigger?: (page: Page) => Promise<void>,
): Promise<SellerCaptureResult<T>> {
  return captureJson<T>(sellerUrl(pathAndQuery), {
    apiMatch,
    timeoutMs,
    realm: 'seller',
    trigger,
  });
}

/**
 * Like sellerCaptureRaw but validates the common Shopee error shapes: the
 * anti-bot gate (90309999 → re-login hint) and a non-zero `error` field.
 * Seller endpoints vary in shape, so validation is applied only when the
 * fields actually exist.
 */
export async function sellerCapture<T extends { error?: number; error_msg?: string }>(
  pathAndQuery: string,
  apiMatch: string | string[],
  timeoutMs?: number,
  trigger?: (page: Page) => Promise<void>,
): Promise<T> {
  const { json, matchedUrl } = await sellerCaptureRaw<T>(
    pathAndQuery,
    apiMatch,
    timeoutMs,
    trigger,
  );
  if (json && json.error === SHOPEE_ANTIBOT_ERROR) {
    throw new SellerAuthRequiredError(matchedUrl);
  }
  if (json && json.error !== undefined && json.error !== null && json.error !== 0) {
    throw new Error(
      `Seller Centre API error ${json.error}${json.error_msg ? `: ${json.error_msg}` : ''} (${matchedUrl})`,
    );
  }
  return json;
}
