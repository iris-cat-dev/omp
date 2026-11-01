// Agent Speed v1.6.1 (MIT), frozen 384ce020cc655133e95aaad5cc085f3985f0ed99.
// Windows Presentation/Titles/{CustomTitleSet,TitleText,EmojiRanges,TitleThemesDocument,
// TitleThemesJson,TitleThemeEditing,TitleTheme}.cs and Titles/TitleThemesService.cs.
// The selected theme stays in windows.json; this owned store persists only the literal custom sets.
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const TITLE_THEMES_FILE_NAME = "titles-v161.json";
export const MAX_CUSTOM_TITLE_THEMES = 8;
export const TITLE_LEVEL_COUNT = 13;
export const TITLE_NAME_LIMIT = 32;
export const TITLE_GRAPHEME_LIMIT = 24;
export const TITLE_MAXIMUM_WIDTH = 51.5;
export const TITLE_COMFORTABLE_WIDTH = 44.2;
export const TITLE_UNDO_MS = 8_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_TEXT_READ = 4096;
const MAX_ELEMENTS_READ = 64;

export const TITLE_PRESET_IDS = [
  "vehicles",
  "animals",
  "wind",
  "space",
  "cultivation",
  "wuxia",
  "mage",
  "gameRank",
  "engineer",
] as const;
export type OmpTitlePresetId = (typeof TITLE_PRESET_IDS)[number];
export type OmpTitleThemeId = OmpTitlePresetId | `custom:${string}`;
export type OmpTitleLanguage = "en" | "zh";
export const TITLE_PRESET_NAMES: Readonly<Record<OmpTitlePresetId, readonly [string, string]>> = {
  vehicles: ["交通工具", "Vehicles"],
  animals: ["动物", "Animals"],
  wind: ["蒲福风级", "Beaufort Scale"],
  space: ["宇宙", "Cosmos"],
  cultivation: ["修真境界", "Cultivation"],
  wuxia: ["武学境界", "Martial Arts"],
  mage: ["魔法位阶", "Arcane Ranks"],
  gameRank: ["游戏段位", "Game Ranks"],
  engineer: ["工程师生涯", "Engineer Career"],
};

// Exact sorted Unicode ranges used by Windows EmojiRanges.cs, not a browser-version-dependent emoji property.
export const TITLE_EMOJI_PRESENTATION_RANGES: readonly number[] = [
  0x231a, 0x231b, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
  0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5,
  0x26fa, 0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c,
  0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf,
  0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e,
  0x1f18e, 0x1f191, 0x1f19a, 0x1f1e6, 0x1f1ff, 0x1f201, 0x1f201, 0x1f21a, 0x1f21a, 0x1f22f, 0x1f22f,
  0x1f232, 0x1f236, 0x1f238, 0x1f23a, 0x1f250, 0x1f251, 0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337,
  0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4,
  0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550,
  0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5,
  0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d8, 0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4,
  0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff,
  0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa8a, 0x1fa8e, 0x1fac6, 0x1fac8, 0x1fac8, 0x1facd, 0x1fadc, 0x1fadf,
  0x1faea, 0x1faef, 0x1faf8,
];
export const TITLE_EMOJI_RANGES: readonly number[] = [
  0x23, 0x23, 0x2a, 0x2a, 0x30, 0x39, 0xa9, 0xa9, 0xae, 0xae, 0x203c, 0x203c, 0x2049, 0x2049,
  0x2122, 0x2122, 0x2139, 0x2139, 0x2194, 0x2199, 0x21a9, 0x21aa, 0x231a, 0x231b, 0x2328, 0x2328,
  0x23cf, 0x23cf, 0x23e9, 0x23f3, 0x23f8, 0x23fa, 0x24c2, 0x24c2, 0x25aa, 0x25ab, 0x25b6, 0x25b6,
  0x25c0, 0x25c0, 0x25fb, 0x25fe, 0x2600, 0x2604, 0x260e, 0x260e, 0x2611, 0x2611, 0x2614, 0x2615,
  0x2618, 0x2618, 0x261d, 0x261d, 0x2620, 0x2620, 0x2622, 0x2623, 0x2626, 0x2626, 0x262a, 0x262a,
  0x262e, 0x262f, 0x2638, 0x263a, 0x2640, 0x2640, 0x2642, 0x2642, 0x2648, 0x2653, 0x265f, 0x2660,
  0x2663, 0x2663, 0x2665, 0x2666, 0x2668, 0x2668, 0x267b, 0x267b, 0x267e, 0x267f, 0x2692, 0x2697,
  0x2699, 0x2699, 0x269b, 0x269c, 0x26a0, 0x26a1, 0x26a7, 0x26a7, 0x26aa, 0x26ab, 0x26b0, 0x26b1,
  0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26c8, 0x26c8, 0x26ce, 0x26cf, 0x26d1, 0x26d1, 0x26d3, 0x26d4,
  0x26e9, 0x26ea, 0x26f0, 0x26f5, 0x26f7, 0x26fa, 0x26fd, 0x26fd, 0x2702, 0x2702, 0x2705, 0x2705,
  0x2708, 0x270d, 0x270f, 0x270f, 0x2712, 0x2712, 0x2714, 0x2714, 0x2716, 0x2716, 0x271d, 0x271d,
  0x2721, 0x2721, 0x2728, 0x2728, 0x2733, 0x2734, 0x2744, 0x2744, 0x2747, 0x2747, 0x274c, 0x274c,
  0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2763, 0x2764, 0x2795, 0x2797, 0x27a1, 0x27a1,
  0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2934, 0x2935, 0x2b05, 0x2b07, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50,
  0x2b55, 0x2b55, 0x3030, 0x3030, 0x303d, 0x303d, 0x3297, 0x3297, 0x3299, 0x3299, 0x1f004, 0x1f004,
  0x1f0cf, 0x1f0cf, 0x1f170, 0x1f171, 0x1f17e, 0x1f17f, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f1e6,
  0x1f1ff, 0x1f201, 0x1f202, 0x1f21a, 0x1f21a, 0x1f22f, 0x1f22f, 0x1f232, 0x1f23a, 0x1f250, 0x1f251,
  0x1f300, 0x1f321, 0x1f324, 0x1f393, 0x1f396, 0x1f397, 0x1f399, 0x1f39b, 0x1f39e, 0x1f3f0, 0x1f3f3,
  0x1f3f5, 0x1f3f7, 0x1f4fd, 0x1f4ff, 0x1f53d, 0x1f549, 0x1f54e, 0x1f550, 0x1f567, 0x1f56f, 0x1f570,
  0x1f573, 0x1f57a, 0x1f587, 0x1f587, 0x1f58a, 0x1f58d, 0x1f590, 0x1f590, 0x1f595, 0x1f596, 0x1f5a4,
  0x1f5a5, 0x1f5a8, 0x1f5a8, 0x1f5b1, 0x1f5b2, 0x1f5bc, 0x1f5bc, 0x1f5c2, 0x1f5c4, 0x1f5d1, 0x1f5d3,
  0x1f5dc, 0x1f5de, 0x1f5e1, 0x1f5e1, 0x1f5e3, 0x1f5e3, 0x1f5e8, 0x1f5e8, 0x1f5ef, 0x1f5ef, 0x1f5f3,
  0x1f5f3, 0x1f5fa, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cb, 0x1f6d2, 0x1f6d5, 0x1f6d8, 0x1f6dc, 0x1f6e5,
  0x1f6e9, 0x1f6e9, 0x1f6eb, 0x1f6ec, 0x1f6f0, 0x1f6f0, 0x1f6f3, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0,
  0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa8a,
  0x1fa8e, 0x1fac6, 0x1fac8, 0x1fac8, 0x1facd, 0x1fadc, 0x1fadf, 0x1faea, 0x1faef, 0x1faf8,
];
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const spaceScalar = /^[\p{Zs}\u0085]$/u;
const removedScalar = /^[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]$/u;
function isTitleSpace(scalar: string): boolean {
  const point = scalar.codePointAt(0)!;
  return (point >= 0x09 && point <= 0x0d) || spaceScalar.test(scalar);
}
function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}
function rangeContains(ranges: readonly number[], point: number): boolean {
  let low = 0,
    high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (point < ranges[middle * 2]!) high = middle - 1;
    else if (point > ranges[middle * 2 + 1]!) low = middle + 1;
    else return true;
  }
  return false;
}
export function isColorTitleEmoji(grapheme: string): boolean {
  let variation = false,
    emoji = false;
  for (const scalar of grapheme) {
    const point = scalar.codePointAt(0)!;
    if (rangeContains(TITLE_EMOJI_PRESENTATION_RANGES, point)) return true;
    variation ||= point === 0xfe0f || point === 0x20e3;
    emoji ||= rangeContains(TITLE_EMOJI_RANGES, point);
  }
  return variation && emoji;
}
export function sanitizeTitleText(
  value: string | null | undefined,
  limit = TITLE_GRAPHEME_LIMIT,
): { text: string; removedEmoji: boolean } {
  let scalars = "",
    lastSpace = true;
  for (const raw of (value ?? "").slice(0, MAX_TEXT_READ).normalize("NFC")) {
    const scalar =
      raw.length === 1 && raw.charCodeAt(0) >= 0xd800 && raw.charCodeAt(0) <= 0xdfff
        ? "\uFFFD"
        : raw;
    if (isTitleSpace(scalar)) {
      if (!lastSpace) scalars += " ";
      lastSpace = true;
    } else if (!removedScalar.test(scalar)) {
      scalars += scalar;
      lastSpace = false;
    }
  }
  let text = "",
    count = 0,
    removedEmoji = false;
  for (const element of graphemes(scalars)) {
    if (isColorTitleEmoji(element)) {
      removedEmoji = true;
      continue;
    }
    if (count >= limit) break;
    text += element;
    count++;
  }
  return { text: text.split(" ").filter(Boolean).join(" "), removedEmoji };
}
export function fitTitleText(
  text: string,
  measure: (text: string) => number,
  maximumWidth = TITLE_MAXIMUM_WIDTH,
): { text: string; cut: boolean } {
  if (!text) return { text, cut: false };
  const width = measure(text);
  if (!Number.isFinite(width) || width < 0) throw new Error("Invalid title measurement");
  if (width <= maximumWidth) return { text, cut: false };
  const elements = graphemes(text);
  let low = 0,
    high = elements.length;
  while (low < high) {
    const middle = (low + high + 1) >>> 1,
      measured = measure(elements.slice(0, middle).join(""));
    if (!Number.isFinite(measured) || measured < 0) throw new Error("Invalid title measurement");
    if (measured <= maximumWidth) low = middle;
    else high = middle - 1;
  }
  return { text: elements.slice(0, low).join("").trim(), cut: true };
}
export function isTitlePresetId(value: unknown): value is OmpTitlePresetId {
  return typeof value === "string" && (TITLE_PRESET_IDS as readonly string[]).includes(value);
}
export function isCustomTitleThemeId(value: unknown): value is `custom:${string}` {
  return (
    typeof value === "string" &&
    /^custom:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  );
}
export function isTitleThemeId(value: unknown): value is OmpTitleThemeId {
  return isTitlePresetId(value) || isCustomTitleThemeId(value);
}

export interface OmpCustomTitleTheme {
  id: `custom:${string}`;
  name: string;
  base: OmpTitlePresetId;
  idle: string;
  /** Exactly 13 overrides, level 1 first. Empty fields follow the base in the current language. */
  titles: string[];
}
export interface OmpTitleThemesDocument {
  version: 1;
  custom: OmpCustomTitleTheme[];
}
export interface OmpTitleThemeDraft {
  id: `custom:${string}`;
  level: number;
  text: string;
}
export interface OmpTitleThemesState extends OmpTitleThemesDocument {
  revision: number;
  draft: OmpTitleThemeDraft | null;
  undo: { kind: "delete" | "reset"; name: string; expiresAt: number } | null;
  /** No filesystem paths, exception details or previous documents cross the renderer boundary. */
  error: boolean;
}
export interface OmpTitlePresetText {
  name: readonly [string, string];
  en: readonly string[];
  zh: readonly string[];
}
export interface OmpResolvedTitleTheme {
  id: OmpTitleThemeId;
  base: OmpTitlePresetId;
  name: string;
  texts: string[];
  labels: string[];
  showsVehicleArt: boolean;
  custom: OmpCustomTitleTheme | null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function readString(value: unknown): string {
  return typeof value === "string" && value.length <= MAX_TEXT_READ ? value : "";
}
function copySet(set: OmpCustomTitleTheme): OmpCustomTitleTheme {
  return { id: set.id, name: set.name, base: set.base, idle: set.idle, titles: [...set.titles] };
}
function writeTitleField(set: OmpCustomTitleTheme, level: number, text: string): void {
  if (level === 0) set.idle = text;
  else set.titles[level - 1] = text;
}
function copySetWithDraft(
  original: OmpCustomTitleTheme,
  draft: OmpTitleThemeDraft | null | undefined,
): OmpCustomTitleTheme {
  const custom = copySet(original);
  if (
    draft?.id === custom.id &&
    (draft.level === 0 || (draft.level >= 1 && draft.level <= TITLE_LEVEL_COUNT))
  )
    writeTitleField(custom, draft.level, sanitizeTitleText(draft.text).text);
  return custom;
}
/** Tolerant native read rules: inspect 64 elements, keep 8 usable unique sets, normalize all 14 fields. */
export function readTitleThemesDocument(value: unknown): OmpTitleThemesDocument {
  const source = record(value),
    custom: OmpCustomTitleTheme[] = [],
    seen = new Set<string>();
  if (Array.isArray(source?.custom))
    for (const candidate of source.custom.slice(0, MAX_ELEMENTS_READ)) {
      const set = record(candidate);
      if (!set || !isCustomTitleThemeId(set.id) || seen.has(set.id)) continue;
      seen.add(set.id);
      const titles = Array.from(
        { length: TITLE_LEVEL_COUNT },
        (_, index) =>
          sanitizeTitleText(readString(Array.isArray(set.titles) ? set.titles[index] : undefined))
            .text,
      );
      custom.push({
        id: set.id,
        name: sanitizeTitleText(readString(set.name), TITLE_NAME_LIMIT).text,
        base: isTitlePresetId(set.base) ? set.base : "vehicles",
        idle: sanitizeTitleText(readString(set.idle)).text,
        titles,
      });
      if (custom.length === MAX_CUSTOM_TITLE_THEMES) break;
    }
  return { version: 1, custom };
}
export function resolveSelectedTitleTheme(
  state: Pick<OmpTitleThemesState, "custom" | "draft"> | null | undefined,
  selected: unknown,
  presets: Readonly<Record<OmpTitlePresetId, OmpTitlePresetText>>,
  language: OmpTitleLanguage,
): OmpResolvedTitleTheme {
  const original = state?.custom.find((set) => set.id === selected) ?? null;
  const custom = original ? copySetWithDraft(original, state?.draft) : null;
  const base = custom?.base ?? (isTitlePresetId(selected) ? selected : "vehicles"),
    preset = presets[base];
  const texts = Array.from({ length: TITLE_LEVEL_COUNT + 1 }, (_, level) => {
    if (custom) {
      const text = level === 0 ? custom.idle : custom.titles[level - 1];
      if (text) return text;
    }
    return preset[language][level] || "";
  });
  const presetName = preset.name[language === "zh" ? 0 : 1];
  const name = custom ? custom.name || copyName(presetName, language) : presetName;
  return {
    id: custom?.id ?? base,
    base,
    name,
    texts,
    labels: language === "en" ? texts.map((text) => text.toUpperCase()) : [...texts],
    showsVehicleArt: base === "vehicles",
    custom,
  };
}
function copyName(name: string, language: OmpTitleLanguage): string {
  return language === "zh" ? `${name}（自定义）` : `${name} (Custom)`;
}
export function uniqueTitleThemeName(sets: readonly OmpCustomTitleTheme[], name: string): string {
  const clean = sanitizeTitleText(name, TITLE_NAME_LIMIT).text,
    taken = new Set(sets.map((set) => set.name));
  if (!taken.has(clean)) return clean;
  for (let number = 2; ; number++) {
    const suffix = ` ${number}`,
      stem = sanitizeTitleText(clean, TITLE_NAME_LIMIT - suffix.length).text,
      candidate = stem + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export type OmpTitleThemeCommand =
  | { type: "copy"; sourceId: OmpTitleThemeId; language: OmpTitleLanguage }
  | { type: "rename"; id: `custom:${string}`; name: string }
  | { type: "setBase"; id: `custom:${string}`; base: OmpTitlePresetId }
  | {
      type: "setField";
      id: `custom:${string}`;
      level: number;
      text: string;
      language: OmpTitleLanguage;
    }
  | { type: "setDraft"; id: `custom:${string}`; level: number; text: string }
  | { type: "resetAll"; id: `custom:${string}` }
  | { type: "delete"; id: `custom:${string}` }
  | { type: "undo" }
  | { type: "dismissUndo" }
  | { type: "clearDraft" };
/** Null is the native per-orb “follow General” value, not a synthetic theme ID. */
export interface OmpTitleThemeReference {
  instanceId: string;
  themeId: OmpTitleThemeId | null;
}
/** Whitelist main-owned references without losing nullable overrides needed by exact delete Undo. */
export function normalizeTitleThemeReferences(value: unknown): OmpTitleThemeReference[] {
  const references: OmpTitleThemeReference[] = [],
    seen = new Set<string>();
  if (!Array.isArray(value)) return references;
  for (let index = 0; index < value.length && index < 8; index++) {
    const reference = record(value[index]);
    if (
      !reference ||
      typeof reference.instanceId !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(reference.instanceId) ||
      seen.has(reference.instanceId) ||
      (reference.themeId !== null && !isTitleThemeId(reference.themeId))
    )
      continue;
    seen.add(reference.instanceId);
    references.push({ instanceId: reference.instanceId, themeId: reference.themeId });
  }
  return references;
}
/** Main-owned context, never accepted from the renderer's command payload. */
export interface OmpTitleThemeContext {
  selected: string;
  references?: readonly OmpTitleThemeReference[];
}
export interface OmpTitleThemeResult {
  ok: boolean;
  state: OmpTitleThemesState;
  error?: "invalid" | "limit" | "missing" | "storage" | "expired";
  selected?: OmpTitleThemeId;
  referenceChanges?: OmpTitleThemeReference[];
  commit?: { text: string; removedEmoji: boolean; cut: boolean };
}
export interface OmpTitleThemesStoreOptions {
  onChange?: () => void;
  now?: () => number;
  /** Optional actual 7-DIP semibold measurement. The editor otherwise fits before SetField, as native Editing does. */
  measureTitle?: (text: string, language: OmpTitleLanguage) => number;
}
function validLevel(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= TITLE_LEVEL_COUNT
  );
}
function validText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_READ;
}
function validLanguage(value: unknown): value is OmpTitleLanguage {
  return value === "en" || value === "zh";
}
function readCustomTitleCommand(command: Record<string, unknown>): OmpTitleThemeCommand | null {
  const id = command.id;
  if (!isCustomTitleThemeId(id)) return null;
  switch (command.type) {
    case "rename":
      return validText(command.name) ? { type: "rename", id, name: command.name } : null;
    case "setBase":
      return isTitlePresetId(command.base) ? { type: "setBase", id, base: command.base } : null;
    case "setField":
      if (
        !validLevel(command.level) ||
        !validText(command.text) ||
        !validLanguage(command.language)
      )
        return null;
      return {
        type: "setField",
        id,
        level: command.level,
        text: command.text,
        language: command.language,
      };
    case "setDraft":
      if (!validLevel(command.level) || !validText(command.text)) return null;
      return { type: "setDraft", id, level: command.level, text: command.text };
    case "resetAll":
      return { type: "resetAll", id };
    case "delete":
      return { type: "delete", id };
    default:
      return null;
  }
}
function readTitleCommand(command: Record<string, unknown>): OmpTitleThemeCommand | null {
  switch (command.type) {
    case "copy":
      if (!isTitleThemeId(command.sourceId) || !validLanguage(command.language)) return null;
      return { type: "copy", sourceId: command.sourceId, language: command.language };
    case "undo":
      return { type: "undo" };
    case "dismissUndo":
      return { type: "dismissUndo" };
    case "clearDraft":
      return { type: "clearDraft" };
    default:
      return readCustomTitleCommand(command);
  }
}
/** Reject unknown keys rather than forwarding arbitrary renderer objects or file paths. */
export function parseTitleThemeCommand(value: unknown): OmpTitleThemeCommand | null {
  const command = record(value);
  if (!command || typeof command.type !== "string") return null;
  const parsed = readTitleCommand(command);
  if (!parsed) return null;
  const keys = Object.keys(parsed);
  if (
    Object.keys(command).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(command, key))
  )
    return null;
  return parsed;
}
function assertTitleFileIdentity(before: Stats, checked: Stats): void {
  if (
    !checked.isFile() ||
    checked.dev !== before.dev ||
    checked.ino !== before.ino ||
    checked.size !== before.size ||
    checked.birthtimeMs !== before.birthtimeMs
  )
    throw new Error("Title file changed");
}
interface TitleUndo {
  kind: "delete" | "reset";
  name: string;
  expiresAt: number;
  before: OmpCustomTitleTheme[];
  selected: OmpTitleThemeId;
  references: OmpTitleThemeReference[] | null;
}
type PersistentTitleCommand = Exclude<
  OmpTitleThemeCommand,
  { type: "setDraft" | "dismissUndo" | "clearDraft" }
>;
type TitleMutationError = NonNullable<OmpTitleThemeResult["error"]>;
interface TitleMutationContext {
  selected: OmpTitleThemeId;
  references: OmpTitleThemeReference[];
}
interface TitleMutation {
  next: OmpCustomTitleTheme[];
  undo: TitleUndo | null;
  output: Omit<OmpTitleThemeResult, "ok" | "state">;
}

/** One trusted directory, one fixed file, one mutation queue. A failed save never publishes a successful edit. */
export class OmpTitleThemesStore {
  private custom: OmpCustomTitleTheme[] = [];
  private draft: OmpTitleThemeDraft | null = null;
  private undo: TitleUndo | null = null;
  private revision = 0;
  private error = false;
  private disposed = false;
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private undoTimer: NodeJS.Timeout | undefined;
  private readonly root: string;
  private readonly fileName: string;
  private readonly now: () => number;
  constructor(
    localMonitorDir: string,
    private readonly options: OmpTitleThemesStoreOptions = {},
  ) {
    if (!path.isAbsolute(localMonitorDir))
      throw new Error("Title themes require an owned absolute monitor directory");
    this.root = path.resolve(localMonitorDir);
    this.fileName = path.join(this.root, TITLE_THEMES_FILE_NAME);
    this.now = options.now ?? Date.now;
  }
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.enqueue(async () => {
      if (this.disposed) return;
      try {
        const document = await this.readDocument();
        if (!this.disposed) this.custom = document.custom;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = true;
      }
      if (!this.disposed) this.changed();
    });
    return this.loading;
  }
  private async readDocument(): Promise<OmpTitleThemesDocument> {
    let file: FileHandle | undefined;
    try {
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Invalid title directory");
      const before = await lstat(this.fileName);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DOCUMENT_BYTES)
        throw new Error("Invalid title file");
      file = await open(this.fileName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const checked = await file.stat();
      assertTitleFileIdentity(before, checked);
      const bytes = Buffer.alloc(checked.size),
        read = await file.read(bytes, 0, bytes.length, 0),
        after = await file.stat();
      if (
        read.bytesRead !== bytes.length ||
        after.size !== checked.size ||
        after.mtimeMs !== checked.mtimeMs ||
        after.ctimeMs !== checked.ctimeMs
      )
        throw new Error("Title file changed");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!record(value)) throw new Error("Invalid title document");
      return readTitleThemesDocument(value);
    } finally {
      await file?.close().catch(() => {});
    }
  }
  state(): OmpTitleThemesState {
    this.expireUndo();
    return {
      version: 1,
      revision: this.revision,
      custom: this.custom.map(copySet),
      draft: this.draft ? { ...this.draft } : null,
      undo: this.undo
        ? { kind: this.undo.kind, name: this.undo.name, expiresAt: this.undo.expiresAt }
        : null,
      error: this.error,
    };
  }
  async execute(value: unknown, context: OmpTitleThemeContext): Promise<OmpTitleThemeResult> {
    await this.load();
    const command = parseTitleThemeCommand(value);
    if (!command) return this.failure("invalid");
    // Capture only whitelisted main-process reference facts before yielding to the serialized mutation.
    const selected = isTitleThemeId(context.selected) ? context.selected : "vehicles";
    const references = normalizeTitleThemeReferences(context.references);
    return this.enqueue(() => this.apply(command, { selected, references }));
  }
  dispose(): void {
    this.disposed = true;
    this.clearUndoTimer();
    this.draft = null;
    this.undo = null;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  private failure(error: NonNullable<OmpTitleThemeResult["error"]>): OmpTitleThemeResult {
    return { ok: false, state: this.state(), error };
  }
  private changed(): void {
    this.revision++;
    this.options.onChange?.();
  }
  private clearUndoTimer(): void {
    clearTimeout(this.undoTimer);
    this.undoTimer = undefined;
  }
  private expireUndo(): boolean {
    if (!this.undo || this.undo.expiresAt > this.now()) return false;
    this.undo = null;
    this.clearUndoTimer();
    return true;
  }
  private offerUndo(undo: TitleUndo): void {
    this.clearUndoTimer();
    this.undo = undo;
    this.undoTimer = setTimeout(
      () => {
        this.undoTimer = undefined;
        if (!this.disposed && this.expireUndo()) this.changed();
      },
      Math.max(1, undo.expiresAt - this.now()),
    );
    this.undoTimer.unref?.();
  }
  private async apply(
    command: OmpTitleThemeCommand,
    context: TitleMutationContext,
  ): Promise<OmpTitleThemeResult> {
    if (this.disposed) return this.failure("storage");
    this.expireUndo();
    if (command.type === "dismissUndo" || command.type === "clearDraft")
      return this.clearTransient(command.type);
    if (command.type === "setDraft") return this.setDraft(command);
    const mutation: TitleMutation = {
      next: this.custom.map(copySet),
      undo: null,
      output: {},
    };
    const error = this.prepareMutation(command, context, mutation);
    if (error) return this.failure(error);
    return this.commitMutation(command, mutation);
  }
  private clearTransient(type: "dismissUndo" | "clearDraft"): OmpTitleThemeResult {
    const changed = type === "dismissUndo" ? this.undo !== null : this.draft !== null;
    if (type === "dismissUndo") {
      this.undo = null;
      this.clearUndoTimer();
    } else this.draft = null;
    if (changed) this.changed();
    return { ok: true, state: this.state() };
  }
  private setDraft(
    command: Extract<OmpTitleThemeCommand, { type: "setDraft" }>,
  ): OmpTitleThemeResult {
    if (!this.custom.some((set) => set.id === command.id)) return this.failure("missing");
    const next = {
      id: command.id,
      level: command.level,
      text: sanitizeTitleText(command.text).text,
    };
    if (
      this.draft?.id !== next.id ||
      this.draft.level !== next.level ||
      this.draft.text !== next.text
    ) {
      this.draft = next;
      this.changed();
    }
    return { ok: true, state: this.state() };
  }
  private prepareMutation(
    command: PersistentTitleCommand,
    context: TitleMutationContext,
    mutation: TitleMutation,
  ): TitleMutationError | null {
    if (command.type === "undo") return this.restoreUndo(mutation);
    if (command.type === "copy") return this.copyTheme(command, mutation);
    const set = mutation.next.find((candidate) => candidate.id === command.id);
    if (!set) return "missing";
    switch (command.type) {
      case "rename":
        set.name = sanitizeTitleText(command.name, TITLE_NAME_LIMIT).text || set.name;
        break;
      case "setBase":
        set.base = command.base;
        break;
      case "setField": {
        const commit = this.editField(set, command);
        if (!commit) return "invalid";
        mutation.output.commit = commit;
        break;
      }
      case "delete":
        this.deleteTheme(set, context, mutation);
        break;
      case "resetAll":
        if (set.idle || set.titles.some(Boolean)) {
          set.idle = "";
          set.titles.fill("");
          mutation.undo = {
            kind: "reset",
            name: set.name,
            before: this.custom.map(copySet),
            selected: context.selected,
            references: null,
            expiresAt: this.now() + TITLE_UNDO_MS,
          };
        }
        break;
    }
    return null;
  }
  private restoreUndo(mutation: TitleMutation): TitleMutationError | null {
    if (!this.undo) return "expired";
    mutation.next = this.undo.before.map(copySet);
    mutation.output.selected = this.undo.selected;
    if (this.undo.references)
      mutation.output.referenceChanges = this.undo.references.map((reference) => ({
        ...reference,
      }));
    return null;
  }
  private copyTheme(
    command: Extract<OmpTitleThemeCommand, { type: "copy" }>,
    mutation: TitleMutation,
  ): TitleMutationError | null {
    if (mutation.next.length >= MAX_CUSTOM_TITLE_THEMES) return "limit";
    const source = mutation.next.find((set) => set.id === command.sourceId);
    let base: OmpTitlePresetId;
    if (source) base = source.base;
    else if (isTitlePresetId(command.sourceId)) base = command.sourceId;
    else return "missing";
    const presetName = TITLE_PRESET_NAMES[base][command.language === "zh" ? 0 : 1];
    const sourceName = source ? source.name || copyName(presetName, command.language) : presetName;
    const id = `custom:${randomUUID()}` as const;
    mutation.next.push({
      id,
      name: uniqueTitleThemeName(mutation.next, copyName(sourceName, command.language)),
      base,
      idle: source?.idle ?? "",
      titles: source ? [...source.titles] : Array<string>(TITLE_LEVEL_COUNT).fill(""),
    });
    mutation.output.selected = id;
    return null;
  }
  private editField(
    set: OmpCustomTitleTheme,
    command: Extract<OmpTitleThemeCommand, { type: "setField" }>,
  ): NonNullable<OmpTitleThemeResult["commit"]> | null {
    const clean = sanitizeTitleText(command.text),
      measure = this.options.measureTitle;
    let fitted = { text: clean.text, cut: false };
    try {
      if (measure)
        fitted = fitTitleText(clean.text, (text) =>
          measure(command.language === "en" ? text.toUpperCase() : text, command.language),
        );
    } catch {
      return null;
    }
    writeTitleField(set, command.level, fitted.text);
    return { ...fitted, removedEmoji: clean.removedEmoji };
  }
  private deleteTheme(
    set: OmpCustomTitleTheme,
    context: TitleMutationContext,
    mutation: TitleMutation,
  ): void {
    mutation.next = mutation.next.filter((candidate) => candidate.id !== set.id);
    if (context.selected === set.id) mutation.output.selected = set.base;
    mutation.output.referenceChanges = context.references
      .filter((reference) => reference.themeId === set.id)
      .map((reference) => ({ instanceId: reference.instanceId, themeId: set.base }));
    mutation.undo = {
      kind: "delete",
      name: set.name,
      before: this.custom.map(copySet),
      selected: context.selected,
      references: context.references.map((reference) => ({ ...reference })),
      expiresAt: this.now() + TITLE_UNDO_MS,
    };
  }
  private async commitMutation(
    command: PersistentTitleCommand,
    mutation: TitleMutation,
  ): Promise<OmpTitleThemeResult> {
    const changed = JSON.stringify(mutation.next) !== JSON.stringify(this.custom);
    if (changed) {
      try {
        await this.save(mutation.next);
      } catch {
        this.error = true;
        this.changed();
        return this.failure("storage");
      }
      this.custom = mutation.next;
      this.error = false;
    }
    const clearDraft =
      command.type === "setField" ||
      command.type === "delete" ||
      command.type === "resetAll" ||
      command.type === "undo";
    const draftChanged = clearDraft && this.draft !== null;
    if (clearDraft) this.draft = null;
    const clearUndo = command.type === "undo";
    if (clearUndo) {
      this.undo = null;
      this.clearUndoTimer();
    }
    if (mutation.undo) this.offerUndo({ ...mutation.undo, expiresAt: this.now() + TITLE_UNDO_MS });
    if (changed || draftChanged || clearUndo || mutation.undo) this.changed();
    return { ok: true, state: this.state(), ...mutation.output };
  }
  private async safeRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Invalid title directory");
    try {
      const target = await lstat(this.fileName);
      if (!target.isFile() || target.isSymbolicLink()) throw new Error("Invalid title file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async save(custom: OmpCustomTitleTheme[]): Promise<void> {
    const text = JSON.stringify({ version: 1, custom });
    if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES || this.disposed)
      throw new Error("Invalid title write");
    await this.safeRoot();
    const temporary = path.join(this.root, `${TITLE_THEMES_FILE_NAME}.${randomUUID()}.tmp`);
    let file: FileHandle | undefined;
    try {
      file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await file.writeFile(text, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      if (this.disposed) throw new Error("Title store disposed");
      await this.safeRoot();
      await rename(temporary, this.fileName);
    } finally {
      await file?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
