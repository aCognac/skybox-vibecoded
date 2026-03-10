import { exec }          from "child_process";
import { promisify }     from "util";
import { existsSync, mkdirSync } from "fs";
import { join }          from "path";

const execAsync = promisify(exec);

const CACHE_DIR = process.env.CACHE_DIR || "/tmp/skybox";
mkdirSync(CACHE_DIR, { recursive: true });

export const thumbnailPath = (fileId) => join(CACHE_DIR, `${fileId}.jpg`);
export const previewPath   = (fileId) => join(CACHE_DIR, `${fileId}_preview.mp4`);

/**
 * Extract a single JPEG frame from a video.
 * Seeks to 3s (avoids black intro frames on most cameras).
 * Returns the output path.
 */
export async function generateThumbnail(fileId, sourcePath) {
  const out = thumbnailPath(fileId);
  if (existsSync(out)) return out;
  await execAsync(
    `ffmpeg -ss 3 -i "${sourcePath}" -vframes 1 -vf "scale=320:-2" -f image2 "${out}" -y`,
    { timeout: 15_000 }
  );
  return out;
}

/**
 * Transcode a video to a compact 360p preview suitable for quick identification.
 * Uses libx264 ultrafast + CRF 30 — fast enough on a Pi 5.
 * Returns the output path.
 */
export async function generatePreview(fileId, sourcePath) {
  const out = previewPath(fileId);
  if (existsSync(out)) return out;
  await execAsync(
    `ffmpeg -i "${sourcePath}" -vf "scale=-2:360" ` +
    `-c:v libx264 -preset ultrafast -crf 30 -tune fastdecode ` +
    `-c:a aac -b:a 64k -movflags +faststart "${out}" -y`,
    { timeout: 300_000 }
  );
  return out;
}

// ── Background preview queue ───────────────────────────────────────────────────

const queue = [];
let running = false;

/** Enqueue a file for background preview transcoding (no-op if already cached). */
export function queuePreview(fileId, sourcePath) {
  if (existsSync(previewPath(fileId))) return;
  // avoid duplicates
  if (queue.some((q) => q.fileId === fileId)) return;
  queue.push({ fileId, sourcePath });
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length > 0) {
    const { fileId, sourcePath } = queue.shift();
    if (existsSync(previewPath(fileId))) continue;
    try {
      console.log(`[media] generating preview for file ${fileId} …`);
      await generatePreview(fileId, sourcePath);
      console.log(`[media] preview done for file ${fileId}`);
    } catch (err) {
      console.error(`[media] preview failed for file ${fileId}: ${err.message}`);
    }
  }
  running = false;
}
