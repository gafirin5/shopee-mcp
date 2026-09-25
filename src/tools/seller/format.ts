import { pick } from '../../utils/json.js';

/**
 * Formatting helpers for loosely-typed Seller Centre payloads. Shopee rotates
 * these shapes; every helper is defensive (missing fields → omitted) and the
 * tools fall back to a raw JSON preview when a known field set isn't present.
 */

/**
 * Find the first array under any of `keys`, checking the payload itself and
 * one level of wrapper objects (data, result, response, …).
 */
export function findArray(payload: unknown, keys: string[]): unknown[] | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const roots: unknown[] = [payload];
  const wrapperKeys = ['data', 'result', 'response', 'content', 'payload'];
  for (const wk of wrapperKeys) {
    const nested = pick(payload, wk);
    if (nested !== null && nested !== undefined) roots.push(nested);
  }
  for (const root of roots) {
    for (const key of keys) {
      const arr = pick<unknown[]>(root, key);
      if (Array.isArray(arr)) return arr;
    }
  }
  return undefined;
}

const ID_KEYS = ['order_id', 'orderid', 'id', 'product_id', 'itemid', 'item_id', 'shop_order_id'];
const NAME_KEYS = ['item_name', 'product_name', 'name', 'username', 'title'];
const STATUS_KEYS = ['order_status', 'status', 'display_status', 'state'];
const AMOUNT_KEYS = ['total_amount', 'order_amount', 'price', 'payment_amount', 'amount'];
const QTY_KEYS = ['quantity', 'qty', 'stock', 'model_quantity'];
const TIME_KEYS = ['create_time', 'ctime', 'created_at', 'update_time'];

function firstPresent(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return undefined;
}

/** One-line human preview of a loosely-typed order/product row. */
export function previewRow(row: unknown): string {
  if (row === null || typeof row !== 'object') return `   • ${String(row)}`;
  const r = row as Record<string, unknown>;
  const parts: string[] = [];
  const id = firstPresent(r, ID_KEYS);
  const name = firstPresent(r, NAME_KEYS);
  const status = firstPresent(r, STATUS_KEYS);
  const amount = firstPresent(r, AMOUNT_KEYS);
  const qty = firstPresent(r, QTY_KEYS);
  const time = firstPresent(r, TIME_KEYS);
  if (name) parts.push(name);
  if (id) parts.push(`#${id}`);
  if (status) parts.push(status);
  if (amount) parts.push(`amount=${amount}`);
  if (qty) parts.push(`qty=${qty}`);
  if (time) parts.push(`at=${time}`);
  if (parts.length === 0) return `   • ${JSON.stringify(row).slice(0, 160)}`;
  return `   • ${parts.join(' | ')}`;
}

/**
 * Format a seller list payload: named rows when a known array exists, otherwise
 * a bounded JSON preview so the live shape stays inspectable.
 */
export function formatSellerPayload(
  title: string,
  payload: unknown,
  arrayKeys: string[],
  maxRows = 20,
  previewMaxChars = 2500,
): string {
  const lines: string[] = [`${title}`, ''];
  const arr = findArray(payload, arrayKeys);
  if (arr && arr.length > 0) {
    lines.push(`(${arr.length} row${arr.length === 1 ? '' : 's'} in response)`, '');
    for (const row of arr.slice(0, maxRows)) lines.push(previewRow(row));
    if (arr.length > maxRows) {
      lines.push(`   … +${arr.length - maxRows} more rows (raise max_rows or narrow the query)`);
    }
    return lines.join('\n');
  }
  lines.push(
    'No recognizable list field in this response — showing the raw shape so the ' +
      'endpoint can be inspected:',
    '',
  );
  lines.push(JSON.stringify(payload, null, 2).slice(0, previewMaxChars));
  return lines.join('\n');
}
