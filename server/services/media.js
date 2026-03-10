import { exec }                   from "child_process";
import { promisify }              from "util";
import { existsSync, mkdirSync }  from "fs";
import { join }                   from "path";

const execAsync = promisify(exec);

const CACHE_DIR = process.env.CACHE_DIR || "/tmp/skybox";
mkdirSync(CACHE_DIR, { recursive: true });

export const thumbnailPath = (fileId) => join(CACHE_DIR, `${fileId}.jpg`);
export const previewPath   = (fileId) => join(CACHE_DIR, `${fileId}_preview.mp4`);

// ── Thumbnail generation ───────────────────────────────────────────────────────
// Max 3 concurrent ffmpeg thumbnail processes (Pi 5 handles this fine).
// In-flight map deduplicates requests for the same file.

const THUMB_CONCURRENCY = 3;
let thumbActive = 0;
const thumbWaiters = [];
const thumbInFlight = new Map(); // fileId → Promise<path>

function acquireThumbSlot() {
  if (thumbActive < THUMB_CONCURRENCY) {
    thumbActive++;
    return Promise.resolve();
  }
  return new Promise((r) => thumbWaiters.push(r));
}

function releaseThumbSlot() {
  if (thumbWaiters.length > 0) {
    thumbWaiters.shift()(); // wake next waiter (they already "acquired")
  } else {
    thumbActive--;
  }
}

/**
 * Generate (or return cached) a JPEG thumbnail for a video file.
 * Concurrent calls for the same fileId share a single Promise.
 * Max THUMB_CONCURRENCY ffmpeg processes run at once.
 */
export function generateThumbnail(fileId, sourcePath) {
  const out = thumbnailPath(fileId);
  if (existsSync(out)) return Promise.resolve(out);

  if (thumbInFlight.has(fileId)) return thumbInFlight.get(fileId);

  const p = acquireThumbSlot()
    .then(async () => {
      if (existsSync(out)) return out; // another request finished while we waited
      await execAsync(
        `ffmpeg -ss 3 -i "${sourcePath}" -vframes 1 -vf "scale=320:-2" -f image2 "${out}" -y`,
        { timeout: 15_000 }
      );
      return out;
    })
    .finally(() => {
      releaseThumbSlot();
      thumbInFlight.delete(fileId);
    });

  thumbInFlight.set(fileId, p);
  return p;
}

// ── Preview generation ─────────────────────────────────────────────────────────
// 360p low-quality MP4, one at a time in the background.

const previewQueue   = [];
const previewInQueue = new Set();
let previewRunning   = false;

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

export function queuePreview(fileId, sourcePath) {
  if (existsSync(previewPath(fileId))) return;
  if (previewInQueue.has(fileId)) return;
  previewInQueue.add(fileId);
  previewQueue.push({ fileId, sourcePath });
  if (!previewRunning) drainPreview();
}

async function drainPreview() {
  previewRunning = true;
  while (previewQueue.length > 0) {
    const { fileId, sourcePath } = previewQueue.shift();
    previewInQueue.delete(fileId);
    if (existsSync(previewPath(fileId))) continue;
    try {
      console.log(`[media] preview start  file=${fileId}`);
      await generatePreview(fileId, sourcePath);
      console.log(`[media] preview done   file=${fileId}`);
    } catch (err) {
      console.error(`[media] preview error  file=${fileId}: ${err.message}`);
    }
  }
  previewRunning = false;
}
