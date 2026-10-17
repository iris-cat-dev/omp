import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: mocks.quitAndInstall,
    setFeedURL: mocks.setFeedURL,
    on: mocks.on,
  },
}));

vi.mock("electron-log/main", () => ({
  default: {
    error: mocks.logError,
    info: mocks.logInfo,
    warn: vi.fn(),
  },
}));

import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  installAppUpdateOnQuit,
} from "./auto-updater";

const UPDATE_INFO = {
  version: "1.3.0",
  files: [{ url: "OMP-Desktop-Setup-1.3.0-arm64.exe", sha512: "checksum" }],
  path: "OMP-Desktop-Setup-1.3.0-arm64.exe",
  sha512: "checksum",
  releaseDate: "2026-09-28T11:11:02.000Z",
  releaseNotes: "Fixes and improvements",
};

describe("desktop app updater", () => {
  beforeEach(() => {
    vi.stubEnv("PASEO_DISABLE_APP_UPDATES", undefined);
    mocks.checkForUpdates.mockReset();
    mocks.downloadUpdate.mockReset();
    mocks.quitAndInstall.mockReset();
    mocks.logError.mockReset();
    mocks.downloadUpdate.mockResolvedValue(["/tmp/update.exe"]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("downloads a newer GitHub release before reporting it ready to install", async () => {
    mocks.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: UPDATE_INFO,
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.0",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: true,
      currentVersion: "1.2.0",
      latestVersion: "1.3.0",
      body: "Fixes and improvements",
      date: "2026-09-28T11:11:02.000Z",
      errorMessage: null,
    });
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("stops the managed daemon after download and before handing off to the installer", async () => {
    const events: string[] = [];
    mocks.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: UPDATE_INFO,
    });
    mocks.downloadUpdate.mockImplementation(async () => {
      events.push("downloaded");
      return ["/tmp/update.exe"];
    });
    mocks.quitAndInstall.mockImplementation(() => {
      events.push("installer-started");
    });

    const result = await downloadAndInstallUpdate(
      { currentVersion: "1.2.0", releaseChannel: "stable" },
      async () => {
        events.push("daemon-stopped");
      },
    );

    expect(result).toMatchObject({ installed: true, version: "1.3.0" });
    expect(events).toEqual(["downloaded", "daemon-stopped", "installer-started"]);
    expect(mocks.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("does not start an installer after the quit deadline has already expired", async () => {
    const controller = new AbortController();
    controller.abort();

    const installing = await installAppUpdateOnQuit({
      currentVersion: "1.2.0",
      releaseChannel: "stable",
      signal: controller.signal,
    });

    expect(installing).toBe(false);
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  it("blocks downloads, daemon shutdown and installation in an isolated trial even after an update was ready", async () => {
    mocks.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: UPDATE_INFO,
    });
    const ready = await checkForAppUpdate({
      currentVersion: "1.2.0",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(ready.readyToInstall).toBe(true);
    mocks.checkForUpdates.mockClear();
    mocks.downloadUpdate.mockClear();
    vi.stubEnv("PASEO_DISABLE_APP_UPDATES", "1");

    const blocked = await checkForAppUpdate({
      currentVersion: "1.2.0",
      releaseChannel: "stable",
      intent: "automatic",
    });
    const stopDaemon = vi.fn();
    const install = await downloadAndInstallUpdate(
      { currentVersion: "1.2.0", releaseChannel: "stable" },
      stopDaemon,
    );
    const installOnQuit = await installAppUpdateOnQuit({
      currentVersion: "1.2.0",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(blocked).toMatchObject({ hasUpdate: false, readyToInstall: false });
    expect(install).toMatchObject({ installed: false, version: null });
    expect(installOnQuit).toBe(false);
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
    expect(stopDaemon).not.toHaveBeenCalled();
  });
});
