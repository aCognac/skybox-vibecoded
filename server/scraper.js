import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { saveDepartedLoad } from "./db.js";

// ── DZ config ─────────────────────────────────────────────────────────────────
// Future: replace with an array of DZ configs loaded from env / a config file.

const DZ = {
  id: process.env.DZ_ID || "2351",
  tz: process.env.DZ_TZ || "Europe/Brussels",
};

const BASE_URL = "https://dzm.burblesoft.eu";
const PAGE_URL = `${BASE_URL}/jmp?dz_id=${DZ.id}`;
const API_URL  = "https://eu-displays.burblesoft.eu/ajax_dzm2_frontend_jumpermanifestpublic";

// ── schedule constants ────────────────────────────────────────────────────────

const ACTIVE_MS  = 30_000;         // 30 s   — daytime
const NIGHT_MS   = 30  * 60_000;  // 30 min — quiet night
const BOOST_MS   = 30_000;         // 30 s   — night-boost after finding a load
const BOOST_TTL  = 30  * 60_000;  // keep boost 30 min after last activity

// Active window in local DZ time: 09:00 – 18:30
const ACTIVE_START_MIN = 9 * 60;        // 540
const ACTIVE_END_MIN   = 18 * 60 + 30; // 1110

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

/** Minutes since midnight in the DZ's local timezone. */
function dzMinuteOfDay() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DZ.tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  return h * 60 + m;
}

function isDaytime() {
  const m = dzMinuteOfDay();
  return m >= ACTIVE_START_MIN && m < ACTIVE_END_MIN;
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
  const departed = [];

  for (const loadObj of apiLoads) {
    if (loadObj.status?.toLowerCase() !== "departed") continue;

    // One-time debug log: show groups/slots structure of the first departed load
    if (departed.length === 0) {
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

    departed.push({
      load: {
        burble_load_id,
        load_number,
        aircraft,
        load_master,
        date:        today,
        departed_at: new Date().toISOString(),
      },
      jumpers,
    });
  }

  let saved = 0;
  for (const { load, jumpers } of departed) {
    if (saveDepartedLoad(load, jumpers)) {
      saved++;
      console.log(
        `[scraper] saved load #${load.load_number} (${load.aircraft}) ` +
        `– ${jumpers.length} jumpers`
      );
    }
  }

  if (departed.length > 0 && saved === 0) {
    console.log(`[scraper] ${departed.length} departed load(s) already in DB`);
  } else if (departed.length === 0) {
    console.log(`[scraper] no departed loads visible`);
  }

  return saved > 0;
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
  const mins  = delay / 60_000;
  console.log(`[scraper] next check in ${mins} min (${modeLabel()}, tz: ${DZ.tz})`);
  setTimeout(tick, delay);
}

export function startScraper() {
  console.log(
    `[scraper] starting for DZ ${DZ.id} (tz: ${DZ.tz}) — ` +
    `daytime ${ACTIVE_MS / 60_000} min | ` +
    `night ${NIGHT_MS / 60_000} min | ` +
    `night-boost ${BOOST_MS / 60_000} min`
  );
  tick();
}
