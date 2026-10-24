import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { object, safeLabel } from "./parser.js";
import type { OmpMonitorScope } from "./types.js";
import type { OmpMonitorPreferences } from "./view-types.js";

export const MAX_MONITOR_ORBS = 8;
const MAX_PREFERENCES_BYTES = 128 * 1024;
export const DEFAULT_MONITOR_PREFERENCES: Readonly<OmpMonitorPreferences> = Object.freeze({
  appearance: "system",
  effects: "standard",
  language: "system",
  redline: 2000,
  style: "led",
  titleTheme: "vehicles",
  size: 148,
  opacity: 1,
  pinned: true,
  clickThrough: false,
  fadeWhenIdle: false,
  nameMode: "auto",
});
const CHOICES: Record<string, Readonly<Record<string, true>>> = {
  appearance: { system: true, dark: true, light: true },
  effects: { off: true, soft: true, standard: true, max: true },
  language: { system: true, en: true, zh: true },
  style: { led: true, needle: true, liquid: true, reactor: true, minimal: true },
  titleTheme: {
    vehicles: true,
    animals: true,
    wind: true,
    space: true,
    cultivation: true,
    wuxia: true,
    mage: true,
    gameRank: true,
    engineer: true,
  },
  nameMode: { auto: true, always: true, never: true },
};
const NUMBERS: Record<string, readonly [number, number]> = {
  redline: [50, 2000],
  size: [64, 240],
  opacity: [0.4, 1],
};
const BOOLEANS: Readonly<Record<string, true>> = {
  pinned: true,
  clickThrough: true,
  fadeWhenIdle: true,
};
export const GLOBAL_MONITOR_KEYS = ["appearance", "effects", "language", "redline"] as const;

export interface MonitorPosition {
  x: number;
  y: number;
}
export interface MonitorOrbRecord {
  id: string;
  scope: OmpMonitorScope;
  preferences: OmpMonitorPreferences;
  visible: boolean;
  positions: Record<string, MonitorPosition>;
}
export interface MonitorPreferencesDocument {
  orbs: MonitorOrbRecord[];
  invalid: boolean;
}

/** Original DESIGN/HeatMath defaults and ranges, adapted from Agent Speed v1.4.1. */
export function configureMonitorPreferences(
  patch: unknown,
  current: OmpMonitorPreferences,
): OmpMonitorPreferences {
  const source = object(patch);
  if (!source || Object.keys(source).length > 14) throw new Error("Invalid monitor preferences");
  const result = { ...current };
  const output = result as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(CHOICES, key)) {
      if (typeof value !== "string" || !Object.hasOwn(CHOICES[key]!, value))
        throw new Error("Invalid monitor preferences");
    } else if (Object.hasOwn(NUMBERS, key)) {
      const [minimum, maximum] = NUMBERS[key]!;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum
      )
        throw new Error("Invalid monitor preferences");
    } else if (!Object.hasOwn(BOOLEANS, key) || typeof value !== "boolean") {
      throw new Error("Invalid monitor preferences");
    }
    output[key] = value;
  }
  result.size = Math.max(result.style === "minimal" ? 64 : 96, Math.round(result.size));
  result.redline = Math.round(result.redline / 50) * 50;
  return result;
}

function scopePart(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && safeLabel(value, "") === value);
}
function readPositions(value: unknown): Record<string, MonitorPosition> {
  const source = object(value);
  if (!source || Object.keys(source).length > 16) throw new Error("Invalid monitor layout");
  const positions: Record<string, MonitorPosition> = Object.create(null);
  for (const [key, candidate] of Object.entries(source)) {
    const point = object(candidate);
    if (
      !key ||
      key.length > 512 ||
      !point ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      Math.abs(point.x) > 1_000_000 ||
      Math.abs(point.y) > 1_000_000
    )
      throw new Error("Invalid monitor layout");
    positions[key] = { x: Math.round(point.x), y: Math.round(point.y) };
  }
  return positions;
}
function readOrb(value: unknown): MonitorOrbRecord {
  const entry = object(value);
  const scope = object(entry?.scope);
  if (
    !entry ||
    typeof entry.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(entry.id) ||
    !scope ||
    !scopePart(scope.profile) ||
    !scopePart(scope.project) ||
    typeof entry.visible !== "boolean"
  )
    throw new Error("Invalid monitor orb");
  return {
    id: entry.id,
    scope: { profile: scope.profile, project: scope.project },
    preferences: configureMonitorPreferences(entry.preferences, { ...DEFAULT_MONITOR_PREFERENCES }),
    visible: entry.visible,
    positions: readPositions(entry.positions),
  };
}
function readDocument(documentValue: unknown): MonitorOrbRecord[] {
  const document = object(documentValue);
  if (
    !document ||
    document.version !== 1 ||
    !Array.isArray(document.orbs) ||
    document.orbs.length > MAX_MONITOR_ORBS
  )
    throw new Error("Invalid monitor preferences");
  const ids = new Set<string>();
  const records: MonitorOrbRecord[] = [];
  for (const value of document.orbs) {
    const orb = readOrb(value);
    if (ids.has(orb.id)) throw new Error("Repeated monitor identity");
    ids.add(orb.id);
    records.push(orb);
  }
  if (records.length)
    for (const orb of records)
      for (const key of GLOBAL_MONITOR_KEYS)
        Object.assign(orb.preferences, { [key]: records[0]!.preferences[key] });
  return records;
}

export async function readMonitorPreferences(file: string): Promise<MonitorPreferencesDocument> {
  let handle;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PREFERENCES_BYTES)
      throw new Error("Invalid monitor preferences file");
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error("Replaced monitor preferences file");
    const bytes = Buffer.alloc(MAX_PREFERENCES_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    if (size > MAX_PREFERENCES_BYTES) throw new Error("Oversized monitor preferences");
    return {
      orbs: readDocument(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
      ),
      invalid: false,
    };
  } catch (error) {
    return { orbs: [], invalid: !(object(error)?.code === "ENOENT") };
  } finally {
    await handle?.close();
  }
}

export async function writeMonitorPreferences(
  file: string,
  records: readonly MonitorOrbRecord[],
  preserveInvalid: boolean,
): Promise<void> {
  const content = JSON.stringify({ version: 1, orbs: records });
  if (Buffer.byteLength(content, "utf8") > MAX_PREFERENCES_BYTES)
    throw new Error("Monitor preferences limit reached");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (preserveInvalid) {
      try {
        await rename(file, `${file}.invalid-${randomUUID()}`);
      } catch (error) {
        if (object(error)?.code !== "ENOENT") throw error;
      }
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
