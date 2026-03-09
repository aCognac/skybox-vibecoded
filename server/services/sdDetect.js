import { exec } from "child_process";
import { EventEmitter } from "events";

export const sdEvents = new EventEmitter();

const POLL_MS = 2000;

// Map of deviceName → device info for currently-mounted USB partitions
const knownDevices = new Map();

function runLsblk() {
  return new Promise((resolve, reject) => {
    exec("lsblk -J -o NAME,MOUNTPOINT,LABEL,SIZE,TYPE,TRAN", (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`lsblk parse error: ${e.message}`));
      }
    });
  });
}

/** Flatten lsblk tree into a list of mounted USB partitions/disks. */
function extractUsbMountpoints(blockdevices) {
  const result = [];

  function walk(dev, parentTran) {
    const tran = dev.tran || parentTran;
    if (dev.mountpoint && tran === "usb") {
      result.push({
        deviceName: dev.name,
        mountPoint: dev.mountpoint,
        label: dev.label || dev.name,
        size: dev.size,
        type: dev.type,
      });
    }
    if (Array.isArray(dev.children)) {
      for (const child of dev.children) walk(child, tran);
    }
  }

  for (const dev of blockdevices) walk(dev, null);
  return result;
}

async function poll() {
  try {
    const { blockdevices } = await runLsblk();
    const current = extractUsbMountpoints(blockdevices);
    const currentMap = new Map(current.map((d) => [d.deviceName, d]));

    // New insertions
    for (const [name, dev] of currentMap) {
      if (!knownDevices.has(name)) {
        knownDevices.set(name, dev);
        console.log(`[sdDetect] inserted: ${name} at ${dev.mountPoint} (${dev.label})`);
        sdEvents.emit("inserted", dev);
      }
    }

    // Ejections
    for (const [name, dev] of knownDevices) {
      if (!currentMap.has(name)) {
        knownDevices.delete(name);
        console.log(`[sdDetect] removed: ${name}`);
        sdEvents.emit("removed", { deviceName: name, ...dev });
      }
    }
  } catch (err) {
    // lsblk unavailable (dev machine) — only log first time
    if (!poll._warned) {
      console.warn(`[sdDetect] lsblk unavailable, SD detection disabled: ${err.message}`);
      poll._warned = true;
    }
  }

  setTimeout(poll, POLL_MS);
}

export function startSdDetect() {
  console.log("[sdDetect] starting USB SD card detection (polling every 2s)");
  poll();
}

export function getCurrentDevices() {
  return Array.from(knownDevices.values());
}
