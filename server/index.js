import "dotenv/config";
import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { startScraper } from "./scraper.js";
import { getLoadsByDate, getLoadById, getDates } from "./db.js";

// ── log ring buffer ───────────────────────────────────────────────────────────

const LOG_RING = [];
const LOG_MAX  = 300;

function capture(level, args) {
  const ts  = new Date().toISOString();
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  LOG_RING.push({ ts, level, msg });
  if (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}

const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log   = (...a) => { _log(...a);  capture("info",  a); };
console.error = (...a) => { _err(...a);  capture("error", a); };

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── routes ───────────────────────────────────────────────────────────────────

/** GET /api/dates — list of days that have recorded loads */
app.get("/api/dates", (_req, res) => {
  res.json(getDates());
});

/** GET /api/loads?date=YYYY-MM-DD — all departed loads for a day */
app.get("/api/loads", (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json(getLoadsByDate(date));
});

/** GET /api/loads/:id — single load with full jumper list */
app.get("/api/loads/:id", (req, res) => {
  const load = getLoadById(Number(req.params.id));
  if (!load) return res.status(404).json({ error: "Not found" });
  res.json(load);
});

/** GET /health */
app.get("/health", (_req, res) => res.json({ status: "ok" }));

/** GET /api/logs — recent log ring buffer */
app.get("/api/logs", (_req, res) => res.json(LOG_RING));

// ── start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Skybox server listening on http://localhost:${PORT}`);
  startScraper();
});
