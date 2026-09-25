/**
 * Helpers for presenting arbitrary JSON (shapes Shopee ships that we don't
 * hard-type) as bounded, readable tool output.
 */

/** Pretty-print JSON, hard-truncated with a note if it exceeds maxChars. */
export function summarizeJson(value: unknown, maxChars = 4000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut}\n… [truncated, ${text.length} chars total]`;
}

/** Safe property read for loosely-typed Shopee payloads. */
export function pick<T = unknown>(obj: unknown, key: string): T | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key] as T | undefined;
}
