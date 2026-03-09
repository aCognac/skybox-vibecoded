import axios from "axios";
import { createReadStream } from "fs";
import { stat } from "fs/promises";

const NC_URL  = () => process.env.NEXTCLOUD_URL  || "";
const NC_USER = () => process.env.NEXTCLOUD_USER || "";
const NC_PASS = () => process.env.NEXTCLOUD_PASSWORD || "";

function davBase() {
  return `${NC_URL()}/remote.php/dav/files/${NC_USER()}`;
}

function authHeader() {
  const token = Buffer.from(`${NC_USER()}:${NC_PASS()}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

/** Create a WebDAV directory. Ignores 405 (already exists). */
async function ensureDir(remotePath) {
  try {
    await axios.request({
      method: "MKCOL",
      url: `${davBase()}${remotePath}`,
      headers: authHeader(),
      timeout: 10_000,
    });
  } catch (err) {
    if (err.response?.status !== 405) throw err;
  }
}

/**
 * Upload a file to Nextcloud via WebDAV PUT.
 * @param {string} localPath  - absolute path on disk
 * @param {string} remoteName - filename to use on Nextcloud (may include subfolder prefix like "2024-03-15/file.mp4")
 * @param {function} onProgress - called with (percent) during upload
 */
export async function uploadFile(localPath, remoteName, onProgress) {
  if (!NC_URL()) throw new Error("NEXTCLOUD_URL not configured");

  const fileStat = await stat(localPath);
  const totalBytes = fileStat.size;

  // Ensure SkyBox root + date subfolder exist
  await ensureDir("/SkyBox");
  const parts = remoteName.split("/");
  if (parts.length > 1) {
    await ensureDir(`/SkyBox/${parts.slice(0, -1).join("/")}`);
  }

  const remotePath = `/SkyBox/${remoteName}`;

  let uploaded = 0;
  const stream = createReadStream(localPath);
  stream.on("data", (chunk) => {
    uploaded += chunk.length;
    if (onProgress) onProgress(Math.round((uploaded / totalBytes) * 100));
  });

  await axios.put(`${davBase()}${remotePath}`, stream, {
    headers: {
      ...authHeader(),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(totalBytes),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0, // no timeout for large files
  });

  return remotePath;
}

/**
 * Test connectivity to Nextcloud.
 * Returns true if reachable and credentials work, false otherwise.
 */
export async function checkConnectivity() {
  if (!NC_URL()) return false;
  try {
    await axios.request({
      method: "PROPFIND",
      url: `${davBase()}/`,
      headers: { ...authHeader(), Depth: "0" },
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Background sync loop: uploads pending files to Nextcloud.
 * Called by the main server on an interval when internet is available.
 */
import {
  getFilesForSync,
  updateFileSyncStatus,
  getLoadById,
} from "../db.js";

export async function runSyncBatch() {
  const files = getFilesForSync();
  if (files.length === 0) return 0;

  const online = await checkConnectivity();
  if (!online) {
    console.log("[nextcloud] not reachable, skipping sync batch");
    return 0;
  }

  let synced = 0;
  for (const file of files) {
    updateFileSyncStatus(file.id, { syncStatus: "syncing", nextcloudPath: null });

    // Build remote filename: prefer final_name, fall back to original_name
    const name = file.final_name || file.original_name;
    const date = file.recorded_at ? file.recorded_at.slice(0, 10) : "unknown";
    const remoteName = `${date}/${name}`;

    const localPath = file.local_path;
    if (!localPath) {
      updateFileSyncStatus(file.id, { syncStatus: "error", nextcloudPath: null });
      continue;
    }

    try {
      const remotePath = await uploadFile(localPath, remoteName, (pct) => {
        console.log(`[nextcloud] uploading ${name}: ${pct}%`);
      });
      updateFileSyncStatus(file.id, { syncStatus: "done", nextcloudPath: remotePath });
      synced++;
      console.log(`[nextcloud] synced: ${name} → ${remotePath}`);
    } catch (err) {
      console.error(`[nextcloud] upload failed for ${name}: ${err.message}`);
      updateFileSyncStatus(file.id, { syncStatus: "pending", nextcloudPath: null }); // retry next time
    }
  }

  return synced;
}
