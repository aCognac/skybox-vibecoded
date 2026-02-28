import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
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

function parseDate($) {
  const raw = $(".dt-date").text().trim().replace(/^-\s*/, "");
  const d = new Date(raw);
  if (isNaN(d)) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Parse a single load's HTML fragment. Returns null if not departed. */
function parseLoadFragment(html, loadObj, date) {
  const $ = cheerio.load(html);

  const statusText = $(".load-info-mins").first().text().trim();
  if (statusText.toLowerCase() !== "departed") return null;

  const $headerTds = $(".load-toolbar table td");
  const aircraft    = $headerTds.eq(0).find("span").first().text().trim();
  const load_number = parseInt($headerTds.eq(0).find(".load-info-big b").first().text().trim());
  const load_master = $(".ex-info td div[style*='float']").text().trim() || null;

  // Prefer a load ID from the JSON object, fall back to the HTML element ID
  const htmlId = $("[id^='jumpermanifest-load-']").first().attr("id");
  const burble_load_id =
    String(loadObj?.id ?? loadObj?.load_id ?? "").replace("jumpermanifest-load-", "") ||
    (htmlId ? htmlId.replace("jumpermanifest-load-", "") : String(Date.now()));

  const jumpers = [];
  $("table.is-sj, table.is-student").each((_j, row) => {
    const $tds = $(row).find("tr td");
    if (!$tds.length) return;

    const cells = $tds
      .map((_k, td) => $(td).text().replace(/\u00a0/g, "").trim())
      .get();

    const name = cells[0];
    if (!name) return;

    let type, group_name, formation, rig;
    if (cells.length >= 6) {
      [, type, group_name, formation, rig] = cells;
    } else {
      [, type, formation, rig] = cells;
      group_name = "";
    }

    jumpers.push({
      name,
      type:       type       || null,
      group_name: group_name || null,
      formation:  formation  || null,
      rig:        rig        || null,
    });
  });

  return {
    load: { burble_load_id, load_number, aircraft, load_master, date, departed_at: new Date().toISOString() },
    jumpers,
  };
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
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer":      "https://eu-displays.burblesoft.eu/jmp",
        "Accept":       "application/json, text/javascript, */*; q=0.01",
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

  // Debug: log the structure of the first load object on the first run
  if (apiLoads.length > 0 && typeof apiLoads[0] === "object") {
    const keys = Object.keys(apiLoads[0]);
    console.log(`[scraper] load[0] keys: ${keys.join(", ")}`);
    console.log(`[scraper] load[0] preview: ${JSON.stringify(apiLoads[0]).slice(0, 300)}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const departed = [];

  for (const loadObj of apiLoads) {
    // Extract the HTML fragment from the load object.
    // Try common property names, then fall back to any string property with HTML.
    let html = "";
    if (typeof loadObj === "string") {
      html = loadObj;
    } else {
      for (const key of ["html", "content", "data", "response", "body"]) {
        if (typeof loadObj[key] === "string" && loadObj[key].includes("<")) {
          html = loadObj[key];
          break;
        }
      }
      if (!html) {
        for (const val of Object.values(loadObj)) {
          if (typeof val === "string" && val.includes("<div") && val.length > 200) {
            html = val;
            break;
          }
        }
      }
    }

    if (!html) continue;

    const result = parseLoadFragment(html, loadObj, today);
    if (result) departed.push(result);
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
