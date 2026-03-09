import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "loads.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ── schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS loads (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    burble_load_id     TEXT    NOT NULL UNIQUE,
    load_number        INTEGER NOT NULL,
    aircraft           TEXT    NOT NULL,
    load_master        TEXT,
    date               TEXT    NOT NULL,
    departed_at        TEXT    NOT NULL,
    confirmed_departed INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS jumpers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    load_id     INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    type        TEXT,
    group_name  TEXT,
    formation   TEXT,
    rig         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_loads_date ON loads(date);
  CREATE INDEX IF NOT EXISTS idx_jumpers_load ON jumpers(load_id);

  CREATE TABLE IF NOT EXISTS sd_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_name  TEXT    NOT NULL,
    mount_point  TEXT    NOT NULL,
    label        TEXT,
    size         TEXT,
    detected_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    ejected_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER REFERENCES sd_sessions(id),
    original_name   TEXT    NOT NULL,
    original_path   TEXT    NOT NULL,
    size_bytes      INTEGER,
    duration_secs   INTEGER,
    recorded_at     TEXT,
    camera_type     TEXT    DEFAULT 'unknown',
    owner_name      TEXT,
    load_id         INTEGER REFERENCES loads(id),
    jumped_with     TEXT    DEFAULT '[]',
    final_name      TEXT,
    local_path      TEXT,
    copied_at       TEXT,
    copy_status     TEXT    DEFAULT 'pending',
    sync_status     TEXT    DEFAULT 'pending',
    synced_at       TEXT,
    nextcloud_path  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
  CREATE INDEX IF NOT EXISTS idx_files_copy_status ON files(copy_status);
  CREATE INDEX IF NOT EXISTS idx_files_sync_status ON files(sync_status);
`);

// Migrate existing DBs without confirmed_departed
try {
  db.exec(`ALTER TABLE loads ADD COLUMN confirmed_departed INTEGER NOT NULL DEFAULT 1`);
} catch { /* already exists */ }

// Clean phantom zero-number loads from old bug
db.exec(`DELETE FROM loads WHERE load_number = 0`);

// ── loads queries ─────────────────────────────────────────────────────────────

const stmtInsertLoad = db.prepare(`
  INSERT OR IGNORE INTO loads
    (burble_load_id, load_number, aircraft, load_master, date, departed_at, confirmed_departed)
  VALUES
    (@burble_load_id, @load_number, @aircraft, @load_master, @date, @departed_at, @confirmed_departed)
`);

const stmtConfirmDeparted = db.prepare(`
  UPDATE loads SET confirmed_departed = 1
  WHERE burble_load_id = ? AND confirmed_departed = 0
`);

const stmtInsertJumper = db.prepare(`
  INSERT INTO jumpers (load_id, name, type, group_name, formation, rig)
  VALUES (@load_id, @name, @type, @group_name, @formation, @rig)
`);

const stmtLoadExists = db.prepare("SELECT id FROM loads WHERE burble_load_id = ?");

export function saveDepartedLoad(load, jumpers) {
  if (stmtLoadExists.get(load.burble_load_id)) return false;
  const insert = db.transaction(() => {
    const info = stmtInsertLoad.run(load);
    const loadId = info.lastInsertRowid;
    for (const j of jumpers) stmtInsertJumper.run({ ...j, load_id: loadId });
  });
  insert();
  return true;
}

export function confirmDeparted(burble_load_id) {
  return stmtConfirmDeparted.run(burble_load_id).changes > 0;
}

export function getLoadsByDate(date) {
  return db
    .prepare(
      `SELECT l.*, json_group_array(
         json_object(
           'name', j.name, 'type', j.type,
           'group_name', j.group_name, 'formation', j.formation, 'rig', j.rig
         )
       ) AS jumpers
       FROM loads l
       LEFT JOIN jumpers j ON j.load_id = l.id
       WHERE l.date = ?
       GROUP BY l.id
       ORDER BY l.load_number`
    )
    .all(date)
    .map((row) => ({ ...row, jumpers: JSON.parse(row.jumpers) }));
}

export function getLoadById(id) {
  const load = db.prepare("SELECT * FROM loads WHERE id = ?").get(id);
  if (!load) return null;
  load.jumpers = db.prepare("SELECT * FROM jumpers WHERE load_id = ?").all(id);
  return load;
}

export function getDates() {
  return db
    .prepare("SELECT DISTINCT date FROM loads ORDER BY date DESC")
    .all()
    .map((r) => r.date);
}

// ── sd session queries ────────────────────────────────────────────────────────

export function createSdSession({ deviceName, mountPoint, label, size }) {
  const info = db
    .prepare(
      `INSERT INTO sd_sessions (device_name, mount_point, label, size)
       VALUES (?, ?, ?, ?)`
    )
    .run(deviceName, mountPoint, label || null, size || null);
  return info.lastInsertRowid;
}

export function ejectSdSession(sessionId) {
  db.prepare(
    `UPDATE sd_sessions SET ejected_at = datetime('now') WHERE id = ?`
  ).run(sessionId);
}

export function getActiveSession() {
  return db
    .prepare(`SELECT * FROM sd_sessions WHERE ejected_at IS NULL ORDER BY detected_at DESC LIMIT 1`)
    .get() || null;
}

// ── file queries ──────────────────────────────────────────────────────────────

export function insertFiles(sessionId, fileList) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO files
      (session_id, original_name, original_path, size_bytes, duration_secs, recorded_at, camera_type)
    VALUES
      (@session_id, @original_name, @original_path, @size_bytes, @duration_secs, @recorded_at, @camera_type)
  `);
  const insertMany = db.transaction((files) => {
    for (const f of files) stmt.run({ session_id: sessionId, ...f });
  });
  insertMany(fileList);
}

export function getFilesBySession(sessionId) {
  return db
    .prepare(`SELECT * FROM files WHERE session_id = ? ORDER BY recorded_at ASC`)
    .all(sessionId);
}

export function getFilesByIds(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...ids);
}

export function updateFileAssignment(id, { ownerName, loadId, jumpedWith, finalName }) {
  db.prepare(`
    UPDATE files SET
      owner_name  = @ownerName,
      load_id     = @loadId,
      jumped_with = @jumpedWith,
      final_name  = @finalName
    WHERE id = @id
  `).run({
    id,
    ownerName: ownerName || null,
    loadId: loadId || null,
    jumpedWith: JSON.stringify(jumpedWith || []),
    finalName: finalName || null,
  });
  return db.prepare(`SELECT * FROM files WHERE id = ?`).get(id);
}

export function updateFileCopyStatus(id, { copyStatus, localPath }) {
  db.prepare(`
    UPDATE files
    SET copy_status = ?,
        local_path  = ?,
        copied_at   = CASE WHEN ? = 'done' THEN datetime('now') ELSE copied_at END
    WHERE id = ?
  `).run(copyStatus, localPath || null, copyStatus, id);
}

export function updateFileSyncStatus(id, { syncStatus, nextcloudPath }) {
  db.prepare(`
    UPDATE files
    SET sync_status    = ?,
        nextcloud_path = ?,
        synced_at      = CASE WHEN ? = 'done' THEN datetime('now') ELSE synced_at END
    WHERE id = ?
  `).run(syncStatus, nextcloudPath || null, syncStatus, id);
}

export function getFilesForSync() {
  return db
    .prepare(`SELECT * FROM files WHERE copy_status = 'done' AND sync_status = 'pending' LIMIT 20`)
    .all();
}
