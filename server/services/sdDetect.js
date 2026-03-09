import { exec } from "child_process";
import { EventEmitter } from "events";

export const sdEvents = new EventEmitter();

const POLL_MS = 2000;

// Map of deviceName → device info for currently-mounted USB partitions
const knownDevices = new Map();

// ── Linux (Pi) ────────────────────────────────────────────────────────────────

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

async function getMountedDevicesLinux() {
  const { blockdevices } = await runLsblk();
  return extractUsbMountpoints(blockdevices);
}

// ── macOS (dev) ───────────────────────────────────────────────────────────────

function runDiskutil() {
  return new Promise((resolve, reject) => {
    exec("diskutil list -plist external", (err, stdout) => {
      if (err) return reject(err);
      // Parse the plist AllDisksAndPartitions array
      // We only need the disk identifiers; mount info comes from diskutil info
      const matches = [...stdout.matchAll(/<string>(disk\d+s\d+)<\/string>/g)];
      resolve(matches.map((m) => m[1]));
    });
  });
}

function runDiskutilInfo(disk) {
  return new Promise((resolve, reject) => {
    exec(`diskutil info -plist ${disk}`, (err, stdout) => {
      if (err) return reject(err);
      const get = (key) => {
        const m = stdout.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
        return m ? m[1] : null;
      };
      const getBool = (key) => {
        const m = stdout.match(new RegExp(`<key>${key}</key>\\s*<(true|false)/>`));
        return m ? m[1] === "true" : false;
      };
      resolve({
        deviceName: disk,
        mountPoint: get("MountPoint"),
        label: get("VolumeName") || disk,
        size: get("TotalSize"),
        removable: getBool("Removable") || getBool("RemovableMediaOrExternalDevice"),
      });
    });
  });
}

async function getMountedDevicesMac() {
  const partitions = await runDiskutil();
  const infos = await Promise.all(partitions.map((d) => runDiskutilInfo(d).catch(() => null)));
  return infos.filter((d) => d && d.mountPoint && d.removable);
}

// ── platform dispatcher ───────────────────────────────────────────────────────

const IS_MAC = process.platform === "darwin";
const getMountedDevices = IS_MAC ? getMountedDevicesMac : getMountedDevicesLinux;

async function poll() {
  try {
    const current = await getMountedDevices();
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
    if (!poll._warned) {
      console.warn(`[sdDetect] SD detection error (${process.platform}): ${err.message}`);
      poll._warned = true;
    }
  }

  setTimeout(poll, POLL_MS);
}

export function startSdDetect() {
  console.log(`[sdDetect] starting SD card detection via ${IS_MAC ? "diskutil (macOS)" : "lsblk (Linux)"}, polling every 2s`);
  poll();
}

export function getCurrentDevices() {
  return Array.from(knownDevices.values());
}
