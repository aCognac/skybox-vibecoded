import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// ── in-memory state ──────────────────────────────────────────────────────────

/** @type {SkyboxState} */
let state = {
  scene: "solid",
  color: "#ffffff",
  colors: ["#ff6600", "#003366"],
  speed: 1.0,
  brightness: 128,
  on: true,
};

// ── routes ───────────────────────────────────────────────────────────────────

/** GET /api/state — RPi polls this */
app.get("/api/state", (_req, res) => {
  res.json(state.on ? state : { ...state, scene: "off" });
});

/** GET /api/state/full — webapp polls this */
app.get("/api/state/full", (_req, res) => {
  res.json(state);
});

/** PUT /api/state — webapp pushes updates */
app.put("/api/state", (req, res) => {
  const allowed = ["scene", "color", "colors", "speed", "brightness", "on"];
  const update = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "No valid fields in body" });
  }

  state = { ...state, ...update };
  res.json(state);
});

/** PATCH /api/state — partial field update */
app.patch("/api/state", (req, res) => {
  const allowed = ["scene", "color", "colors", "speed", "brightness", "on"];
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) state[k] = v;
  }
  res.json(state);
});

/** POST /api/state/reset */
app.post("/api/state/reset", (_req, res) => {
  state = {
    scene: "solid",
    color: "#ffffff",
    colors: ["#ff6600", "#003366"],
    speed: 1.0,
    brightness: 128,
    on: true,
  };
  res.json(state);
});

// ── health ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Skybox server listening on http://localhost:${PORT}`);
});
