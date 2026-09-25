import type { Response } from 'playwright';
import { withBrowserLock } from '../browser/session.js';

/**
 * Capture an API response AND the rendered product names from the page DOM,
 * matched by `shopid:itemid` from tile hrefs.
 *
 * Needed because the 2026 search/shop card APIs no longer carry the product
 * name (see normalizeSearchCard): the name only exists in the rendered tiles.
 * The body is read inside the response handler (see captureJson — redirecting
 * pages evict the resource otherwise), and the DOM scrape waits for product
 * links to actually paint first.
 */
export async function captureWithNames<T>(
  pageUrl: string,
  apiMatch: string | string[],
): Promise<{ data: T; names: Record<string, string> }> {
  return withBrowserLock(async () => {
    const { getPageFor } = await import('../browser/session.js');
    const page = await getPageFor('buyer');

    const matches = Array.isArray(apiMatch) ? apiMatch : [apiMatch];
    const result = await new Promise<{ json: T; matchedUrl: string }>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        page.off('response', handler);
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(new Error(`Timeout 30000ms exceeded waiting for ${matches.join('|')}`)),
          ),
        30000,
      );
      const handler = (r: Response): void => {
        if (!matches.some((m) => r.url().includes(m))) return;
        void r
          .text()
          .then((text) => {
            try {
              finish(() => resolve({ json: JSON.parse(text) as T, matchedUrl: r.url() }));
            } catch {
              /* unreadable/evicted body — keep listening for the next match */
            }
          })
          .catch(() => {});
      };
      page.on('response', handler);
      page
        .goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch((err) => finish(() => reject(err)));
    });

    // Names only exist in the rendered tiles — the API response arrives before
    // the DOM paints, so wait for a product link to appear, then scrape.
    await page
      .waitForSelector('a[href*="/product/"], a[href*="-i."]', { timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(800);

    const names = await page
      .evaluate(() => {
        const map: Record<string, string> = {};
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = a.getAttribute('href') ?? '';
          const m = href.match(/-i\.(\d+)\.(\d+)/) ?? href.match(/\/product\/(\d+)\/(\d+)/);
          if (!m) continue;
          const key = `${m[1]}:${m[2]}`;
          if (map[key]) continue;
          const alt = a.querySelector('img')?.getAttribute('alt')?.trim() ?? '';
          const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
          const name = alt.length >= 8 ? alt : text.length >= 8 ? text : '';
          if (name) map[key] = name.slice(0, 200);
        }
        return map;
      })
      .catch(() => ({}) as Record<string, string>);

    return { data: result.json, names };
  });
}
