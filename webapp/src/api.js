const BASE = "/api";

async function json(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// ── SD Card ───────────────────────────────────────────────────────────────────

/**
 * Open an SSE connection to /api/sd/events.
 * Callbacks: onSdInserted, onFilesScanned, onSdRemoved, onScanError
 * Returns the EventSource (call .close() to disconnect).
 */
export function subscribeToSdEvents({ onSdInserted, onFilesScanned, onSdRemoved, onScanError } = {}) {
  const es = new EventSource(`${BASE}/sd/events`);

  es.addEventListener("sd_inserted",   (e) => onSdInserted?.(JSON.parse(e.data)));
  es.addEventListener("files_scanned", (e) => onFilesScanned?.(JSON.parse(e.data)));
  es.addEventListener("sd_removed",    (e) => onSdRemoved?.(JSON.parse(e.data)));
  es.addEventListener("scan_error",    (e) => onScanError?.(JSON.parse(e.data)));
  es.addEventListener("sd_status",     (e) => {
    const data = JSON.parse(e.data);
    if (!data.inserted) {
      // No card currently — nothing to do, UI stays on step 1
    }
  });

  es.onerror = () => {
    // EventSource auto-reconnects, no action needed
  };

  return es;
}

export async function getSdStatus() {
  return json(await fetch(`${BASE}/sd/status`));
}

export async function rescanSd() {
  return json(await fetch(`${BASE}/sd/scan`, { method: "POST" }));
}

// ── Loads (Burble manifest) ───────────────────────────────────────────────────

export async function fetchLoads(date) {
  const d = date || new Date().toISOString().slice(0, 10);
  return json(await fetch(`${BASE}/loads?date=${d}`));
}

export async function fetchLoadById(id) {
  return json(await fetch(`${BASE}/loads/${id}`));
}

export async function fetchDates() {
  return json(await fetch(`${BASE}/dates`));
}

export async function fetchAllJumpers() {
  return json(await fetch(`${BASE}/jumpers`));
}

// ── Files ─────────────────────────────────────────────────────────────────────

export async function fetchFiles(sessionId) {
  return json(await fetch(`${BASE}/files?session_id=${sessionId}`));
}

/**
 * Update file assignment metadata.
 * @param {number} id
 * @param {{ ownerName, loadId, jumpedWith, finalName }} body
 */
export async function patchFile(id, body) {
  return json(
    await fetch(`${BASE}/files/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

// ── Copy ──────────────────────────────────────────────────────────────────────

/**
 * Start copying files from SD to NVMe.
 * @param {number[]} fileIds
 * @returns {{ jobId: string, fileCount: number }}
 */
export async function startCopy(fileIds) {
  return json(
    await fetch(`${BASE}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds }),
    })
  );
}

/**
 * Subscribe to copy progress for a job.
 * Callbacks: onProgress, onFileStart, onFileDone, onFileError, onJobDone
 * Returns the EventSource.
 */
export function subscribeToCopyEvents(
  jobId,
  { onProgress, onFileStart, onFileDone, onFileError, onJobDone } = {}
) {
  const es = new EventSource(`${BASE}/copy/events/${jobId}`);

  es.addEventListener("progress",   (e) => onProgress?.(JSON.parse(e.data)));
  es.addEventListener("file_start", (e) => onFileStart?.(JSON.parse(e.data)));
  es.addEventListener("file_done",  (e) => onFileDone?.(JSON.parse(e.data)));
  es.addEventListener("file_error", (e) => onFileError?.(JSON.parse(e.data)));
  es.addEventListener("job_done",   (e) => onJobDone?.(JSON.parse(e.data)));

  es.onerror = () => {};

  return es;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function fetchSyncStatus() {
  return json(await fetch(`${BASE}/sync/status`));
}

export async function triggerSync() {
  return json(await fetch(`${BASE}/sync/trigger`, { method: "POST" }));
}
