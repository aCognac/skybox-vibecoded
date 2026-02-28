#!/usr/bin/env python3
"""
Skybox RPi daemon — polls the server for the current state and drives the LED strip.
"""

import os
import sys
import time
import math
import signal
import logging
import requests
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ── config ──────────────────────────────────────────────────────────────────

SERVER_URL     = os.getenv("SERVER_URL", "http://localhost:3001")
LED_COUNT      = int(os.getenv("LED_COUNT", 60))
LED_PIN        = int(os.getenv("LED_PIN", 18))
LED_BRIGHTNESS = int(os.getenv("LED_BRIGHTNESS", 128))
POLL_INTERVAL  = float(os.getenv("POLL_INTERVAL", 0.1))

# ── LED driver (stub-safe) ───────────────────────────────────────────────────

try:
    from rpi_ws281x import PixelStrip, Color
    _HW = True
except ImportError:
    log.warning("rpi_ws281x not available — running in simulation mode")
    _HW = False

    class Color:  # noqa: D101
        def __new__(cls, r, g, b):
            return (r << 16) | (g << 8) | b

    class PixelStrip:  # noqa: D101
        def __init__(self, *a, **kw):
            self._n = a[0]
            self._buf = [0] * self._n
        def begin(self): pass
        def numPixels(self): return self._n
        def setPixelColor(self, i, c): self._buf[i] = c
        def show(self): pass
        def setBrightness(self, b): pass


strip = PixelStrip(LED_COUNT, LED_PIN, 800000, 5, False, LED_BRIGHTNESS, 0)
strip.begin()

# ── helpers ──────────────────────────────────────────────────────────────────

def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    r = int(lerp(c1[0], c2[0], t))
    g = int(lerp(c1[1], c2[1], t))
    b = int(lerp(c1[2], c2[2], t))
    return (r, g, b)

# ── scenes ───────────────────────────────────────────────────────────────────

def scene_solid(state: dict) -> None:
    r, g, b = hex_to_rgb(state.get("color", "#ffffff"))
    c = Color(r, g, b)
    for i in range(strip.numPixels()):
        strip.setPixelColor(i, c)
    strip.show()


def scene_gradient(state: dict) -> None:
    colors = state.get("colors", ["#ff6600", "#003366"])
    if len(colors) < 2:
        colors = ["#000000", "#ffffff"]
    c1 = hex_to_rgb(colors[0])
    c2 = hex_to_rgb(colors[-1])
    n = strip.numPixels()
    for i in range(n):
        t = i / max(n - 1, 1)
        r, g, b = lerp_color(c1, c2, t)
        strip.setPixelColor(i, Color(r, g, b))
    strip.show()


_pulse_phase = 0.0

def scene_pulse(state: dict) -> None:
    global _pulse_phase
    speed = float(state.get("speed", 1.0))
    r, g, b = hex_to_rgb(state.get("color", "#0088ff"))
    brightness = (math.sin(_pulse_phase) + 1) / 2
    cr = int(r * brightness)
    cg = int(g * brightness)
    cb = int(b * brightness)
    c = Color(cr, cg, cb)
    for i in range(strip.numPixels()):
        strip.setPixelColor(i, c)
    strip.show()
    _pulse_phase += speed * POLL_INTERVAL * 2 * math.pi


_rainbow_offset = 0

def scene_rainbow(state: dict) -> None:
    global _rainbow_offset
    speed = float(state.get("speed", 1.0))
    n = strip.numPixels()
    for i in range(n):
        hue = (i / n + _rainbow_offset) % 1.0
        r, g, b = _hsv_to_rgb(hue, 1.0, 1.0)
        strip.setPixelColor(i, Color(r, g, b))
    strip.show()
    _rainbow_offset = (_rainbow_offset + speed * POLL_INTERVAL * 0.1) % 1.0


def scene_off(_state: dict) -> None:
    for i in range(strip.numPixels()):
        strip.setPixelColor(i, Color(0, 0, 0))
    strip.show()


SCENES = {
    "solid":    scene_solid,
    "gradient": scene_gradient,
    "pulse":    scene_pulse,
    "rainbow":  scene_rainbow,
    "off":      scene_off,
}


def _hsv_to_rgb(h, s, v):
    if s == 0:
        rv = int(v * 255)
        return rv, rv, rv
    i = int(h * 6)
    f = h * 6 - i
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    i %= 6
    table = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]
    r, g, b = table[i]
    return int(r * 255), int(g * 255), int(b * 255)

# ── main loop ────────────────────────────────────────────────────────────────

_running = True

def _shutdown(sig, frame):
    global _running
    log.info("Shutting down...")
    _running = False

signal.signal(signal.SIGTERM, _shutdown)
signal.signal(signal.SIGINT, _shutdown)


def fetch_state() -> dict | None:
    try:
        resp = requests.get(f"{SERVER_URL}/api/state", timeout=2)
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        log.debug("fetch_state failed: %s", exc)
        return None


def main():
    log.info("Skybox daemon started — LED_COUNT=%d", LED_COUNT)
    last_state: dict | None = None
    fail_streak = 0

    while _running:
        state = fetch_state()

        if state is None:
            fail_streak += 1
            if fail_streak == 5:
                log.warning("Server unreachable — holding last scene")
        else:
            fail_streak = 0
            if state != last_state:
                log.info("State changed: scene=%s", state.get("scene", "?"))
                last_state = state

        if last_state:
            scene_fn = SCENES.get(last_state.get("scene", "solid"), scene_solid)
            try:
                scene_fn(last_state)
            except Exception as exc:  # noqa: BLE001
                log.error("Scene error: %s", exc)

        time.sleep(POLL_INTERVAL)

    scene_off({})
    log.info("LEDs cleared. Goodbye.")


if __name__ == "__main__":
    main()
