import { createReadStream, createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { EventEmitter } from "events";

export const copyEvents = new EventEmitter();

const MEDIA_ROOT = process.env.MEDIA_ROOT || "/mnt/nvme/skybox";

/**
 * Copy a single file from SD to the local NVMe inbox.
 * Emits `progress` events on copyEvents during transfer.
 * Resolves with the destination path.
 */
function copyOne(jobId, file) {
  return new Promise(async (resolve, reject) => {
    const date = file.recorded_at
      ? file.recorded_at.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const destDir = join(MEDIA_ROOT, "inbox", date);
    try {
      await mkdir(destDir, { recursive: true });
    } catch (err) {
      return reject(err);
    }

    const destPath = join(destDir, file.original_name);
    const totalBytes = file.size_bytes || 0;
    let bytesCopied = 0;

    const src = createReadStream(file.original_path);
    const dst = createWriteStream(destPath);

    src.on("data", (chunk) => {
      bytesCopied += chunk.length;
      const percent = totalBytes > 0 ? Math.round((bytesCopied / totalBytes) * 100) : 0;
      copyEvents.emit("progress", { jobId, fileId: file.id, percent, bytesCopied, totalBytes });
    });

    src.on("error", (err) => reject(err));
    dst.on("error", (err) => reject(err));
    dst.on("finish", () => resolve(destPath));

    src.pipe(dst);
  });
}

/**
 * Run a copy job for a list of files.
 * Emits: file_start, progress, file_done, file_error, job_done
 * Returns array of {fileId, localPath, error}.
 */
export async function runCopyJob(jobId, files) {
  const results = [];

  for (const file of files) {
    copyEvents.emit("file_start", { jobId, fileId: file.id, name: file.original_name });
    try {
      const localPath = await copyOne(jobId, file);
      copyEvents.emit("file_done", { jobId, fileId: file.id, localPath });
      results.push({ fileId: file.id, localPath, error: null });
    } catch (err) {
      console.error(`[copier] failed to copy ${file.original_name}: ${err.message}`);
      copyEvents.emit("file_error", { jobId, fileId: file.id, error: err.message });
      results.push({ fileId: file.id, localPath: null, error: err.message });
    }
  }

  copyEvents.emit("job_done", { jobId, results });
  return results;
}
