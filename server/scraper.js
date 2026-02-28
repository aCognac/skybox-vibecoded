import axios from "axios";
import * as cheerio from "cheerio";
import { saveDepartedLoad } from "./db.js";

const DZ_ID = process.env.DZ_ID || "2351";
const MANIFEST_URL = `https://dzm.burblesoft.eu/jmp?dz_id=${DZ_ID}`;
const INTERVAL_MS = (parseInt(process.env.SCRAPE_INTERVAL_MINS) || 10) * 60_000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Cache-Control": "no-cache",
};

// ── parsing ───────────────────────────────────────────────────────────────────

function parseDate($) {
  // " - Saturday, February, 2026"  →  "2026-02-28"
  const raw = $(".dt-date").text().trim().replace(/^-\s*/, "");
  const d = new Date(raw);
  if (isNaN(d)) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function parseLoads($, date) {
  const results = [];

  $("[id^='jumpermanifest-load-']").each((_i, el) => {
    const $load = $(el);

    // ── status: only process departed loads ───────────────────────────────
    const statusText = $load.find(".load-info-mins").text().trim();
    if (statusText.toLowerCase() !== "departed") return;

    // ── burble internal load id ───────────────────────────────────────────
    const burble_load_id = el.attribs.id.replace("jumpermanifest-load-", "");

    // ── load header: aircraft & load number ──────────────────────────────
    const $headerTds = $load.find(".load-toolbar table td");
    const aircraft = $headerTds.eq(0).find("span").first().text().trim();
    const load_number = parseInt(
      $headerTds.eq(0).find(".load-info-big b").first().text().trim()
    );

    // ── load master ───────────────────────────────────────────────────────
    const load_master =
      $load.find(".ex-info td div[style*='float']").text().trim() || null;

    // ── jumpers ───────────────────────────────────────────────────────────
    const jumpers = [];
    $load.find("table.is-sj, table.is-student").each((_j, row) => {
      const $tds = $(row).find("tr td");
      if (!$tds.length) return;

      const cells = $tds
        .map((_k, td) => $(td).text().replace(/\u00a0/g, "").trim())
        .get();

      const name = cells[0];
      if (!name) return;

      // Column layout varies: 5-col (no group) vs 6-col (with group)
      let type, group_name, formation, rig;
      if (cells.length >= 6) {
        // 6-col: name | type | group | formation | rig | [img]
        [, type, group_name, formation, rig] = cells;
      } else {
        // 5-col: name | type | formation | rig | [img]
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

    results.push({
      load: {
        burble_load_id,
        load_number,
        aircraft,
        load_master,
        date,
        departed_at: new Date().toISOString(),
      },
      jumpers,
    });
  });

  return results;
}

// ── scrape ────────────────────────────────────────────────────────────────────

export async function scrape() {
  let html;
  try {
    const res = await axios.get(MANIFEST_URL, { headers: HEADERS, timeout: 15_000 });
    html = res.data;
  } catch (err) {
    console.error(`[scraper] fetch failed: ${err.message}`);
    return;
  }

  const $ = cheerio.load(html);
  const date = parseDate($);
  const departed = parseLoads($, date);

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
}

// ── scheduler ─────────────────────────────────────────────────────────────────

export function startScraper() {
  console.log(`[scraper] starting – interval ${INTERVAL_MS / 60_000} min`);
  scrape(); // run immediately on start
  setInterval(scrape, INTERVAL_MS);
}
