import { isSyntaxThemeId, type SyntaxThemeId } from "@omp-desktop/highlight";
import type { ActiveTurnBehavior } from "@omp-desktop/protocol/messages";
import type { QueryClient } from "@tanstack/react-query";
import type { DesktopSettings } from "@/desktop/settings/desktop-settings";
import { parseAppLanguage, type AppLanguage } from "@/i18n/locales";
import {
  DEFAULT_SIDEBAR_CHECKS_DISPLAY,
  parseSidebarChecksDisplay,
  type SidebarChecksDisplay,
} from "@/components/sidebar/display-preferences/checks-display";
import {
  DEFAULT_SIDEBAR_ROW_ITEMS,
  isChecksHiddenByLegacyRowItem,
  parseSidebarRowItems,
  type SidebarRowItems,
} from "@/components/sidebar/display-preferences/row-items";
import { isNative } from "@/constants/platform";
import {
  DEFAULT_RELAY_SERVER_ADDRESS,
  formatRelayServerAddress,
  parseRelayServerAddress,
} from "@/utils/daemon-endpoints";
import {
  FONT_SIZE,
  PLUGIN_THEME_PREFERENCE,
  THEME_OPTIONS,
  type ThemePreference,
} from "@/styles/theme";
import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import { APP_SETTINGS_KEY, LEGACY_SETTINGS_KEY } from "./keys";
import { migrateAppSettings } from "./migrations";

export { APP_SETTINGS_KEY } from "./keys";
export const APP_SETTINGS_QUERY_KEY = ["app-settings"];

export type SendBehavior = ActiveTurnBehavior | "queue";
export type ReleaseChannel = "stable" | "beta";
export type ToolCallDetailLevel = "overview" | "detailed";

const ThemePreferenceSchema = z.enum([
  ...THEME_OPTIONS.map((option) => option.name),
  PLUGIN_THEME_PREFERENCE,
]);
const VALID_THEMES = new Set<string>(ThemePreferenceSchema.options);
/** Where the theme picker lands when the persisted preference cannot be honoured. */
export const DEFAULT_THEME_PREFERENCE = "dark" satisfies ThemePreference;
const VALID_TOOL_CALL_DETAIL_LEVELS = new Set<ToolCallDetailLevel>(["overview", "detailed"]);
export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 10_000;
export const MIN_TERMINAL_SCROLLBACK_LINES = 0;
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000;
export function defaultUiBaseFontSize(_native: boolean): number {
  return 13;
}

export const DEFAULT_UI_BASE_FONT_SIZE = defaultUiBaseFontSize(isNative);
export const MIN_UI_BASE_FONT_SIZE = 10;
export const MAX_UI_BASE_FONT_SIZE = 21;
// `uiFontSize` scaled the pre-v0.4 14px interface tier; keep migrations stable
// when the current authored default changes.
const LEGACY_UI_BASE_FONT_SIZE = 14;
export function defaultContentFontSize(native: boolean): number {
  return native ? 15 : FONT_SIZE.content;
}

export const DEFAULT_CONTENT_FONT_SIZE = defaultContentFontSize(isNative);
export const MIN_CONTENT_FONT_SIZE = 10;
export const MAX_CONTENT_FONT_SIZE = 21;
export const DEFAULT_CODE_FONT_SIZE = FONT_SIZE.code;
export const MIN_CODE_FONT_SIZE = 9;
export const MAX_CODE_FONT_SIZE = 22; // line-height 1.5×22=33 stays safe
export const MAX_FONT_FAMILY_LENGTH = 200;

export interface AppSettings {
  theme: ThemePreference;
  /** Which contributed theme `theme: "plugin"` selects. */
  pluginThemeId: string | null;
  language: AppLanguage;
  sendBehavior: SendBehavior;
  /** Relay used when adding a host; users may clear it to trust each pairing offer. */
  relayServerAddress: string;
  terminalScrollbackLines: number;
  useLegacyTerminalRenderer: boolean;
  uiFontFamily: string; // "" = platform default UI stack
  monoFontFamily: string; // "" = platform default mono stack
  uiBaseFontSize: number; // clamped px, default 13
  contentFontSize: number; // clamped px, default 14 (15 on native)
  codeFontSize: number; // clamped px, default 13
  syntaxTheme: SyntaxThemeId; // default "cursor"
  sidebarRowItems: SidebarRowItems;
  sidebarChecksDisplay: SidebarChecksDisplay;
  autoExpandReasoning: boolean;
  toolCallDetailLevel: ToolCallDetailLevel;
  chatOutlineEnabled: boolean;
  homeAnimationsEnabled: boolean;
  vimKeybindings: boolean;
  wallpaperEnabled: boolean;
  wallpaperSource: "none" | "file" | "url";
  wallpaperCandidateId: string | null;
  wallpaperUrl: string | null;
  wallpaperOpacity: number;
}

export interface Settings extends AppSettings {
  manageBuiltInDaemon: boolean;
  releaseChannel: ReleaseChannel;
}

// Strict, so every item in SIDEBAR_ROW_ITEMS needs a key here the day it is added: the whole
// settings write is one validation, and one unknown key silently loses every other toggle in it.
// `checks` and `scripts` are gone from the item list and stay here for the COMPAT reads in
// row-items.ts.
const SidebarRowItemsSchema = z.strictObject({
  branch: z.boolean().optional(),
  project: z.boolean().optional(),
  host: z.boolean().optional(),
  changeRequest: z.boolean().optional(),
  services: z.boolean().optional(),
  labels: z.boolean().optional(),
  checks: z.boolean().optional(),
  scripts: z.boolean().optional(),
});

const StoredAppSettingsSchema = z.strictObject({
  theme: ThemePreferenceSchema.optional(),
  pluginThemeId: z.string().nullish(),
  language: z
    .enum(["system", "ar", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"])
    .optional(),
  sendBehavior: z.enum(["interrupt", "steer", "queue"]).optional(),
  // COMPAT(serviceUrlBehavior): tolerate any retired value without invalidating other settings.
  serviceUrlBehavior: z.unknown().optional(),
  relayServerAddress: z.string().optional(),
  terminalScrollbackLines: z.union([z.number(), z.string()]).optional(),
  useLegacyTerminalRenderer: z.boolean().optional(),
  uiFontFamily: z.string().optional(),
  monoFontFamily: z.string().optional(),
  uiBaseFontSize: z.union([z.number(), z.string()]).optional(),
  contentFontSize: z.union([z.number(), z.string()]).optional(),
  // COMPAT(uiFontSizeScale): replaced by the literal base size in v0.4, remove after 2027-08-17.
  uiFontSize: z.union([z.number(), z.string()]).optional(),
  codeFontSize: z.union([z.number(), z.string()]).optional(),
  syntaxTheme: z.string().refine(isSyntaxThemeId).optional(),
  // COMPAT(sidebarDisplay): retired choices are ignored and removed on the next read.
  workspaceTitleSource: z.unknown().optional(),
  sidebarWorkspaceTrailing: z.unknown().optional(),
  sidebarRowItems: SidebarRowItemsSchema.optional(),
  sidebarChecksDisplay: z.enum(["iconAndText", "icon", "none"]).optional(),
  autoExpandReasoning: z.boolean().optional(),
  toolCallDetailLevel: z.enum(["overview", "detailed"]).optional(),
  compactToolCalls: z.boolean().optional(),
  chatOutlineEnabled: z.boolean().optional(),
  homeAnimationsEnabled: z.boolean().optional(),
  vimKeybindings: z.boolean().optional(),
  wallpaperEnabled: z.boolean().optional(),
  wallpaperSource: z.enum(["none", "file", "url"]).optional(),
  // Normalize a corrupt local identity independently; it must not discard URL or other settings.
  wallpaperCandidateId: z.unknown().optional(),
  wallpaperPath: z.unknown().optional(),
  wallpaperUrl: z.string().nullish(),
  wallpaperOpacity: z.union([z.number(), z.string()]).optional(),
  wallpaperDir: z.unknown().optional(),
  // COMPAT(sidePanelRouting): ignored since the right pane became tool-only; remove after 2027-03-04.
  openSupportingTabsInSidePanel: z.boolean().optional(),
  // COMPAT(rendererDesktopSettings): these fields used to share this renderer-owned key.
  manageBuiltInDaemon: z.boolean().optional(),
  releaseChannel: z.enum(["stable", "beta"]).optional(),
});

const LegacyRendererSettingsSchema = StoredAppSettingsSchema;

type StoredAppSettings = z.infer<typeof StoredAppSettingsSchema>;

export const DEFAULT_CLIENT_SETTINGS: AppSettings = {
  theme: DEFAULT_THEME_PREFERENCE,
  pluginThemeId: null,
  language: "system",
  sendBehavior: "steer",
  relayServerAddress: DEFAULT_RELAY_SERVER_ADDRESS,
  terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
  useLegacyTerminalRenderer: false,
  uiFontFamily: "",
  monoFontFamily: "",
  uiBaseFontSize: DEFAULT_UI_BASE_FONT_SIZE,
  contentFontSize: DEFAULT_CONTENT_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  syntaxTheme: "cursor",
  sidebarRowItems: DEFAULT_SIDEBAR_ROW_ITEMS,
  sidebarChecksDisplay: DEFAULT_SIDEBAR_CHECKS_DISPLAY,
  autoExpandReasoning: false,
  toolCallDetailLevel: "detailed",
  chatOutlineEnabled: true,
  homeAnimationsEnabled: true,
  vimKeybindings: false,
  wallpaperEnabled: false,
  wallpaperSource: "none",
  wallpaperCandidateId: null,
  wallpaperUrl: null,
  wallpaperOpacity: 0.85,
};

export const DEFAULT_APP_SETTINGS: Settings = {
  ...DEFAULT_CLIENT_SETTINGS,
  manageBuiltInDaemon: true,
  releaseChannel: "stable",
};
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface DesktopSettingsBridge {
  isElectron(): boolean;
  loadDesktopSettings(): Promise<DesktopSettings>;
  migrateLegacyDesktopSettings(input: {
    manageBuiltInDaemon?: boolean;
    releaseChannel?: ReleaseChannel;
  }): Promise<void>;
}

export interface SettingsDeps {
  storage: KeyValueStorage;
  desktop: DesktopSettingsBridge;
  wallpaper?: {
    importLegacy(input: { directory: string | null; path: string | null }): Promise<{
      candidateId: string | null;
      reason: string | null;
    }>;
  };
}
const appSettingsSaveTails = new WeakMap<KeyValueStorage, Promise<void>>();
const pendingWallpaperInputs = new WeakMap<
  KeyValueStorage,
  {
    wallpaperDir?: unknown;
    wallpaperPath?: unknown;
  }
>();

function serializeAppSettings(settings: AppSettings, storage: KeyValueStorage): string {
  const pending = pendingWallpaperInputs.get(storage);
  if (!pending) return JSON.stringify(settings);
  const { wallpaperCandidateId: _candidateId, ...rest } = settings;
  return JSON.stringify({ ...rest, ...pending });
}

interface SaveAppSettingsInput {
  queryClient: QueryClient;
  updates: Partial<AppSettings>;
  deps: SettingsDeps;
}

async function runQueuedAppSettingsSave(
  input: SaveAppSettingsInput,
  previous: Promise<void>,
): Promise<void> {
  try {
    await previous;
  } catch {
    // A failed write must not prevent the next user change from being persisted.
  }
  const storedCurrent =
    input.queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage({ ...input.deps, wallpaper: undefined }));
  const current = normalizeAppSettings(storedCurrent);
  const next = normalizeAppSettings({ ...current, ...input.updates });
  input.queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
  try {
    // An explicit selection (including null) takes precedence over any in-flight import.
    const pending = pendingWallpaperInputs.get(input.deps.storage);
    const explicitChoice = Object.hasOwn(input.updates, "wallpaperCandidateId");
    if (explicitChoice) pendingWallpaperInputs.delete(input.deps.storage);
    try {
      await input.deps.storage.setItem(
        APP_SETTINGS_KEY,
        serializeAppSettings(next, input.deps.storage),
      );
    } catch (error) {
      if (explicitChoice && pending) pendingWallpaperInputs.set(input.deps.storage, pending);
      throw error;
    }
  } catch (error) {
    if (input.queryClient.getQueryData(APP_SETTINGS_QUERY_KEY) === next) {
      input.queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, current);
    }
    throw error;
  }
}

export async function saveAppSettings(input: SaveAppSettingsInput): Promise<void> {
  const previous = appSettingsSaveTails.get(input.deps.storage) ?? Promise.resolve();
  const save = runQueuedAppSettingsSave(input, previous);
  appSettingsSaveTails.set(input.deps.storage, save);
  try {
    await save;
  } finally {
    if (appSettingsSaveTails.get(input.deps.storage) === save) {
      appSettingsSaveTails.delete(input.deps.storage);
    }
  }
}

async function readLatestAppSettingsAfterSaves(deps: SettingsDeps): Promise<AppSettings> {
  const previous = appSettingsSaveTails.get(deps.storage) ?? Promise.resolve();
  const read = previous.catch(() => {}).then(async () => (await readAppSettings(deps)).settings);
  const tail = read.then(
    () => undefined,
    () => undefined,
  );
  appSettingsSaveTails.set(deps.storage, tail);
  try {
    return await read;
  } finally {
    if (appSettingsSaveTails.get(deps.storage) === tail) appSettingsSaveTails.delete(deps.storage);
  }
}

export async function loadAppSettingsFromStorage(deps: SettingsDeps): Promise<AppSettings> {
  const read = await readAppSettings(deps);
  if (read.needsWrite) {
    await deps.storage.setItem(APP_SETTINGS_KEY, serializeAppSettings(read.settings, deps.storage));
  }
  const settings = await migrateAppSettings(read.settings, deps.storage, (value) =>
    serializeAppSettings(value, deps.storage),
  );
  const pending = pendingWallpaperInputs.get(deps.storage);
  // A network background must never wait for the local library or legacy filesystem I/O.
  // Switching back to file mode re-enters this loader with the preserved raw input.
  if (!pending || !deps.wallpaper || settings.wallpaperSource === "url") return settings;
  let binding: { candidateId: string | null; reason: string | null };
  try {
    binding = await deps.wallpaper.importLegacy({
      directory: typeof pending.wallpaperDir === "string" ? pending.wallpaperDir : null,
      path: typeof pending.wallpaperPath === "string" ? pending.wallpaperPath : null,
    });
  } catch (error) {
    // Keep the raw input for retry without making URL playback or ordinary settings fail.
    console.error("[AppSettings] Failed to migrate local wallpaper:", error);
    return readLatestAppSettingsAfterSaves(deps);
  }
  const previous = appSettingsSaveTails.get(deps.storage) ?? Promise.resolve();
  const commit = (async () => {
    await previous.catch(() => {});
    const latest = await readValidatedJson(deps.storage, APP_SETTINGS_KEY, StoredAppSettingsSchema);
    if (latest && Object.hasOwn(latest, "wallpaperCandidateId")) {
      pendingWallpaperInputs.delete(deps.storage);
      return normalizeAppSettings(latest);
    }
    const next = {
      ...normalizeAppSettings(latest ?? settings),
      wallpaperCandidateId: binding.candidateId,
    };
    await deps.storage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
    pendingWallpaperInputs.delete(deps.storage);
    return next;
  })();
  const tail = commit.then(
    () => undefined,
    () => undefined,
  );
  appSettingsSaveTails.set(deps.storage, tail);
  try {
    return await commit;
  } catch (error) {
    console.error("[AppSettings] Failed to save wallpaper migration:", error);
    return readLatestAppSettingsAfterSaves(deps);
  } finally {
    if (appSettingsSaveTails.get(deps.storage) === tail) appSettingsSaveTails.delete(deps.storage);
  }
}

async function readAppSettings(
  deps: SettingsDeps,
): Promise<{ settings: AppSettings; needsWrite: boolean }> {
  const stored = await readValidatedJson(deps.storage, APP_SETTINGS_KEY, StoredAppSettingsSchema);
  if (deps.desktop.isElectron() && stored && !Object.hasOwn(stored, "wallpaperCandidateId")) {
    pendingWallpaperInputs.set(deps.storage, {
      ...(Object.hasOwn(stored, "wallpaperDir") ? { wallpaperDir: stored.wallpaperDir } : {}),
      ...(Object.hasOwn(stored, "wallpaperPath") ? { wallpaperPath: stored.wallpaperPath } : {}),
    });
  } else {
    pendingWallpaperInputs.delete(deps.storage);
  }
  if (stored) {
    return {
      settings: normalizeAppSettings(stored),
      // COMPAT(uiFontSizeScale): persist the converted base size, remove after 2027-08-17.
      needsWrite:
        stored.serviceUrlBehavior !== undefined ||
        stored.workspaceTitleSource !== undefined ||
        stored.sidebarWorkspaceTrailing !== undefined ||
        (stored.uiBaseFontSize === undefined && stored.uiFontSize !== undefined) ||
        stored.contentFontSize === undefined ||
        stored.wallpaperDir !== undefined ||
        stored.wallpaperPath !== undefined,
    };
  }

  const legacyStored = await readValidatedJson(
    deps.storage,
    LEGACY_SETTINGS_KEY,
    LegacyRendererSettingsSchema,
  );
  if (legacyStored) {
    if (deps.desktop.isElectron() && !Object.hasOwn(legacyStored, "wallpaperCandidateId")) {
      pendingWallpaperInputs.set(deps.storage, {
        ...(Object.hasOwn(legacyStored, "wallpaperDir")
          ? { wallpaperDir: legacyStored.wallpaperDir }
          : {}),
        ...(Object.hasOwn(legacyStored, "wallpaperPath")
          ? { wallpaperPath: legacyStored.wallpaperPath }
          : {}),
      });
    }
    return {
      settings: {
        ...DEFAULT_CLIENT_SETTINGS,
        ...pickAppSettingsFromLegacy(legacyStored),
      } satisfies AppSettings,
      needsWrite: true,
    };
  }

  if (deps.desktop.isElectron()) pendingWallpaperInputs.set(deps.storage, {});
  return { settings: DEFAULT_CLIENT_SETTINGS, needsWrite: true };
}

export async function loadSettingsFromStorage(deps: SettingsDeps): Promise<Settings> {
  const legacyDesktopSettings = deps.desktop.isElectron()
    ? await loadLegacyDesktopSettingsFromStorage(deps.storage)
    : null;
  const appSettings = await loadAppSettingsFromStorage(deps);

  if (!deps.desktop.isElectron()) {
    return {
      ...DEFAULT_APP_SETTINGS,
      ...appSettings,
    };
  }

  if (legacyDesktopSettings) {
    await deps.desktop.migrateLegacyDesktopSettings(legacyDesktopSettings);
  }

  const desktopSettings = await deps.desktop.loadDesktopSettings();
  return {
    ...DEFAULT_APP_SETTINGS,
    ...appSettings,
    manageBuiltInDaemon: desktopSettings.daemon.manageBuiltInDaemon,
    releaseChannel: desktopSettings.releaseChannel,
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const result = StoredAppSettingsSchema.safeParse(value);
  return {
    ...DEFAULT_CLIENT_SETTINGS,
    ...pickAppSettings(result.success ? result.data : {}),
  };
}

function parseToolCallDetailLevel(stored: StoredAppSettings): ToolCallDetailLevel | null {
  if (stored.toolCallDetailLevel !== undefined) {
    if (
      typeof stored.toolCallDetailLevel === "string" &&
      VALID_TOOL_CALL_DETAIL_LEVELS.has(stored.toolCallDetailLevel)
    ) {
      return stored.toolCallDetailLevel;
    }
    // COMPAT(toolCallDetailLevelConcise): removed in v0.1.107; legacy "concise" values
    // deliberately follow the unknown-value fallback. Remove after 2027-01-14.
    return "overview";
  }
  if (typeof stored.compactToolCalls === "boolean") {
    // COMPAT(compactToolCalls): migrated in v0.1.105, remove after 2027-01-12.
    return stored.compactToolCalls ? "overview" : "detailed";
  }
  return null;
}

function parseStoredSidebarChecksDisplay(stored: StoredAppSettings): SidebarChecksDisplay | null {
  const display = parseSidebarChecksDisplay(stored.sidebarChecksDisplay);
  if (display !== null) {
    return display;
  }
  // COMPAT(sidebarRowItemsChecks): migrated in v0.3.0, remove after 2027-08-05.
  return isChecksHiddenByLegacyRowItem(stored.sidebarRowItems) ? "none" : null;
}

function pickBooleanAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (typeof stored.useLegacyTerminalRenderer === "boolean") {
    result.useLegacyTerminalRenderer = stored.useLegacyTerminalRenderer;
  }
  if (typeof stored.vimKeybindings === "boolean") {
    result.vimKeybindings = stored.vimKeybindings;
  }
  if (typeof stored.chatOutlineEnabled === "boolean") {
    result.chatOutlineEnabled = stored.chatOutlineEnabled;
  }
  if (typeof stored.homeAnimationsEnabled === "boolean") {
    result.homeAnimationsEnabled = stored.homeAnimationsEnabled;
  }
  if (typeof stored.wallpaperEnabled === "boolean") {
    result.wallpaperEnabled = stored.wallpaperEnabled;
  }
  return result;
}

/**
 * The settings whose stored value only has to be a member of a fixed set. Grouped like the
 * boolean settings are: the numeric and font settings need real parsing and clamping, these
 * need a membership check and nothing else.
 */
function pickEnumAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (typeof stored.theme === "string" && VALID_THEMES.has(stored.theme)) {
    result.theme = stored.theme;
  }
  if (
    stored.sendBehavior === "interrupt" ||
    stored.sendBehavior === "steer" ||
    stored.sendBehavior === "queue"
  ) {
    result.sendBehavior = stored.sendBehavior;
  }
  if (typeof stored.syntaxTheme === "string" && isSyntaxThemeId(stored.syntaxTheme)) {
    result.syntaxTheme = stored.syntaxTheme;
  }
  if (
    typeof stored.wallpaperSource === "string" &&
    ["none", "file", "url"].includes(stored.wallpaperSource)
  ) {
    result.wallpaperSource = stored.wallpaperSource as AppSettings["wallpaperSource"];
  }
  return result;
}

/**
 * The wallpaper fields that are media picks rather than plain membership checks: the opacity
 * needs numeric/string parsing, and path/url/dir accept an explicit `null` (cleared) alongside
 * their string form. `wallpaperEnabled` and `wallpaperSource` stay with the boolean/enum groups.
 */
function pickWallpaperMediaAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  const wallpaperOpacity =
    typeof stored.wallpaperOpacity === "string"
      ? Number.parseFloat(stored.wallpaperOpacity)
      : stored.wallpaperOpacity;
  if (
    typeof wallpaperOpacity === "number" &&
    Number.isFinite(wallpaperOpacity) &&
    wallpaperOpacity >= 0 &&
    wallpaperOpacity <= 1
  ) {
    result.wallpaperOpacity = wallpaperOpacity;
  }
  const candidateId = z.uuid().safeParse(stored.wallpaperCandidateId);
  result.wallpaperCandidateId = candidateId.success ? candidateId.data : null;
  if (typeof stored.wallpaperUrl === "string") {
    result.wallpaperUrl = stored.wallpaperUrl;
  } else if (stored.wallpaperUrl === null) {
    result.wallpaperUrl = null;
  }
  return result;
}

function pickAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  Object.assign(result, pickEnumAppSettings(stored));
  if (typeof stored.pluginThemeId === "string") {
    result.pluginThemeId = stored.pluginThemeId;
  }
  if (typeof stored.relayServerAddress === "string" && stored.relayServerAddress.trim()) {
    try {
      result.relayServerAddress = formatRelayServerAddress(
        parseRelayServerAddress(stored.relayServerAddress),
      );
    } catch {
      // Invalid persisted overrides fall back to the relay advertised by the pairing offer.
    }
  }
  if (stored.sidebarRowItems !== undefined) {
    result.sidebarRowItems = parseSidebarRowItems(stored.sidebarRowItems);
  }
  const sidebarChecksDisplay = parseStoredSidebarChecksDisplay(stored);
  if (sidebarChecksDisplay !== null) {
    result.sidebarChecksDisplay = sidebarChecksDisplay;
  }
  const language = parseAppLanguage(stored.language);
  if (language !== null) {
    result.language = language;
  }
  const terminalScrollbackLines = parseTerminalScrollbackLines(stored.terminalScrollbackLines);
  if (terminalScrollbackLines !== null) {
    result.terminalScrollbackLines = terminalScrollbackLines;
  }
  const uiFontFamily = sanitizeFontFamily(stored.uiFontFamily);
  if (uiFontFamily !== null) {
    result.uiFontFamily = uiFontFamily;
  }
  const monoFontFamily = sanitizeFontFamily(stored.monoFontFamily);
  if (monoFontFamily !== null) {
    result.monoFontFamily = monoFontFamily;
  }
  const uiBaseFontSize = parseClampedFontSize(stored.uiBaseFontSize, {
    min: MIN_UI_BASE_FONT_SIZE,
    max: MAX_UI_BASE_FONT_SIZE,
  });
  if (uiBaseFontSize !== null) {
    result.uiBaseFontSize = uiBaseFontSize;
  } else {
    const legacyUiFontSize = parseClampedFontSize(stored.uiFontSize, {
      min: 11,
      max: 24,
    });
    if (legacyUiFontSize !== null) {
      result.uiBaseFontSize = Math.round((LEGACY_UI_BASE_FONT_SIZE * legacyUiFontSize) / 16);
    }
  }
  const contentFontSize = parseClampedFontSize(stored.contentFontSize, {
    min: MIN_CONTENT_FONT_SIZE,
    max: MAX_CONTENT_FONT_SIZE,
  });
  if (contentFontSize !== null) {
    result.contentFontSize = contentFontSize;
  } else if (stored.contentFontSize === undefined) {
    // Existing content followed the interface ramp. Preserve that rendered size
    // once, then persist the independent setting during the read migration.
    result.contentFontSize = result.uiBaseFontSize ?? DEFAULT_UI_BASE_FONT_SIZE;
  }
  const codeFontSize = parseClampedFontSize(stored.codeFontSize, {
    min: MIN_CODE_FONT_SIZE,
    max: MAX_CODE_FONT_SIZE,
  });
  if (codeFontSize !== null) {
    result.codeFontSize = codeFontSize;
  }
  Object.assign(result, pickBooleanAppSettings(stored));
  if (typeof stored.autoExpandReasoning === "boolean") {
    result.autoExpandReasoning = stored.autoExpandReasoning;
  }
  const toolCallDetailLevel = parseToolCallDetailLevel(stored);
  if (toolCallDetailLevel !== null) {
    result.toolCallDetailLevel = toolCallDetailLevel;
  }
  Object.assign(result, pickWallpaperMediaAppSettings(stored));
  return result;
}

function pickAppSettingsFromLegacy(
  legacy: z.infer<typeof LegacyRendererSettingsSchema>,
): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (legacy.theme === "dark" || legacy.theme === "light" || legacy.theme === "auto") {
    result.theme = legacy.theme;
  }
  const legacyInterfaceSize = pickAppSettings(legacy).uiBaseFontSize;
  if (legacyInterfaceSize !== undefined) {
    result.uiBaseFontSize = legacyInterfaceSize;
  }
  // The legacy key rendered content on the interface ramp. Freeze that
  // rendered value into the new independent preference during migration.
  result.contentFontSize = legacyInterfaceSize ?? DEFAULT_UI_BASE_FONT_SIZE;
  Object.assign(result, pickWallpaperMediaAppSettings(legacy), pickBooleanAppSettings(legacy));
  if (legacy.wallpaperSource !== undefined) result.wallpaperSource = legacy.wallpaperSource;
  return result;
}

export function parseTerminalScrollbackLines(value: unknown): number | null {
  let numericValue = NaN;
  if (typeof value === "number") {
    numericValue = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    numericValue = Number(value);
  }
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return Math.min(
    MAX_TERMINAL_SCROLLBACK_LINES,
    Math.max(MIN_TERMINAL_SCROLLBACK_LINES, Math.floor(numericValue)),
  );
}

export function parseClampedFontSize(
  value: unknown,
  bounds: { min: number; max: number },
): number | null {
  let numericValue = NaN;
  if (typeof value === "number") {
    numericValue = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    numericValue = Number(value);
  }
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(numericValue)));
}

export function sanitizeFontFamily(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return ""; // explicit empty = default
  }
  if (trimmed.length > MAX_FONT_FAMILY_LENGTH) {
    return null;
  }
  if (/[;{}<>]/.test(trimmed)) {
    return null; // would break the web CSS font-family declaration
  }
  if ([...trimmed].some((char) => char.charCodeAt(0) <= 0x1f)) {
    return null; // control chars would corrupt the font-family string
  }
  return trimmed; // quotes/commas are legit in stacks
}

async function loadLegacyDesktopSettingsFromStorage(storage: KeyValueStorage): Promise<{
  manageBuiltInDaemon?: boolean;
  releaseChannel?: ReleaseChannel;
} | null> {
  const stored = await loadRendererSettingsPayload(storage);
  if (!stored) {
    return null;
  }

  const result: {
    manageBuiltInDaemon?: boolean;
    releaseChannel?: ReleaseChannel;
  } = {};

  if (typeof stored.manageBuiltInDaemon === "boolean") {
    result.manageBuiltInDaemon = stored.manageBuiltInDaemon;
  }
  if (stored.releaseChannel === "stable" || stored.releaseChannel === "beta") {
    result.releaseChannel = stored.releaseChannel;
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function loadRendererSettingsPayload(
  storage: KeyValueStorage,
): Promise<z.infer<typeof LegacyRendererSettingsSchema> | null> {
  const current = await readValidatedJson(storage, APP_SETTINGS_KEY, LegacyRendererSettingsSchema);
  if (current) {
    return current;
  }

  return readValidatedJson(storage, LEGACY_SETTINGS_KEY, LegacyRendererSettingsSchema);
}
