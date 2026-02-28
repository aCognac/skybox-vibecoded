import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import SunCalc from "suncalc";
import { saveDepartedLoad, confirmDeparted } from "./db.js";

// ── DZ config ─────────────────────────────────────────────────────────────────

const DZ = {
  id:  process.env.DZ_ID  || "2351",
  tz:  process.env.DZ_TZ  || "Europe/Madrid",
  lat: parseFloat(process.env.DZ_LAT || "37.16"),
  lon: parseFloat(process.env.DZ_LON || "-5.61"),
};

const BASE_URL = "https://dzm.burblesoft.eu";
const PAGE_URL = `${BASE_URL}/jmp?dz_id=${DZ.id}`;
const API_URL  = "https://eu-displays.burblesoft.eu/ajax_dzm2_frontend_jumpermanifestpublic";

// ── schedule constants ────────────────────────────────────────────────────────

const ACTIVE_MS  = 30_000;        // 30 s  (0.5 min) — daytime
const NIGHT_MS   = 30 * 60_000;  // 30 min           — quiet night
const BOOST_MS   = 30_000;        // 30 s             — night-boost after finding a load
const BOOST_TTL  = 30 * 60_000;  // keep boost 30 min after last activity

// ── http client with cookie jar ───────────────────────────────────────────────

function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15_000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "Cache-Control": "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    },
  }));
}

// One persistent client for the lifetime of the process.
// Re-using it keeps the session cookie alive between polls.
let client = makeClient();

// ── timing helpers ────────────────────────────────────────────────────────────

/** Minutes since midnight for a Date object in the DZ's local timezone. */
function toLocalMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DZ.tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  return h * 60 + m;
}

/** Minutes since midnight right now in the DZ's local timezone. */
function dzMinuteOfDay() {
  return toLocalMinutes(new Date());
}

/** Returns { sunriseMin, sunsetMin } in DZ local minutes-since-midnight. */
function getSolarWindow() {
  const now   = new Date();
  const times = SunCalc.getTimes(now, DZ.lat, DZ.lon);
  return {
    sunriseMin: toLocalMinutes(times.sunrise),
    sunsetMin:  toLocalMinutes(times.sunset),
  };
}

function isDaytime() {
  const m = dzMinuteOfDay();
  const { sunriseMin, sunsetMin } = getSolarWindow();
  return m >= sunriseMin && m < sunsetMin;
}

// ── parsing ───────────────────────────────────────────────────────────────────

/**
 * Extract a flat jumper list from a load object.
 *
 * Burble returns groups as an array of arrays:
 *   [ [slot, slot, …], [slot], … ]
 * Each slot: { name, type, team_name, jump, formation_type_name, rig_name, … }
 */
function parseJumpers(loadObj) {
  const jumpers = [];

  if (Array.isArray(loadObj.groups)) {
    for (const group of loadObj.groups) {
      // Each group element is itself an array of slot objects
      const slots = Array.isArray(group) ? group : [group];
      for (const slot of slots) {
        const name = slot.name || "";
        if (!name) continue;
        jumpers.push({
          name,
          type:       slot.type       || null,
          group_name: slot.team_name  || null,
          formation:  slot.jump       || slot.formation_type_name || null,
          rig:        slot.rig_name   || null,
        });
      }
    }
  }

  return jumpers;
}

/**
 * Determine if a load should be captured and whether it is confirmed departed.
 *
 * Burble normally sets status = "departed" when the plane leaves.
 * Sometimes it skips that state and the slot count drops to 0 or -1 instead.
 * We capture both cases:
 *   - confirmed  → status === "departed"
 *   - unconfirmed → status is a number ≤ 0, OR open_slots / slots field ≤ 0
 *
 * Returns null if the load should be skipped entirely.
 */
function classifyLoad(loadObj) {
  const statusStr = String(loadObj.status ?? "").trim();

  if (statusStr.toLowerCase() === "departed") return "confirmed";

  // Numeric status value (Burble sometimes uses "0" or "-1" as status).
  // Guard statusStr !== "" because Number("") === 0, which would falsely match.
  const statusNum = Number(statusStr);
  if (statusStr !== "" && !isNaN(statusNum) && statusNum <= 0) return "unconfirmed";

  // Explicit open-slot count fields
  const openSlots =
    typeof loadObj.open_slots === "number" ? loadObj.open_slots :
    typeof loadObj.slots      === "number" ? loadObj.slots      :
    null;
  if (openSlots !== null && openSlots <= 0) return "unconfirmed";

  return null; // still active / loading
}

// ── scrape ────────────────────────────────────────────────────────────────────

/** Returns true if any new loads were saved to DB. */
export async function scrape() {
  let apiLoads;
  try {
    // Pre-flight: visit the public manifest page so Burble sets session cookies.
    await client.get(PAGE_URL, { maxRedirects: 5 });

    const params = new URLSearchParams({
      action:          "getLoads",
      dz_id:           DZ.id,
      aircraft:        "0",
      columns:         "4",
      display_tandem:  "1",
      display_student: "1",
      display_sport:   "1",
      display_menu:    "1",
      font_size:       "0",
      date_format:     "d/m/Y",
      acl_application: "Burble DZM",
    });

    const res = await client.post(API_URL, params.toString(), {
      headers: {
        "Content-Type":     "application/x-www-form-urlencoded",
        "Referer":          "https://eu-displays.burblesoft.eu/jmp",
        "Accept":           "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
      maxRedirects: 5,
    });

    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

    if (!data?.success || !Array.isArray(data.loads)) {
      console.error(`[scraper] unexpected API response: ${JSON.stringify(data).slice(0, 300)}`);
      return false;
    }

    apiLoads = data.loads;
  } catch (err) {
    console.error(`[scraper] fetch failed: ${err.message}`);
    client = makeClient();
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  const toProcess = [];
  let firstUnconfirmedLogged = false;

  for (const loadObj of apiLoads) {
    const kind = classifyLoad(loadObj);
    if (!kind) continue;

    // One-time debug log for the first unconfirmed (0/-1) load
    if (kind === "unconfirmed" && !firstUnconfirmedLogged) {
      firstUnconfirmedLogged = true;
      console.log(`[scraper] first unconfirmed load debug: ${JSON.stringify({
        id:     loadObj.id,
        name:   loadObj.name,
        status: loadObj.status,
        open_slots: loadObj.open_slots,
        slots:  typeof loadObj.slots === "number" ? loadObj.slots : "(array/other)",
      })}`);
    }

    // One-time debug log for the first confirmed load (kept from original)
    if (kind === "confirmed" && toProcess.filter(t => t.kind === "confirmed").length === 0) {
      console.log(`[scraper] first departed load debug: ${JSON.stringify({
        id:     loadObj.id,
        name:   loadObj.name,
        status: loadObj.status,
        lm:     loadObj.lm,
        groups: Array.isArray(loadObj.groups) ? loadObj.groups.slice(0, 1) : loadObj.groups,
        slots:  Array.isArray(loadObj.slots)  ? loadObj.slots.slice(0, 2)  : loadObj.slots,
      })}`);
    }

    const burble_load_id = String(loadObj.id);

    // "G-CKSE 15" → aircraft="G-CKSE", load_number=15
    const nameParts   = (loadObj.name || "").split(" ");
    const load_number = parseInt(nameParts[nameParts.length - 1]) || 0;
    const aircraft    = loadObj.aircraft_name
                     || nameParts.slice(0, -1).join(" ")
                     || "";

    const lm          = loadObj.lm;
    const load_master = typeof lm === "string" ? lm
                      : (lm?.name || lm?.display_name || null);

    const jumpers = parseJumpers(loadObj);

    toProcess.push({
      kind,
      load: {
        burble_load_id,
        load_number,
        aircraft,
        load_master,
        date:               today,
        departed_at:        new Date().toISOString(),
        confirmed_departed: kind === "confirmed" ? 1 : 0,
      },
      jumpers,
    });
  }

  let saved = 0, upgraded = 0;

  for (const { kind, load, jumpers } of toProcess) {
    // If newly confirmed, upgrade any existing unconfirmed record first.
    if (kind === "confirmed") {
      if (confirmDeparted(load.burble_load_id)) {
        upgraded++;
        console.log(
          `[scraper] confirmed load #${load.load_number} (${load.aircraft}) — was unconfirmed`
        );
      }
    }

    if (saveDepartedLoad(load, jumpers)) {
      saved++;
      const label = kind === "confirmed" ? "departed" : "slots ≤0 (unconfirmed)";
      console.log(
        `[scraper] saved load #${load.load_number} (${load.aircraft}) ` +
        `[${label}] – ${jumpers.length} jumpers`
      );
    }
  }

  if (toProcess.length > 0 && saved === 0 && upgraded === 0) {
    console.log(`[scraper] ${toProcess.length} load(s) already in DB`);
  } else if (toProcess.length === 0) {
    console.log(`[scraper] no captured loads visible`);
  }

  return saved > 0 || upgraded > 0;
}

// ── smart scheduler ───────────────────────────────────────────────────────────

let lastActivityAt = 0;

function nextInterval(foundActivity) {
  if (foundActivity) lastActivityAt = Date.now();

  if (isDaytime()) return ACTIVE_MS;

  const boosted = Date.now() - lastActivityAt < BOOST_TTL;
  return boosted ? BOOST_MS : NIGHT_MS;
}

function modeLabel() {
  if (isDaytime()) return "daytime";
  if (Date.now() - lastActivityAt < BOOST_TTL) return "night-boost";
  return "night";
}

async function tick() {
  const found = await scrape();
  const delay = nextInterval(found);
  const mins  = (delay / 60_000).toFixed(1);
  console.log(`[scraper] next check in ${mins} min (${modeLabel()}, tz: ${DZ.tz})`);
  setTimeout(tick, delay);
}

export function startScraper() {
  const { sunriseMin, sunsetMin } = getSolarWindow();
  const fmt = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  console.log(
    `[scraper] starting for DZ ${DZ.id} (tz: ${DZ.tz}, lat: ${DZ.lat}, lon: ${DZ.lon})\n` +
    `[scraper] solar window today: ${fmt(sunriseMin)} – ${fmt(sunsetMin)} | ` +
    `daytime every ${ACTIVE_MS / 1000}s | night ${NIGHT_MS / 60_000} min`
  );
  tick();
}
