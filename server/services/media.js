import { spawn }                  from "child_process";
import { existsSync, mkdirSync }  from "fs";
import { join }                   from "path";

const CACHE_DIR = process.env.CACHE_DIR || "/tmp/skybox";
mkdirSync(CACHE_DIR, { recursive: true });

export const thumbnailPath = (fileId) => join(CACHE_DIR, `${fileId}.jpg`);
export const previewPath   = (fileId) => join(CACHE_DIR, `${fileId}_preview.mp4`);

// ── ffmpeg helpers ─────────────────────────────────────────────────────────────

/** Run ffmpeg with args as an array (no shell — safe with any file path). */
function ffmpeg(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    proc.stderr.on("data", (d) => stderr.push(d));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(stderr).toString().slice(-300)}`));
    });
  });
}

// ── Thumbnail generation ───────────────────────────────────────────────────────
// Max THUMB_CONCURRENCY simultaneous ffmpeg processes.
// In-flight map deduplicates concurrent requests for the same file.

const THUMB_CONCURRENCY = 3;
let thumbActive = 0;
const thumbWaiters  = [];
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
    thumbWaiters.shift()(); // transfer slot to next waiter (thumbActive stays same)
  } else {
    thumbActive--;
  }
}

/**
 * Extract a JPEG frame from sourcePath.
 * Tries seeking to 2s first; falls back to 0s if that fails (handles short clips).
 * Returns the output path.
 */
export function generateThumbnail(fileId, sourcePath) {
  const out = thumbnailPath(fileId);
  if (existsSync(out)) return Promise.resolve(out);
  if (thumbInFlight.has(fileId)) return thumbInFlight.get(fileId);

  const p = acquireThumbSlot()
    .then(async () => {
      if (existsSync(out)) return out;

      const base = ["-y", "-vframes", "1", "-vf", "scale=320:-2", "-f", "image2", out];
      try {
        await ffmpeg(["-ss", "2", "-i", sourcePath, ...base]);
      } catch {
        // Fallback: no seek (handles very short clips or tricky keyframe positions)
        await ffmpeg(["-i", sourcePath, ...base]);
      }
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
// 360p low-quality MP4, processed one at a time in background.

const previewQueue   = [];
const previewInQueue = new Set();
let previewRunning   = false;

export async function generatePreview(fileId, sourcePath) {
  const out = previewPath(fileId);
  if (existsSync(out)) return out;
  await ffmpeg(
    [
      "-i", sourcePath,
      "-vf", "scale=-2:360",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
      "-tune", "fastdecode",
      "-c:a", "aac", "-b:a", "64k",
      "-movflags", "+faststart",
      "-y", out,
    ],
    300_000
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
