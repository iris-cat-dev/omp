import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NsisUpdater } from "electron-updater/out/NsisUpdater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userDataPath: "",
  updateInfo: {
    version: "0.5.3",
    files: [{ url: "OMP-Desktop-Setup.exe", sha512: "checksum" }],
    path: "OMP-Desktop-Setup.exe",
    sha512: "checksum",
    releaseDate: "2026-11-07T00:00:00.000Z",
  },
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock("electron-updater", async () => {
  mocks.userDataPath = await mkdtemp(join(tmpdir(), "desktop-updater-versions-"));
  const updater = new NsisUpdater(null, {
    version: "0.6.0",
    name: "OMP Desktop updater regression",
    isPackaged: true,
    appUpdateConfigPath: join(mocks.userDataPath, "app-update.yml"),
    userDataPath: mocks.userDataPath,
    baseCachePath: mocks.userDataPath,
    whenReady: async () => {},
    relaunch: vi.fn(),
    quit: vi.fn(),
    onQuit: vi.fn(),
  });
  // Keep the real channel setter and version comparison; isolate network and installer effects.
  vi.spyOn(GitHubProvider.prototype, "getLatestVersion").mockImplementation(async () => ({
    tag: mocks.updateInfo.version,
    ...mocks.updateInfo,
  }));
  vi.spyOn(updater, "downloadUpdate").mockImplementation(mocks.downloadUpdate);
  vi.spyOn(updater, "quitAndInstall").mockImplementation(mocks.quitAndInstall);
  return { autoUpdater: updater };
});

vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  type AppReleaseChannel,
  checkForAppUpdate,
  downloadAndInstallUpdate,
  installAppUpdateOnQuit,
} from "./auto-updater";

beforeEach(() => {
  vi.stubEnv("PASEO_DISABLE_APP_UPDATES", undefined);
  mocks.downloadUpdate.mockReset().mockResolvedValue([`${mocks.userDataPath}/update.exe`]);
  mocks.quitAndInstall.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(mocks.userDataPath, { recursive: true, force: true });
});

describe("desktop update version policy with electron-updater", () => {
  it.each(["0.5.3", "0.6.0"])(
    "does not download or offer %s when running 0.6.0, including after channel switches",
    async (version) => {
      mocks.updateInfo.version = version;
      const channels: AppReleaseChannel[] = ["stable", "beta", "stable"];
      for (const releaseChannel of channels) {
        const result = await checkForAppUpdate({
          currentVersion: "0.6.0",
          releaseChannel,
          intent: "manual",
        });
        expect(result).toMatchObject({
          hasUpdate: false,
          readyToInstall: false,
          currentVersion: "0.6.0",
          latestVersion: "0.6.0",
          errorMessage: null,
        });
      }
      expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    },
  );

  it("downloads a newer release but refuses stale releases during explicit and quit-time installation", async () => {
    mocks.updateInfo.version = "0.6.1";
    const ready = await checkForAppUpdate({
      currentVersion: "0.6.0",
      releaseChannel: "stable",
      intent: "automatic",
    });
    expect(ready).toMatchObject({
      hasUpdate: true,
      readyToInstall: true,
      latestVersion: "0.6.1",
      errorMessage: null,
    });
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce();
    mocks.downloadUpdate.mockClear();

    mocks.updateInfo.version = "0.5.3";
    const installOnQuit = await installAppUpdateOnQuit({
      currentVersion: "0.6.0",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });
    const prepareToQuit = vi.fn();
    const stopDaemon = vi.fn();
    const install = await downloadAndInstallUpdate(
      { currentVersion: "0.6.0", releaseChannel: "stable" },
      { prepareToQuit, stopDaemon },
    );

    expect(installOnQuit).toBe(false);
    expect(install).toMatchObject({ installed: false, version: null });
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
    expect(prepareToQuit).not.toHaveBeenCalled();
    expect(stopDaemon).not.toHaveBeenCalled();
  });
});
