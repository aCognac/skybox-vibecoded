import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "loads.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

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
`);

// Migrate existing databases that don't have confirmed_departed yet.
try {
  db.exec(`ALTER TABLE loads ADD COLUMN confirmed_departed INTEGER NOT NULL DEFAULT 1`);
} catch { /* column already exists */ }

// Remove phantom load_number=0 entries that were saved before the status="" bug fix.
db.exec(`DELETE FROM loads WHERE load_number = 0`);

// ── queries ──────────────────────────────────────────────────────────────────

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

const stmtLoadExists = db.prepare(
  "SELECT id FROM loads WHERE burble_load_id = ?"
);

/**
 * Save a load + its jumpers atomically.
 * No-op if the burble_load_id already exists.
 * @param {object} load - must include confirmed_departed (1 = confirmed, 0 = inferred from slot count)
 * @returns {boolean} true if newly inserted, false if already existed
 */
export function saveDepartedLoad(load, jumpers) {
  if (stmtLoadExists.get(load.burble_load_id)) return false;

  const insert = db.transaction(() => {
    const info = stmtInsertLoad.run(load);
    const loadId = info.lastInsertRowid;
    for (const j of jumpers) {
      stmtInsertJumper.run({ ...j, load_id: loadId });
    }
  });

  insert();
  return true;
}

/**
 * Upgrade a previously-unconfirmed load to confirmed_departed = 1.
 * @returns {boolean} true if a row was updated
 */
export function confirmDeparted(burble_load_id) {
  return stmtConfirmDeparted.run(burble_load_id).changes > 0;
}

// ── read API ─────────────────────────────────────────────────────────────────

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
  const load = db
    .prepare("SELECT * FROM loads WHERE id = ?")
    .get(id);
  if (!load) return null;
  load.jumpers = db
    .prepare("SELECT * FROM jumpers WHERE load_id = ?")
    .all(id);
  return load;
}

export function getDates() {
  return db
    .prepare("SELECT DISTINCT date FROM loads ORDER BY date DESC")
    .all()
    .map((r) => r.date);
}
