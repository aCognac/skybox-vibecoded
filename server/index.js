import "dotenv/config";
import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createReadStream, statSync, existsSync } from "fs";

import { startScraper }    from "./scraper.js";
import { startLoadsSync }  from "./services/loadsSync.js";
import { generateThumbnail, thumbnailPath, previewPath, queuePreview } from "./services/media.js";
import {
  getLoadsByDate,
  getLoadById,
  getDates,
  getAllJumperNames,
  createSdSession,
  ejectSdSession,
  getActiveSession,
  clearStaleSessions,
  insertFiles,
  getFilesBySession,
  getFilesByIds,
  updateFileAssignment,
  updateFileCopyStatus,
  getFilesForSync,
} from "./db.js";
import { startSdDetect, sdEvents, getCurrentDevices } from "./services/sdDetect.js";
import { scanSdCard } from "./services/scanner.js";
import { runCopyJob, copyEvents } from "./services/copier.js";
import { runSyncBatch, checkConnectivity } from "./services/nextcloud.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── log ring buffer ───────────────────────────────────────────────────────────

const LOG_RING = [];
const LOG_MAX  = 300;
function capture(level, args) {
  const ts  = new Date().toISOString();
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  LOG_RING.push({ ts, level, msg });
  if (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log   = (...a) => { _log(...a);  capture("info",  a); };
console.error = (...a) => { _err(...a);  capture("error", a); };

// ── SSE helpers ───────────────────────────────────────────────────────────────

const sdSseClients  = new Set();
const copySseClients = new Map(); // jobId → Set<res>

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSd(event, data) {
  for (const res of sdSseClients) sseWrite(res, event, data);
}

function broadcastCopy(jobId, event, data) {
  const clients = copySseClients.get(jobId);
  if (!clients) return;
  for (const res of clients) sseWrite(res, event, data);
}

// ── Wire SD events ────────────────────────────────────────────────────────────

sdEvents.on("inserted", async (device) => {
  console.log(`[server] SD inserted: ${device.deviceName} at ${device.mountPoint}`);

  // Reuse existing session if this is the same device (e.g. server restarted with card still in)
  const existingSession = getActiveSession();
  if (existingSession && existingSession.mount_point === device.mountPoint) {
    console.log(`[server] reusing existing session ${existingSession.id} for ${device.mountPoint}`);
    const sessionId = existingSession.id;
    const existing = getFilesBySession(sessionId).map((f) => ({
      ...f,
      jumped_with: JSON.parse(f.jumped_with || "[]"),
    }));
    broadcastSd("sd_inserted", { ...device, sessionId });
    if (existing.length > 0) {
      broadcastSd("files_scanned", { sessionId, count: existing.length, files: existing });
      return;
    }
    // Session exists but no files yet — fall through to rescan
    try {
      const files = await scanSdCard(device.mountPoint);
      console.log(`[server] scanned ${files.length} file(s) from ${device.mountPoint}`);
      insertFiles(sessionId, files.map((f) => ({
        original_name: f.original_name, original_path: f.original_path,
        size_bytes: f.size_bytes, duration_secs: f.duration_secs,
        recorded_at: f.recorded_at, camera_type: f.camera_type,
      })));
      const saved = getFilesBySession(sessionId).map((f) => ({ ...f, jumped_with: JSON.parse(f.jumped_with || "[]") }));
      broadcastSd("files_scanned", { sessionId, count: saved.length, files: saved });
    } catch (err) {
      console.error(`[server] scan error: ${err.message}`);
      broadcastSd("scan_error", { sessionId, error: err.message });
    }
    return;
  }

  const sessionId = createSdSession(device);
  broadcastSd("sd_inserted", { ...device, sessionId });

  try {
    const files = await scanSdCard(device.mountPoint);
    console.log(`[server] scanned ${files.length} file(s) from ${device.mountPoint}`);

    const dbFiles = files.map((f) => ({
      original_name: f.original_name,
      original_path: f.original_path,
      size_bytes:    f.size_bytes,
      duration_secs: f.duration_secs,
      recorded_at:   f.recorded_at,
      camera_type:   f.camera_type,
    }));
    insertFiles(sessionId, dbFiles);

    const saved = getFilesBySession(sessionId).map((f) => ({
      ...f,
      jumped_with: JSON.parse(f.jumped_with || "[]"),
    }));
    broadcastSd("files_scanned", { sessionId, count: saved.length, files: saved });

    // Kick off background thumbnail + preview generation (non-blocking)
    for (const f of saved) {
      if (f.original_path) {
        generateThumbnail(f.id, f.original_path).catch(() => {}); // eagerly pre-generate thumbs
        queuePreview(f.id, f.original_path);
      }
    }
  } catch (err) {
    console.error(`[server] scan error: ${err.message}`);
    broadcastSd("scan_error", { sessionId, error: err.message });
  }
});

sdEvents.on("removed", (device) => {
  const session = getActiveSession();
  if (session && session.device_name === device.deviceName) {
    ejectSdSession(session.id);
  }
  broadcastSd("sd_removed", { deviceName: device.deviceName });
});

// ── Wire copy events ──────────────────────────────────────────────────────────

copyEvents.on("progress",   (d) => broadcastCopy(d.jobId, "progress",   d));
copyEvents.on("file_start", (d) => broadcastCopy(d.jobId, "file_start", d));
copyEvents.on("file_done",  (d) => {
  updateFileCopyStatus(d.fileId, { copyStatus: "done", localPath: d.localPath });
  broadcastCopy(d.jobId, "file_done", d);
});
copyEvents.on("file_error", (d) => {
  updateFileCopyStatus(d.fileId, { copyStatus: "error", localPath: null });
  broadcastCopy(d.jobId, "file_error", d);
});
copyEvents.on("job_done", (d) => {
  broadcastCopy(d.jobId, "job_done", d);
  setTimeout(() => copySseClients.delete(d.jobId), 5000);
});

// ── Express app ───────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(express.static(join(__dirname, "public"), { extensions: ["html"] }));

// ── SD Card ───────────────────────────────────────────────────────────────────

app.get("/api/sd/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();

  // Send current state immediately on connect
  const session = getActiveSession();
  if (session) {
    const files = getFilesBySession(session.id).map((f) => ({
      ...f,
      jumped_with: JSON.parse(f.jumped_with || "[]"),
    }));
    sseWrite(res, "sd_inserted", {
      deviceName: session.device_name,
      mountPoint: session.mount_point,
      label:      session.label,
      size:       session.size,
      sessionId:  session.id,
    });
    if (files.length > 0) {
      sseWrite(res, "files_scanned", { sessionId: session.id, count: files.length, files });
    }
  } else {
    sseWrite(res, "sd_status", { inserted: false });
  }

  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  sdSseClients.add(res);
  req.on("close", () => { clearInterval(ping); sdSseClients.delete(res); });
});

app.get("/api/sd/status", (_req, res) => {
  const session = getActiveSession();
  if (!session) return res.json({ inserted: false });
  const files = getFilesBySession(session.id).map((f) => ({
    ...f,
    jumped_with: JSON.parse(f.jumped_with || "[]"),
  }));
  res.json({ inserted: true, session, files });
});

app.post("/api/sd/scan", async (_req, res) => {
  const session = getActiveSession();
  if (!session) return res.status(404).json({ error: "No SD card mounted" });
  try {
    const files = await scanSdCard(session.mount_point);
    insertFiles(session.id, files.map((f) => ({
      original_name: f.original_name,
      original_path: f.original_path,
      size_bytes:    f.size_bytes,
      duration_secs: f.duration_secs,
      recorded_at:   f.recorded_at,
      camera_type:   f.camera_type,
    })));
    const saved = getFilesBySession(session.id).map((f) => ({
      ...f,
      jumped_with: JSON.parse(f.jumped_with || "[]"),
    }));
    broadcastSd("files_scanned", { sessionId: session.id, count: saved.length, files: saved });
    res.json({ sessionId: session.id, count: saved.length, files: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Files ─────────────────────────────────────────────────────────────────────

app.get("/api/files", (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: "session_id required" });
  const files = getFilesBySession(Number(sessionId)).map((f) => ({
    ...f,
    jumped_with: JSON.parse(f.jumped_with || "[]"),
  }));
  res.json(files);
});

app.patch("/api/files/:id", (req, res) => {
  const id = Number(req.params.id);
  const { ownerName, loadId, jumpedWith, finalName } = req.body;
  const updated = updateFileAssignment(id, { ownerName, loadId, jumpedWith, finalName });
  if (!updated) return res.status(404).json({ error: "File not found" });
  res.json({ ...updated, jumped_with: JSON.parse(updated.jumped_with || "[]") });
});

/** GET /api/files/:id/stream — range-capable video stream for in-app preview */
app.get("/api/files/:id/stream", (req, res) => {
  const [file] = getFilesByIds([Number(req.params.id)]);
  if (!file) return res.status(404).json({ error: "Not found" });

  const filePath = file.local_path || file.original_path;
  if (!filePath) return res.status(404).json({ error: "No path available" });

  let stat;
  try { stat = statSync(filePath); } catch { return res.status(404).json({ error: "File not on disk" }); }

  const { range } = req.headers;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr);
    const end   = endStr ? parseInt(endStr) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range":  `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": end - start + 1,
      "Content-Type":   "video/mp4",
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" });
    createReadStream(filePath).pipe(res);
  }
});

/** GET /api/files/:id/thumbnail — lazy-generate + serve a JPEG frame */
app.get("/api/files/:id/thumbnail", async (req, res) => {
  const [file] = getFilesByIds([Number(req.params.id)]);
  if (!file) return res.status(404).end();

  const sourcePath = file.original_path;
  if (!sourcePath || !existsSync(sourcePath)) return res.status(404).end();

  // Serve cached thumbnail if available
  const cached = thumbnailPath(file.id);
  if (existsSync(cached)) {
    return res.sendFile(cached);
  }

  try {
    const out = await generateThumbnail(file.id, sourcePath);
    res.sendFile(out);
  } catch (err) {
    console.error(`[media] thumbnail error for file ${file.id}: ${err.message}`);
    res.status(500).end();
  }
});

/** GET /api/files/:id/preview — serve transcoded 360p preview, or raw stream as fallback */
app.get("/api/files/:id/preview", (req, res) => {
  const [file] = getFilesByIds([Number(req.params.id)]);
  if (!file) return res.status(404).end();

  const pv = previewPath(file.id);
  if (existsSync(pv)) {
    // Serve the pre-generated preview with range support
    let stat;
    try { stat = statSync(pv); } catch { return res.status(404).end(); }
    const { range } = req.headers;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
      const start = parseInt(startStr);
      const end   = endStr ? parseInt(endStr) : stat.size - 1;
      res.writeHead(206, {
        "Content-Range":  `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges":  "bytes",
        "Content-Length": end - start + 1,
        "Content-Type":   "video/mp4",
      });
      return createReadStream(pv, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" });
    return createReadStream(pv).pipe(res);
  }

  // Preview not ready — fall back to raw file (also queues preview if not already queued)
  const sourcePath = file.local_path || file.original_path;
  if (!sourcePath) return res.status(404).end();
  if (file.original_path) queuePreview(file.id, file.original_path);

  let stat;
  try { stat = statSync(sourcePath); } catch { return res.status(404).end(); }
  const { range } = req.headers;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr);
    const end   = endStr ? parseInt(endStr) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range":  `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": end - start + 1,
      "Content-Type":   "video/mp4",
    });
    return createReadStream(sourcePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" });
  createReadStream(sourcePath).pipe(res);
});

// ── Copy ──────────────────────────────────────────────────────────────────────

app.post("/api/copy", async (req, res) => {
  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: "fileIds array required" });
  }
  const files = getFilesByIds(fileIds.map(Number));
  if (files.length === 0) return res.status(404).json({ error: "No files found" });

  const jobId = randomUUID();
  for (const f of files) updateFileCopyStatus(f.id, { copyStatus: "copying", localPath: null });

  runCopyJob(jobId, files).catch((err) =>
    console.error(`[copy] job ${jobId} failed: ${err.message}`)
  );

  res.json({ jobId, fileCount: files.length });
});

app.get("/api/copy/events/:jobId", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const { jobId } = req.params;
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  if (!copySseClients.has(jobId)) copySseClients.set(jobId, new Set());
  copySseClients.get(jobId).add(res);
  req.on("close", () => { clearInterval(ping); copySseClients.get(jobId)?.delete(res); });
});

// ── Sync ──────────────────────────────────────────────────────────────────────

app.get("/api/sync/status", async (_req, res) => {
  const pending = getFilesForSync().length;
  const online  = await checkConnectivity();
  res.json({ pending, online, nextcloudUrl: process.env.NEXTCLOUD_URL || null });
});

app.post("/api/sync/trigger", async (_req, res) => {
  try {
    const synced = await runSyncBatch();
    res.json({ synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Loads ─────────────────────────────────────────────────────────────────────

app.get("/api/dates", (_req, res) => res.json(getDates()));

app.get("/api/jumpers", (_req, res) => res.json(getAllJumperNames()));

app.get("/api/loads", (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json(getLoadsByDate(date));
});

app.get("/api/loads/:id", (req, res) => {
  const load = getLoadById(Number(req.params.id));
  if (!load) return res.status(404).json({ error: "Not found" });
  res.json(load);
});

// ── Health / Logs ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/logs", (_req, res) => res.json(LOG_RING));

// ── Background sync ───────────────────────────────────────────────────────────

async function syncLoop() {
  try {
    await runSyncBatch();
  } catch (err) {
    console.error(`[sync] batch error: ${err.message}`);
  }
  setTimeout(syncLoop, 5 * 60_000); // every 5 minutes
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const mode = process.env.LOADS_SOURCE_URL ? "pi" : "truenas";
  console.log(`Skybox server listening on http://localhost:${PORT} [mode: ${mode}]`);

  if (mode === "pi") {
    // Pi: sync loads from TrueNAS, handle SD cards, upload to Nextcloud

    // Clear sessions whose mount point no longer exists (card was removed while Pi was off).
    // Sessions whose mount point still exists are kept — sdDetect will pick them up
    // on first poll and re-register them without firing a new scan.
    const stale = getActiveSession();
    if (stale && !existsSync(stale.mount_point)) {
      console.log(`[server] clearing stale session for ${stale.mount_point} (no longer mounted)`);
      clearStaleSessions();
    }

    startSdDetect();
    startLoadsSync();
    setTimeout(syncLoop, 30_000); // first Nextcloud sync after 30s
  } else {
    // TrueNAS: scrape Burble 24/7, no SD card handling
    startScraper();
  }
});
