import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  privateDistribution: false,
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

vi.mock("../distribution.js", () => ({
  get PRIVATE_PLUGIN_DISTRIBUTION() {
    return mocks.privateDistribution;
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
    mocks.privateDistribution = false;
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
      {
        prepareToQuit: async () => {
          events.push("settings-saved");
        },
        stopDaemon: async () => {
          events.push("daemon-stopped");
        },
      },
    );

    expect(result).toMatchObject({ installed: true, version: "1.3.0" });
    expect(events).toEqual(["downloaded", "settings-saved", "daemon-stopped", "installer-started"]);
    expect(mocks.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("vetoes every failed pre-install preparation before daemon or installer effects, then permits a delayed successful retry", async () => {
    const events: string[] = [],
      preparation = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    mocks.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: UPDATE_INFO });
    mocks.quitAndInstall.mockImplementation(() => {
      events.push("installer-started");
    });
    const prepareToQuit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Settings save failed"))
      .mockRejectedValueOnce(new Error("Settings save failed again"))
      .mockImplementationOnce(async () => {
        events.push("preparation-started");
        started.resolve();
        await preparation.promise;
        events.push("settings-durable");
      });
    const stopDaemon = vi.fn(async () => {
      events.push("daemon-stopped");
    });
    for (const message of ["Settings save failed", "Settings save failed again"]) {
      const rejected = await downloadAndInstallUpdate(
        { currentVersion: "1.2.0", releaseChannel: "stable" },
        { prepareToQuit, stopDaemon },
      );
      expect(rejected).toEqual({ installed: false, version: null, message });
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(mocks.quitAndInstall).not.toHaveBeenCalled();
    }
    const retry = downloadAndInstallUpdate(
      { currentVersion: "1.2.0", releaseChannel: "stable" },
      { prepareToQuit, stopDaemon },
    );
    await started.promise;
    try {
      expect(events).toEqual(["preparation-started"]);
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(mocks.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      preparation.resolve();
    }
    await expect(retry).resolves.toMatchObject({ installed: true, version: "1.3.0" });
    expect(events).toEqual([
      "preparation-started",
      "settings-durable",
      "daemon-stopped",
      "installer-started",
    ]);
    expect(prepareToQuit).toHaveBeenCalledTimes(3);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1);
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

  it.each(["isolated trial", "private plugin distribution"])(
    "blocks downloads, daemon shutdown and installation in a %s even after an update was ready",
    async (distribution) => {
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
      if (distribution === "isolated trial") {
        vi.stubEnv("PASEO_DISABLE_APP_UPDATES", "1");
      } else {
        mocks.privateDistribution = true;
      }

      const blocked = await checkForAppUpdate({
        currentVersion: "1.2.0",
        releaseChannel: "stable",
        intent: "automatic",
      });
      const prepareToQuit = vi.fn(),
        stopDaemon = vi.fn();
      const install = await downloadAndInstallUpdate(
        { currentVersion: "1.2.0", releaseChannel: "stable" },
        { prepareToQuit, stopDaemon },
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
      expect(prepareToQuit).not.toHaveBeenCalled();
    },
  );
});
