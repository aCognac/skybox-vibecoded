import { readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Known camera DCIM subdirectory patterns → camera type
const CAMERA_FOLDER_PATTERNS = [
  { re: /^1\d\dGOPRO$/i,   type: "gopro" },      // GoPro: 100GOPRO, 101GOPRO, ...
  { re: /^Camera\d*$/i,    type: "insta360" },    // Insta360: Camera01
  { re: /^DJI_.*/i,        type: "dji" },         // DJI Action / Osmo
  { re: /^PANORAMA$/i,     type: "dji360" },      // DJI 360
  { re: /^\d+MEDIA$/i,     type: "gopro360" },    // GoPro MAX: 100MEDIA
  { re: /^\d+GOPRO$/i,     type: "gopro" },       // Fallback numeric gopro
];

// Video file extensions to include (lowercase)
const VIDEO_EXTS = new Set([".mp4", ".mov", ".insv", ".lrf"]);

// Files to skip even if extension matches above (GoPro proxies/thumbnails)
const SKIP_SUFFIXES = [".lrv", ".thm", ".gpr", ".insp"];

function cameraTypeForFolder(folderName) {
  for (const { re, type } of CAMERA_FOLDER_PATTERNS) {
    if (re.test(folderName)) return type;
  }
  return null;
}

/** Try to get video duration (seconds) using ffprobe. Returns null if unavailable. */
async function getVideoDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_streams -select_streams v:0 "${filePath}"`,
      { timeout: 5000 }
    );
    const info = JSON.parse(stdout);
    const dur = info.streams?.[0]?.duration;
    if (dur) return Math.round(parseFloat(dur));
  } catch {
    // ffprobe not available or file unreadable
  }
  return null;
}

/** Scan a single directory for video files. Appends to results array. */
async function scanDir(dir, cameraType, results) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable
  }

  // Collect valid video file entries first
  const candidates = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const nameLower = entry.name.toLowerCase();
    const ext = extname(nameLower);
    if (SKIP_SUFFIXES.some((s) => nameLower.endsWith(s))) continue;
    if (!VIDEO_EXTS.has(ext)) continue;
    candidates.push(entry);
  }

  // Stat + ffprobe all files in parallel
  await Promise.all(candidates.map(async (entry) => {
    const fullPath = join(dir, entry.name);
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch {
      return;
    }
    const durationSecs = await getVideoDuration(fullPath);
    results.push({
      original_name: entry.name,
      original_path: fullPath,
      size_bytes: fileStat.size,
      duration_secs: durationSecs,
      recorded_at: fileStat.mtime.toISOString(),
      camera_type: cameraType,
    });
  }));
}

/**
 * Scan an SD card mount point for video files.
 * Returns an array of file descriptor objects sorted oldest-first.
 */
export async function scanSdCard(mountPoint) {
  const results = [];
  const dcimPath = join(mountPoint, "DCIM");

  let dcimEntries;
  try {
    dcimEntries = await readdir(dcimPath, { withFileTypes: true });
  } catch {
    // No DCIM folder — scan mount root directly
    await scanDir(mountPoint, "unknown", results);
    results.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    return results;
  }

  const cameraFolders = [];
  const otherFolders = [];

  for (const entry of dcimEntries) {
    if (!entry.isDirectory()) continue;
    const ctype = cameraTypeForFolder(entry.name);
    if (ctype) cameraFolders.push({ name: entry.name, type: ctype });
    else otherFolders.push(entry.name);
  }

  if (cameraFolders.length > 0) {
    for (const { name, type } of cameraFolders) {
      await scanDir(join(dcimPath, name), type, results);
    }
  } else {
    // No recognized folders — scan everything under DCIM
    for (const name of otherFolders) {
      await scanDir(join(dcimPath, name), "unknown", results);
    }
    await scanDir(dcimPath, "unknown", results);
  }

  results.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
  return results;
}
