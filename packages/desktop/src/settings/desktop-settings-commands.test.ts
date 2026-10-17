import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettingsStore } from "./desktop-settings";
import { createDesktopSettingsCommandHandlers } from "./desktop-settings-commands";
import type { LaunchAtLoginController } from "./launch-at-login";

function createStoreMock(): DesktopSettingsStore {
  return {
    get: vi.fn(async () => DEFAULT_DESKTOP_SETTINGS),
    patch: vi.fn(async () => ({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
    })),
    migrateLegacyRendererSettings: vi.fn(async () => ({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: true,
      },
    })),
    subscribe: vi.fn(() => () => undefined),
    getWallpaperLibrary: vi.fn(async () => ({ version: 1, revision: 0, items: [] })),
    addWallpaperCandidates: vi.fn(async () => ({
      library: { version: 1, revision: 0, items: [] },
      added: [],
      duplicates: [],
    })),
    removeWallpaperCandidates: vi.fn(async () => ({
      library: { version: 1, revision: 0, items: [] },
      removedCandidateIds: [],
    })),
    importLegacyWallpaper: vi.fn(async () => ({
      library: { version: 1, revision: 0, items: [] },
      candidateId: null,
      reason: null,
    })),
    subscribeWallpaperLibrary: vi.fn(() => () => undefined),
  };
}

function createLaunchAtLoginControllerMock(): LaunchAtLoginController {
  return {
    get: vi.fn(() => ({ enabled: false, supported: true })),
    set: vi.fn((enabled) => ({ enabled, supported: true })),
  };
}

describe("desktop-settings-commands", () => {
  it("exposes get and patch handlers through the desktop command bus shape", async () => {
    const store = createStoreMock();
    const handlers = createDesktopSettingsCommandHandlers({
      settingsStore: store,
      launchAtLoginController: createLaunchAtLoginControllerMock(),
    });

    await expect(handlers.get_desktop_settings()).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS);
    await expect(
      handlers.patch_desktop_settings({
        daemon: { keepRunningAfterQuit: false },
      }),
    ).resolves.toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
    });

    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.patch).toHaveBeenCalledWith({
      daemon: { keepRunningAfterQuit: false },
    });
  });

  it("accepts legacy renderer settings migration payloads", async () => {
    const store = createStoreMock();
    const handlers = createDesktopSettingsCommandHandlers({
      settingsStore: store,
      launchAtLoginController: createLaunchAtLoginControllerMock(),
    });

    const result = await handlers.migrate_legacy_desktop_settings({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
    });

    expect(result).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: true,
      },
    });
    expect(store.migrateLegacyRendererSettings).toHaveBeenCalledWith({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
    });
  });

  it("reads and updates launch-at-login through the command bus", () => {
    const launchAtLoginController = createLaunchAtLoginControllerMock();
    const handlers = createDesktopSettingsCommandHandlers({
      settingsStore: createStoreMock(),
      launchAtLoginController,
    });

    expect(handlers.get_launch_at_login()).toEqual({ enabled: false, supported: true });
    expect(handlers.set_launch_at_login({ enabled: true })).toEqual({
      enabled: true,
      supported: true,
    });
    expect(launchAtLoginController.set).toHaveBeenCalledWith(true);
    expect(() => handlers.set_launch_at_login({ enabled: "true" })).toThrow(TypeError);
  });
});
