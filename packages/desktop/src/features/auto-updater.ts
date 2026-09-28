import log from "electron-log/main";
import { autoUpdater, type UpdateInfo } from "electron-updater";

export type AppReleaseChannel = "stable" | "beta";
export type AppUpdateCheckIntent = "automatic" | "manual";

export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string;
  latestVersion: string;
  body: string | null;
  date: string | null;
  errorMessage: string | null;
}

export interface AppUpdateInstallResult {
  installed: boolean;
  version: string | null;
  message: string;
}

const UPDATE_REPOSITORY = {
  provider: "github",
  owner: "iris-cat-dev",
  repo: "omp-desktop",
} as const;

let configured = false;
let operationTail: Promise<void> = Promise.resolve();
let downloadedUpdateChannel: AppReleaseChannel | null = null;

function configureUpdater(releaseChannel: AppReleaseChannel): void {
  if (!configured) {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.fullChangelog = false;
    autoUpdater.setFeedURL(UPDATE_REPOSITORY);
    autoUpdater.on("error", (error) => {
      log.error("[auto-updater] updater error", error);
    });
    configured = true;
  }

  autoUpdater.allowPrerelease = releaseChannel === "beta";
  autoUpdater.channel = releaseChannel === "beta" ? "beta" : "latest";
}

function runUpdateOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function releaseNotesToText(releaseNotes: UpdateInfo["releaseNotes"]): string | null {
  if (typeof releaseNotes === "string") {
    return releaseNotes.trim() || null;
  }
  if (!releaseNotes) {
    return null;
  }
  const notes = releaseNotes
    .map(({ version, note }) => {
      const body = note?.trim();
      return body ? `${version}\n${body}` : null;
    })
    .filter((note): note is string => note !== null);
  return notes.length > 0 ? notes.join("\n\n") : null;
}

function noUpdateResult(currentVersion: string): AppUpdateCheckResult {
  return {
    hasUpdate: false,
    readyToInstall: false,
    currentVersion,
    latestVersion: currentVersion,
    body: null,
    date: null,
    errorMessage: null,
  };
}

async function checkAndDownloadUpdate({
  currentVersion,
  releaseChannel,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
}): Promise<AppUpdateCheckResult> {
  configureUpdater(releaseChannel);
  const result = await autoUpdater.checkForUpdates();
  if (!result?.isUpdateAvailable) {
    downloadedUpdateChannel = null;
    return noUpdateResult(currentVersion);
  }

  const updateInfo = result.updateInfo;
  await autoUpdater.downloadUpdate();
  downloadedUpdateChannel = releaseChannel;
  return {
    hasUpdate: true,
    readyToInstall: true,
    currentVersion,
    latestVersion: updateInfo.version,
    body: releaseNotesToText(updateInfo.releaseNotes),
    date: updateInfo.releaseDate || null,
    errorMessage: null,
  };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}): Promise<AppUpdateCheckResult> {
  try {
    return await runUpdateOperation(() =>
      checkAndDownloadUpdate({ currentVersion, releaseChannel }),
    );
  } catch (error) {
    const message = messageFromError(error);
    log.error("[auto-updater] failed to check or download update", {
      releaseChannel,
      intent,
      error: message,
    });
    return {
      ...noUpdateResult(currentVersion),
      errorMessage: message,
    };
  }
}

export async function downloadAndInstallUpdate(
  { currentVersion, releaseChannel }: { currentVersion: string; releaseChannel: AppReleaseChannel },
  onBeforeQuit?: () => Promise<void>,
): Promise<AppUpdateInstallResult> {
  return await runUpdateOperation(async () => {
    try {
      const update = await checkAndDownloadUpdate({ currentVersion, releaseChannel });
      if (!update.readyToInstall) {
        return {
          installed: false,
          version: null,
          message: "OMP Desktop is already up to date",
        };
      }

      autoUpdater.autoRunAppAfterInstall = true;
      await onBeforeQuit?.();
      autoUpdater.quitAndInstall(false, true);
      return {
        installed: true,
        version: update.latestVersion,
        message: "Installing update and restarting OMP Desktop",
      };
    } catch (error) {
      const message = messageFromError(error);
      log.error("[auto-updater] failed to install update", error);
      return { installed: false, version: null, message };
    }
  });
}

function waitForAbort(signal: AbortSignal): Promise<null> {
  if (signal.aborted) {
    return Promise.resolve(null);
  }
  const { promise, resolve } = Promise.withResolvers<null>();
  signal.addEventListener("abort", () => resolve(null), { once: true });
  return promise;
}

export async function installAppUpdateOnQuit({
  currentVersion,
  releaseChannel,
  signal,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  signal: AbortSignal;
}): Promise<boolean> {
  if (downloadedUpdateChannel !== releaseChannel) {
    return false;
  }

  const update = await Promise.race([
    runUpdateOperation(() => checkAndDownloadUpdate({ currentVersion, releaseChannel })),
    waitForAbort(signal),
  ]);
  if (!update || signal.aborted || !update.readyToInstall) {
    return false;
  }

  autoUpdater.autoRunAppAfterInstall = false;
  autoUpdater.quitAndInstall(false, false);
  return true;
}
