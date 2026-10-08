import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Checks a video path before anything is sent to a page's file input. The seller
 * upload and the Shopee Video post both use it, so a wrong path (a credentials file,
 * say) never reaches an uploader.
 */

export const VIDEO_EXT_OK = new Set(['.mp4', '.mov', '.m4v']);

export async function validateVideoFile(videoPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(videoPath);
  } catch {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${videoPath}`);
  const ext = path.extname(videoPath).toLowerCase();
  if (!VIDEO_EXT_OK.has(ext)) {
    throw new Error(
      `Unsupported video extension "${ext}". Shopee accepts ${[...VIDEO_EXT_OK].join(', ')} ` +
        `(prefer MP4 H.264).`,
    );
  }
  const maxBytes = parseInt(process.env.SHOPEE_VIDEO_MAX_MB ?? '200', 10) * 1024 * 1024;
  if (stat.size > maxBytes) {
    throw new Error(
      `Video is ${(stat.size / 1024 / 1024).toFixed(0)} MB — over the ${maxBytes / 1024 / 1024} MB guard. ` +
        'Compress it first (Shopee portals typically cap well below this).',
    );
  }
}
