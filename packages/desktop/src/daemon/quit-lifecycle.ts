import type { DesktopSettingsStore } from "../settings/desktop-settings.js";

interface QuitLifecycleSettings {
  daemon: {
    keepRunningAfterQuit: boolean;
  };
}

interface BeforeQuitEvent {
  preventDefault(): void;
}

interface BeforeQuitApp {
  exit(code: number): void;
  quit(): void;
}

interface ExternalQuitSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

interface QuitLifecycle {
  handleBeforeQuit(event: BeforeQuitEvent): void;
  handleBeforeQuitForUpdate(): void;
}

interface DeferredUpdateQuit {
  promise: Promise<boolean>;
  resolve(): void;
}

export interface StopOnQuitDeps {
  settingsStore: Pick<DesktopSettingsStore, "get">;
  isDesktopManagedDaemonRunning: () => boolean;
  stopDaemon: () => Promise<unknown>;
  showShutdownFeedback: () => void;
}

export function registerExternalQuitSignals({
  signals,
  quit,
}: {
  signals: ExternalQuitSignalSource;
  quit: () => void;
}): void {
  let quitRequested = false;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
    signals.on(signal, () => {
      if (quitRequested) return;
      quitRequested = true;
      quit();
    });
  }
}

export function shouldStopDesktopManagedDaemonOnQuit(settings: QuitLifecycleSettings): boolean {
  return !settings.daemon.keepRunningAfterQuit;
}

export async function stopDesktopManagedDaemonOnQuitIfNeeded(
  deps: StopOnQuitDeps,
): Promise<boolean> {
  const settings = await deps.settingsStore.get();
  if (!shouldStopDesktopManagedDaemonOnQuit(settings)) {
    return false;
  }

  if (!deps.isDesktopManagedDaemonRunning()) {
    return false;
  }

  deps.showShutdownFeedback();
  await deps.stopDaemon();
  return true;
}

function waitForUpdateDeadline(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
}

function createDeferredUpdateQuit(): DeferredUpdateQuit {
  let resolvePromise!: (started: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise(true) };
}

export function createQuitLifecycle({
  app,
  prepareToQuit,
  closeTransportSessions,
  stopDesktopManagedDaemonIfNeeded,
  installAppUpdateOnQuit,
  createUpdateDeadlineSignal,
  onPrepareError,
  onStopError,
  onUpdateError,
}: {
  app: BeforeQuitApp;
  prepareToQuit: () => Promise<void>;
  closeTransportSessions: () => void;
  stopDesktopManagedDaemonIfNeeded: () => Promise<boolean>;
  installAppUpdateOnQuit: (signal: AbortSignal) => Promise<boolean>;
  createUpdateDeadlineSignal: () => AbortSignal;
  onPrepareError: (error: unknown) => void;
  onStopError: (error: unknown) => void;
  onUpdateError: (error: unknown) => void;
}): QuitLifecycle {
  // Draft persistence can veto a normal quit. Only a successful preparation may
  // advance the daemon/update lifecycle or mark unrelated application windows as closing.
  let preparing = false;
  let quitting = false;
  let quittingForUpdate = false;
  let updateInstallationStarted = false;
  const updateQuit = createDeferredUpdateQuit();

  function handleBeforeQuit(event: BeforeQuitEvent): void {
    if (quitting && (quittingForUpdate || updateInstallationStarted)) {
      closeTransportSessions();
      // MacUpdater's no-relaunch path re-fires app.quit() without the update event.
      updateQuit.resolve();
      return;
    }
    event.preventDefault();
    if (preparing || quitting) return;
    preparing = true;

    void (async () => {
      try {
        await prepareToQuit();
      } catch (error) {
        preparing = false;
        onPrepareError(error);
        return;
      }
      preparing = false;
      quitting = true;
      closeTransportSessions();
      if (quittingForUpdate) {
        // Manual installation prepared before launch; its later quit still owns process exit.
        app.quit();
        return;
      }
      try {
        await stopDesktopManagedDaemonIfNeeded();
      } catch (error) {
        onStopError(error);
      }

      const signal = createUpdateDeadlineSignal();
      updateInstallationStarted = true;
      const updateInstallation = installAppUpdateOnQuit(signal).catch((error) => {
        onUpdateError(error);
        return false;
      });
      const installingUpdate = await Promise.race([
        updateInstallation,
        waitForUpdateDeadline(signal),
      ]);
      if (installingUpdate) {
        const handoffStarted = await Promise.race([
          updateQuit.promise,
          waitForUpdateDeadline(createUpdateDeadlineSignal()),
        ]);
        if (handoffStarted) return;
      }

      // No validated updater owns exit. Preserve the existing macOS
      // window-all-closed bypass, after actual monitor persistence has completed.
      app.exit(0);
    })();
  }

  return {
    handleBeforeQuit,
    handleBeforeQuitForUpdate() {
      quittingForUpdate = true;
      updateQuit.resolve();
    },
  };
}
