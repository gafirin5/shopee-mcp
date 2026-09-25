/**
 * Pure helpers for detecting video media in loosely-typed Shopee payloads
 * (PDP responses carry video info under several key names across versions).
 */

export interface VideoInfo {
  /** The best video URL found, if any. */
  url?: string;
  /** Cover/thumbnail image URL, if any. */
  cover?: string;
  /** The JSON path where it was found, e.g. "data.video_info". */
  foundAt: string;
}

const URL_KEYS = ['video_url', 'videourl', 'url', 'video_url_low', 'video_data'];

/**
 * Depth-first search for the first video-ish node in a payload. A node counts
 * when its key matches /video/i and it is (or contains) a usable media URL.
 * Purely structural — no network, no browser.
 */
export function findVideoInfo(value: unknown, maxDepth = 8): VideoInfo | undefined {
  const found = dfs(value, '', 0, maxDepth, new Set());
  return found ?? undefined;
}

function dfs(
  node: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  seen: Set<object>,
): VideoInfo | undefined {
  if (depth > maxDepth || node === null || node === undefined) return undefined;
  if (typeof node !== 'object') return undefined;
  if (seen.has(node as object)) return undefined;
  seen.add(node as object);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = dfs(node[i], `${path}[${i}]`, depth + 1, maxDepth, seen);
      if (hit) return hit;
    }
    return undefined;
  }

  const record = node as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    const here = `${path}${path ? '.' : ''}${key}`;
    if (/video/i.test(key)) {
      const info = asVideoInfo(val, here);
      if (info) return info;
    }
    const nested = dfs(val, here, depth + 1, maxDepth, seen);
    if (nested) return nested;
  }
  return undefined;
}

function asVideoInfo(val: unknown, path: string): VideoInfo | undefined {
  if (typeof val === 'string') {
    if (/^https?:\/\//.test(val) || val.startsWith('//')) {
      return { url: normalizeUrl(val), foundAt: path };
    }
    return undefined;
  }
  if (val !== null && typeof val === 'object') {
    const record = val as Record<string, unknown>;
    for (const k of URL_KEYS) {
      const candidate = record[k];
      if (typeof candidate === 'string' && candidate.length > 4) {
        const cover =
          typeof record.video_cover === 'string' ? normalizeUrl(record.video_cover) : undefined;
        return { url: normalizeUrl(candidate), cover, foundAt: path };
      }
    }
    // A video-keyed object with no obvious URL — still evidence of media.
    return { foundAt: path };
  }
  return undefined;
}

function normalizeUrl(u: string): string {
  return u.startsWith('//') ? `https:${u}` : u;
}
