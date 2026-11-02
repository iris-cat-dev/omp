import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import type { MessagePort } from "node:worker_threads";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventEmitter } from "node:events";
import { screen } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { OmpMonitorController } from "./controller.js";
import { createQuitLifecycle } from "../daemon/quit-lifecycle.js";
import { downloadAndInstallUpdate } from "../features/auto-updater.js";
import { OmpMonitorWorker } from "./worker.js";
import type {
  OmpMonitorRoot,
  OmpMonitorScope,
  OmpMonitorSnapshot,
  OmpMonitorWorkerRequest,
  OmpMonitorWorkerResponse,
} from "./types.js";
import type { OmpMonitorSurface, OmpMonitorViewState } from "./view-types.js";
import type { OmpTitleThemeResult } from "./title-themes.js";
import type * as WindowChrome from "./window-chrome.js";
import type { OmpMonitorPerfCardRequest, OmpMonitorPerfCardState } from "./perf-card-types.js";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
type MockWindow = EventEmitter & {
  options: Record<string, unknown>;
  bounds: Bounds;
  contentInsets: { left: number; top: number; right: number; bottom: number };
  url: string | null;
  inputChanges: Array<{ ignored: boolean; visible: boolean; loaded: boolean }>;
  focus: Mock;
  showInactive: Mock;
  visible: boolean;
  minimized: boolean;
  destroyed: boolean;
  loaded: boolean;
  draftLocked: boolean;
  title: string;
  closeRequests: number;
  ignored: boolean;
  pinned: boolean;
  webContents: EventEmitter & {
    id: number;
    mainFrame: object;
    send: Mock;
    setWindowOpenHandler: Mock;
  };
  setTitle: (value: string) => void;
  destroy: () => void;
  close: () => void;
  hide: () => void;
  getBounds: () => Bounds;
  getContentBounds: () => Bounds;
  setBounds: (value: Bounds) => void;
  setIgnoreMouseEvents: (value: boolean) => void;
};
type MockWorker = EventEmitter & {
  options: {
    workerData: {
      roots?: OmpMonitorRoot[];
      cacheDir: string;
      sourceEnabled?: boolean;
      pricingRecoveryRequired?: boolean;
    };
  };
  postMessage: Mock;
  terminate: Mock;
};
type TestWorkerPort = EventEmitter & {
  postMessage(message: OmpMonitorWorkerResponse): void;
  close(): void;
};
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => unknown>(),
  listeners: new Map<string, (event: unknown, value?: unknown) => unknown>(),
  windows: [] as MockWindow[],
  workers: [] as MockWorker[],
  area: { x: 0, y: 0, width: 1920, height: 1040 },
  cursor: { x: 0, y: 0 },
  userData: "",
  now: Date.UTC(2026, 9, 24, 12),
  save: vi.fn(),
  confirm: vi.fn(),
  openFolder: vi.fn(),
  autoShutdown: true,
  createWorker: null as ((port: TestWorkerPort, input: unknown) => void) | null,
  beforeRename: undefined as ((source: string, target: string) => Promise<void>) | undefined,
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  menu: [] as Array<Record<string, unknown>>,
  inputError: null as "startup" | "set" | null,
  loginEnabled: false,
  loginReadError: false,
  loginWriteError: false,
  loginWrites: vi.fn(),
  chromeCreated: vi.fn(),
  chromeApply: vi.fn(),
  loadWindow: vi.fn(),
  flushDraft: vi.fn(),
  releaseDraft: vi.fn(),
  theme: null as (EventEmitter & { shouldUseDarkColors: boolean; themeSource: string }) | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    async rename(...args: Parameters<typeof actual.rename>) {
      await mock.beforeRename?.(String(args[0]), String(args[1]));
      return actual.rename(...args);
    },
  };
});
vi.mock("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: mock.checkForUpdates,
    downloadUpdate: mock.downloadUpdate,
    quitAndInstall: mock.quitAndInstall,
    setFeedURL: vi.fn(),
    on: vi.fn(),
  },
}));
vi.mock("electron-log/main", () => ({
  default: { error: vi.fn() },
}));
vi.mock("../distribution.js", () => ({ PRIVATE_PLUGIN_DISTRIBUTION: false }));
vi.mock("../window/main-windows.js", () => ({
  isMainWindowSender: (sender: { main?: boolean }) => sender.main === true,
}));
vi.mock("../settings/desktop-settings-electron.js", async () => {
  // This hoisted mock factory runs before static test imports initialize; load the real policy inside that boundary.
  const { createLaunchAtLoginController } = await import("../settings/launch-at-login.js");
  return {
    launchAtLoginController: createLaunchAtLoginController({
      platform: "win32",
      getLoginItemSettings: () => {
        if (mock.loginReadError) throw new Error("Login status unavailable");
        return { openAtLogin: mock.loginEnabled };
      },
      setLoginItemSettings: ({ openAtLogin }) => {
        if (mock.loginWriteError) throw new Error("Login write refused");
        mock.loginWrites(openAtLogin);
        mock.loginEnabled = openAtLogin;
      },
    }),
  };
});
vi.mock("./window-input.js", () => ({
  createMonitorWindowInput() {
    if (mock.inputError === "startup") throw new Error("Native binding unavailable");
    return {
      setIgnored(window: Pick<MockWindow, "setIgnoreMouseEvents">, ignored: boolean) {
        if (mock.inputError === "set") throw new Error("Native input update failed");
        window.setIgnoreMouseEvents(ignored);
      },
    };
  },
}));
vi.mock("./window-chrome.js", async (importOriginal) => {
  const original = await importOriginal<typeof WindowChrome>();
  return {
    ...original,
    createMonitorWindowChrome() {
      mock.chromeCreated();
      return { apply: mock.chromeApply, measure: vi.fn() };
    },
    flushMonitorSettingsDraft: (window: MockWindow) => mock.flushDraft(window),
    releaseMonitorSettingsDraftLock: (window: MockWindow) => mock.releaseDraft(window),
  };
});
vi.mock("node:worker_threads", async () => {
  // Hoisted vi.mock factories run before static imports initialize; load the emitter inside this module-loading boundary.
  const { EventEmitter: Emitter } = await import("node:events");
  class Worker extends Emitter {
    private port: TestWorkerPort | null = null;
    postMessage = vi.fn((request: OmpMonitorWorkerRequest) => {
      if (this.port) {
        this.port.emit("message", request);
      } else if (request.type === "pricing.configure") {
        queueMicrotask(() =>
          this.emit("message", {
            type: "command-result",
            requestId: request.requestId,
            ok: true,
          }),
        );
      } else if (request.type === "shutdown" && mock.autoShutdown) {
        queueMicrotask(() => {
          this.emit("message", { type: "command-result", requestId: request.requestId, ok: true });
          this.emit("exit", 0);
        });
      }
    });
    terminate = vi.fn(async () => {
      this.port?.emit("close");
      return 0;
    });
    constructor(
      _script: string,
      public options: MockWorker["options"],
    ) {
      super();
      mock.workers.push(this);
      if (mock.createWorker) {
        const port = Object.assign(new Emitter(), {
          postMessage: (message: OmpMonitorWorkerResponse) => {
            this.emit("message", message);
          },
          close: () => {
            port.emit("close");
            queueMicrotask(() => this.emit("exit", 0));
          },
        });
        this.port = port;
        mock.createWorker(port, options.workerData);
      }
    }
  }
  return { Worker, parentPort: null, workerData: null };
});
vi.mock("electron", async () => {
  // Hoisted vi.mock factories run before static imports initialize; load the emitter inside this module-loading boundary.
  const { EventEmitter: Emitter } = await import("node:events");
  class Window extends Emitter {
    destroyed = false;
    visible = false;
    minimized = false;
    ignored = true;
    loaded = false;
    draftLocked = false;
    title: string;
    closeRequests = 0;
    pinned: boolean;
    bounds: Bounds;
    contentInsets = { left: 0, top: 0, right: 0, bottom: 0 };
    url: string | null = null;
    inputChanges: Array<{ ignored: boolean; visible: boolean; loaded: boolean }> = [];
    webContents = Object.assign(new Emitter(), {
      id: mock.windows.length + 1,
      mainFrame: {},
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => this.destroyed,
    });
    constructor(public options: Record<string, unknown>) {
      super();
      this.pinned = options.alwaysOnTop === true;
      this.title = String(options.title ?? "");
      this.bounds = {
        x: Number(options.x),
        y: Number(options.y),
        width: Number(options.width),
        height: Number(options.height),
      };
      mock.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return this.minimized;
    }
    show() {
      this.visible = true;
      this.emit("show");
    }
    showInactive = vi.fn(() => {
      this.show();
    });
    hide() {
      this.visible = false;
      this.emit("hide");
    }
    focus = vi.fn();
    restore() {
      this.minimized = false;
      this.emit("restore");
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
    close() {
      if (this.destroyed) return;
      this.closeRequests++;
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      this.emit("close", event);
      if (!event.defaultPrevented) this.destroy();
    }
    async loadURL(url: string) {
      this.url = url;
      await mock.loadWindow(this);
      this.loaded = true;
    }
    setTitle(value: string) {
      this.title = value;
    }
    getBounds() {
      return { ...this.bounds };
    }
    getContentBounds() {
      const { left, top, right, bottom } = this.contentInsets;
      return {
        x: this.bounds.x + left,
        y: this.bounds.y + top,
        width: this.bounds.width - left - right,
        height: this.bounds.height - top - bottom,
      };
    }
    setBounds(value: Bounds) {
      this.bounds = { ...value };
    }
    setAlwaysOnTop(value: boolean) {
      this.pinned = value;
    }
    setIgnoreMouseEvents(value: boolean) {
      this.inputChanges.push({ ignored: value, visible: this.visible, loaded: this.loaded });
      this.ignored = value;
    }
  }
  return {
    app: { getLocale: () => "zh-CN", getPath: () => mock.userData },
    BrowserWindow: Window,
    nativeTheme: (mock.theme = Object.assign(new Emitter(), {
      shouldUseDarkColors: false,
      themeSource: "system",
    })),
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, value?: unknown) => unknown) =>
        mock.handlers.set(channel, handler),
      removeHandler: (channel: string) => mock.handlers.delete(channel),
      on: (channel: string, listener: (event: unknown, value?: unknown) => unknown) =>
        mock.listeners.set(channel, listener),
      removeListener: (channel: string) => mock.listeners.delete(channel),
    },
    dialog: {
      showSaveDialog: mock.save,
      showMessageBox: mock.confirm,
      showOpenDialog: mock.openFolder,
    },
    Menu: {
      buildFromTemplate: (template: Array<Record<string, unknown>>) => {
        mock.menu = template;
        return { popup() {} };
      },
    },
    screen: Object.assign(new Emitter(), {
      getPrimaryDisplay: () => ({ id: "primary", workArea: mock.area }),
      getAllDisplays: () => [{ id: "primary", workArea: mock.area }],
      getCursorScreenPoint: () => ({ ...mock.cursor }),
    }),
  };
});
const controllers: OmpMonitorController[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  mock.handlers.clear();
  mock.listeners.clear();
  mock.windows.length = 0;
  mock.workers.length = 0;
  mock.area = { x: 0, y: 0, width: 1920, height: 1040 };
  mock.cursor = { x: 0, y: 0 };
  mock.now = Date.UTC(2026, 9, 24, 12);
  mock.userData = await mkdtemp(path.join(tmpdir(), "omp-monitor-controller-"));
  mock.save.mockReset().mockResolvedValue({ canceled: true });
  mock.confirm.mockReset().mockResolvedValue({ response: 0 });
  mock.openFolder.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  mock.autoShutdown = true;
  mock.createWorker = null;
  mock.beforeRename = undefined;
  mock.checkForUpdates.mockReset().mockResolvedValue({
    isUpdateAvailable: true,
    updateInfo: { version: "1.6.2", releaseNotes: null, releaseDate: null },
  });
  mock.downloadUpdate.mockReset().mockResolvedValue(["owned-update.exe"]);
  mock.quitAndInstall.mockReset();
  vi.stubEnv("PASEO_DISABLE_APP_UPDATES", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Controller tests must stay offline")),
  );
  vi.stubEnv("USERPROFILE", mock.userData);
  vi.stubEnv("HOME", mock.userData);
  vi.stubEnv("PI_CONFIG_DIR", ".owned-omp");
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(mock.userData, "owned-default-agent"));
  vi.stubEnv("XDG_DATA_HOME", "");
  mock.menu = [];
  mock.inputError = null;
  mock.loginEnabled = false;
  mock.loginReadError = false;
  mock.loginWriteError = false;
  mock.loginWrites.mockReset();
  mock.chromeCreated.mockReset();
  mock.loadWindow.mockReset().mockResolvedValue(undefined);
  mock.chromeApply.mockReset().mockImplementation((window: MockWindow) => {
    if (!window.loaded || window.destroyed)
      throw new Error("Native chrome touched an unready or destroyed window");
    return { clientMaterial: "opaque" };
  });
  mock.flushDraft.mockReset().mockImplementation(async (window: MockWindow) => {
    window.draftLocked = true;
  });
  mock.releaseDraft.mockReset().mockImplementation(async (window: MockWindow) => {
    window.draftLocked = false;
  });
  mock.theme!.shouldUseDarkColors = false;
  mock.theme!.themeSource = "system";
  vi.spyOn(Date, "now").mockImplementation(() => mock.now);
});
afterEach(async () => {
  mock.beforeRename = undefined;
  for (const instance of controllers) await instance.dispose();
  expect(mock.theme!.listenerCount("updated")).toBe(0);
  controllers.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(mock.userData, { recursive: true, force: true });
});
function controller(
  options: { roots?: OmpMonitorRoot[] } = {
    roots: [{ path: "C:/isolated-fixture", label: "fixture" }],
  },
): OmpMonitorController {
  const instance = new OmpMonitorController(options);
  controllers.push(instance);
  instance.initialize();
  return instance;
}
async function durableWorkerController(): Promise<OmpMonitorController> {
  const cacheDir = path.join(mock.userData, "local-monitor");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, "sources.json"),
    JSON.stringify({
      version: 1,
      enabled: false,
      folder: null,
    }),
  );
  await writeFile(
    path.join(cacheDir, "pricing-settings.json"),
    JSON.stringify({
      schema: 1,
      networkEnabled: true,
      autoSyncPrices: true,
      currency: "USD",
    }),
  );
  mock.createWorker = (port, input) => {
    new OmpMonitorWorker(port as unknown as MessagePort, input).start();
  };
  const instance = controller({ roots: [] });
  await instance.open();
  return instance;
}
function invoke(
  channel: string,
  window: MockWindow,
  value?: unknown,
  frame = window.webContents.mainFrame,
): unknown {
  const handler = mock.handlers.get("paseo:monitor:" + channel);
  if (!handler) throw new Error("Missing test handler");
  return handler({ sender: window.webContents, senderFrame: frame }, value);
}
function state(window: MockWindow): OmpMonitorViewState {
  return invoke("ready", window) as OmpMonitorViewState;
}
function surfaces(surface: OmpMonitorSurface): MockWindow[] {
  return mock.windows.filter(
    (window) =>
      !window.destroyed &&
      window.url !== "omp-desktop://monitor/local-perf-card" &&
      state(window).surface === surface,
  );
}
function snapshot(scope: OmpMonitorScope = { profile: null, project: null }): OmpMonitorSnapshot {
  const usage = {
    requests: 1,
    failedRequests: 0,
    inputTokens: 100,
    outputTokens: 40,
    reasoningTokens: 0,
    reasoningKnownRequests: 0,
    reasoningKnownOutputTokens: 0,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    totalTokens: 150,
    costUsd: 0.01,
    unpricedRequests: 0,
    estimatedCostUsd: 0.02,
    unestimatedRequests: 0,
    measuredOutputTokens: 40,
    measuredDurationMs: 1000,
    peakOutputTps: 40,
    peakTotalTps: 150,
  };
  const feed = {
    status: "bundled" as const,
    version: "fixture",
    updatedAt: null,
    fetchedAt: null,
    lastAttemptAt: null,
    source: "fixture",
  };
  return {
    updatedAt: mock.now,
    scope,
    scopes: { profiles: ["default", "second"], projects: ["A", "B"] },
    resources: {
      status: "unavailable",
      sampledAt: 0,
      processCount: 0,
      cpuPercent: null,
      workingSetBytes: null,
      privateBytes: null,
      reason: "no_processes",
    },
    pricing: {
      networkEnabled: false,
      autoSyncPrices: true,
      currency: "USD",
      currencies: ["USD", "CNY"],
      prices: feed,
      rates: feed,
      exchangeRate: 1,
      attribution: null,
    },
    status: "ready",
    rate: {
      measuredTps: 40,
      estimatedTps: 0,
      measuredTotalTps: 150,
      estimatedTotalTps: 0,
      estimatedShare: 0,
      measuredThinkingTps: null,
      estimatedThinkingTps: null,
    },
    activity: {
      lastResponseAt: null,
      peakAt: null,
      peakObservedAt: null,
      totalPeakAt: null,
      totalPeakObservedAt: null,
    },
    today: usage,
    days: [{ ...usage, date: "2026-10-24", agentCount: 1 }],
    breakdowns: { models: [], modes: [] },
    historyRange: {
      startDate: "2026-10-24",
      endDate: "2026-10-24",
      limited: false,
      scanning: false,
    },
    performance: { current: {}, records: [], baselines: [], scanning: false, limited: false },
    agents: [],
    series: [],
    coverage: {
      roots: [{ label: "fixture", available: true }],
      discoveredFiles: 1,
      readFiles: 1,
      skippedFiles: 0,
      malformedLines: 0,
      limited: false,
      issues: [],
    },
  };
}
function publish(window: MockWindow, value = snapshot(), worker = mock.workers.at(-1)!): void {
  worker.emit("message", {
    type: "snapshots",
    snapshots: [{ scopeId: state(window).instanceId, snapshot: value }],
  });
}
function interact(window: MockWindow, value: boolean, frame = window.webContents.mainFrame): void {
  mock.listeners.get("paseo:monitor:interactive")!(
    { sender: window.webContents, senderFrame: frame },
    value,
  );
}

describe("native monitor save-before-close lifecycle", () => {
  it("uses original outer native panel metrics, titles and resolved appearance without changing the global theme", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const instance = controller();
      await instance.open();
      const orb = surfaces("orb")[0]!,
        dashboard = surfaces("dashboard")[0]!;
      expect(dashboard.options).toMatchObject({ frame: false, width: 368 });
      expect(mock.chromeApply).not.toHaveBeenCalled();
      const nativeLoad = Promise.withResolvers<void>();
      mock.loadWindow.mockImplementationOnce(() => nativeLoad.promise);
      const settingsOpening = invoke("surface", orb, "settings") as Promise<void>;
      const settingsReopening = invoke("surface", orb, "settings") as Promise<void>;
      const settings = surfaces("settings")[0]!;
      expect(settings.loaded).toBe(false);
      expect(settings.visible).toBe(false);
      mock.theme!.emit("updated");
      expect(mock.chromeApply).not.toHaveBeenCalled();
      nativeLoad.resolve();
      await Promise.all([settingsOpening, settingsReopening]);
      await invoke("surface", orb, "history");
      const history = surfaces("history")[0]!;
      expect(settings.options).toMatchObject({
        frame: true,
        transparent: false,
        useContentSize: false,
        width: 900,
        height: 680,
        minWidth: 680,
        minHeight: 480,
      });
      expect(history.options).toMatchObject({
        frame: true,
        transparent: false,
        useContentSize: false,
        width: 920,
        height: 680,
        minWidth: 720,
        minHeight: 540,
      });
      expect(settings.title).toBe("Agent Speed · 设置");
      expect(history.title).toBe("用量历史");
      expect(mock.chromeCreated).toHaveBeenCalledTimes(1);
      expect(mock.chromeApply.mock.calls).toEqual([
        [settings, "light"],
        [history, "light"],
      ]);
      mock.theme!.shouldUseDarkColors = true;
      mock.theme!.emit("updated");
      expect(mock.chromeApply.mock.calls.slice(-2)).toEqual([
        [settings, "dark"],
        [history, "dark"],
      ]);
      await invoke("configure", settings, { language: "en" });
      expect(settings.title).toBe("Agent Speed · Settings");
      expect(history.title).toBe("Usage History");
      expect(mock.chromeApply.mock.calls.slice(-2)).toEqual([
        [settings, "dark"],
        [history, "dark"],
      ]);
      await invoke("configure", settings, { appearance: "light" });
      expect(mock.chromeApply.mock.calls.slice(-2)).toEqual([
        [settings, "light"],
        [history, "light"],
      ]);
      expect(mock.theme!.themeSource).toBe("system");
      await instance.dispose();
      const calls = mock.chromeApply.mock.calls.length;
      mock.theme!.emit("updated");
      expect(mock.chromeApply).toHaveBeenCalledTimes(calls);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("cancels native X synchronously, coalesces rapid closes and flushes genuine queued title edits before one native retry", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    const copied = (await invoke("title-theme", settings, {
      type: "copy",
      sourceId: "vehicles",
      language: "en",
    })) as OmpTitleThemeResult;
    const started = Promise.withResolvers<void>(),
      draft = Promise.withResolvers<void>();
    mock.flushDraft.mockImplementationOnce(async (window: MockWindow) => {
      window.draftLocked = true;
      started.resolve();
      await draft.promise;
      const saved = (await invoke("title-theme", window, {
        type: "setField",
        id: copied.selected,
        level: 1,
        text: "Native-close draft",
        language: "en",
      })) as OmpTitleThemeResult;
      if (!saved.ok) throw new Error("Genuine editor command failed");
      await invoke("configure", window, { orbName: "Saved before native X" });
    });
    settings.close();
    expect(settings.destroyed).toBe(false);
    const closing = invoke("close", settings) as Promise<void>;
    expect(invoke("close", settings)).toBe(closing);
    settings.close();
    await started.promise;
    expect(mock.flushDraft).toHaveBeenCalledTimes(1);
    expect(settings.draftLocked).toBe(true);
    expect(settings.destroyed).toBe(false);
    draft.resolve();
    await closing;
    expect(settings.destroyed).toBe(true);
    expect(settings.closeRequests).toBe(3); // Two cancelled X events, one permitted native retry.
    expect(mock.releaseDraft).not.toHaveBeenCalled();
    const titles = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "titles-v161.json"), "utf8"),
    );
    expect(titles.custom[0].titles[0]).toBe("Native-close draft");
    const preferences = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(preferences.orbs[0].preferences.orbName).toBe("Saved before native X");
  });

  it("reports a real flush failure, restores editor input and permits an explicit successful retry", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      failure = new Error("Owned title file is locked");
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mock.flushDraft.mockImplementationOnce(async (window: MockWindow) => {
      window.draftLocked = true;
      throw failure;
    });
    settings.close();
    await expect(invoke("close", settings)).rejects.toBe(failure);
    expect(settings.destroyed).toBe(false);
    expect(settings.draftLocked).toBe(false);
    expect(settings.closeRequests).toBe(1);
    expect(mock.releaseDraft).toHaveBeenCalledWith(settings);
    expect(state(settings).preferenceError).toBe(true);
    expect(reported).toHaveBeenCalledWith(expect.any(String), failure);
    await invoke("close", settings);
    expect(settings.destroyed).toBe(true);
    expect(settings.closeRequests).toBe(2);
  });

  it("does not hide input-lock recovery failure or destroy the editor", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      saveError = new Error("Save rejected"),
      lockError = new Error("Recovery hook rejected");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mock.flushDraft.mockImplementationOnce(async (window: MockWindow) => {
      window.draftLocked = true;
      throw saveError;
    });
    mock.releaseDraft.mockRejectedValueOnce(lockError);
    await expect(invoke("close", settings)).rejects.toMatchObject({
      name: "AggregateError",
      errors: [saveError, lockError],
    });
    expect(settings.destroyed).toBe(false);
    expect(settings.draftLocked).toBe(true);
    expect(settings.closeRequests).toBe(0);
    await invoke("close", settings);
    expect(settings.destroyed).toBe(true);
  });

  it("treats native cancellation after a successful flush as a recoverable failed close", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const veto = (event: { preventDefault(): void }) => event.preventDefault();
    settings.on("close", veto);
    await expect(invoke("close", settings)).rejects.toThrow("cancelled");
    expect(settings.destroyed).toBe(false);
    expect(settings.draftLocked).toBe(false);
    settings.removeListener("close", veto);
    await invoke("close", settings);
    expect(settings.destroyed).toBe(true);
    expect(mock.flushDraft).toHaveBeenCalledTimes(2);
  });

  it("persists before close-all destroys any window and closes Settings before its dependent windows", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      started = Promise.withResolvers<void>(),
      draft = Promise.withResolvers<void>();
    const order: string[] = [];
    for (const [name, window] of [
      ["settings", settings],
      ["orb", orb],
      ["dashboard", dashboard],
    ] as const)
      window.on("closed", () => order.push(name));
    mock.flushDraft.mockImplementationOnce(async (window: MockWindow) => {
      window.draftLocked = true;
      started.resolve();
      await draft.promise;
      await invoke("configure", window, { orbName: "Close-all durable preference" });
    });
    const closing = invoke("close-all", orb) as Promise<void>;
    expect(invoke("close-all", orb)).toBe(closing);
    await started.promise;
    expect(mock.windows.every((window) => !window.destroyed)).toBe(true);
    expect(order).toEqual([]);
    draft.resolve();
    await closing;
    expect(order[0]).toBe("settings");
    expect(new Set(order)).toEqual(new Set(["settings", "orb", "dashboard"]));
    expect(mock.flushDraft).toHaveBeenCalledTimes(1);
    const preferences = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(preferences.orbs[0].preferences.orbName).toBe("Close-all durable preference");
  });

  it("vetoes native Quit monitor and disposal when real preference persistence fails, then retries without losing windows", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    await invoke("configure", settings, { language: "en" });
    const preferenceFile = path.join(mock.userData, "local-monitor", "windows.json");
    await rm(preferenceFile);
    await mkdir(preferenceFile);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    invoke("menu", orb);
    const quitMonitor = mock.menu.find((item) => item.label === "Quit monitor")!;
    (quitMonitor.click as () => void)();
    await expect(invoke("close-all", orb)).rejects.toThrow();
    expect(mock.windows.every((window) => !window.destroyed)).toBe(true);
    expect(settings.draftLocked).toBe(false);
    await expect(instance.dispose()).rejects.toThrow();
    expect(mock.handlers.size).toBeGreaterThan(0);
    expect(settings.destroyed).toBe(false);
    await rm(preferenceFile, { recursive: true });
    await instance.dispose();
    expect(mock.windows.every((window) => window.destroyed)).toBe(true);
    expect(mock.handlers.size).toBe(0);
  });

  it("gates a dependent orb close on its live Settings editor instead of destroying the editor in closed", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      started = Promise.withResolvers<void>(),
      draft = Promise.withResolvers<void>();
    mock.flushDraft.mockImplementationOnce(async (window: MockWindow) => {
      window.draftLocked = true;
      started.resolve();
      await draft.promise;
      await invoke("configure", window, { appearance: "light" });
    });
    orb.close();
    const closing = invoke("close", orb) as Promise<void>;
    await started.promise;
    expect(settings.destroyed).toBe(false);
    expect(orb.destroyed).toBe(false);
    draft.resolve();
    await closing;
    expect(settings.destroyed).toBe(true);
    expect(orb.destroyed).toBe(true);
  });

  it("coalesces disposal, leaves command IPC alive for the real flush queue and waits before teardown", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      started = Promise.withResolvers<void>(),
      draft = Promise.withResolvers<void>();
    mock.flushDraft.mockImplementationOnce(async (window: MockWindow) => {
      window.draftLocked = true;
      started.resolve();
      await draft.promise;
      await invoke("configure", window, { orbName: "Dispose waits for genuine queue" });
    });
    const disposing = instance.dispose();
    expect(instance.dispose()).toBe(disposing);
    await started.promise;
    expect(mock.handlers.has("paseo:monitor:title-theme")).toBe(true);
    expect(settings.destroyed).toBe(false);
    expect(mock.workers[0]!.terminate).not.toHaveBeenCalled();
    draft.resolve();
    await disposing;
    expect(settings.destroyed).toBe(true);
    expect(mock.handlers.size).toBe(0);
    const preferences = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(preferences.orbs[0].preferences.orbName).toBe("Dispose waits for genuine queue");
  });
  it("makes real app quit wait for controller draft recovery, genuine queued writes and disposal before unrelated shutdown", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      failure = new Error("Owned draft storage denied");
    const failed = Promise.withResolvers<unknown>(),
      started = Promise.withResolvers<void>();
    const draft = Promise.withResolvers<void>(),
      exited = Promise.withResolvers<void>();
    const events: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mock.flushDraft
      .mockImplementationOnce(async (window: MockWindow) => {
        window.draftLocked = true;
        throw failure;
      })
      .mockImplementationOnce(async (window: MockWindow) => {
        window.draftLocked = true;
        started.resolve();
        await draft.promise;
        await invoke("configure", window, { orbName: "App quit saved draft" });
      });
    const lifecycle = createQuitLifecycle({
      app: {
        quit: () => events.push("quit"),
        exit: () => {
          events.push("exit");
          exited.resolve();
        },
      },
      prepareToQuit: async () => {
        await instance.dispose();
        events.push("other-window-shutdown");
      },
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("stop-daemon");
        return false;
      },
      installAppUpdateOnQuit: async () => false,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: (error) => failed.resolve(error),
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });
    const event = { preventDefault: () => events.push("veto") };
    lifecycle.handleBeforeQuit(event);
    expect(await failed.promise).toBe(failure);
    expect(events).toEqual(["veto"]);
    expect(settings.destroyed).toBe(false);
    expect(settings.draftLocked).toBe(false);
    expect(mock.handlers.size).toBeGreaterThan(0);
    lifecycle.handleBeforeQuit(event);
    lifecycle.handleBeforeQuit(event);
    await started.promise;
    expect(events).toEqual(["veto", "veto", "veto"]);
    expect(settings.destroyed).toBe(false);
    draft.resolve();
    await exited.promise;
    expect(events.slice(3)).toEqual([
      "other-window-shutdown",
      "close-transports",
      "stop-daemon",
      "exit",
    ]);
    expect(mock.flushDraft).toHaveBeenCalledTimes(2);
    expect(mock.handlers.size).toBe(0);
    const preferences = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(preferences.orbs[0].preferences.orbName).toBe("App quit saved draft");
  });
});

describe("monitor worker durable settings lifecycle", () => {
  it.each(["close-all", "dispose", "close", "app-quit"] as const)(
    "awaits real delayed settings acknowledgements and graceful worker exit before %s destroys the last orb",
    async (mode) => {
      const instance = await durableWorkerController();
      const orb = surfaces("orb")[0]!,
        worker = mock.workers[0]!;
      if (mode === "dispose" || mode === "close") await invoke("surface", orb, "settings");
      const settings = surfaces("settings")[0] ?? orb;
      const file = path.join(mock.userData, "local-monitor", "pricing-settings.json");
      const staged = Promise.withResolvers<void>(),
        install = Promise.withResolvers<void>();
      const order: string[] = [];
      mock.beforeRename = async (_source, target) => {
        if (target !== file) return;
        staged.resolve();
        await install.promise;
      };
      let acknowledged = false;
      const network = (invoke("network-enabled", settings, false) as Promise<void>).then(() => {
        acknowledged = true;
        order.push("network-acknowledged");
        return undefined;
      });
      await staged.promise;
      const autoSync = (invoke("auto-sync-prices", settings, false) as Promise<void>).then(() => {
        order.push("auto-sync-acknowledged");
        return undefined;
      });
      worker.on("exit", () => order.push("worker-exited"));
      orb.on("closed", () => order.push("orb-closed"));
      const quitFinished = Promise.withResolvers<void>(),
        shutdownEffects: string[] = [];
      const lifecycle = createQuitLifecycle({
        app: {
          exit: () => {
            shutdownEffects.push("exit");
            quitFinished.resolve();
          },
          quit: () => {
            quitFinished.reject(new Error("Unexpected updater handoff"));
          },
        },
        prepareToQuit: async () => {
          await instance.dispose();
          shutdownEffects.push("other-windows");
        },
        closeTransportSessions: () => shutdownEffects.push("transports"),
        stopDesktopManagedDaemonIfNeeded: async () => {
          shutdownEffects.push("daemon");
          return false;
        },
        installAppUpdateOnQuit: async () => {
          shutdownEffects.push("update-check");
          return false;
        },
        createUpdateDeadlineSignal: () => new AbortController().signal,
        onPrepareError: quitFinished.reject,
        onStopError: quitFinished.reject,
        onUpdateError: quitFinished.reject,
      });
      let closing: Promise<void>;
      if (mode === "app-quit") {
        lifecycle.handleBeforeQuit({ preventDefault() {} });
        closing = quitFinished.promise;
      } else if (mode === "dispose") closing = instance.dispose();
      else {
        if (mode === "close") orb.close();
        closing = invoke(mode, orb) as Promise<void>;
      }
      try {
        expect(acknowledged).toBe(false);
        expect(mock.windows.every((window) => !window.destroyed)).toBe(true);
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(shutdownEffects).toEqual([]);
        expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
          networkEnabled: true,
          autoSyncPrices: true,
        });
      } finally {
        install.resolve();
        await Promise.all([network, autoSync, closing]);
        mock.beforeRename = undefined;
      }
      expect(order).toEqual([
        "network-acknowledged",
        "auto-sync-acknowledged",
        "worker-exited",
        "orb-closed",
      ]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        schema: 1,
        networkEnabled: false,
        autoSyncPrices: false,
        currency: "USD",
      });
      expect(mock.windows.every((window) => window.destroyed)).toBe(true);
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(shutdownEffects).toEqual(
        mode === "app-quit"
          ? ["other-windows", "transports", "daemon", "update-check", "exit"]
          : [],
      );
    },
  );

  it("vetoes close, source handoff and manual installation after a real settings-save failure, retaining the worker and editor until explicit save recovery", async () => {
    const instance = await durableWorkerController();
    const orb = surfaces("orb")[0]!,
      worker = mock.workers[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    const file = path.join(mock.userData, "local-monitor", "pricing-settings.json");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mock.beforeRename = async (_source, target) => {
      if (target === file) throw new Error("Owned pricing replacement refused");
    };
    const stopDaemon = vi.fn(async () => undefined);
    try {
      await expect(invoke("network-enabled", settings, false)).rejects.toThrow(
        "Unable to save monitor pricing settings",
      );
      expect(JSON.parse(await readFile(file, "utf8")).networkEnabled).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(instance.dispose()).rejects.toThrow("Retry saving");
        expect(mock.windows.every((window) => !window.destroyed)).toBe(true);
        expect(settings.draftLocked).toBe(false);
        expect(mock.handlers.has("paseo:monitor:network-enabled")).toBe(true);
      }
      await expect(invoke("source-enabled", settings, true)).rejects.toThrow("Retry saving");
      const result = await downloadAndInstallUpdate(
        { currentVersion: "1.6.1", releaseChannel: "stable" },
        { prepareToQuit: () => instance.dispose(), stopDaemon },
      );
      expect(result).toMatchObject({ installed: false, version: null });
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(mock.quitAndInstall).not.toHaveBeenCalled();
      expect(mock.workers).toEqual([worker]);
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(settings.destroyed).toBe(false);
      expect(settings.draftLocked).toBe(false);
      expect(
        JSON.parse(
          await readFile(path.join(mock.userData, "local-monitor", "sources.json"), "utf8"),
        ),
      ).toEqual({ version: 1, enabled: false, folder: null });
    } finally {
      mock.beforeRename = undefined;
      // The same explicit disabled value is a real save retry, not an enable/disable workaround.
      await invoke("network-enabled", settings, false);
      await invoke("auto-sync-prices", settings, false);
    }
    expect(mock.workers).toEqual([worker]);
    await instance.dispose();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schema: 1,
      networkEnabled: false,
      autoSyncPrices: false,
      currency: "USD",
    });
    expect(mock.windows.every((window) => window.destroyed)).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["error", "exit", "post"] as const)(
    "rejects an unacknowledged worker %s as unknown, blocks stale-permission restart and recovers only through a real explicit save",
    async (failure) => {
      const instance = await durableWorkerController();
      const orb = surfaces("orb")[0]!,
        old = mock.workers[0]!;
      await invoke("surface", orb, "settings");
      const settings = surfaces("settings")[0]!,
        posted = Promise.withResolvers<void>();
      const forward = old.postMessage.getMockImplementation()!;
      old.postMessage.mockImplementation((request: OmpMonitorWorkerRequest) => {
        if (request.type === "pricing.configure") {
          posted.resolve();
          if (failure === "post") throw new Error("Private postMessage failure");
        } else forward(request);
      });
      const saving = invoke("network-enabled", settings, false) as Promise<void>;
      const unknown = expect(saving).rejects.toThrow("could not be confirmed");
      await posted.promise;
      if (failure === "error")
        old.emit("error", new Error("A private worker failure must not escape through IPC"));
      else if (failure === "exit") old.emit("exit", 0);
      await unknown;
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(invoke("refresh", orb)).rejects.toThrow("unavailable");
      await expect(instance.dispose()).rejects.toThrow("could not be confirmed");
      expect(mock.workers).toEqual([old]);
      expect(settings.destroyed).toBe(false);
      expect(settings.draftLocked).toBe(false);
      // A separate auto-sync save cannot accidentally revive the previous network permission.
      await invoke("auto-sync-prices", settings, false);
      expect(mock.workers).toHaveLength(2);
      expect(mock.workers[1]!.options.workerData.pricingRecoveryRequired).toBe(true);
      expect(
        JSON.parse(
          await readFile(
            path.join(mock.userData, "local-monitor", "pricing-settings.json"),
            "utf8",
          ),
        ),
      ).toEqual({ schema: 1, networkEnabled: false, autoSyncPrices: false, currency: "USD" });
      await instance.dispose();
      expect(mock.workers[1]!.terminate).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("prepares real queued title drafts before manual updater effects, retries failed saves and preserves the updater's later quit ownership", async () => {
    const instance = await durableWorkerController();
    const orb = surfaces("orb")[0]!;
    await invoke("network-enabled", orb, false);
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    const copied = (await invoke("title-theme", settings, {
      type: "copy",
      sourceId: "vehicles",
      language: "en",
    })) as OmpTitleThemeResult;
    const titlesFile = path.join(mock.userData, "local-monitor", "titles-v161.json");
    const staged = Promise.withResolvers<void>(),
      install = Promise.withResolvers<void>();
    const handoff = Promise.withResolvers<void>(),
      events: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mock.flushDraft.mockImplementation(async (window: MockWindow) => {
      window.draftLocked = true;
      const saved = (await invoke("title-theme", window, {
        type: "setField",
        id: copied.selected,
        level: 1,
        text: "Manual update draft",
        language: "en",
      })) as OmpTitleThemeResult;
      if (!saved.ok) throw new Error("Monitor title draft could not be saved");
    });
    const prepareToQuit = async () => {
      await instance.dispose();
      events.push("other-window-shutdown");
    };
    const lifecycle = createQuitLifecycle({
      app: {
        exit: () => events.push("unexpected-force-exit"),
        quit: () => {
          events.push("updater-resumed-quit");
          lifecycle.handleBeforeQuit({
            preventDefault: () => events.push("unexpected-second-veto"),
          });
          handoff.resolve();
        },
      },
      prepareToQuit,
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("unexpected-normal-stop");
        return false;
      },
      installAppUpdateOnQuit: async () => {
        events.push("unexpected-reinstall");
        return false;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onPrepareError: () => events.push("unexpected-late-save-error"),
      onStopError: () => events.push("unexpected-stop-error"),
      onUpdateError: () => events.push("unexpected-update-error"),
    });
    const stopDaemon = vi.fn(async () => {
      const saved = JSON.parse(await readFile(titlesFile, "utf8"));
      expect(saved.custom[0].titles[0]).toBe("Manual update draft");
      events.push("daemon-stopped");
    });
    mock.quitAndInstall.mockImplementation(() => {
      events.push("installer-launched");
      // This models the installed updater ordering: installation precedes the update quit event.
      lifecycle.handleBeforeQuitForUpdate();
      lifecycle.handleBeforeQuit({ preventDefault: () => events.push("update-quit-veto") });
    });
    mock.beforeRename = async (_source, target) => {
      if (target === titlesFile) throw new Error("Owned title replacement refused");
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await downloadAndInstallUpdate(
        { currentVersion: "1.6.1", releaseChannel: "stable" },
        { prepareToQuit, stopDaemon },
      );
      expect(result).toEqual({
        installed: false,
        version: null,
        message: "Monitor title draft could not be saved",
      });
      expect(events).toEqual([]);
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(mock.quitAndInstall).not.toHaveBeenCalled();
      expect(settings.destroyed).toBe(false);
      expect(settings.draftLocked).toBe(false);
    }
    mock.beforeRename = async (_source, target) => {
      if (target !== titlesFile) return;
      staged.resolve();
      await install.promise;
    };
    const retry = downloadAndInstallUpdate(
      { currentVersion: "1.6.1", releaseChannel: "stable" },
      { prepareToQuit, stopDaemon },
    );
    await staged.promise;
    try {
      expect(events).toEqual([]);
      expect(settings.destroyed).toBe(false);
      expect(settings.draftLocked).toBe(true);
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(mock.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      install.resolve();
      mock.beforeRename = undefined;
    }
    await expect(retry).resolves.toMatchObject({ installed: true, version: "1.6.2" });
    await handoff.promise;
    expect(events).toEqual([
      "other-window-shutdown",
      "daemon-stopped",
      "installer-launched",
      "update-quit-veto",
      "other-window-shutdown",
      "close-transports",
      "updater-resumed-quit",
      "close-transports",
    ]);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(mock.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(mock.windows.every((window) => window.destroyed)).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("original-design native OMP monitor", () => {
  it("does not create a leaking window when the native input binding cannot initialize", async () => {
    const instance = controller();
    mock.inputError = "startup";
    await expect(instance.open()).rejects.toThrow();
    expect(mock.windows).toEqual([]);
    mock.inputError = null;
    await instance.open();
    expect(surfaces("orb")[0]?.visible).toBe(true);
  });

  it("closes only the failing native orb without throwing from interactivity events", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    const dashboard = surfaces("dashboard")[0]!;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("surface", second, "dashboard");
    mock.inputError = "set";
    expect(() => interact(first, true)).not.toThrow();
    expect(first.destroyed).toBe(true);
    expect(surfaces("orb")).toEqual([second]);
    expect(dashboard.destroyed).toBe(false);
    mock.inputError = null;
    interact(second, true);
    expect(second.ignored).toBe(false);
  });

  it("authorizes exact owned frames, including pointer control, and keeps panels independent of orb lifetime", async () => {
    const instance = controller(),
      opening = mock.handlers.get("paseo:monitor:open")!;
    const mainFrame = {};
    expect(() => opening({ sender: { main: false, mainFrame }, senderFrame: mainFrame })).toThrow();
    expect(() => opening({ sender: { main: true, mainFrame }, senderFrame: {} })).toThrow();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    expect(state(dashboard).instanceId).toBe(state(orb).instanceId);
    expect(() => invoke("refresh", orb, undefined, {})).toThrow();
    interact(orb, true, {});
    expect(orb.ignored).toBe(true);
    interact(orb, true);
    expect(orb.ignored).toBe(false);
    dashboard.close();
    expect(orb.destroyed).toBe(false);
    expect(state(orb).windowCount).toBe(1);
    await instance.dispose();
    expect(mock.handlers.size).toBe(0);
    expect(mock.listeners.size).toBe(0);
  });

  it("caps actual orbs at eight without counting the shared dashboard, history or settings panels", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    for (let index = 1; index < 8; index++) await invoke("new-window", first);
    await invoke("surface", first, "history");
    await invoke("surface", first, "settings");
    await expect(invoke("new-window", first)).rejects.toThrow("limit");
    expect(surfaces("orb")).toHaveLength(8);
    expect(surfaces("dashboard")).toHaveLength(1);
    expect(surfaces("history")).toHaveLength(1);
    expect(surfaces("settings")).toHaveLength(1);
    expect(state(first).windowCount).toBe(8);
    expect(mock.workers).toHaveLength(1);
  });

  it("shares a scope between an orb and its panels, retargets the singleton panel and rejects stale or arbitrary scopes", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    publish(second);
    await expect(
      invoke("scope", first, { profile: null, project: "C:/private/session.jsonl" }),
    ).rejects.toThrow();
    await invoke("scope", first, { profile: "second", project: "A" });
    publish(first);
    expect(state(first).snapshot).toBeNull();
    const scoped = snapshot({ profile: "second", project: "A" });
    publish(first, scoped);
    expect(state(first).snapshot?.scope).toEqual(scoped.scope);
    const dashboard = surfaces("dashboard")[0]!;
    expect(state(dashboard).snapshot?.scope).toEqual(scoped.scope);
    await invoke("surface", second, "dashboard");
    expect(surfaces("dashboard")).toHaveLength(1);
    expect(state(dashboard).instanceId).toBe(state(second).instanceId);
    expect(state(second).scope).toEqual({ profile: null, project: null });
  });

  it("persists genuine per-orb preferences and native positions while global appearance is shared", async () => {
    const firstController = controller();
    await firstController.open();
    const first = surfaces("orb")[0]!;
    await invoke("configure", first, {
      style: "minimal",
      size: 72,
      titleTheme: "cultivation",
      clickThrough: true,
      appearance: "light",
      opacity: 0.65,
    });
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("configure", second, { style: "needle", size: 196, pinned: false });
    const firstId = state(first).instanceId,
      secondId = state(second).instanceId;
    const firstBounds = first.getBounds();
    await invoke("close-all", first);
    await firstController.dispose();
    const nextController = controller();
    await nextController.open();
    const restored = surfaces("orb").find((window) => state(window).instanceId === firstId)!;
    const other = surfaces("orb").find((window) => state(window).instanceId === secondId)!;
    expect(state(restored).preferences).toMatchObject({
      style: "minimal",
      size: 72,
      titleTheme: "cultivation",
      clickThrough: true,
      appearance: "light",
      opacity: 0.65,
    });
    expect(restored.getBounds()).toEqual(firstBounds);
    expect(state(other).preferences).toMatchObject({
      style: "needle",
      size: 196,
      pinned: false,
      appearance: "light",
    });
    expect(restored.ignored).toBe(true);
    expect(other.pinned).toBe(false);
  });

  it("applies a valid sibling snapshot when another scope changed during the same poll", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    publish(second);
    await invoke("scope", first, { profile: null, project: "A" });
    const next = snapshot();
    next.today.requests = 7;
    mock.workers.at(-1)!.emit("message", {
      type: "snapshots",
      snapshots: [
        { scopeId: state(first).instanceId, snapshot: snapshot() },
        { scopeId: state(second).instanceId, snapshot: next },
      ],
    });
    expect(state(first).scope.project).toBe("A");
    expect(state(first).snapshot).toBeNull();
    expect(state(first).refreshing).toBe(true);
    expect(state(second).snapshot?.today.requests).toBe(7);
    expect(state(second).refreshing).toBe(false);
  });

  it("keeps click-through recoverable from the dashboard and a hidden orb can be restored without recreation", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    interact(orb, true);
    await invoke("configure", dashboard, { clickThrough: true });
    interact(orb, true);
    expect(orb.ignored).toBe(true);
    await invoke("configure", dashboard, { clickThrough: false });
    interact(orb, true);
    expect(orb.ignored).toBe(false);
    await invoke("orb-visible", dashboard, false);
    expect(orb.visible).toBe(false);
    expect(state(dashboard).orbVisible).toBe(false);
    await invoke("orb-visible", dashboard, true);
    expect(orb.visible).toBe(true);
    expect(surfaces("orb")).toHaveLength(1);
  });

  it("does not accept invalid preference payloads or allow panel frames to move the native orb", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    for (const value of [
      { size: Infinity },
      { opacity: 0 },
      { effects: "unsafe" },
      { arbitraryCommand: "exec" },
      null,
    ])
      await expect(invoke("configure", orb, value)).rejects.toThrow();
    expect(() => invoke("drag-start", dashboard)).toThrow();
    await invoke("configure", orb, { style: "minimal", size: 72 });
    await invoke("configure", orb, { style: "needle" });
    expect(state(orb).preferences.size).toBe(96);
  });

  it("moves from native cursor deltas, snaps the visible disc to the screen edge and saves the released position", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    mock.cursor = { x: 500, y: 300 };
    invoke("drag-start", orb);
    const before = orb.getBounds();
    mock.cursor = { x: 500 - before.x - 30, y: 320 };
    vi.advanceTimersByTime(50);
    await invoke("drag-end", orb);
    const after = orb.getBounds();
    expect(after.x + state(orb).preferences.size * 0.25).toBe(12);
    expect(after.y).toBe(before.y + 20);
    const saved = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(Object.values(saved.orbs[0].positions)).toContainEqual({ x: after.x, y: after.y });
  });

  it("emits live completion and measured peak sequences using completion provenance, never initial history or estimates", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const initial = snapshot();
    initial.activity = {
      lastResponseAt: mock.now - 10,
      totalPeakAt: null,
      totalPeakObservedAt: null,
      peakAt: mock.now - 60_000,
      peakObservedAt: mock.now - 10,
    };
    publish(orb, initial);
    expect(state(orb).activity).toMatchObject({ responseSequence: 0, peakSequence: 0 });
    mock.now += 2000;
    const fresh = snapshot();
    fresh.today.peakOutputTps = 80;
    fresh.activity = {
      lastResponseAt: mock.now - 5,
      peakAt: mock.now - 30_000,
      totalPeakAt: null,
      totalPeakObservedAt: null,
      peakObservedAt: mock.now - 5,
    };
    publish(orb, fresh);
    expect(state(orb).activity).toMatchObject({
      responseSequence: 1,
      peakSequence: 1,
      lastPeakAt: fresh.activity.peakObservedAt,
    });
    mock.now += 1000;
    const estimated = {
      ...fresh,
      updatedAt: mock.now,
      rate: { ...fresh.rate, measuredTps: 0, estimatedTps: 50_000, estimatedShare: 1 },
    };
    publish(orb, estimated);
    expect(state(orb).activity).toMatchObject({ responseSequence: 1, peakSequence: 1 });
    const old = snapshot();
    old.today.peakOutputTps = 5000;
    old.activity = {
      lastResponseAt: mock.now - 50_000,
      peakAt: mock.now - 100_000,
      totalPeakAt: null,
      totalPeakObservedAt: null,
      peakObservedAt: mock.now - 50_000,
    };
    publish(orb, old);
    expect(state(orb).activity.peakSequence).toBe(1);
  });

  it("keeps partial scans live without replaying a fresh completion when history fills a higher peak", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const initial = snapshot();
    initial.status = "partial";
    initial.coverage.issues = ["scan_pending"];
    publish(orb, initial);
    expect(state(orb).refreshing).toBe(false);
    mock.now += 2000;
    const fresh = snapshot();
    fresh.status = "partial";
    fresh.today.peakOutputTps = 80;
    fresh.activity = {
      lastResponseAt: mock.now - 5,
      peakAt: mock.now - 3000,
      peakObservedAt: mock.now - 5,
      totalPeakAt: null,
      totalPeakObservedAt: null,
    };
    publish(orb, fresh);
    expect(state(orb).activity).toMatchObject({ responseSequence: 1, peakSequence: 1 });
    mock.now += 100;
    const backfilled = {
      ...fresh,
      updatedAt: mock.now,
      today: { ...fresh.today, peakOutputTps: 120 },
    };
    publish(orb, backfilled);
    expect(state(orb).activity).toMatchObject({ responseSequence: 1, peakSequence: 1 });
    publish(orb, {
      ...backfilled,
      activity: { ...fresh.activity, peakObservedAt: mock.now - 60_000 },
    });
    publish(orb, { ...backfilled, today: { ...backfilled.today, peakOutputTps: 140 } });
    expect(state(orb).activity).toMatchObject({
      responseSequence: 1,
      peakSequence: 1,
      lastPeakAt: fresh.activity.peakObservedAt,
    });
    mock.now += 100;
    const next = snapshot();
    next.status = "partial";
    next.today.peakOutputTps = 200;
    next.activity = {
      lastResponseAt: mock.now - 5,
      peakAt: mock.now - 3000,
      peakObservedAt: mock.now - 5,
      totalPeakAt: null,
      totalPeakObservedAt: null,
    };
    publish(orb, next);
    expect(state(orb).activity).toMatchObject({ responseSequence: 2, peakSequence: 2 });
  });

  it("suppresses peaks after a scope change and recovers a failed worker without accepting its late messages", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    publish(orb);
    await invoke("scope", orb, { profile: null, project: "A" });
    publish(orb, snapshot({ profile: null, project: "A" }));
    mock.now += 2000;
    const fresh = snapshot({ profile: null, project: "A" });
    fresh.today.peakOutputTps = 200;
    fresh.activity = {
      ...fresh.activity,
      lastResponseAt: mock.now,
      peakAt: mock.now,
      peakObservedAt: mock.now,
    };
    publish(orb, fresh);
    expect(state(orb).activity.peakSequence).toBe(0);
    const oldWorker = mock.workers[0]!;
    oldWorker.emit("error", new Error("private path must not escape"));
    expect(state(orb).workerError).toBe(true);
    await invoke("refresh", orb);
    oldWorker.emit("message", {
      type: "snapshots",
      snapshots: [
        {
          scopeId: state(orb).instanceId,
          snapshot: { ...fresh, today: { ...fresh.today, requests: 999 } },
        },
      ],
    });
    expect(state(orb).snapshot?.today.requests).toBe(1);
    publish(orb, fresh);
    expect(state(orb).workerError).toBe(false);
    expect(JSON.stringify(state(orb))).not.toContain("private path");
  });

  it.each(["unavailable", "error", "scanning"] as const)(
    "refuses an unknown %s report rather than exporting fabricated zero usage",
    async (status) => {
      const instance = controller();
      await instance.open();
      const orb = surfaces("orb")[0]!;
      const data = snapshot();
      data.status = status;
      data.coverage.readFiles = 0;
      publish(orb, data);
      expect(await invoke("export-csv", orb)).toBe("unavailable");
    },
  );

  it("rejects out-of-scope history dates and exports exactly the selected available dates", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const data = snapshot();
    data.days.unshift({ ...data.today, date: "2026-10-23", requests: 7, agentCount: 1 });
    data.historyRange.startDate = "2026-10-23";
    publish(orb, data);
    await expect(
      invoke("export-csv", orb, { startDate: "2000-01-01", endDate: "2026-10-24" }),
    ).rejects.toThrow();
    const destination = path.join(mock.userData, "selected.csv");
    mock.save.mockResolvedValue({ canceled: false, filePath: destination });
    expect(
      await invoke("export-csv", orb, { startDate: "2026-10-23", endDate: "2026-10-23" }),
    ).toBe("saved");
    const csv = await readFile(destination, "utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"daily"');
    expect(csv).toContain('"2026-10-23"');
    expect(csv).not.toContain('"today"');
    expect(csv).not.toContain('"resources"');
  });

  it("recovers a hidden click-through secondary orb through the original settings selector", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("configure", second, { clickThrough: true });
    await invoke("orb-visible", second, false);
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    await expect(invoke("select-orb", first, state(second).instanceId)).rejects.toThrow();
    await expect(invoke("select-orb", settings, "unknown-id")).rejects.toThrow();
    await invoke("select-orb", settings, state(second).instanceId);
    expect(state(settings).instanceId).toBe(state(second).instanceId);
    expect(
      state(settings).orbs.find((orb) => orb.instanceId === state(second).instanceId),
    ).toMatchObject({ visible: false, clickThrough: true });
    await invoke("configure", settings, { clickThrough: false });
    await invoke("orb-visible", settings, true);
    interact(second, true);
    expect(second.visible).toBe(true);
    expect(second.ignored).toBe(false);
    expect(state(first).preferences.clickThrough).toBe(false);
  });

  it.each(["renderer loss", "unresponsive", "hidden", "click-through"])(
    "cancels native cursor tracking on %s and never traps input",
    async (reason) => {
      const instance = controller();
      await instance.open();
      const orb = surfaces("orb")[0]!,
        dashboard = surfaces("dashboard")[0]!;
      mock.cursor = { x: 500, y: 300 };
      invoke("drag-start", orb);
      if (reason === "renderer loss") orb.webContents.emit("render-process-gone");
      else if (reason === "unresponsive") orb.emit("unresponsive");
      else if (reason === "hidden") await invoke("orb-visible", dashboard, false);
      else await invoke("configure", dashboard, { clickThrough: true });
      const bounds = orb.getBounds();
      mock.cursor = { x: 800, y: 600 };
      vi.advanceTimersByTime(100);
      expect(orb.getBounds()).toEqual(bounds);
      expect(orb.ignored).toBe(true);
      if (reason === "renderer loss" || reason === "unresponsive") {
        interact(orb, true);
        expect(orb.ignored).toBe(true);
        await invoke("refresh", dashboard);
        interact(orb, true);
        expect(orb.ignored).toBe(false);
      }
    },
  );

  it("resets a high-water peak when switching to a lower-peak project on the same day", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const all = snapshot();
    all.today.peakOutputTps = 1000;
    publish(orb, all);
    await invoke("scope", orb, { profile: null, project: "A" });
    const baseline = snapshot({ profile: null, project: "A" });
    baseline.today.peakOutputTps = 100;
    publish(orb, baseline);
    mock.now += 61_000;
    const fresh = snapshot({ profile: null, project: "A" });
    fresh.today.peakOutputTps = 150;
    fresh.activity = {
      lastResponseAt: mock.now - 10,
      peakAt: mock.now - 10,
      totalPeakAt: null,
      totalPeakObservedAt: null,
      peakObservedAt: mock.now - 10,
    };
    publish(orb, fresh);
    expect(state(orb).activity.peakSequence).toBe(1);
  });

  it("downgrades four simultaneous redline orbs except the most recently interacted one", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    for (let index = 1; index < 4; index++) await invoke("new-window", first);
    const orbs = surfaces("orb");
    for (const orb of orbs) {
      const data = snapshot();
      data.rate = {
        measuredTps: 3000,
        estimatedTps: 0,
        measuredTotalTps: 3000,
        estimatedTotalTps: 0,
        estimatedShare: 0,
        measuredThinkingTps: null,
        estimatedThinkingTps: null,
      };
      publish(orb, data);
    }
    expect(orbs.map((orb) => state(orb).maxFps)).toEqual([30, 30, 30, 60]);
    interact(first, true);
    expect(orbs.map((orb) => state(orb).maxFps)).toEqual([60, 30, 30, 30]);
  });

  it("bounds independent boards and authorizes only their own edits and confirmed removal", async () => {
    const instance = controller();
    await instance.open();
    const dashboard = surfaces("dashboard")[0]!;
    publish(surfaces("orb")[0]!, snapshot());
    for (let index = 0; index < 4; index++) await invoke("new-board", dashboard);
    await expect(invoke("new-board", dashboard)).rejects.toThrow("limit");
    const [first, second] = surfaces("board");
    const id = state(first!).board!.id;
    await expect(
      invoke("configure-board", second!, { id, patch: { style: "neon" } }),
    ).rejects.toThrow();
    await invoke("configure-board", first!, { id, patch: { style: "neon", size: "large" } });
    expect(first!.getBounds()).toMatchObject({ width: 500, height: 500 });
    expect(state(first!).board).toMatchObject({ id, style: "neon", size: "large" });
    expect(state(second!).board).toMatchObject({ style: "glass", size: "medium" });
    await invoke("scope", dashboard, { profile: null, project: "A" });
    expect(state(first!).scope).toEqual({ profile: null, project: "A" });
    await invoke("remove-board", first!, id);
    expect(state(dashboard).boards).toHaveLength(4);
    mock.confirm.mockResolvedValueOnce({ response: 1 });
    await invoke("remove-board", first!, id);
    expect(first!.destroyed).toBe(true);
    expect(second!.destroyed).toBe(false);
    expect(state(dashboard).boards).toHaveLength(3);
  });

  it("never lets the board's transparent margin or rounded corner trap pointer input", async () => {
    const instance = controller();
    await instance.open();
    await invoke("new-board", surfaces("dashboard")[0]!);
    const board = surfaces("board")[0]!,
      bounds = board.getBounds(),
      id = state(board).board!.id;
    const point = (x: number, y: number) => {
      mock.cursor = { x: bounds.x + x, y: bounds.y + y };
      vi.advanceTimersByTime(100);
    };
    point(210, 210);
    expect(board.ignored).toBe(false);
    point(10, 10);
    expect(board.ignored).toBe(true);
    point(41, 41);
    expect(board.ignored).toBe(true);
    point(80, 80);
    expect(board.ignored).toBe(false);
    board.emit("unresponsive");
    expect(board.ignored).toBe(true);
    point(210, 210);
    expect(board.ignored).toBe(true);
    board.emit("responsive");
    vi.advanceTimersByTime(100);
    expect(board.ignored).toBe(false);
    await invoke("configure-board", board, { id, patch: { clickThrough: true } });
    point(210, 210);
    expect(board.ignored).toBe(true);
  });

  it("persists global metric, units, effects and names without overwriting independent orb appearance", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("configure", first, { redline: 150, titleTheme: "animals" });
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("configure", second, { orbUnit: "cost", style: "needle", orbTitleTheme: "space" });
    await invoke("configure", first, {
      metric: "total",
      redline: 236_789,
      liveUnit: "cost",
      celebratePeaks: false,
      responsePulses: false,
      nameMode: "always",
    });
    expect(state(second).preferences).toMatchObject({
      metric: "total",
      redline: 240_000,
      redlineOutput: 150,
      redlineTotal: 240_000,
      liveUnit: "cost",
      celebratePeaks: false,
      responsePulses: false,
      nameMode: "always",
      orbUnit: "cost",
      style: "needle",
      titleTheme: "animals",
      orbTitleTheme: "space",
    });
    expect(state(first).preferences).toMatchObject({
      orbUnit: "tokens",
      style: "led",
      titleTheme: "animals",
    });
    await invoke("configure", second, { metric: "output" });
    expect(state(first).preferences.redline).toBe(150);
    await invoke("configure", second, { metric: "total" });
    expect(state(first).preferences.redline).toBe(240_000);
    const before = state(first).orbs;
    await invoke("close-all", first);
    await instance.dispose();
    const reopened = controller();
    await reopened.open();
    const restored = surfaces("orb")[0]!;
    expect(state(restored).orbs).toEqual(before);
    expect(state(restored).preferences).toMatchObject({
      metric: "total",
      redline: 240_000,
      redlineOutput: 150,
      celebratePeaks: false,
      responsePulses: false,
      nameMode: "always",
    });
  });

  it("keeps master visibility separate from eyes, restores all-hidden orbs and never hides boards", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    await invoke("new-board", first);
    const board = surfaces("board")[0]!;
    await invoke("orb-command", settings, {
      type: "visible",
      instanceId: state(first).instanceId,
      visible: false,
    });
    await invoke("configure", settings, { showOrbs: false });
    expect([first.visible, second.visible, board.visible]).toEqual([false, false, true]);
    expect(state(settings).orbs.map((orb) => orb.visible)).toEqual([false, true]);
    await invoke("configure", settings, { showOrbs: true });
    expect([first.visible, second.visible]).toEqual([false, true]);
    await invoke("orb-command", settings, {
      type: "visible",
      instanceId: state(second).instanceId,
      visible: false,
    });
    await invoke("configure", settings, { showOrbs: true });
    expect([first.visible, second.visible]).toEqual([true, true]);
    await invoke("configure", settings, { showOrbs: false });
    await invoke("orb-command", settings, {
      type: "visible",
      instanceId: state(first).instanceId,
      visible: true,
    });
    expect(state(settings).preferences.showOrbs).toBe(true);
    expect([first.visible, second.visible, board.visible]).toEqual([true, true, true]);
  });

  it("duplicates after the template, reorders without moving and undoes removal with board references intact", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("configure", first, {
      style: "minimal",
      size: 72,
      opacity: 0.6,
      titleTheme: "wuxia",
    });
    await invoke("new-board", first);
    const board = surfaces("board")[0]!,
      boardId = state(board).board!.id;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const firstId = state(first).instanceId,
      secondId = state(second).instanceId;
    const firstBounds = first.getBounds();
    await invoke("orb-command", settings, { type: "duplicate", instanceId: firstId });
    const duplicate = surfaces("orb")[2]!,
      duplicateId = state(duplicate).instanceId;
    expect(state(settings).orbs.map((orb) => orb.instanceId)).toEqual([
      firstId,
      duplicateId,
      secondId,
    ]);
    expect(state(duplicate).preferences).toEqual(state(first).preferences);
    expect(state(settings).boards).toHaveLength(1);
    expect(duplicate.getBounds()).not.toEqual(firstBounds);
    const duplicateBounds = duplicate.getBounds();
    await invoke("orb-command", settings, { type: "move", instanceId: secondId, index: 0 });
    expect(state(settings).orbs.map((orb) => orb.instanceId)).toEqual([
      secondId,
      firstId,
      duplicateId,
    ]);
    expect(first.getBounds()).toEqual(firstBounds);
    expect(duplicate.getBounds()).toEqual(duplicateBounds);
    await invoke("orb-command", settings, { type: "remove", instanceId: firstId });
    expect(first.destroyed).toBe(true);
    expect(settings.destroyed).toBe(false);
    expect(board.destroyed).toBe(false);
    expect(state(board).board).toMatchObject({ id: boardId, orbId: secondId });
    expect(state(settings).orbUndo).toEqual({ kind: "remove", expiresAt: mock.now + 8_000 });
    await invoke("configure", settings, { appearance: "light", metric: "total" });
    await invoke("orb-command", settings, { type: "duplicate", instanceId: secondId });
    const addedAfterRemoval = surfaces("orb").at(-1)!;
    await invoke("orb-command", settings, { type: "undo" });
    expect(addedAfterRemoval.destroyed).toBe(true);
    expect(state(settings).orbs.map((orb) => orb.instanceId)).toEqual([
      secondId,
      firstId,
      duplicateId,
    ]);
    const restored = surfaces("orb").find((orb) => state(orb).instanceId === firstId)!;
    expect(restored.getBounds()).toEqual(firstBounds);
    expect(state(restored).preferences).toMatchObject({
      style: "minimal",
      size: 72,
      opacity: 0.6,
      titleTheme: "wuxia",
      appearance: "light",
      metric: "total",
    });
    expect(state(board).board).toMatchObject({ id: boardId, orbId: firstId });
    expect(state(settings).orbUndo).toBeNull();
    const saved = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(saved.orbs.map((orb: { id: string }) => orb.id)).toEqual([
      secondId,
      firstId,
      duplicateId,
    ]);
    expect(saved.boards[0].orbId).toBe(firstId);
  });

  it("enforces exact orb commands, the last-orb rule and an expiring eight-second undo", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!,
      id = state(first).instanceId;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    await expect(
      invoke("orb-command", settings, { type: "merge", instanceId: id }),
    ).rejects.toThrow();
    expect(state(settings).orbManagement).toEqual({
      canSplit: false,
      canMerge: false,
      reason: "single-omp-source",
    });
    for (const command of [
      { type: "remove", instanceId: id },
      { type: "move", instanceId: id, index: -1 },
      { type: "move", instanceId: id, index: 0.5 },
      { type: "visible", instanceId: id, visible: 1 },
      { type: "duplicate", instanceId: "foreign-orb" },
      { type: "split", instanceId: id },
      { type: "duplicate", instanceId: id, path: "C:/outside" },
    ])
      await expect(invoke("orb-command", settings, command)).rejects.toThrow();
    await expect(
      invoke("orb-command", first, { type: "duplicate", instanceId: id }),
    ).rejects.toThrow();
    expect(() =>
      invoke("orb-command", settings, { type: "duplicate", instanceId: id }, {}),
    ).toThrow();
    expect(state(settings).windowCount).toBe(1);
    await invoke("orb-command", settings, { type: "duplicate", instanceId: id });
    const second = surfaces("orb")[1]!,
      secondId = state(second).instanceId;
    await invoke("orb-command", settings, { type: "remove", instanceId: secondId });
    mock.now += 8_001;
    vi.advanceTimersByTime(8_001);
    expect(state(settings).orbUndo).toBeNull();
    await expect(invoke("orb-command", settings, { type: "undo" })).rejects.toThrow("expired");
    expect(state(settings).windowCount).toBe(1);
  });

  it("loads custom themes before initial publication and atomically moves and restores all live references", async () => {
    const directory = path.join(mock.userData, "local-monitor");
    await mkdir(directory);
    const id = "custom:12345678-1234-4234-8234-123456789abc";
    await writeFile(
      path.join(directory, "titles-v161.json"),
      JSON.stringify({
        version: 1,
        custom: [{ id, name: "Fixture", base: "animals", idle: "", titles: Array(13).fill("") }],
      }),
    );
    await writeFile(
      path.join(directory, "windows.json"),
      JSON.stringify({
        version: 2,
        orbs: [
          {
            id: "saved-orb",
            scope: { profile: null, project: null },
            visible: true,
            positions: {},
            preferences: { titleTheme: id },
          },
        ],
        boards: [],
      }),
    );
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    const initial = first.webContents.send.mock.calls.filter(
      ([channel]) => channel === "paseo:monitor:state",
    );
    expect(initial.every(([, value]) => value.titleThemes.custom[0]?.id === id)).toBe(true);
    expect(state(first).preferences.titleTheme).toBe(id);
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const edit = (await invoke("title-theme", settings, {
      type: "setField",
      id,
      level: 1,
      text: "Measured title",
      language: "en",
    })) as OmpTitleThemeResult;
    expect(edit.ok).toBe(true);
    const removed = (await invoke("title-theme", settings, {
      type: "delete",
      id,
    })) as OmpTitleThemeResult;
    expect(removed.ok).toBe(true);
    expect(state(first).preferences.titleTheme).toBe("animals");
    expect(state(second).preferences.titleTheme).toBe("animals");
    expect(state(settings).titleThemes.custom).toEqual([]);
    const undone = (await invoke("title-theme", settings, { type: "undo" })) as OmpTitleThemeResult;
    expect(undone.ok).toBe(true);
    expect([state(first).preferences.titleTheme, state(second).preferences.titleTheme]).toEqual([
      id,
      id,
    ]);
    expect(state(settings).titleThemes.custom[0]?.titles[0]).toBe("Measured title");
    const saved = JSON.parse(await readFile(path.join(directory, "windows.json"), "utf8"));
    expect(
      saved.orbs.every(
        (orb: { preferences: { titleTheme: string } }) => orb.preferences.titleTheme === id,
      ),
    ).toBe(true);
    expect(JSON.stringify(state(settings))).not.toContain(directory);
    await invoke("close-all", first);
    await instance.dispose();
    const reopened = controller();
    await reopened.open();
    expect(state(surfaces("orb")[0]!).titleThemes.custom[0]?.titles[0]).toBe("Measured title");
    expect(state(surfaces("orb")[0]!).preferences.titleTheme).toBe(id);
  });

  it("refuses unknown theme IDs, privileged payload keys and failed theme saves without changing references", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    await expect(
      invoke("title-theme", first, { type: "copy", sourceId: "vehicles", language: "en" }),
    ).rejects.toThrow();
    expect(() => invoke("title-theme", settings, { type: "undo" }, {})).toThrow();
    for (const titleTheme of [
      "custom:12345678-1234-4234-8234-123456789abc",
      "custom:../../file",
      "vehicle",
    ])
      await expect(invoke("configure", settings, { titleTheme })).rejects.toThrow();
    expect(
      await invoke("title-theme", settings, {
        type: "copy",
        sourceId: "vehicles",
        language: "en",
        file: "C:/outside.json",
      }),
    ).toMatchObject({ ok: false, error: "invalid" });
    const copied = (await invoke("title-theme", settings, {
      type: "copy",
      sourceId: "wind",
      language: "en",
    })) as OmpTitleThemeResult;
    expect(copied.ok).toBe(true);
    const id = copied.selected!;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    const titleFile = path.join(mock.userData, "local-monitor", "titles-v161.json");
    await rm(titleFile);
    await mkdir(titleFile);
    const failed = (await invoke("title-theme", settings, {
      type: "delete",
      id,
    })) as OmpTitleThemeResult;
    expect(failed).toMatchObject({ ok: false, error: "storage" });
    expect(state(settings).titleThemes.error).toBe(true);
    expect([state(first).preferences.titleTheme, state(second).preferences.titleTheme]).toEqual([
      id,
      id,
    ]);
    expect(state(settings).titleThemes.custom).toHaveLength(1);
    const saved = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(
      saved.orbs.every(
        (orb: { preferences: { titleTheme: string } }) => orb.preferences.titleTheme === id,
      ),
    ).toBe(true);
  });

  it("reports a reference persistence failure instead of returning a successful title command", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const copied = (await invoke("title-theme", settings, {
      type: "copy",
      sourceId: "space",
      language: "en",
    })) as OmpTitleThemeResult;
    const preferenceFile = path.join(mock.userData, "local-monitor", "windows.json");
    await rm(preferenceFile);
    await mkdir(preferenceFile);
    const failed = (await invoke("title-theme", settings, {
      type: "delete",
      id: copied.selected,
    })) as OmpTitleThemeResult;
    expect(failed).toMatchObject({ ok: false, error: "storage" });
    expect(state(settings).preferenceError).toBe(true);
    expect(state(first).preferences.titleTheme).toBe("space");
    expect(state(settings).titleThemes.custom).toEqual([]);
    await rm(preferenceFile, { recursive: true });
  });

  it("reads host startup state without writing and restricts changes to settings with accurate failures", async () => {
    mock.loginEnabled = true;
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    expect(state(first).launchAtLogin).toEqual({ enabled: true, supported: true, error: false });
    expect(mock.loginWrites).not.toHaveBeenCalled();
    expect(() => invoke("launch-at-login", first, false)).toThrow();
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    expect(() => invoke("launch-at-login", settings, "false")).toThrow();
    expect(() => invoke("launch-at-login", settings, false, {})).toThrow();
    await invoke("launch-at-login", settings, false);
    expect(state(settings).launchAtLogin).toEqual({
      enabled: false,
      supported: true,
      error: false,
    });
    mock.loginWriteError = true;
    expect(() => invoke("launch-at-login", settings, true)).toThrow("Unable");
    expect(state(settings).launchAtLogin).toEqual({ enabled: false, supported: true, error: true });
    mock.loginWriteError = false;
    mock.loginEnabled = true;
    await invoke("refresh-launch-at-login", settings);
    expect(state(settings).launchAtLogin).toEqual({ enabled: true, supported: true, error: false });
    expect(mock.loginWrites.mock.calls).toEqual([[false]]);
    const saved = await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8");
    expect(saved).not.toContain("launchAtLogin");
  });

  it("runs an explicit bounded visual demo without altering numeric facts, logs or persisted preferences", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const facts = JSON.stringify({
      snapshot: state(first).snapshot,
      activity: state(first).activity,
    });
    const file = path.join(mock.userData, "local-monitor", "windows.json");
    const preferences = await readFile(file, "utf8");
    expect(() => invoke("effects-preview-start", first)).toThrow();
    await invoke("effects-preview-start", settings);
    expect(state(settings).effectsPreview).toEqual({
      active: true,
      sequence: 1,
      startedAt: mock.now,
      endsAt: mock.now + 20_000,
    });
    await invoke("effects-preview-start", settings);
    expect(state(settings).effectsPreview.sequence).toBe(1);
    mock.now += 20_000;
    vi.advanceTimersByTime(20_000);
    expect(state(settings).effectsPreview).toEqual({
      active: false,
      sequence: 1,
      startedAt: null,
      endsAt: null,
    });
    await invoke("effects-preview-start", settings);
    await invoke("effects-preview-stop", settings);
    expect(state(settings).effectsPreview.active).toBe(false);
    await invoke("effects-preview-start", settings);
    await invoke("close", settings);
    expect(state(first).effectsPreview.active).toBe(false);
    expect(
      JSON.stringify({ snapshot: state(first).snapshot, activity: state(first).activity }),
    ).toBe(facts);
    expect(await readFile(file, "utf8")).toBe(preferences);
  });

  it("keeps peak celebrations output-driven in total mode and never replays disabled feedback", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    const baseline = snapshot();
    baseline.today.peakOutputTps = 500;
    baseline.today.peakTotalTps = 10_000;
    baseline.activity = {
      ...baseline.activity,
      lastResponseAt: mock.now,
      peakObservedAt: mock.now,
      totalPeakObservedAt: mock.now - 1,
    };
    publish(first, baseline);
    await invoke("configure", first, { metric: "total" });
    publish(first, baseline);
    expect(state(first).activity).toMatchObject({ responseSequence: 0, peakSequence: 0 });
    mock.now += 2_000;
    const fresh = snapshot();
    fresh.today.peakOutputTps = 500;
    fresh.today.peakTotalTps = 15_000;
    fresh.activity = {
      ...fresh.activity,
      lastResponseAt: mock.now,
      peakObservedAt: baseline.activity.peakObservedAt,
      totalPeakObservedAt: mock.now,
      totalPeakAt: mock.now,
    };
    publish(first, fresh);
    expect(state(first).activity).toMatchObject({
      responseSequence: 1,
      peakSequence: 0,
      lastPeakAt: baseline.activity.peakObservedAt,
    });
    mock.now += 2_000;
    const outputPeak = {
      ...fresh,
      updatedAt: mock.now,
      rate: { ...fresh.rate, measuredTps: 600 },
      today: { ...fresh.today, peakOutputTps: 600 },
      activity: {
        ...fresh.activity,
        lastResponseAt: mock.now,
        peakAt: mock.now,
        peakObservedAt: mock.now,
      },
    };
    publish(first, outputPeak);
    expect(state(first).activity).toMatchObject({
      responseSequence: 2,
      peakSequence: 1,
      lastPeakAt: outputPeak.activity.peakObservedAt,
    });
    await invoke("configure", first, { celebratePeaks: false, responsePulses: false });
    mock.now += 2_000;
    fresh.updatedAt = mock.now;
    fresh.today.peakTotalTps = 20_000;
    fresh.activity.lastResponseAt = mock.now;
    fresh.activity.totalPeakObservedAt = mock.now;
    fresh.today.peakOutputTps = 700;
    fresh.activity.peakObservedAt = mock.now;
    publish(first, fresh);
    expect(state(first).activity).toMatchObject({ responseSequence: 2, peakSequence: 1 });
    await invoke("configure", first, { celebratePeaks: true, responsePulses: true });
    publish(first, fresh);
    expect(state(first).activity).toMatchObject({ responseSequence: 2, peakSequence: 1 });
    mock.now += 2_000;
    const estimated = snapshot();
    estimated.rate.estimatedTotalTps = 5_000_000;
    estimated.today.peakTotalTps = 20_000;
    estimated.activity = { ...fresh.activity, lastResponseAt: mock.now };
    publish(first, estimated);
    expect(state(first).activity.peakSequence).toBe(1);
  });

  it("rejects malformed pricing commands and never permits manual downloads through a disabled network switch", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    const before = mock.workers[0]!.postMessage.mock.calls.length;
    for (const channel of ["refresh-public-data", "check-prices", "refresh-rates"])
      await expect(invoke(channel, first)).rejects.toThrow("disabled");
    await expect(invoke("auto-sync-prices", first, 1)).rejects.toThrow();
    await expect(invoke("network-enabled", first, "true")).rejects.toThrow();
    expect(mock.workers[0]!.postMessage.mock.calls).toHaveLength(before);
    expect(state(first).snapshot?.pricing).toMatchObject({
      networkEnabled: false,
      autoSyncPrices: true,
    });
  });

  it("drains owned writes and disposes preview, title and orb undo timers without later renderer callbacks", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const copied = (await invoke("title-theme", settings, {
      type: "copy",
      sourceId: "vehicles",
      language: "en",
    })) as OmpTitleThemeResult;
    await invoke("title-theme", settings, { type: "delete", id: copied.selected });
    await invoke("orb-command", settings, {
      type: "duplicate",
      instanceId: state(first).instanceId,
    });
    const secondId = state(surfaces("orb")[1]!).instanceId;
    await invoke("orb-command", settings, { type: "remove", instanceId: secondId });
    await invoke("effects-preview-start", settings);
    expect(state(settings).orbUndo).not.toBeNull();
    expect(state(settings).titleThemes.undo).not.toBeNull();
    await instance.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const callbacks = mock.windows.map((window) => window.webContents.send.mock.calls.length);
    vi.advanceTimersByTime(25_000);
    expect(mock.windows.map((window) => window.webContents.send.mock.calls.length)).toEqual(
      callbacks,
    );
    const saved = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(saved.orbs).toHaveLength(1);
    expect(saved.orbs[0].preferences.titleTheme).toBe("vehicles");
  });

  it("merges real OMP orbs around the chosen identity and undoes scopes, positions and board associations", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    await invoke("scope", first, { profile: null, project: "A" });
    publish(first, snapshot({ profile: null, project: "A" }));
    await invoke("new-board", first);
    const firstBoard = surfaces("board")[0]!;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    publish(second, snapshot({ profile: null, project: "A" }));
    await invoke("scope", second, { profile: null, project: "B" });
    publish(second, snapshot({ profile: null, project: "B" }));
    await invoke("configure", second, { style: "minimal", size: 72, orbUnit: "cost" });
    await invoke("new-board", second);
    const secondBoard = surfaces("board")[1]!;
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const firstId = state(first).instanceId,
      secondId = state(second).instanceId;
    const firstBounds = first.getBounds(),
      secondBounds = second.getBounds();
    expect(state(settings).orbManagement.canMerge).toBe(true);
    await invoke("orb-command", settings, { type: "merge", instanceId: secondId });
    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(false);
    expect(second.getBounds()).toEqual(secondBounds);
    expect(state(settings)).toMatchObject({
      instanceId: secondId,
      scope: { profile: null, project: null },
      snapshot: null,
      preferences: { style: "minimal", size: 72, orbUnit: "cost" },
      orbUndo: { kind: "merge", expiresAt: mock.now + 8_000 },
      orbManagement: { canMerge: false, canSplit: false },
    });
    expect([state(firstBoard).board!.orbId, state(secondBoard).board!.orbId]).toEqual([
      secondId,
      secondId,
    ]);
    publish(second, snapshot({ profile: null, project: "B" }));
    expect(state(second).snapshot).toBeNull();
    await invoke("orb-command", settings, { type: "undo" });
    const restoredFirst = surfaces("orb").find((orb) => state(orb).instanceId === firstId)!;
    expect(restoredFirst.getBounds()).toEqual(firstBounds);
    expect(second.getBounds()).toEqual(secondBounds);
    expect(state(restoredFirst).scope.project).toBe("A");
    expect(state(second).scope.project).toBe("B");
    expect(state(second).snapshot).toBeNull();
    expect([state(firstBoard).board!.orbId, state(secondBoard).board!.orbId]).toEqual([
      firstId,
      secondId,
    ]);
    expect(state(settings).orbManagement.canMerge).toBe(true);
    const saved = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(saved.orbs.map((orb: { scope: { project: string } }) => orb.scope.project)).toEqual([
      "A",
      "B",
    ]);
  });

  it("exports only the requested real mode/date rows and rejects renderer filenames or unavailable ranges", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    const data = snapshot();
    data.days.unshift({ ...data.today, date: "2026-10-23", agentCount: 1 });
    data.historyRange.startDate = "2026-10-23";
    const counts = {
      requests: 2,
      outputTokens: 140,
      measuredOutputTokens: 140,
      measuredDurationMs: 2000,
    };
    data.breakdowns.modes = [
      {
        ...counts,
        date: "2026-10-23",
        source: "omp",
        model: "outside-date-model",
        kind: "speed",
        value: "fast",
        evidence: "recorded",
        provider: "openai",
      },
      {
        ...counts,
        date: "2026-10-24",
        source: "omp",
        model: "outside-kind-model",
        kind: "effort",
        value: "high",
        evidence: "selected",
        provider: "openai",
      },
      {
        ...counts,
        date: "2026-10-24",
        source: "omp",
        model: "included-mode-model",
        kind: "speed",
        value: null,
        evidence: null,
        provider: null,
      },
    ];
    publish(first, data);
    const range = { startDate: "2026-10-24", endDate: "2026-10-24", kind: "speed" };
    for (const value of [
      undefined,
      { ...range, kind: "standard" },
      { ...range, startDate: "2000-01-01" },
      { ...range, filePath: "C:/outside.csv" },
      { ...range, endDate: "2026-10-23" },
    ])
      await expect(invoke("export-mode-csv", first, value)).rejects.toThrow();
    expect(mock.save).not.toHaveBeenCalled();
    expect(() => invoke("export-mode-csv", first, range, {})).toThrow();
    expect(await invoke("export-mode-csv", first, range)).toBe("cancelled");
    const destination = path.join(mock.userData, "actual-selected-modes.csv");
    mock.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    expect(await invoke("export-mode-csv", first, range)).toBe("saved");
    const csv = await readFile(destination, "utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("included-mode-model");
    expect(csv).toContain("unknown");
    expect(csv).toContain("avg_speed_tok_s");
    expect(csv).not.toContain("outside-date-model");
    expect(csv).not.toContain("outside-kind-model");
    mock.save.mockResolvedValueOnce({ canceled: false, filePath: mock.userData });
    expect(await invoke("export-mode-csv", first, range)).toBe("failed");
    expect(await invoke("export-mode-csv", first, range)).toBe("cancelled");
  });

  it("resets actual geometry to the native main-display corner or beside its blocker without changing numeric facts", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    await invoke("configure", first, { nameMode: "never", showName: "on" });
    await invoke("new-board", first);
    const board = surfaces("board")[0]!,
      boardBounds = board.getBounds();
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("configure", second, { showName: "off" });
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const firstId = state(first).instanceId,
      secondId = state(second).instanceId;
    const facts = JSON.stringify(state(first).snapshot);
    invoke("drag-start", first);
    await invoke("orb-command", settings, { type: "resetPosition", instanceId: firstId });
    expect(first.ignored).toBe(true);
    const corner = first.getBounds();
    expect(corner).toMatchObject({
      x: mock.area.width - 24 - 148 * 1.25,
      y: mock.area.height - 48 - 148 * 1.25,
    });
    mock.cursor = { x: 900, y: 500 };
    vi.advanceTimersByTime(100);
    expect(first.getBounds()).toEqual(corner);
    await invoke("orb-command", settings, { type: "resetPosition", instanceId: secondId });
    expect(second.getBounds()).toMatchObject({ x: corner.x - 160, y: corner.y });
    expect(board.getBounds()).toEqual(boardBounds);
    expect(JSON.stringify(state(first).snapshot)).toBe(facts);
    expect(state(first).preferences).toMatchObject({ nameMode: "never", showName: "on" });
    expect(state(second).preferences).toMatchObject({ nameMode: "never", showName: "off" });
    await invoke("orb-command", settings, { type: "visible", instanceId: firstId, visible: false });
    await invoke("orb-command", settings, { type: "resetPosition", instanceId: secondId });
    expect(second.getBounds()).toEqual(corner);
    expect(first.visible).toBe(false);
    const saved = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(
      saved.orbs.map((orb: { preferences: { showName: string } }) => orb.preferences.showName),
    ).toEqual(["on", "off"]);
    expect(Object.values(saved.orbs[1].positions)).toContainEqual({ x: corner.x, y: corner.y });
    await expect(
      invoke("orb-command", first, { type: "resetPosition", instanceId: firstId }),
    ).rejects.toThrow();
    await expect(
      invoke("orb-command", settings, {
        type: "resetPosition",
        instanceId: secondId,
        x: 100,
      }),
    ).rejects.toThrow();
  });

  it("exports all retained history and accepts sparse interior dates without accepting invalid or out-of-bounds dates", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    const data = snapshot();
    data.days.unshift({ ...data.today, date: "2025-01-02", requests: 9, agentCount: 1 });
    data.historyRange.startDate = "2025-01-02";
    data.historyRange.limited = true;
    data.historyRange.scanning = true;
    data.coverage.limited = true;
    data.status = "partial";
    publish(first, data);
    const all = { startDate: "2025-01-02", endDate: "2026-10-24" };
    const fullFile = path.join(mock.userData, "all-retained-history.csv");
    mock.save.mockResolvedValueOnce({ canceled: false, filePath: fullFile });
    expect(await invoke("export-csv", first, all)).toBe("saved");
    const full = await readFile(fullFile, "utf8");
    expect(full).toContain('"2025-01-02"');
    expect(full).toContain('"2026-10-24"');
    expect(full).toContain('"partial"');
    const empty = { startDate: "2025-06-03", endDate: "2025-06-30" };
    const emptyFile = path.join(mock.userData, "sparse-empty-history.csv");
    mock.save.mockResolvedValueOnce({ canceled: false, filePath: emptyFile });
    expect(await invoke("export-csv", first, empty)).toBe("saved");
    expect(await readFile(emptyFile, "utf8")).not.toContain('"daily"');
    const modesFile = path.join(mock.userData, "sparse-empty-modes.csv");
    mock.save.mockResolvedValueOnce({ canceled: false, filePath: modesFile });
    expect(await invoke("export-mode-csv", first, { ...empty, kind: "effort" })).toBe("saved");
    expect((await readFile(modesFile, "utf8")).trim().split("\r\n")).toHaveLength(1);
    const dialogs = mock.save.mock.calls.length;
    for (const range of [
      { ...all, startDate: "2025-01-01" },
      { ...all, endDate: "2026-11-01" },
      { startDate: "2026-02-30", endDate: "2026-03-01" },
      { ...all, startDate: "0000-01-01" },
      { ...all, filePath: "C:/outside.csv" },
    ])
      await expect(invoke("export-csv", first, range)).rejects.toThrow();
    const future = {
      ...data,
      historyRange: { ...data.historyRange, endDate: "2026-11-01" },
      days: [...data.days, { ...data.today, date: "2026-11-01", agentCount: 1 }],
    };
    publish(first, future);
    await expect(
      invoke("export-csv", first, {
        startDate: "2026-10-24",
        endDate: "2026-11-01",
      }),
    ).rejects.toThrow();
    publish(first, { ...data, historyRange: { ...data.historyRange, startDate: null } });
    await expect(invoke("export-mode-csv", first, { ...empty, kind: "speed" })).rejects.toThrow();
    expect(mock.save.mock.calls).toHaveLength(dialogs);
  });

  it("keeps advanced orb names and redlines independent through Add, Duplicate, Merge, undo and reload", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("configure", first, {
      orbName: "  Prime\torb  ",
      redline: 350,
      orbRedlineOutput: 175,
      orbRedlineTotal: 236_789,
    });
    expect(state(first)).toMatchObject({
      orbName: "Prime orb",
      effectiveRedline: 200,
      preferences: { redline: 350, orbRedlineOutput: 200, orbRedlineTotal: 240_000 },
    });
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!,
      firstId = state(first).instanceId;
    await invoke("orb-command", settings, { type: "duplicate", instanceId: firstId });
    const duplicate = surfaces("orb")[1]!,
      duplicateId = state(duplicate).instanceId;
    expect(state(duplicate)).toMatchObject({
      orbName: "Prime orb 2",
      effectiveRedline: 200,
      preferences: { orbRedlineOutput: 200, orbRedlineTotal: 240_000 },
    });
    await invoke("new-window", first);
    const added = surfaces("orb")[2]!;
    expect(state(added)).toMatchObject({
      orbName: "OMP",
      effectiveRedline: 350,
      preferences: { orbName: null, orbRedlineOutput: null, orbRedlineTotal: null },
    });
    await invoke("configure", added, { orbName: "Second", orbRedlineOutput: 450 });
    await invoke("configure", first, { redline: 1000 });
    expect([
      state(first).effectiveRedline,
      state(added).effectiveRedline,
      state(duplicate).effectiveRedline,
    ]).toEqual([200, 450, 200]);
    await invoke("configure", first, { metric: "total", redline: 500_000 });
    expect([
      state(first).effectiveRedline,
      state(added).effectiveRedline,
      state(duplicate).effectiveRedline,
    ]).toEqual([240_000, 500_000, 240_000]);
    await invoke("configure", first, { orbRedlineTotal: null });
    expect(state(first).effectiveRedline).toBe(500_000);
    expect(state(first).preferences.orbRedlineOutput).toBe(200);
    await invoke("orb-command", settings, { type: "merge", instanceId: duplicateId });
    expect(state(settings)).toMatchObject({
      instanceId: duplicateId,
      orbName: "OMP",
      effectiveRedline: 240_000,
      preferences: { orbName: null, orbRedlineOutput: 200, orbRedlineTotal: 240_000 },
    });
    await invoke("orb-command", settings, { type: "undo" });
    expect(state(settings).orbs.map((orb) => [orb.name, orb.effectiveRedline])).toEqual([
      ["Prime orb", 500_000],
      ["Second", 500_000],
      ["Prime orb 2", 240_000],
    ]);
    const expected = state(settings).orbs;
    await invoke("close-all", settings);
    await instance.dispose();
    const reopened = controller();
    await reopened.open();
    const current = surfaces("orb")[0]!;
    expect(state(current).orbs).toEqual(expected);
    expect(state(current).preferences).toMatchObject({
      redline: 500_000,
      orbName: "Prime orb",
      orbRedlineOutput: 200,
      orbRedlineTotal: null,
    });
  });

  it("uses each orb's effective redline for the native simultaneous-hot-orb frame limit", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    for (let index = 1; index < 4; index++) await invoke("new-window", first);
    const orbs = surfaces("orb");
    for (const orb of orbs) {
      await invoke("configure", orb, { orbRedlineOutput: 100 });
      const data = snapshot();
      data.rate.measuredTps = 100;
      publish(orb, data);
    }
    expect(orbs.map((orb) => state(orb).preferences.redline)).toEqual([2000, 2000, 2000, 2000]);
    expect(orbs.map((orb) => state(orb).maxFps)).toEqual([30, 30, 30, 60]);
  });

  it("shares the real General title while preserving orb overrides and restores literal General-following nulls on title undo", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("configure", first, { titleTheme: "animals" });
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("configure", second, { orbTitleTheme: "space" });
    expect([state(first).effectiveTitleTheme, state(second).effectiveTitleTheme]).toEqual([
      "animals",
      "space",
    ]);
    await invoke("configure", first, { titleTheme: "wind" });
    expect(state(second).preferences.titleTheme).toBe("wind");
    expect([state(first).effectiveTitleTheme, state(second).effectiveTitleTheme]).toEqual([
      "wind",
      "space",
    ]);
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    const copied = (await invoke("title-theme", settings, {
      type: "copy",
      sourceId: "wind",
      language: "en",
    })) as OmpTitleThemeResult;
    const id = copied.selected!;
    expect(copied.ok).toBe(true);
    expect(state(second).preferences.titleTheme).toBe(id);
    expect(state(second).effectiveTitleTheme).toBe("space");
    await invoke("configure", first, { orbTitleTheme: id });
    await invoke("new-window", second);
    const third = surfaces("orb")[2]!;
    await invoke("configure", third, { orbTitleTheme: null });
    expect(state(third).effectiveTitleTheme).toBe(id);
    const deleted = (await invoke("title-theme", settings, {
      type: "delete",
      id,
    })) as OmpTitleThemeResult;
    expect(deleted.ok).toBe(true);
    expect(state(first).preferences).toMatchObject({ titleTheme: "wind", orbTitleTheme: "wind" });
    expect(state(second).preferences.orbTitleTheme).toBe("space");
    expect(state(third).preferences.orbTitleTheme).toBeNull();
    await invoke("configure", third, { orbTitleTheme: "mage" });
    const undone = (await invoke("title-theme", settings, { type: "undo" })) as OmpTitleThemeResult;
    expect(undone.ok).toBe(true);
    expect(state(first).preferences).toMatchObject({ titleTheme: id, orbTitleTheme: id });
    expect(state(second).preferences).toMatchObject({ titleTheme: id, orbTitleTheme: "space" });
    expect(state(third).preferences).toMatchObject({ titleTheme: id, orbTitleTheme: null });
    expect([
      state(first).effectiveTitleTheme,
      state(second).effectiveTitleTheme,
      state(third).effectiveTitleTheme,
    ]).toEqual([id, "space", id]);
    const expected = state(settings).orbs;
    await invoke("close-all", settings);
    await instance.dispose();
    const reopened = controller();
    await reopened.open();
    const restored = surfaces("orb");
    expect(state(restored[0]!).orbs).toEqual(expected);
    expect(restored.map((orb) => state(orb).preferences.orbTitleTheme)).toEqual([
      id,
      "space",
      null,
    ]);
  });
});

describe("authenticated OMP source settings", () => {
  it("restricts every source command to the exact Settings main frame and never accepts renderer paths", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    for (const channel of ["source-enabled", "source-folder", "source-folder-reset"]) {
      await expect(
        invoke(channel, orb, channel === "source-enabled" ? false : undefined),
      ).rejects.toThrow("Settings");
      expect(() => invoke(channel, settings, undefined, {})).toThrow("Unauthorized");
    }
    await expect(invoke("source-enabled", settings, "false")).rejects.toThrow();
    await expect(invoke("source-folder", settings, { folder: "C:/arbitrary" })).rejects.toThrow(
      "native-owned",
    );
    await expect(invoke("source-folder-reset", settings, "C:/arbitrary")).rejects.toThrow(
      "native-owned",
    );
    await expect(invoke("source-folder", settings)).rejects.toThrow("Injected");
    expect(mock.openFolder).not.toHaveBeenCalled();
    expect(mock.workers).toHaveLength(1);
    expect(state(settings).ompSource).toMatchObject({
      enabled: true,
      usingDefaultFolder: true,
      canChangeFolder: false,
      status: "scanning",
      folder: path.resolve("C:/isolated-fixture"),
    });
    expect(state(orb).ompSource.folder).toBe("");
  });

  it("waits for clean old-worker exit, clears stale facts, preserves filters and forwards concurrent commands only to the new source", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    publish(orb);
    await invoke("scope", orb, { profile: "second", project: "B" });
    publish(orb, snapshot({ profile: "second", project: "B" }));
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      old = mock.workers[0]!;
    expect(state(settings).ompSource).toMatchObject({ status: "ready", sessions: 1 });
    mock.autoShutdown = false;
    const disabling = invoke("source-enabled", settings, false) as Promise<void>;
    await Promise.resolve();
    await Promise.resolve();
    expect(old.postMessage).toHaveBeenCalledWith(
      { type: "shutdown", requestId: expect.any(Number) },
      [],
    );
    expect(old.terminate).not.toHaveBeenCalled();
    expect(mock.workers).toHaveLength(1);
    expect(state(settings).ompSource.changing).toBe(true);
    expect(state(orb).snapshot).toBeNull();
    publish(orb, snapshot({ profile: "second", project: "B" }), old);
    expect(state(orb).snapshot).toBeNull();
    const network = invoke("network-enabled", settings, false);
    const refresh = invoke("refresh", settings);
    const shutdown = old.postMessage.mock.calls.find(
      ([request]) => request.type === "shutdown",
    )![0];
    old.emit("message", { type: "command-result", requestId: shutdown.requestId, ok: true });
    old.emit("exit", 0);
    await disabling;
    await Promise.all([network, refresh]);
    expect(mock.workers).toHaveLength(2);
    const disabled = mock.workers[1]!;
    expect(disabled.options.workerData.roots).toEqual([]);
    expect(disabled.postMessage).toHaveBeenCalledWith(
      { type: "pricing.configure", requestId: expect.any(Number), networkEnabled: false },
      [],
    );
    expect(disabled.postMessage).toHaveBeenCalledWith({ type: "refresh" }, []);
    expect(
      old.postMessage.mock.calls.some(([request]) => request.type === "pricing.configure"),
    ).toBe(false);
    expect(state(settings).scope).toEqual({ profile: "second", project: "B" });
    expect(state(settings).ompSource).toMatchObject({
      enabled: false,
      status: "disabled",
      sessions: 0,
      changing: false,
    });
    expect(
      JSON.parse(await readFile(path.join(mock.userData, "local-monitor", "sources.json"), "utf8")),
    ).toEqual({ version: 1, enabled: false, folder: null });
    mock.autoShutdown = true;
    await invoke("source-enabled", settings, true);
    expect(mock.workers[2]!.options.workerData.roots).toEqual([
      { path: "C:/isolated-fixture", label: "fixture" },
    ]);
    expect(state(orb).activity).toMatchObject({
      responseSequence: 0,
      peakSequence: 0,
      lastResponseAt: null,
      lastPeakAt: null,
    });
  });

  it("never resets explicit QA roots, including an empty root list, to real environment roots", async () => {
    await mkdir(path.join(mock.userData, "local-monitor"), { recursive: true });
    await writeFile(
      path.join(mock.userData, "local-monitor", "sources.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        folder: path.join(mock.userData, "must-not-replace-injected-roots"),
      }),
    );
    const instance = controller({ roots: [] });
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    await invoke("source-folder-reset", settings);
    await invoke("source-enabled", settings, false);
    await invoke("source-enabled", settings, true);
    expect(mock.workers.every((worker) => Array.isArray(worker.options.workerData.roots))).toBe(
      true,
    );
    expect(mock.workers.every((worker) => worker.options.workerData.roots!.length === 0)).toBe(
      true,
    );
    expect(state(settings).ompSource).toMatchObject({
      folder: "",
      usingDefaultFolder: true,
      canChangeFolder: false,
    });
    expect(mock.openFolder).not.toHaveBeenCalled();
  });

  it("uses the real native picker with its Settings owner, persists its canonical folder, and resets to the actual environment default", async () => {
    const instance = controller({});
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      chosen = path.join(mock.userData, "chosen", "sessions");
    await mkdir(chosen, { recursive: true });
    expect(state(settings).ompSource).toMatchObject({
      folder: path.join(mock.userData, "owned-default-agent", "sessions"),
      usingDefaultFolder: true,
      canChangeFolder: true,
    });
    mock.openFolder.mockResolvedValueOnce({ canceled: false, filePaths: [chosen] });
    expect(await invoke("source-folder", settings)).toBe("changed");
    expect(mock.openFolder).toHaveBeenCalledWith(
      settings,
      expect.objectContaining({
        properties: ["openDirectory", "dontAddToRecent"],
      }),
    );
    expect(mock.workers[0]!.terminate).not.toHaveBeenCalled();
    expect(mock.workers[1]!.options.workerData.roots).toEqual([{ path: chosen, label: "default" }]);
    expect(state(settings).ompSource).toMatchObject({
      enabled: true,
      folder: chosen,
      usingDefaultFolder: false,
    });
    expect(state(orb).ompSource.folder).toBe("");
    await invoke("source-folder-reset", settings);
    expect(mock.workers[2]!.options.workerData.roots).toBeUndefined();
    expect(state(settings).ompSource).toMatchObject({
      folder: path.join(mock.userData, "owned-default-agent", "sessions"),
      usingDefaultFolder: true,
    });
    expect(
      JSON.parse(await readFile(path.join(mock.userData, "local-monitor", "sources.json"), "utf8"))
        .folder,
    ).toBeNull();
    const before = mock.workers.length;
    expect(await invoke("source-folder", settings)).toBe("cancelled");
    expect(mock.workers).toHaveLength(before);
  });

  it("does not commit a native selection after its authenticated Settings owner closes", async () => {
    const instance = controller({});
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      chosen = path.join(mock.userData, "chosen");
    await mkdir(chosen);
    const selection = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    const dialogOpened = Promise.withResolvers<void>();
    mock.openFolder.mockImplementationOnce(() => {
      dialogOpened.resolve();
      return selection.promise;
    });
    const selecting = invoke("source-folder", settings) as Promise<unknown>;
    await dialogOpened.promise;
    expect(state(settings).ompSource.changing).toBe(true);
    settings.destroy();
    selection.resolve({ canceled: false, filePaths: [chosen] });
    await expect(selecting).rejects.toThrow("Settings");
    expect(mock.workers).toHaveLength(1);
    expect(state(orb).ompSource).toMatchObject({
      enabled: true,
      usingDefaultFolder: true,
      changing: false,
    });
    await expect(
      readFile(path.join(mock.userData, "local-monitor", "sources.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not claim a successful source change when clean shutdown or persistence fails", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!,
      first = mock.workers[0]!;
    mock.autoShutdown = false;
    const failed = invoke("source-enabled", settings, false);
    await Promise.resolve();
    await Promise.resolve();
    first.emit("exit", 1);
    await expect(failed).rejects.toThrow("cleanly");
    expect(state(settings).ompSource).toMatchObject({
      enabled: true,
      status: "error",
      changing: false,
    });
    expect(mock.workers[1]!.options.workerData.roots).toEqual([
      { path: "C:/isolated-fixture", label: "fixture" },
    ]);
    mock.autoShutdown = true;
    await mkdir(path.join(mock.userData, "local-monitor", "sources.json"), { recursive: true });
    await expect(invoke("source-enabled", settings, false)).rejects.toThrow("Unsafe");
    expect(state(settings).ompSource).toMatchObject({
      enabled: true,
      status: "error",
      changing: false,
    });
    expect(mock.workers[2]!.options.workerData.roots).toEqual([
      { path: "C:/isolated-fixture", label: "fixture" },
    ]);
  });

  it("restores a disabled source without starting a real-root collector, then repairs corrupt source settings only on explicit action", async () => {
    await mkdir(path.join(mock.userData, "local-monitor"), { recursive: true });
    const sourceFile = path.join(mock.userData, "local-monitor", "sources.json");
    await writeFile(sourceFile, "{corrupt-saved-source");
    const instance = controller({});
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("surface", orb, "settings");
    const settings = surfaces("settings")[0]!;
    expect(mock.workers[0]!.options.workerData.roots).toEqual([]);
    expect(state(settings).ompSource).toMatchObject({ enabled: false, status: "disabled" });
    expect(await readFile(sourceFile, "utf8")).toBe("{corrupt-saved-source");
    await invoke("source-enabled", settings, false);
    expect(JSON.parse(await readFile(sourceFile, "utf8"))).toEqual({
      version: 1,
      enabled: false,
      folder: null,
    });
    await invoke("close-all", settings);
    await instance.dispose();
    const reopened = controller({});
    await reopened.open();
    expect(mock.workers.at(-1)!.options.workerData.roots).toEqual([]);
    expect(state(surfaces("orb")[0]!).ompSource.enabled).toBe(false);
  });
});

function perfCardSnapshot(): OmpMonitorSnapshot {
  const result = snapshot();
  const agent = {
    id: "alpha",
    parentId: null,
    name: "Alpha",
    project: "A",
    profile: "default",
    kind: "main" as const,
    model: "fixture-model",
    phase: "generating" as const,
    lastActivityAt: mock.now,
    outputTps: 40,
    totalTps: 150,
    liveMeasuredTps: 40,
    liveEstimatedTps: 0,
    liveMeasuredTotalTps: 150,
    liveEstimatedTotalTps: 0,
    thinkingTps: null,
    liveCostUsdPerSecond: null,
    speedMode: null,
    effortMode: null,
    ttftMs: 100,
  };
  result.agents = [
    agent,
    { ...agent, id: "beta", parentId: "alpha", name: "Beta", kind: "subagent" },
  ];
  return result;
}
function perfCardRequest(agentId = "alpha"): OmpMonitorPerfCardRequest {
  return {
    agentId,
    anchor: { x: 40, y: 40, width: 280, height: 280 },
    rowTop: 80,
    topCount: 0,
    subAgents: 0,
    facts: [],
  };
}
function requestCard(
  window: MockWindow,
  value: unknown,
  frame = window.webContents.mainFrame,
): void {
  mock.listeners.get("paseo:monitor:perf-card")!(
    { sender: window.webContents, senderFrame: frame },
    value,
  );
}
function cardState(window: MockWindow): OmpMonitorPerfCardState {
  return invoke("perf-card-ready", window) as OmpMonitorPerfCardState;
}
function cardWindow(): MockWindow {
  const window = mock.windows.find(
    (candidate) =>
      !candidate.destroyed && candidate.url === "omp-desktop://monitor/local-perf-card",
  );
  if (!window) throw new Error("Missing independent performance tooltip");
  return window;
}

describe("independent native performance tooltip", () => {
  it("measures before nonactivating show, uses the exact host content-screen origin and reuses one passthrough window", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("new-board", orb);
    const board = surfaces("board")[0]!;
    publish(orb, perfCardSnapshot());
    board.setBounds({ x: 600, y: 100, width: 420, height: 420 });
    board.contentInsets = { left: 11, top: 17, right: 7, bottom: 9 };
    requestCard(board, perfCardRequest());
    const popup = cardWindow(),
      first = cardState(popup);
    expect(popup.options).toMatchObject({
      transparent: true,
      frame: false,
      show: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      resizable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    expect(popup.inputChanges).toEqual([{ ignored: true, visible: false, loaded: false }]);
    expect(popup.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.loaded).toBe(true);
    expect(popup.visible).toBe(false);
    expect(first.maxCardHeight).toBe(1024);
    await invoke("perf-card-size", popup, { sequence: first.sequence, height: 600, compact: 0 });
    expect(popup.getBounds()).toEqual({ x: 915, y: 177, width: 368, height: 652 });
    expect(popup.bounds.height).toBeGreaterThan(board.bounds.height);
    expect(popup.visible).toBe(true);
    expect(popup.showInactive).toHaveBeenCalledTimes(1);
    expect(popup.focus).not.toHaveBeenCalled();
    expect(() => state(popup)).toThrow("Unauthorized");
    expect(state(orb).windowCount).toBe(1);
    expect(surfaces("board")).toHaveLength(1);
    const count = mock.windows.length;
    requestCard(board, perfCardRequest("beta"));
    const second = cardState(popup),
      before = popup.getBounds();
    expect(second.sequence).toBeGreaterThan(first.sequence);
    await invoke("perf-card-size", popup, { sequence: first.sequence, height: 900, compact: 0 });
    expect(popup.getBounds()).toEqual(before);
    await invoke("perf-card-size", popup, { sequence: second.sequence, height: 620, compact: 0 });
    expect(popup.bounds.height).toBe(672);
    expect(mock.windows).toHaveLength(count);
    expect(cardWindow()).toBe(popup);
    expect(popup.showInactive).toHaveBeenCalledTimes(1);
  });

  it("never resurrects a dismissed load or size and an old fade cannot hide a newer request", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    await invoke("configure", dashboard, { showPerformance: true });
    publish(orb, perfCardSnapshot());
    const loading = Promise.withResolvers<void>();
    mock.loadWindow.mockImplementationOnce(() => loading.promise);
    requestCard(dashboard, perfCardRequest());
    const popup = cardWindow(),
      initial = cardState(popup);
    invoke("perf-card-size", popup, { sequence: initial.sequence, height: 500, compact: 0 });
    expect(popup.visible).toBe(false);
    requestCard(dashboard, null);
    expect(cardState(popup).request).toBeNull();
    loading.resolve();
    await vi.advanceTimersByTimeAsync(0);
    invoke("perf-card-size", popup, { sequence: initial.sequence, height: 500, compact: 0 });
    expect(popup.visible).toBe(false);
    expect(popup.showInactive).not.toHaveBeenCalled();
    requestCard(dashboard, perfCardRequest("beta"));
    const second = cardState(popup);
    invoke("perf-card-size", popup, { sequence: second.sequence, height: 520, compact: 0 });
    expect(popup.visible).toBe(true);
    requestCard(dashboard, null);
    expect(cardState(popup).request).toBeNull();
    expect(popup.visible).toBe(true);
    vi.advanceTimersByTime(50);
    requestCard(dashboard, perfCardRequest());
    const third = cardState(popup);
    invoke("perf-card-size", popup, { sequence: third.sequence, height: 540, compact: 0 });
    invoke("perf-card-size", popup, { sequence: second.sequence, height: 800, compact: 0 });
    vi.advanceTimersByTime(100);
    expect(popup.visible).toBe(true);
    expect(popup.bounds.height).toBe(592);
    requestCard(dashboard, null);
    vi.advanceTimersByTime(99);
    expect(popup.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(popup.visible).toBe(false);
  });

  it("authenticates both exact main frames and rejects unowned agents, screen coordinates, counts and unbounded facts", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    await invoke("configure", dashboard, { showPerformance: true });
    const initialWindows = mock.windows.length;
    requestCard(dashboard, perfCardRequest());
    expect(mock.windows).toHaveLength(initialWindows);
    publish(orb, perfCardSnapshot());
    requestCard(dashboard, perfCardRequest(), {});
    requestCard(orb, perfCardRequest());
    mock.listeners.get("paseo:monitor:perf-card")!(
      {
        sender: { id: dashboard.webContents.id },
        senderFrame: dashboard.webContents.mainFrame,
      },
      perfCardRequest(),
    );
    for (const request of [
      { ...perfCardRequest(), agentId: "not-in-snapshot" },
      { ...perfCardRequest(), anchor: { x: NaN, y: 0, width: 280, height: 280 } },
      { ...perfCardRequest(), anchor: { x: 200, y: 40, width: 280, height: 280 } },
      { ...perfCardRequest(), rowTop: dashboard.getContentBounds().height * 2 + 1 },
      { ...perfCardRequest(), topCount: 3 },
      { ...perfCardRequest(), topCount: -1 },
      { ...perfCardRequest(), subAgents: 2 },
      { ...perfCardRequest(), facts: [42] },
      { ...perfCardRequest(), facts: ["x".repeat(1025)] },
      { ...perfCardRequest(), screenX: 3000 },
    ])
      requestCard(dashboard, request);
    expect(mock.windows).toHaveLength(initialWindows);
    requestCard(dashboard, perfCardRequest());
    const popup = cardWindow(),
      current = cardState(popup);
    expect(() => invoke("perf-card-ready", dashboard)).toThrow("Unauthorized");
    expect(() => invoke("perf-card-ready", popup, undefined, {})).toThrow("Unauthorized");
    expect(() =>
      invoke("perf-card-size", dashboard, { sequence: current.sequence, height: 500, compact: 0 }),
    ).toThrow("Unauthorized");
    expect(() =>
      invoke("perf-card-size", popup, { sequence: current.sequence, height: 500, compact: 0 }, {}),
    ).toThrow("Unauthorized");
    expect(() => invoke("configure", popup, { language: "en" })).toThrow("Unauthorized");
    await vi.advanceTimersByTimeAsync(0);
    invoke("perf-card-size", popup, { sequence: current.sequence, height: 500, compact: 0 });
    expect(popup.visible).toBe(true);
    requestCard(dashboard, null, {});
    expect(cardState(popup).request?.agentId).toBe("alpha");
    requestCard(popup, null);
    expect(cardState(popup).request?.agentId).toBe("alpha");
  });

  it("does not let another host's leave, blur or close hide the current host's card", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    await invoke("configure", dashboard, { showPerformance: true });
    await invoke("new-board", orb);
    const board = surfaces("board")[0]!;
    publish(orb, perfCardSnapshot());
    requestCard(dashboard, perfCardRequest());
    const popup = cardWindow();
    cardState(popup);
    await vi.advanceTimersByTimeAsync(0);
    requestCard(board, {
      ...perfCardRequest("beta"),
      subAgents: 1,
      topCount: 2,
      facts: ["Output 80 tok/s"],
    });
    const current = cardState(popup);
    invoke("perf-card-size", popup, { sequence: current.sequence, height: 500, compact: 0 });
    requestCard(dashboard, null);
    dashboard.emit("blur");
    dashboard.hide();
    dashboard.close();
    vi.advanceTimersByTime(200);
    expect(cardState(popup).request?.agentId).toBe("beta");
    expect(popup.visible).toBe(true);
    expect(board.listenerCount("blur")).toBe(1);
    expect(dashboard.listenerCount("blur")).toBe(0);
  });

  it("refreshes the owner's real snapshot, language, theme and screen-only compaction limit while following native geometry", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    await invoke("new-board", orb);
    const board = surfaces("board")[0]!;
    publish(orb, perfCardSnapshot());
    board.setBounds({ x: 600, y: 100, width: 420, height: 420 });
    requestCard(board, perfCardRequest());
    const popup = cardWindow(),
      initial = cardState(popup);
    await vi.advanceTimersByTimeAsync(0);
    invoke("perf-card-size", popup, { sequence: initial.sequence, height: 500, compact: 0 });
    const next = perfCardSnapshot();
    next.agents[0]!.ttftMs = 321;
    publish(orb, next);
    const updated = cardState(popup);
    expect(updated.sequence).toBeGreaterThan(initial.sequence);
    expect(updated.view.snapshot?.agents[0]!.ttftMs).toBe(321);
    mock.theme!.shouldUseDarkColors = true;
    mock.theme!.emit("updated");
    expect(cardState(popup).view.preferences.appearance).toBe("dark");
    await invoke("configure", board, { language: "en" });
    expect(cardState(popup).view.language).toBe("en");
    board.setBounds({ x: 100, y: 200, width: 420, height: 420 });
    board.emit("moved");
    expect(popup.getBounds()).toEqual({ x: 404, y: 260, width: 368, height: 552 });
    mock.area = { x: 0, y: 0, width: 1280, height: 720 };
    screen.emit("display-metrics-changed");
    const smaller = cardState(popup);
    expect(smaller.maxCardHeight).toBe(704);
    expect(smaller.maxCardHeight).toBeGreaterThan(board.bounds.height);
    expect(popup.getBounds()).toEqual({ x: 404, y: 192, width: 368, height: 552 });
    expect(() =>
      invoke("perf-card-size", popup, { sequence: smaller.sequence, height: 800, compact: 1 }),
    ).toThrow("compact");
    invoke("perf-card-size", popup, { sequence: smaller.sequence, height: 800, compact: 2 });
    expect(popup.getBounds()).toEqual({ x: 404, y: -12, width: 368, height: 852 });
    invoke("perf-card-size", popup, { sequence: updated.sequence, height: 350, compact: 0 });
    expect(popup.bounds.height).toBe(852);
    expect(popup.focus).not.toHaveBeenCalled();
  });

  it.each([
    "blur",
    "hide",
    "close",
    "unresponsive",
    "renderer loss",
    "scope change",
    "agent removal",
    "worker failure",
  ] as const)(
    "invalidates an owned card on %s without accepting a late measurement",
    async (reason) => {
      const instance = controller();
      await instance.open();
      const orb = surfaces("orb")[0]!;
      await invoke("new-board", orb);
      const board = surfaces("board")[0]!;
      publish(orb, perfCardSnapshot());
      requestCard(board, perfCardRequest());
      const popup = cardWindow(),
        current = cardState(popup);
      await vi.advanceTimersByTimeAsync(0);
      invoke("perf-card-size", popup, { sequence: current.sequence, height: 500, compact: 0 });
      if (reason === "hide") board.hide();
      else if (reason === "close") board.close();
      else if (reason === "renderer loss") board.webContents.emit("render-process-gone");
      else if (reason === "scope change")
        await invoke("scope", board, { profile: null, project: "A" });
      else if (reason === "agent removal") {
        const next = perfCardSnapshot();
        next.agents = next.agents.filter((agent) => agent.id !== "alpha");
        publish(orb, next);
      } else if (reason === "worker failure")
        mock.workers.at(-1)!.emit("error", new Error("Fixture worker lost"));
      else board.emit(reason);
      expect(cardState(popup).request).toBeNull();
      expect(popup.visible).toBe(false);
      const before = popup.getBounds();
      invoke("perf-card-size", popup, { sequence: current.sequence, height: 700, compact: 0 });
      vi.advanceTimersByTime(200);
      expect(popup.visible).toBe(false);
      expect(popup.getBounds()).toEqual(before);
      expect(board.listenerCount("blur")).toBe(0);
    },
  );

  it.each(["unresponsive", "renderer loss", "closed"] as const)(
    "tears down a lost %s popup, removes owned listeners and ignores its delayed load after a replacement",
    async (reason) => {
      const instance = controller();
      await instance.open();
      const orb = surfaces("orb")[0]!,
        dashboard = surfaces("dashboard")[0]!;
      await invoke("configure", dashboard, { showPerformance: true });
      publish(orb, perfCardSnapshot());
      const loading = Promise.withResolvers<void>();
      mock.loadWindow.mockImplementationOnce(() => loading.promise);
      requestCard(dashboard, perfCardRequest());
      const old = cardWindow(),
        initial = cardState(old);
      invoke("perf-card-size", old, { sequence: initial.sequence, height: 500, compact: 0 });
      if (reason === "renderer loss") old.webContents.emit("render-process-gone");
      else if (reason === "closed") old.destroy();
      else old.emit("unresponsive");
      expect(old.destroyed).toBe(true);
      expect(dashboard.listenerCount("blur")).toBe(0);
      expect(old.webContents.listenerCount("render-process-gone")).toBe(0);
      expect(old.webContents.listenerCount("will-navigate")).toBe(0);
      expect(() => cardState(old)).toThrow("Unauthorized");
      requestCard(dashboard, perfCardRequest("beta"));
      const replacement = cardWindow(),
        current = cardState(replacement);
      await vi.advanceTimersByTimeAsync(0);
      invoke("perf-card-size", replacement, {
        sequence: current.sequence,
        height: 540,
        compact: 0,
      });
      expect(replacement).not.toBe(old);
      expect(replacement.visible).toBe(true);
      const bounds = replacement.getBounds();
      loading.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(replacement.getBounds()).toEqual(bounds);
      expect(replacement.visible).toBe(true);
      expect(() =>
        invoke("perf-card-size", old, { sequence: initial.sequence, height: 900, compact: 0 }),
      ).toThrow("Unauthorized");
    },
  );

  it("fails closed when native passthrough or the private document load fails", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    await invoke("configure", dashboard, { showPerformance: true });
    publish(orb, perfCardSnapshot());
    mock.inputError = "set";
    requestCard(dashboard, perfCardRequest());
    expect(mock.windows.at(-1)!.destroyed).toBe(true);
    expect(dashboard.listenerCount("blur")).toBe(0);
    mock.inputError = null;
    mock.loadWindow.mockRejectedValueOnce(new Error("Owned tooltip document unavailable"));
    requestCard(dashboard, perfCardRequest());
    const failed = cardWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.destroyed).toBe(true);
    expect(failed.showInactive).not.toHaveBeenCalled();
    requestCard(dashboard, perfCardRequest());
    const recovered = cardWindow(),
      current = cardState(recovered);
    await vi.advanceTimersByTimeAsync(0);
    invoke("perf-card-size", recovered, { sequence: current.sequence, height: 500, compact: 0 });
    expect(recovered.visible).toBe(true);
  });

  it("destroys the owned popup and timers on close-all/dispose, including a pending document load", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    await invoke("configure", dashboard, { showPerformance: true });
    publish(orb, perfCardSnapshot());
    const loading = Promise.withResolvers<void>();
    mock.loadWindow.mockImplementationOnce(() => loading.promise);
    requestCard(dashboard, perfCardRequest());
    const popup = cardWindow(),
      current = cardState(popup);
    invoke("perf-card-size", popup, { sequence: current.sequence, height: 500, compact: 0 });
    await invoke("close-all", dashboard);
    expect(popup.destroyed).toBe(true);
    expect(dashboard.listenerCount("blur")).toBe(0);
    expect(popup.listenerCount("unresponsive")).toBe(0);
    expect(popup.webContents.listenerCount("render-process-gone")).toBe(0);
    loading.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.showInactive).not.toHaveBeenCalled();
    expect(() => cardState(popup)).toThrow("Unauthorized");
    await instance.dispose();
    expect(mock.handlers.size).toBe(0);
    expect(mock.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("clipped performance-row native placement", () => {
  it("keeps exact rowTop outside the panel frame and clamps only to the monitor work area", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    await invoke("configure", dashboard, { showPerformance: true });
    publish(orb, perfCardSnapshot());
    dashboard.setBounds({ x: 1000, y: 200, width: 368, height: 600 });
    requestCard(dashboard, { ...perfCardRequest(), rowTop: -10 });
    const popup = cardWindow(),
      initial = cardState(popup);
    await vi.advanceTimersByTimeAsync(0);
    invoke("perf-card-size", popup, { sequence: initial.sequence, height: 500, compact: 0 });
    expect(popup.getBounds()).toMatchObject({ y: 170, width: 368, height: 552 });
    expect(initial.request?.rowTop).toBe(-10);
    requestCard(dashboard, { ...perfCardRequest(), rowTop: -250 });
    const aboveScreen = cardState(popup);
    invoke("perf-card-size", popup, { sequence: aboveScreen.sequence, height: 500, compact: 0 });
    expect(popup.getBounds()).toMatchObject({ y: -12, width: 368, height: 552 });
  });
});
