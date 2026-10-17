import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WallpaperLibrarySchema,
  WallpaperMigrationSchema,
  type WallpaperAddedCandidates,
  type WallpaperCandidate,
  type WallpaperLegacyResult,
  type WallpaperLibrary,
  type WallpaperMigration,
  type WallpaperRemoveResult,
  type WallpaperValidatedFile,
} from "@omp-desktop/protocol/desktop-wallpaper";

import type { AppReleaseChannel } from "../features/auto-updater.js";
import { isBrowserTargetId, type BrowserTargetId } from "../features/browser-targets.js";
import type { DesktopPetSettings, PetPosition } from "../pets/types.js";

export interface DesktopSettings {
  releaseChannel: AppReleaseChannel;
  browser: {
    target: BrowserTargetId;
  };
  notifications: {
    playSound: boolean;
  };
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
  window: {
    closeBehavior: "ask" | "background" | "quit";
  };
  pet: DesktopPetSettings;
}

interface DesktopSettingsPatch {
  releaseChannel?: AppReleaseChannel;
  browser?: Partial<DesktopSettings["browser"]>;
  notifications?: Partial<DesktopSettings["notifications"]>;
  daemon?: Partial<DesktopSettings["daemon"]>;
  window?: Partial<DesktopSettings["window"]>;
  pet?: Partial<DesktopPetSettings>;
}

interface PersistedDesktopSettingsDocument {
  version: 1;
  settings: DesktopSettings;
  wallpaperLibrary: WallpaperLibrary;
  migrations: {
    legacyRendererSettingsImported: boolean;
    // Installs created before the stop-on-quit default persisted the old
    // `keepRunningAfterQuit: true` default to disk, so the new default alone
    // would only reach fresh installs. Reset it once; a later explicit toggle
    // persists this flag and is never overridden again.
    daemonStopOnQuitDefaultApplied: boolean;
    wallpaperImported: WallpaperMigration | null;
  };
}

export interface DesktopSettingsStore {
  get(): Promise<DesktopSettings>;
  patch(patch: unknown): Promise<DesktopSettings>;
  migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings>;
  subscribe(listener: (settings: DesktopSettings) => void): () => void;
  getWallpaperLibrary(): Promise<WallpaperLibrary>;
  addWallpaperCandidates(
    files: readonly WallpaperValidatedFile[],
  ): Promise<WallpaperAddedCandidates>;
  removeWallpaperCandidates(candidateIds: readonly string[]): Promise<WallpaperRemoveResult>;
  importLegacyWallpaper(
    file: WallpaperValidatedFile | null,
    reason: string | null,
  ): Promise<WallpaperLegacyResult>;
  subscribeWallpaperLibrary(listener: (library: WallpaperLibrary) => void): () => void;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  releaseChannel: "stable",
  browser: {
    target: "system",
  },
  notifications: {
    playSound: true,
  },
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
  window: {
    closeBehavior: "ask",
  },
  pet: { enabled: false, size: "medium", selectedId: "iris", position: null },
};

const DESKTOP_SETTINGS_FILENAME = "desktop-settings.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceReleaseChannel(value: unknown): AppReleaseChannel | null {
  if (value === "beta") {
    return "beta";
  }
  if (value === "stable") {
    return "stable";
  }
  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function coerceCloseBehavior(value: unknown): DesktopSettings["window"]["closeBehavior"] | null {
  if (value === "ask" || value === "background" || value === "quit") {
    return value;
  }
  return null;
}

function coercePetPosition(value: unknown): PetPosition | null {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  )
    return null;
  return { x: Math.round(value.x), y: Math.round(value.y) };
}

function coercePetPatch(value: unknown): Partial<DesktopPetSettings> {
  if (!isRecord(value)) return {};
  const pet: Partial<DesktopPetSettings> = {};
  if (typeof value.enabled === "boolean") pet.enabled = value.enabled;
  const size =
    value.size === "small" || value.size === "medium" || value.size === "large" ? value.size : null;
  if (size) pet.size = size;
  if (
    typeof value.selectedId === "string" &&
    value.selectedId.trim() &&
    value.selectedId.length <= 128
  ) {
    pet.selectedId = value.selectedId;
  }
  const position = coercePetPosition(value.position);
  if (value.position === null || position) pet.position = position;
  return pet;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function buildDefaultDocument(): PersistedDesktopSettingsDocument {
  return {
    version: 1,
    settings: {
      releaseChannel: DEFAULT_DESKTOP_SETTINGS.releaseChannel,
      notifications: { ...DEFAULT_DESKTOP_SETTINGS.notifications },
      browser: { ...DEFAULT_DESKTOP_SETTINGS.browser },
      daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
      window: { ...DEFAULT_DESKTOP_SETTINGS.window },
      pet: { ...DEFAULT_DESKTOP_SETTINGS.pet },
    },
    wallpaperLibrary: { version: 1, revision: 0, items: [] },
    migrations: {
      legacyRendererSettingsImported: false,
      daemonStopOnQuitDefaultApplied: true,
      wallpaperImported: null,
    },
  };
}

function coerceDesktopSettings(input: unknown): DesktopSettings {
  const result: DesktopSettings = {
    releaseChannel: DEFAULT_DESKTOP_SETTINGS.releaseChannel,
    browser: { ...DEFAULT_DESKTOP_SETTINGS.browser },
    notifications: { ...DEFAULT_DESKTOP_SETTINGS.notifications },
    daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
    window: { ...DEFAULT_DESKTOP_SETTINGS.window },
    pet: { ...DEFAULT_DESKTOP_SETTINGS.pet },
  };

  if (!isRecord(input)) {
    return result;
  }

  const releaseChannel = coerceReleaseChannel(input.releaseChannel);
  if (releaseChannel) {
    result.releaseChannel = releaseChannel;
  }

  if (isRecord(input.browser) && isBrowserTargetId(input.browser.target)) {
    result.browser.target = input.browser.target;
  }

  if (isRecord(input.notifications)) {
    const playSound = coerceBoolean(input.notifications.playSound);
    if (playSound !== null) {
      result.notifications.playSound = playSound;
    }
  }

  if (isRecord(input.daemon)) {
    const manageBuiltInDaemon = coerceBoolean(input.daemon.manageBuiltInDaemon);
    if (manageBuiltInDaemon !== null) {
      result.daemon.manageBuiltInDaemon = manageBuiltInDaemon;
    }

    const keepRunningAfterQuit = coerceBoolean(input.daemon.keepRunningAfterQuit);
    if (keepRunningAfterQuit !== null) {
      result.daemon.keepRunningAfterQuit = keepRunningAfterQuit;
    }
  }

  if (isRecord(input.window)) {
    const closeBehavior = coerceCloseBehavior(input.window.closeBehavior);
    if (closeBehavior) {
      result.window.closeBehavior = closeBehavior;
    }
  }
  result.pet = { ...result.pet, ...coercePetPatch(input.pet) };

  return result;
}

function coerceDesktopSettingsPatch(input: unknown): DesktopSettingsPatch {
  if (!isRecord(input)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};

  const releaseChannel = coerceReleaseChannel(input.releaseChannel);
  if (releaseChannel) {
    patch.releaseChannel = releaseChannel;
  }

  if (isRecord(input.browser) && isBrowserTargetId(input.browser.target)) {
    patch.browser = { target: input.browser.target };
  }

  if (isRecord(input.notifications)) {
    const playSound = coerceBoolean(input.notifications.playSound);
    if (playSound !== null) {
      patch.notifications = { playSound };
    }
  }

  if (isRecord(input.daemon)) {
    const daemonPatch: Partial<DesktopSettings["daemon"]> = {};
    const manageBuiltInDaemon = coerceBoolean(input.daemon.manageBuiltInDaemon);
    if (manageBuiltInDaemon !== null) {
      daemonPatch.manageBuiltInDaemon = manageBuiltInDaemon;
    }
    const keepRunningAfterQuit = coerceBoolean(input.daemon.keepRunningAfterQuit);
    if (keepRunningAfterQuit !== null) {
      daemonPatch.keepRunningAfterQuit = keepRunningAfterQuit;
    }
    if (Object.keys(daemonPatch).length > 0) {
      patch.daemon = daemonPatch;
    }
  }

  if (isRecord(input.window)) {
    const closeBehavior = coerceCloseBehavior(input.window.closeBehavior);
    if (closeBehavior) {
      patch.window = { closeBehavior };
    }
  }
  if (isRecord(input.pet)) patch.pet = coercePetPatch(input.pet);

  return patch;
}

function pickDesktopSettingsFromLegacyRendererSettings(
  legacySettings: unknown,
): DesktopSettingsPatch {
  if (!isRecord(legacySettings)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};
  const releaseChannel = coerceReleaseChannel(legacySettings.releaseChannel);
  if (releaseChannel) {
    patch.releaseChannel = releaseChannel;
  }

  const manageBuiltInDaemon = coerceBoolean(legacySettings.manageBuiltInDaemon);
  if (manageBuiltInDaemon !== null) {
    patch.daemon = { manageBuiltInDaemon };
  }

  return patch;
}

function mergeDesktopSettings(
  current: DesktopSettings,
  patch: DesktopSettingsPatch,
): DesktopSettings {
  return {
    releaseChannel: patch.releaseChannel ?? current.releaseChannel,
    browser: { ...current.browser, ...patch.browser },
    notifications: { ...current.notifications, ...patch.notifications },
    daemon: { ...current.daemon, ...patch.daemon },
    window: { ...current.window, ...patch.window },
    pet: { ...current.pet, ...patch.pet },
  };
}

function hasLegacyRendererOwnedPatch(patch: DesktopSettingsPatch): boolean {
  return patch.releaseChannel !== undefined || patch.daemon?.manageBuiltInDaemon !== undefined;
}

class InvalidWallpaperDataError extends Error {
  constructor(
    readonly settings: DesktopSettings,
    cause: unknown,
  ) {
    super("Invalid persisted wallpaper data.", { cause });
    this.name = "InvalidWallpaperDataError";
  }
}

function coerceDocument(input: unknown): PersistedDesktopSettingsDocument {
  if (!isRecord(input)) {
    throw new TypeError("Invalid desktop settings document.");
  }
  if (Object.hasOwn(input, "migrations") && !isRecord(input.migrations)) {
    throw new TypeError("Invalid desktop settings migrations.");
  }
  const settings = coerceDesktopSettings(input.settings);
  const migrations = {
    legacyRendererSettingsImported:
      isRecord(input.migrations) && input.migrations.legacyRendererSettingsImported === true,
    daemonStopOnQuitDefaultApplied:
      isRecord(input.migrations) && input.migrations.daemonStopOnQuitDefaultApplied === true,
  };
  if (!migrations.daemonStopOnQuitDefaultApplied) {
    settings.daemon.keepRunningAfterQuit = DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit;
    migrations.daemonStopOnQuitDefaultApplied = true;
  }

  let wallpaperLibrary: WallpaperLibrary;
  let wallpaperImported: WallpaperMigration | null = null;
  try {
    wallpaperLibrary = Object.hasOwn(input, "wallpaperLibrary")
      ? WallpaperLibrarySchema.parse(input.wallpaperLibrary)
      : { version: 1, revision: 0, items: [] };
    if (
      isRecord(input.migrations) &&
      Object.hasOwn(input.migrations, "wallpaperImported") &&
      input.migrations.wallpaperImported !== null
    ) {
      wallpaperImported = WallpaperMigrationSchema.parse(input.migrations.wallpaperImported);
    }
  } catch (error) {
    // Ordinary read-only preferences remain usable, but no invalid library is cached or written.
    throw new InvalidWallpaperDataError(settings, error);
  }

  return {
    version: 1,
    settings,
    wallpaperLibrary,
    migrations: { ...migrations, wallpaperImported },
  };
}

export function createDesktopSettingsStore({
  userDataPath,
  onWallpaperLibraryCommitted,
}: {
  userDataPath: string;
  onWallpaperLibraryCommitted?: (library: WallpaperLibrary) => void;
}): DesktopSettingsStore {
  const filePath = path.join(userDataPath, DESKTOP_SETTINGS_FILENAME);
  let cachedDocument: PersistedDesktopSettingsDocument | null = null;
  let operationQueue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(settings: DesktopSettings) => void>();
  const wallpaperListeners = new Set<(library: WallpaperLibrary) => void>();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const queued = operationQueue.then(operation, operation);
    operationQueue = queued.catch(() => undefined);
    return queued;
  }

  function copySettings(settings: DesktopSettings): DesktopSettings {
    return {
      ...settings,
      notifications: { ...settings.notifications },
      browser: { ...settings.browser },
      daemon: { ...settings.daemon },
      window: { ...settings.window },
      pet: {
        ...settings.pet,
        position: settings.pet.position ? { ...settings.pet.position } : null,
      },
    };
  }

  function copyCandidate(candidate: WallpaperCandidate): WallpaperCandidate {
    return {
      candidateId: candidate.candidateId,
      directory: candidate.directory,
      path: candidate.path,
      name: candidate.name,
      kind: candidate.kind,
    };
  }

  function copyLibrary(library: WallpaperLibrary): WallpaperLibrary {
    return { ...library, items: library.items.map(copyCandidate) };
  }

  function publishLibrary(library: WallpaperLibrary, notifyListeners: boolean): void {
    onWallpaperLibraryCommitted?.(copyLibrary(library));
    if (!notifyListeners) return;
    for (const listener of wallpaperListeners) {
      try {
        listener(copyLibrary(library));
      } catch {
        // A failed consumer cannot undo a committed library or block other consumers.
      }
    }
  }

  function appendCandidates(
    library: WallpaperLibrary,
    files: readonly WallpaperValidatedFile[],
  ): { library: WallpaperLibrary; added: WallpaperCandidate[]; duplicates: WallpaperCandidate[] } {
    const byPath = new Map(library.items.map((item) => [item.path, item]));
    const added: WallpaperCandidate[] = [];
    const duplicates: WallpaperCandidate[] = [];
    for (const file of files) {
      const existing = byPath.get(file.path);
      if (existing) {
        duplicates.push(existing);
      } else {
        const candidate = { ...file, candidateId: randomUUID() };
        added.push(candidate);
        byPath.set(file.path, candidate);
      }
    }
    return {
      library: added.length
        ? {
            version: 1,
            revision: incrementRevision(library.revision),
            items: [...library.items, ...added],
          }
        : library,
      added,
      duplicates,
    };
  }

  function incrementRevision(revision: number): number {
    if (revision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Wallpaper library revision is exhausted.");
    }
    return revision + 1;
  }

  async function persistDocument(
    document: PersistedDesktopSettingsDocument,
    publish: "load" | "change" | null = null,
  ): Promise<void> {
    await mkdir(userDataPath, { recursive: true });
    const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
    } catch (error) {
      await rm(tempFilePath, { force: true }).catch(() => undefined);
      throw error;
    }
    cachedDocument = document;
    if (publish) publishLibrary(document.wallpaperLibrary, publish === "change");
  }

  function notify(settings: DesktopSettings): void {
    for (const listener of listeners) {
      try {
        listener(copySettings(settings));
      } catch {
        // Persistence has already succeeded; continue notifying other consumers.
      }
    }
  }

  async function loadDocument(): Promise<PersistedDesktopSettingsDocument> {
    if (cachedDocument) {
      return cachedDocument;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      const document = buildDefaultDocument();
      await persistDocument(document, "load");
      return document;
    }
    const document = coerceDocument(JSON.parse(raw));
    cachedDocument = document;
    publishLibrary(document.wallpaperLibrary, false);
    return document;
  }

  return {
    get(): Promise<DesktopSettings> {
      return serialize(async () => {
        try {
          return copySettings((await loadDocument()).settings);
        } catch (error) {
          if (error instanceof InvalidWallpaperDataError) return copySettings(error.settings);
          throw error;
        }
      });
    },

    patch(patch: unknown): Promise<DesktopSettings> {
      return serialize(async () => {
        const current = await loadDocument();
        const coercedPatch = coerceDesktopSettingsPatch(patch);
        const next = mergeDesktopSettings(current.settings, coercedPatch);
        await persistDocument({
          ...current,
          settings: next,
          migrations: {
            ...current.migrations,
            legacyRendererSettingsImported:
              current.migrations.legacyRendererSettingsImported ||
              hasLegacyRendererOwnedPatch(coercedPatch),
          },
        });
        notify(next);
        return copySettings(next);
      });
    },

    migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings> {
      return serialize(async () => {
        const current = await loadDocument();
        if (current.migrations.legacyRendererSettingsImported)
          return copySettings(current.settings);
        const next = mergeDesktopSettings(
          current.settings,
          pickDesktopSettingsFromLegacyRendererSettings(legacySettings),
        );
        await persistDocument({
          ...current,
          settings: next,
          migrations: { ...current.migrations, legacyRendererSettingsImported: true },
        });
        notify(next);
        return copySettings(next);
      });
    },

    getWallpaperLibrary(): Promise<WallpaperLibrary> {
      return serialize(async () => copyLibrary((await loadDocument()).wallpaperLibrary));
    },

    addWallpaperCandidates(files): Promise<WallpaperAddedCandidates> {
      const input = files.map(({ directory, path: mediaPath, name, kind }) => ({
        directory,
        path: mediaPath,
        name,
        kind,
      }));
      return serialize(async () => {
        const current = await loadDocument();
        const result = appendCandidates(current.wallpaperLibrary, input);
        if (result.added.length) {
          await persistDocument({ ...current, wallpaperLibrary: result.library }, "change");
        }
        return {
          library: copyLibrary(result.library),
          added: result.added.map(copyCandidate),
          duplicates: result.duplicates.map(copyCandidate),
        };
      });
    },

    removeWallpaperCandidates(candidateIds): Promise<WallpaperRemoveResult> {
      const ids = new Set(candidateIds);
      return serialize(async () => {
        const current = await loadDocument();
        const removedCandidateIds = current.wallpaperLibrary.items
          .filter((item) => ids.has(item.candidateId))
          .map((item) => item.candidateId);
        if (!removedCandidateIds.length) {
          return { library: copyLibrary(current.wallpaperLibrary), removedCandidateIds };
        }
        const library: WallpaperLibrary = {
          version: 1,
          revision: incrementRevision(current.wallpaperLibrary.revision),
          items: current.wallpaperLibrary.items.filter((item) => !ids.has(item.candidateId)),
        };
        await persistDocument({ ...current, wallpaperLibrary: library }, "change");
        return { library: copyLibrary(library), removedCandidateIds };
      });
    },

    importLegacyWallpaper(file, reason): Promise<WallpaperLegacyResult> {
      const input = file ? { ...file } : null;
      return serialize(async () => {
        const current = await loadDocument();
        if (current.migrations.wallpaperImported) {
          return {
            ...current.migrations.wallpaperImported,
            library: copyLibrary(current.wallpaperLibrary),
          };
        }
        const result = appendCandidates(current.wallpaperLibrary, input ? [input] : []);
        const binding: WallpaperMigration = {
          candidateId: input ? (result.added[0] ?? result.duplicates[0])!.candidateId : null,
          reason: input ? null : reason,
        };
        await persistDocument(
          {
            ...current,
            wallpaperLibrary: result.library,
            migrations: { ...current.migrations, wallpaperImported: binding },
          },
          result.added.length ? "change" : null,
        );
        return { ...binding, library: copyLibrary(result.library) };
      });
    },

    subscribeWallpaperLibrary(listener): () => void {
      wallpaperListeners.add(listener);
      return () => {
        wallpaperListeners.delete(listener);
      };
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
