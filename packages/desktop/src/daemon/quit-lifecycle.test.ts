import { describe, expect, it } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  shouldStopDesktopManagedDaemonOnQuit,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./quit-lifecycle";

const SETTINGS_STOP_ON_QUIT = DEFAULT_DESKTOP_SETTINGS;
const SETTINGS_KEEP_RUNNING = {
  ...DEFAULT_DESKTOP_SETTINGS,
  daemon: {
    ...DEFAULT_DESKTOP_SETTINGS.daemon,
    keepRunningAfterQuit: true,
  },
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitForQuitLifecycle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("quit-lifecycle", () => {
  it("turns external termination signals into one Electron quit", () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const quits: string[] = [];

    registerExternalQuitSignals({
      signals: {
        on: (signal, listener) => {
          listeners.set(signal, listener);
        },
      },
      quit: () => quits.push("quit"),
    });

    expect(Array.from(listeners.keys())).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    listeners.get("SIGTERM")?.();
    listeners.get("SIGHUP")?.();
    expect(quits).toEqual(["quit"]);
  });

  it("stops by default and only keeps running when keepRunningAfterQuit is enabled", () => {
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_STOP_ON_QUIT)).toBe(true);
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_KEEP_RUNNING)).toBe(false);
  });

  it("short-circuits without inspecting the daemon when keep-running is on", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_KEEP_RUNNING },
      isDesktopManagedDaemonRunning: () => {
        events.push("inspect");
        return true;
      },
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not stop a manually started daemon on quit", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => false,
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(false);
    expect(events).toEqual([]);
  });

  it("shows feedback then stops a desktop-managed daemon", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(true);
    expect(events).toEqual(["feedback", "stop"]);
  });

  it("revalidates updates after daemon shutdown before exiting", async () => {
    const stopDecision = deferred<boolean>();
    const updateDecision = deferred<boolean>();
    const events: string[] = [];

    const quitLifecycle = createQuitLifecycle({
      app: {
        quit: () => events.push("quit"),
        exit: (code) => {
          events.push(`exit:${code}`);
        },
      },
      prepareToQuit: async () => {},
      closeTransportSessions: () => {
        events.push("close-transports");
      },
      stopDesktopManagedDaemonIfNeeded: () => stopDecision.promise,
      installAppUpdateOnQuit: () => updateDecision.promise,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: () => {
        events.push("prepare-error");
      },
      onStopError: () => {
        events.push("stop-error");
      },
      onUpdateError: () => {
        events.push("update-error");
      },
    });

    quitLifecycle.handleBeforeQuit({
      preventDefault: () => {
        events.push("prevent-default");
      },
    });

    expect(events).toEqual(["prevent-default"]);
    await waitForQuitLifecycle();
    expect(events).toEqual(["prevent-default", "close-transports"]);

    events.push("daemon-stopped");
    stopDecision.resolve(false);
    await waitForQuitLifecycle();

    expect(events).toEqual(["prevent-default", "close-transports", "daemon-stopped"]);

    events.push("update-checked");
    updateDecision.resolve(false);
    await waitForQuitLifecycle();

    expect(events).toEqual([
      "prevent-default",
      "close-transports",
      "daemon-stopped",
      "update-checked",
      "exit:0",
    ]);

    quitLifecycle.handleBeforeQuit({
      preventDefault: () => {
        events.push("second-prevent-default");
      },
    });

    expect(events.at(-1)).toBe("close-transports");
    expect(events).not.toContain("second-prevent-default");
  });

  it("lets the updater own process exit when a validated update is installing", async () => {
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code), quit: () => {} },
      prepareToQuit: async () => {},
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: () => {},
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    quitLifecycle.handleBeforeQuitForUpdate();
    await waitForQuitLifecycle();

    expect(exits).toEqual([]);
  });

  it("recognizes a repeated quit as updater handoff", async () => {
    const exits: number[] = [];
    let preventedQuitCount = 0;
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code), quit: () => {} },
      prepareToQuit: async () => {},
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: () => {},
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => preventedQuitCount++ });
    await waitForQuitLifecycle();
    quitLifecycle.handleBeforeQuit({ preventDefault: () => preventedQuitCount++ });
    await waitForQuitLifecycle();

    expect(preventedQuitCount).toBe(1);
    expect(exits).toEqual([]);
  });

  it("exits when the updater does not take ownership before its deadline", async () => {
    const revalidationDeadline = new AbortController();
    const handoffDeadline = new AbortController();
    let deadlineCount = 0;
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code), quit: () => {} },
      prepareToQuit: async () => {},
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () =>
        deadlineCount++ === 0 ? revalidationDeadline.signal : handoffDeadline.signal,
      onStopError: () => {},
      onPrepareError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    handoffDeadline.abort();
    await waitForQuitLifecycle();

    expect(exits).toEqual([0]);
  });

  it("prepares live settings before resuming a manual update's own quit", async () => {
    const preparation = Promise.withResolvers<void>();
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: {
        exit: (code) => events.push(`exit:${code}`),
        quit: (): void => {
          events.push("resume-update-quit");
          quitLifecycle.handleBeforeQuit({
            preventDefault: () => events.push("unexpected-second-veto"),
          });
        },
      },
      prepareToQuit: () => preparation.promise,
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("stop-daemon");
        return false;
      },
      installAppUpdateOnQuit: async () => {
        events.push("revalidate-update");
        return false;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: () => events.push("prepare-error"),
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });

    quitLifecycle.handleBeforeQuitForUpdate();
    quitLifecycle.handleBeforeQuit({ preventDefault: () => events.push("prevent-default") });
    expect(events).toEqual(["prevent-default"]);
    preparation.resolve();
    await waitForQuitLifecycle();
    expect(events).toEqual([
      "prevent-default",
      "close-transports",
      "resume-update-quit",
      "close-transports",
    ]);
  });

  it("exits when update revalidation reaches its deadline", async () => {
    const deadline = new AbortController();
    const updateDecision = deferred<boolean>();
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code), quit: () => {} },
      prepareToQuit: async () => {},
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: () => updateDecision.promise,
      createUpdateDeadlineSignal: () => deadline.signal,
      onStopError: () => {},
      onPrepareError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    deadline.abort();
    await waitForQuitLifecycle();

    expect(exits).toEqual([0]);

    updateDecision.resolve(true);
    await waitForQuitLifecycle();
    expect(exits).toEqual([0]);
  });
  it("coalesces repeated quit requests while real save preparation is pending and never treats them as updater handoff", async () => {
    const preparation = Promise.withResolvers<void>(),
      daemon = Promise.withResolvers<boolean>();
    const events: string[] = [];
    let preparations = 0;
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`), quit: () => events.push("quit") },
      prepareToQuit: async () => {
        preparations++;
        await preparation.promise;
      },
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: () => daemon.promise,
      installAppUpdateOnQuit: async () => {
        events.push("check-update");
        return false;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: () => events.push("prepare-error"),
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });
    const event = { preventDefault: () => events.push("veto") };
    quitLifecycle.handleBeforeQuit(event);
    quitLifecycle.handleBeforeQuit(event);
    await waitForQuitLifecycle();
    expect(preparations).toBe(1);
    expect(events).toEqual(["veto", "veto"]);
    preparation.resolve();
    await waitForQuitLifecycle();
    quitLifecycle.handleBeforeQuit(event);
    expect(events).toEqual(["veto", "veto", "close-transports", "veto"]);
    daemon.resolve(false);
    await waitForQuitLifecycle();
    expect(events.slice(-2)).toEqual(["check-update", "exit:0"]);
  });

  it("vetoes failed genuine draft preparation without daemon, transport or update side effects and permits a later retry", async () => {
    const failure = new Error("Settings title draft could not be saved");
    const errors: unknown[] = [],
      events: string[] = [];
    let attempts = 0;
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`), quit: () => events.push("quit") },
      prepareToQuit: async () => {
        if (++attempts === 1) throw failure;
      },
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("stop-daemon");
        return false;
      },
      installAppUpdateOnQuit: async () => {
        events.push("check-update");
        return false;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: (error) => errors.push(error),
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });
    const event = { preventDefault: () => events.push("veto") };
    quitLifecycle.handleBeforeQuit(event);
    await waitForQuitLifecycle();
    expect(errors).toEqual([failure]);
    expect(events).toEqual(["veto"]);
    quitLifecycle.handleBeforeQuit(event);
    await waitForQuitLifecycle();
    expect(attempts).toBe(2);
    expect(events).toEqual([
      "veto",
      "veto",
      "close-transports",
      "stop-daemon",
      "check-update",
      "exit:0",
    ]);
  });
});
