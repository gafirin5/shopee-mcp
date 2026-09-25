import type { Page } from 'playwright';
import { withBrowserLock, SELLER_BASE_URL } from '../browser/session.js';
import { sellerUrl } from './urls.js';

/**
 * Direct portal-API caller.
 *
 * Unlike the marketplace's /api/v4/* (which mints per-request anti-fraud
 * signatures), most Seller Centre APIs authenticate with cookies plus an
 * `SPC_CDS` query token that mirrors a cookie — so we can call them directly
 * from the page context with `fetch` instead of navigating pages and hoping
 * the app fires the request. Verified live: shop_info, user_info, mpsku list.
 * Endpoints that DO require anti-fraud headers (e.g. /api/v3/order/*) must go
 * through capture instead (see capture.ts).
 */
export async function portalApi<T>(
  path: string,
  opts?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  return withBrowserLock(async () => {
    const { getPageFor } = await import('../browser/session.js');
    const page: Page = await getPageFor('seller');

    // The SPC_CDS cookie exists on any seller-subdomain page. Land on the
    // onboarding page — the redirect TARGET for new shops, so it is stable and
    // never bounces — then let any in-flight client-side redirect settle
    // before fetching: a fetch fired mid-navigation dies with the page.
    if (!page.url().includes('seller.') || !page.url().includes('/portal/id-onboarding/')) {
      await page.goto(sellerUrl('/portal/id-onboarding/qr-code'), {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const result = await page.evaluate(
      async ({ p, method, body }) => {
        const cds = document.cookie.match(/SPC_CDS=([^;]+)/)?.[1] ?? null;
        if (!cds) return { ok: false as const, reason: 'SPC_CDS cookie not found' };
        try {
          const res = await fetch(
            `${p}${p.includes('?') ? '&' : '?'}SPC_CDS=${cds}&SPC_CDS_VER=2`,
            {
              method: method ?? 'GET',
              credentials: 'include',
              headers: body ? { 'content-type': 'application/json;charset=UTF-8' } : undefined,
              body: body ? JSON.stringify(body) : undefined,
            },
          );
          const text = await res.text();
          return { ok: true as const, status: res.status, text };
        } catch (err) {
          return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
        }
      },
      { p: sellerUrl(path), method: opts?.method, body: opts?.body },
    );

    if (!result.ok) {
      throw new Error(`Portal API ${path}: ${result.reason} — is the seller session logged in?`);
    }
    let json: unknown;
    try {
      json = JSON.parse(result.text);
    } catch {
      throw new Error(`Portal API ${path}: non-JSON response (HTTP ${result.status})`);
    }
    // Portal APIs report failures as {code: <non-zero>, message} rather than HTTP errors.
    const record = json as { code?: number; message?: string };
    if (typeof record.code === 'number' && record.code !== 0) {
      throw new Error(
        `Portal API ${path}: code ${record.code} — ${record.message ?? 'unknown error'}`,
      );
    }
    return json as T;
  });
}

/** True when we can call portal APIs directly (session + SPC_CDS present). */
export async function portalApiAvailable(): Promise<boolean> {
  try {
    await portalApi('/api/selleraccount/user_info/');
    return true;
  } catch {
    return false;
  }
}

export { SELLER_BASE_URL };
