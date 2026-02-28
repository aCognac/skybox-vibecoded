const BASE = "/api";

export async function fetchState() {
  const res = await fetch(`${BASE}/state/full`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function patchState(update) {
  const res = await fetch(`${BASE}/state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resetState() {
  const res = await fetch(`${BASE}/state/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
