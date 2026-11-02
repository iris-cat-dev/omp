import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { object, safeLabel } from "./parser.js";
import type { OmpMonitorScope } from "./types.js";
import type { OmpMonitorPreferences, OmpMonitorTitleTheme } from "./view-types.js";
import { DEFAULT_BOARD_PREFERENCES, MAX_MONITOR_BOARDS } from "./board-types.js";
import type { OmpMonitorBoardPreferences, OmpMonitorBoardRecord } from "./board-types.js";
import { isCustomTitleThemeId, isTitleThemeId } from "./title-themes.js";
import { canonicalOmpSourcePath, regularDirectory } from "./roots.js";

export const MAX_MONITOR_ORBS = 8;
const EMPTY_TITLE_THEME_IDS: ReadonlySet<string> = new Set();
const MAX_PREFERENCES_BYTES = 128 * 1024;
const ORB_NAME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ORB_NAME_EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;
const ORB_NAME_END_SPACE = /\p{White_Space}+$/gu;
export const DEFAULT_MONITOR_PREFERENCES: Readonly<OmpMonitorPreferences> = Object.freeze({
  appearance: "system",
  effects: "standard",
  language: "system",
  metric: "output",
  liveUnit: "tokens",
  celebratePeaks: true,
  responsePulses: true,
  showOrbs: true,
  redline: 2000,
  redlineOutput: 2000,
  redlineTotal: 2_000_000,
  orbRedlineOutput: null,
  orbRedlineTotal: null,
  orbUnit: "tokens",
  style: "led",
  titleTheme: "vehicles",
  orbTitleTheme: null,
  size: 148,
  opacity: 1,
  pinned: true,
  clickThrough: false,
  fadeWhenIdle: false,
  nameMode: "auto",
  showName: "auto",
  orbName: null,
  showPerformance: false,
  showThinking: true,
});
const CHOICES: Record<string, Readonly<Record<string, true>>> = {
  appearance: { system: true, dark: true, light: true },
  effects: { off: true, soft: true, standard: true, max: true },
  language: { system: true, en: true, zh: true },
  metric: { output: true, total: true },
  liveUnit: { tokens: true, cost: true },
  orbUnit: { tokens: true, cost: true },
  style: { led: true, needle: true, liquid: true, reactor: true, minimal: true },
  nameMode: { auto: true, always: true, never: true },
  showName: { auto: true, on: true, off: true },
};
const NUMBERS: Record<string, readonly [number, number]> = {
  redlineOutput: [50, 2000],
  redlineTotal: [20_000, 2_000_000],
  orbRedlineOutput: [50, 2000],
  orbRedlineTotal: [20_000, 2_000_000],
  size: [64, 240],
  opacity: [0.4, 1],
};
const BOOLEANS: Readonly<Record<string, true>> = {
  pinned: true,
  clickThrough: true,
  fadeWhenIdle: true,
  showPerformance: true,
  showThinking: true,
  celebratePeaks: true,
  responsePulses: true,
  showOrbs: true,
};
export const GLOBAL_MONITOR_KEYS = [
  "appearance",
  "effects",
  "language",
  "redline",
  "redlineOutput",
  "redlineTotal",
  "metric",
  "liveUnit",
  "celebratePeaks",
  "responsePulses",
  "showOrbs",
  "nameMode",
  "titleTheme",
] as const;

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
  boards: OmpMonitorBoardRecord[];
  invalid: boolean;
}

export interface MonitorSourcePreferences {
  enabled: boolean;
  /** Null means the real environment-selected OMP default and its named profiles. */
  folder: string | null;
}
export interface MonitorSourcePreferencesDocument extends MonitorSourcePreferences {
  invalid: boolean;
}
const MAX_SOURCE_PREFERENCES_BYTES = 8 * 1024;

async function sourcePreferencesDirectory(file: string, create: boolean): Promise<void> {
  const directory = path.dirname(file);
  let current = directory;
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe monitor source preferences directory");
    } catch (error) {
      if (object(error)?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  else await lstat(directory);
  if (!(await regularDirectory(directory)))
    throw new Error("Monitor source preferences directory is unavailable");
}

function sourcePreferencesDocument(value: unknown): MonitorSourcePreferencesDocument {
  const document = object(value);
  if (
    !document ||
    document.version !== 1 ||
    typeof document.enabled !== "boolean" ||
    !Object.hasOwn(document, "folder") ||
    Object.keys(document).length !== 3
  )
    throw new Error("Invalid monitor source preferences");
  return {
    enabled: document.enabled,
    folder: document.folder === null ? null : canonicalOmpSourcePath(document.folder),
    invalid: false,
  };
}

/** Corrupt source settings fail closed; they must never silently enable real user roots. */
export async function readMonitorSourcePreferences(
  file: string,
): Promise<MonitorSourcePreferencesDocument> {
  let handle;
  try {
    await sourcePreferencesDirectory(file, false);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_PREFERENCES_BYTES)
      throw new Error("Invalid monitor source preferences file");
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error("Replaced monitor source preferences file");
    const bytes = Buffer.alloc(MAX_SOURCE_PREFERENCES_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    if (size > MAX_SOURCE_PREFERENCES_BYTES)
      throw new Error("Oversized monitor source preferences");
    return sourcePreferencesDocument(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
    );
  } catch (error) {
    if (object(error)?.code === "ENOENT") return { enabled: true, folder: null, invalid: false };
    return { enabled: false, folder: null, invalid: true };
  } finally {
    await handle?.close();
  }
}

export async function writeMonitorSourcePreferences(
  file: string,
  preferences: MonitorSourcePreferences,
  preserveInvalid: boolean,
): Promise<void> {
  if (typeof preferences.enabled !== "boolean")
    throw new Error("Invalid monitor source preference");
  const folder = preferences.folder === null ? null : canonicalOmpSourcePath(preferences.folder);
  const content = JSON.stringify({ version: 1, enabled: preferences.enabled, folder });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await sourcePreferencesDirectory(file, true);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Unsafe monitor source preferences file");
    } catch (error) {
      if (object(error)?.code !== "ENOENT") throw error;
    }
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await sourcePreferencesDirectory(file, false);
    if (preserveInvalid) {
      try {
        // Copy exclusively: moving the primary first would turn an interrupted repair into first use.
        await copyFile(file, `${file}.invalid-${randomUUID()}`, constants.COPYFILE_EXCL);
      } catch (error) {
        if (object(error)?.code !== "ENOENT") throw error;
      }
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function truncateOrbName(text: string, count: number): string {
  let seen = 0;
  for (const part of ORB_NAME_SEGMENTER.segment(text))
    if (seen++ === count) return text.slice(0, part.index);
  return text;
}

/** Native OrbDefinition.CleanName: controls become spaces; trim, then at most 32 text elements. */
export function cleanMonitorOrbName(value: string | null): string | null {
  if (value === null) return null;
  const clean = value
    .slice(0, 1024)
    .replace(/\p{Cc}/gu, " ")
    .replace(ORB_NAME_EDGE_SPACE, "");
  return truncateOrbName(clean, 32).replace(ORB_NAME_EDGE_SPACE, "") || null;
}

export function duplicateMonitorOrbName(value: string | null): string | null {
  const clean = cleanMonitorOrbName(value);
  return clean === null ? null : truncateOrbName(clean, 30).replace(ORB_NAME_END_SPACE, "") + " 2";
}

/** Per-orb overrides never replace the General metric's persisted redline. */
export function effectiveMonitorRedline(preferences: OmpMonitorPreferences): number {
  return (
    (preferences.metric === "total" ? preferences.orbRedlineTotal : preferences.orbRedlineOutput) ??
    preferences.redline
  );
}

export function effectiveMonitorTitleTheme(
  preferences: OmpMonitorPreferences,
): OmpMonitorTitleTheme {
  return preferences.orbTitleTheme ?? preferences.titleTheme;
}

function isMonitorPreferenceKey(key: string): key is keyof OmpMonitorPreferences {
  return Object.hasOwn(DEFAULT_MONITOR_PREFERENCES, key);
}

function inPreferenceRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function validNumericPreference(key: string, value: unknown): boolean {
  if ((key === "orbRedlineOutput" || key === "orbRedlineTotal") && value === null) return true;
  const [minimum, maximum] = NUMBERS[key]!;
  return inPreferenceRange(value, minimum, maximum);
}

function requireTitleThemePreference(
  key: string,
  value: unknown,
  customTitleThemeIds: ReadonlySet<string>,
): void {
  if (key === "orbTitleTheme" && value === null) return;
  if (!isTitleThemeId(value) || (isCustomTitleThemeId(value) && !customTitleThemeIds.has(value)))
    throw new Error("Unknown monitor title theme");
}

function requireMonitorPreference<K extends keyof OmpMonitorPreferences>(
  key: K,
  value: unknown,
  metric: unknown,
  customTitleThemeIds: ReadonlySet<string>,
): asserts value is OmpMonitorPreferences[K] {
  if (key === "titleTheme" || key === "orbTitleTheme") {
    requireTitleThemePreference(key, value, customTitleThemeIds);
  } else if (key === "redline") {
    const minimum = metric === "total" ? 20_000 : 50;
    const maximum = metric === "total" ? 2_000_000 : 2000;
    if (!inPreferenceRange(value, minimum, maximum)) throw new Error("Invalid monitor redline");
  } else if (Object.hasOwn(CHOICES, key)) {
    if (typeof value !== "string" || !Object.hasOwn(CHOICES[key]!, value))
      throw new Error("Invalid monitor preferences");
  } else if (Object.hasOwn(NUMBERS, key)) {
    if (!validNumericPreference(key, value)) throw new Error("Invalid monitor preferences");
  } else if (!Object.hasOwn(BOOLEANS, key) || typeof value !== "boolean") {
    throw new Error("Invalid monitor preferences");
  }
}

function applyMonitorPreference<K extends keyof OmpMonitorPreferences>(
  result: OmpMonitorPreferences,
  key: K,
  value: unknown,
  metric: unknown,
  customTitleThemeIds: ReadonlySet<string>,
): void {
  if (key === "orbName") {
    if (value !== null && typeof value !== "string") throw new Error("Invalid monitor orb name");
    result.orbName = cleanMonitorOrbName(value);
    return;
  }
  requireMonitorPreference(key, value, metric, customTitleThemeIds);
  result[key] = value;
}

/** Original Agent Speed v1.6.1 preferences; omitted keys keep the previous default. */
export function configureMonitorPreferences(
  patch: unknown,
  current: OmpMonitorPreferences,
  customTitleThemeIds: ReadonlySet<string> = EMPTY_TITLE_THEME_IDS,
): OmpMonitorPreferences {
  const source = object(patch);
  if (!source || Object.keys(source).length > Object.keys(DEFAULT_MONITOR_PREFERENCES).length)
    throw new Error("Invalid monitor preferences");
  const metric = source.metric ?? current.metric;
  const result = { ...current };
  for (const [key, value] of Object.entries(source)) {
    if (!isMonitorPreferenceKey(key)) throw new Error("Invalid monitor preferences");
    applyMonitorPreference(result, key, value, metric, customTitleThemeIds);
  }
  result.size = Math.max(result.style === "minimal" ? 64 : 96, Math.round(result.size));
  result.redlineOutput = Math.round(result.redlineOutput / 50) * 50;
  const totalStep = 10 ** (Math.floor(Math.log10(result.redlineTotal)) - 1);
  result.redlineTotal = Math.round(result.redlineTotal / totalStep) * totalStep;
  if (result.orbRedlineOutput !== null)
    result.orbRedlineOutput = Math.round(result.orbRedlineOutput / 50) * 50;
  if (result.orbRedlineTotal !== null) {
    const step = 10 ** (Math.floor(Math.log10(result.orbRedlineTotal)) - 1);
    result.orbRedlineTotal = Math.round(result.orbRedlineTotal / step) * step;
  }
  if (Object.hasOwn(source, "redline")) {
    if (result.metric === "total") {
      const step = 10 ** (Math.floor(Math.log10(result.redline)) - 1);
      result.redlineTotal = Math.round(result.redline / step) * step;
    } else result.redlineOutput = Math.round(result.redline / 50) * 50;
  }
  result.redline = result.metric === "total" ? result.redlineTotal : result.redlineOutput;
  return result;
}

export function configureMonitorBoard(
  patch: unknown,
  current: OmpMonitorBoardPreferences,
): OmpMonitorBoardPreferences {
  const source = object(patch);
  if (!source || Object.keys(source).length > 7)
    throw new Error("Invalid monitor board preferences");
  const result = { ...current };
  for (const [key, value] of Object.entries(source)) {
    if (key === "style") {
      if (value !== "glass" && value !== "timing" && value !== "neon")
        throw new Error("Invalid monitor board style");
      result.style = value;
    } else if (key === "size") {
      if (value !== "small" && value !== "medium" && value !== "large")
        throw new Error("Invalid monitor board size");
      result.size = value;
    } else if (
      key === "showPerformance" ||
      key === "showThinking" ||
      key === "showCost" ||
      key === "pinned" ||
      key === "clickThrough"
    ) {
      if (typeof value !== "boolean") throw new Error("Invalid monitor board preference");
      result[key] = value;
    } else {
      throw new Error("Unknown monitor board preference");
    }
  }
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
/** Read legacy files without accepting the retired key in live configuration or writing it back. */
function migratePerformancePreference(value: unknown): unknown {
  const source = object(value);
  if (!source || !Object.hasOwn(source, "showTaskScore")) return value;
  const { showTaskScore: legacy, ...preferences } = source;
  if (!Object.hasOwn(preferences, "showPerformance")) preferences.showPerformance = legacy;
  return preferences;
}

function readOrb(value: unknown, customTitleThemeIds: ReadonlySet<string>): MonitorOrbRecord {
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
  const sourcePreferences = object(migratePerformancePreference(entry.preferences));
  const preferences = sourcePreferences ? { ...sourcePreferences } : null;
  if (preferences) {
    // Existing independently selected themes become explicit overrides, not silent General-following changes.
    if (!Object.hasOwn(preferences, "orbTitleTheme"))
      preferences.orbTitleTheme = isTitleThemeId(preferences.titleTheme)
        ? preferences.titleTheme
        : null;
    if (
      isCustomTitleThemeId(preferences.titleTheme) &&
      !customTitleThemeIds.has(preferences.titleTheme)
    )
      preferences.titleTheme = "vehicles";
    if (
      isCustomTitleThemeId(preferences.orbTitleTheme) &&
      !customTitleThemeIds.has(preferences.orbTitleTheme)
    )
      preferences.orbTitleTheme = null;
  }
  return {
    id: entry.id,
    scope: { profile: scope.profile, project: scope.project },
    preferences: configureMonitorPreferences(
      preferences,
      { ...DEFAULT_MONITOR_PREFERENCES },
      customTitleThemeIds,
    ),
    visible: entry.visible,
    positions: readPositions(entry.positions),
  };
}
function readBoard(value: unknown, orbIds: ReadonlySet<string>): OmpMonitorBoardRecord {
  const entry = object(value);
  if (
    !entry ||
    typeof entry.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(entry.id) ||
    typeof entry.orbId !== "string" ||
    !orbIds.has(entry.orbId) ||
    typeof entry.visible !== "boolean"
  )
    throw new Error("Invalid monitor board");
  const preferences = configureMonitorBoard(
    {
      style: entry.style,
      size: entry.size,
      showPerformance: Object.hasOwn(entry, "showPerformance")
        ? entry.showPerformance
        : entry.showTaskScore,
      showThinking: entry.showThinking,
      showCost: entry.showCost,
      pinned: entry.pinned,
      clickThrough: entry.clickThrough,
    },
    DEFAULT_BOARD_PREFERENCES,
  );
  return {
    ...preferences,
    id: entry.id,
    orbId: entry.orbId,
    visible: entry.visible,
    positions: readPositions(entry.positions),
  };
}

function readDocument(
  documentValue: unknown,
  customTitleThemeIds: ReadonlySet<string>,
): Pick<MonitorPreferencesDocument, "orbs" | "boards"> {
  const document = object(documentValue);
  if (
    !document ||
    (document.version !== 1 && document.version !== 2) ||
    !Array.isArray(document.orbs) ||
    document.orbs.length > MAX_MONITOR_ORBS
  )
    throw new Error("Invalid monitor preferences");
  const ids = new Set<string>();
  const records: MonitorOrbRecord[] = [];
  for (const value of document.orbs) {
    const orb = readOrb(value, customTitleThemeIds);
    if (ids.has(orb.id)) throw new Error("Repeated monitor identity");
    ids.add(orb.id);
    records.push(orb);
  }
  if (records.length)
    for (const orb of records)
      for (const key of GLOBAL_MONITOR_KEYS)
        Object.assign(orb.preferences, { [key]: records[0]!.preferences[key] });
  const boards: OmpMonitorBoardRecord[] = [];
  if (document.version === 2) {
    if (!Array.isArray(document.boards) || document.boards.length > MAX_MONITOR_BOARDS)
      throw new Error("Invalid monitor boards");
    const boardIds = new Set<string>();
    for (const value of document.boards) {
      const board = readBoard(value, ids);
      if (boardIds.has(board.id)) throw new Error("Repeated monitor board identity");
      boardIds.add(board.id);
      boards.push(board);
    }
  }
  return { orbs: records, boards };
}

export async function readMonitorPreferences(
  file: string,
  customTitleThemeIds: ReadonlySet<string> = EMPTY_TITLE_THEME_IDS,
): Promise<MonitorPreferencesDocument> {
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
      ...readDocument(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
        customTitleThemeIds,
      ),
      invalid: false,
    };
  } catch (error) {
    return {
      orbs: [],
      boards: [],
      invalid: (error as NodeJS.ErrnoException | null)?.code !== "ENOENT",
    };
  } finally {
    await handle?.close();
  }
}

export async function writeMonitorPreferences(
  file: string,
  records: readonly MonitorOrbRecord[],
  preserveInvalid: boolean,
  boards: readonly OmpMonitorBoardRecord[],
): Promise<void> {
  const content = JSON.stringify({ version: 2, orbs: records, boards });
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
