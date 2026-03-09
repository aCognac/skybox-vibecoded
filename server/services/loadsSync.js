import axios from "axios";
import { saveDepartedLoad } from "../db.js";

const SOURCE_URL   = process.env.LOADS_SOURCE_URL || "";
const SYNC_INTERVAL = 5 * 60_000; // every 5 minutes

/**
 * Fetch today's and yesterday's loads from the TrueNAS server API
 * and upsert them into the local SQLite DB.
 * Returns the number of newly-inserted loads.
 */
export async function syncLoadsFromSource() {
  if (!SOURCE_URL) return 0;

  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let totalSynced = 0;

  for (const date of [today, yesterday]) {
    try {
      const { data: loads } = await axios.get(`${SOURCE_URL}/api/loads`, {
        params:  { date },
        timeout: 10_000,
      });

      if (!Array.isArray(loads)) continue;

      for (const load of loads) {
        // Filter null-name jumpers that can appear due to LEFT JOINs
        const jumpers = (load.jumpers || []).filter((j) => j.name);

        const saved = saveDepartedLoad(
          {
            burble_load_id:     String(load.burble_load_id),
            load_number:        load.load_number,
            aircraft:           load.aircraft,
            load_master:        load.load_master || null,
            date:               load.date,
            departed_at:        load.departed_at,
            confirmed_departed: load.confirmed_departed ?? 1,
          },
          jumpers
        );

        if (saved) totalSynced++;
      }

      console.log(`[loadsSync] ${date}: ${loads.length} loads from source (${totalSynced} new)`);
    } catch (err) {
      console.error(`[loadsSync] failed to sync ${date}: ${err.message}`);
    }
  }

  return totalSynced;
}

/**
 * Start the background sync loop.
 * Immediately fires once, then repeats every SYNC_INTERVAL.
 */
export function startLoadsSync() {
  console.log(`[loadsSync] starting — source: ${SOURCE_URL}, interval: ${SYNC_INTERVAL / 1000}s`);

  async function tick() {
    try {
      await syncLoadsFromSource();
    } catch (err) {
      console.error(`[loadsSync] tick error: ${err.message}`);
    }
    setTimeout(tick, SYNC_INTERVAL);
  }

  tick();
}
