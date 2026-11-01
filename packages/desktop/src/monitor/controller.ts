import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen } from "electron";
import type {
  Event as ElectronEvent,
  IpcMainInvokeEvent,
  IpcMainEvent,
  Rectangle,
  MenuItemConstructorOptions,
} from "electron";
import { isMainWindowSender } from "../window/main-windows.js";
import { launchAtLoginController } from "../settings/desktop-settings-electron.js";
import { buildMonitorCsv, buildMonitorModeCsv } from "./csv.js";
import {
  clampMonitorPanel,
  monitorArrangement,
  monitorNameplate,
  nearestMonitorArea,
  placeMonitorOrb,
  snapMonitorOrb,
  type MonitorDisplay,
  type OrbNeighbour,
} from "./window-geometry.js";
import {
  configureMonitorBoard,
  configureMonitorPreferences,
  duplicateMonitorOrbName,
  effectiveMonitorRedline,
  effectiveMonitorTitleTheme,
  DEFAULT_MONITOR_PREFERENCES,
  GLOBAL_MONITOR_KEYS,
  MAX_MONITOR_ORBS,
  readMonitorPreferences,
  readMonitorSourcePreferences,
  writeMonitorPreferences,
  writeMonitorSourcePreferences,
  type MonitorOrbRecord,
  type MonitorSourcePreferences,
} from "./window-preferences.js";
import { createMonitorWindowInput } from "./window-input.js";
import type { MonitorWindowInput } from "./window-input.js";
import { OmpMonitorPerfCardWindow } from "./perf-card-window.js";
import {
  createMonitorWindowChrome,
  flushMonitorSettingsDraft,
  MONITOR_NATIVE_PANEL_METRICS,
  releaseMonitorSettingsDraftLock,
} from "./window-chrome.js";
import { defaultOmpMonitorFolder, regularDirectory, selectedOmpSourceFolder } from "./roots.js";
import type {
  OmpMonitorRoot,
  OmpMonitorScope,
  OmpMonitorSnapshot,
  OmpMonitorWorkerRequest,
  OmpMonitorWorkerResponse,
} from "./types.js";
import type {
  OmpMonitorActivityEvents,
  OmpMonitorChooseSourceResult,
  OmpMonitorSourceState,
  OmpMonitorExportRange,
  OmpMonitorExportResult,
  OmpMonitorOrbSummary,
  OmpMonitorEffectsPreview,
  OmpMonitorPreferences,
  OmpMonitorSurface,
  OmpMonitorViewState,
} from "./view-types.js";
import { DEFAULT_BOARD_PREFERENCES, MAX_MONITOR_BOARDS } from "./board-types.js";
import type { OmpMonitorBoardRecord, OmpMonitorBoardSummary } from "./board-types.js";
import {
  OmpTitleThemesStore,
  isCustomTitleThemeId,
  type OmpTitleThemeResult,
} from "./title-themes.js";

const MONITOR_URL = "omp-desktop://monitor/local-monitor";
const NO_TRANSFERABLES: [] = [];
const PANEL_SIZES = {
  dashboard: { width: 368, height: 840 },
  ...MONITOR_NATIVE_PANEL_METRICS,
} as const;
type PanelSurface = keyof typeof PANEL_SIZES;
type PricingSettingsCommand = Omit<
  Extract<OmpMonitorWorkerRequest, { type: "pricing.configure" }>,
  "requestId"
>;
type AcknowledgedWorkerCommand = PricingSettingsCommand | { type: "shutdown" };
const SETTINGS_SAVE_ERROR =
  "Unable to save monitor pricing settings. Retry saving before closing or changing sources.";
const SETTINGS_UNKNOWN_ERROR =
  "Monitor pricing settings save could not be confirmed. Save again before closing or changing sources.";
interface OrbSession {
  record: MonitorOrbRecord;
  window: BrowserWindow;
  snapshot: OmpMonitorSnapshot | null;
  workerError: boolean;
  refreshing: boolean;
  createdAt: number;
  baseline: boolean;
  lastResponse: number;
  previousPeak: number;
  day: string;
  peakMutedUntil: number;
  activity: OmpMonitorActivityEvents;
  interactive: boolean;
  inputBlocked: boolean;
  interaction: number;
  pointer: { x: number; y: number } | null;
  drag: { cursor: { x: number; y: number }; bounds: Rectangle } | null;
}
interface BoardSession {
  record: OmpMonitorBoardRecord;
  window: BrowserWindow;
  orb: OrbSession;
  ignored: boolean;
  unresponsive: boolean;
}
interface MonitorView {
  window: BrowserWindow;
  surface: OmpMonitorSurface;
  orb: OrbSession;
  exporting: boolean;
  board: OmpMonitorBoardRecord | null;
}

interface OrbEditUndo {
  kind: "remove" | "merge";
  orbs: MonitorOrbRecord[];
  boardReferences: { id: string; orbId: string }[];
  expiresAt: number;
}

function copyOrbRecord(record: MonitorOrbRecord): MonitorOrbRecord {
  return {
    ...record,
    scope: { ...record.scope },
    preferences: { ...record.preferences },
    positions: Object.fromEntries(
      Object.entries(record.positions).map(([key, point]) => [key, { ...point }]),
    ),
  };
}

function requireOrbCommandKeys(command: Record<string, unknown>): void {
  let keys: readonly string[];
  switch (command.type) {
    case "visible":
      keys = ["type", "instanceId", "visible"];
      break;
    case "move":
      keys = ["type", "instanceId", "index"];
      break;
    case "duplicate":
    case "remove":
    case "merge":
    case "resetPosition":
      keys = ["type", "instanceId"];
      break;
    case "undo":
    case "dismissUndo":
      keys = ["type"];
      break;
    default:
      throw new Error("Invalid orb command");
  }
  const actualKeys = Object.keys(command);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key)))
    throw new Error("Invalid orb command");
}

function restoredOrbRecord(
  record: MonitorOrbRecord,
  global: OmpMonitorPreferences,
  customIds: ReadonlySet<string>,
): MonitorOrbRecord {
  const next = copyOrbRecord(record);
  for (const key of GLOBAL_MONITOR_KEYS) Object.assign(next.preferences, { [key]: global[key] });
  if (
    isCustomTitleThemeId(next.preferences.titleTheme) &&
    !customIds.has(next.preferences.titleTheme)
  )
    next.preferences.titleTheme = "vehicles";
  if (
    isCustomTitleThemeId(next.preferences.orbTitleTheme) &&
    !customIds.has(next.preferences.orbTitleTheme)
  )
    next.preferences.orbTitleTheme = null;
  return next;
}

function nearestOrbGridPosition(
  center: { x: number; y: number },
  radius: number,
  area: Rectangle,
  free: (x: number, y: number) => boolean,
): { x: number; y: number } | undefined {
  const lowX = Math.ceil((area.x + radius + 12 - center.x) / 24);
  const highX = Math.floor((area.x + area.width - radius - 12 - center.x) / 24);
  const lowY = Math.ceil((area.y + radius + 12 - center.y) / 24);
  const highY = Math.floor((area.y + area.height - radius - 12 - center.y) / 24);
  if ((highX - lowX + 1) * (highY - lowY + 1) > 250_000) return undefined;
  let nearest = Infinity;
  let chosen: { x: number; y: number } | undefined;
  for (let row = lowY; row <= highY; row++)
    for (let column = lowX; column <= highX; column++) {
      const distance = column * column + row * row;
      const x = center.x + column * 24,
        y = center.y + row * 24;
      if (distance < nearest - 0.001 && free(x, y)) {
        nearest = distance;
        chosen = { x, y };
      }
    }
  return chosen;
}

function isExportableSnapshot(snapshot: OmpMonitorSnapshot | null): snapshot is OmpMonitorSnapshot {
  return (
    snapshot !== null &&
    snapshot.status !== "unavailable" &&
    snapshot.status !== "error" &&
    !(snapshot.status === "scanning" && snapshot.coverage.readFiles === 0)
  );
}

function preventNavigation(event: ElectronEvent): void {
  event.preventDefault();
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01")
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isFreshActivity(
  at: number | null,
  previous: number,
  createdAt: number,
  now: number,
): boolean {
  return at !== null && at > previous && at >= createdAt && at <= now && now - at <= 3_000;
}

/** Native original-design surfaces share at most eight numeric OMP scopes. */
export class OmpMonitorController {
  private readonly orbs = new Map<string, OrbSession>();
  private readonly windows = new Map<number, MonitorView>();
  private readonly panels = new Map<PanelSurface, MonitorView>();
  private readonly panelLoads = new Map<PanelSurface, Promise<void>>();
  private readonly boards = new Map<string, BoardSession>();
  private readonly handlers: string[] = [];
  private readonly windowChrome = createMonitorWindowChrome();
  private readonly readyNativePanels = new WeakSet<BrowserWindow>();
  private readonly nativePanelAppearance = new WeakMap<BrowserWindow, "light" | "dark">();
  private readonly nativePanelTitles = new WeakMap<BrowserWindow, string>();
  private readonly settingsCloseAttempts = new Map<BrowserWindow, Promise<void>>();
  private readonly settingsCloseDrains = new WeakSet<BrowserWindow>();
  private readonly orbCloseAttempts = new Map<BrowserWindow, Promise<void>>();
  private readonly nativeCloseAttempts = new Map<
    BrowserWindow,
    {
      permitted: boolean;
      reject(error: Error): void;
    }
  >();
  private closing: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  private worker: Worker | null = null;
  private workerStopping: Promise<void> | null = null;
  private workerCommandSequence = 0;
  private readonly workerCommands = new Map<
    number,
    {
      worker: Worker;
      type: AcknowledgedWorkerCommand["type"];
      resolve(): void;
      reject(error: Error): void;
    }
  >();
  private workerSettingsRecoveryRequired = false;
  private sourcePreferences: MonitorSourcePreferences = { enabled: true, folder: null };
  private sourceFolder = "";
  private sourceChanging = false;
  private sourceError = false;
  private invalidSourcePreferences = false;
  private pricing: OmpMonitorSnapshot["pricing"] | null = null;
  private input: MonitorWindowInput | null = null;
  private perfCard: OmpMonitorPerfCardWindow | null = null;
  private initialized = false;
  private disposed = false;
  private closingAll = false;
  private opening: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private savedOrbs: MonitorOrbRecord[] = [];
  private savedBoards: OmpMonitorBoardRecord[] = [];
  private preferenceError = false;
  private invalidPreferences = false;
  private preferenceWrites: Promise<void> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private titleCommandRunning = false;
  private orbUndo: OrbEditUndo | null = null;
  private orbUndoTimer: NodeJS.Timeout | undefined;
  private previewTimer: NodeJS.Timeout | undefined;
  private effectsPreview: OmpMonitorEffectsPreview = {
    active: false,
    sequence: 0,
    startedAt: null,
    endsAt: null,
  };
  private launchAtLogin = { enabled: false, supported: false, error: false };
  private pointerTimer: NodeJS.Timeout | undefined;
  private scopes: OmpMonitorSnapshot["scopes"] = { profiles: [], projects: [] };
  private summaries: OmpMonitorOrbSummary[] | null = null;
  private interactionSequence = 0;
  private readonly preferencesFile = path.join(
    app.getPath("userData"),
    "local-monitor",
    "windows.json",
  );
  private readonly sourcePreferencesFile = path.join(
    path.dirname(this.preferencesFile),
    "sources.json",
  );
  private readonly titleThemes = new OmpTitleThemesStore(path.dirname(this.preferencesFile), {
    onChange: () => {
      if (!this.titleCommandRunning) this.sendStates();
    },
  });

  constructor(private readonly options: { roots?: OmpMonitorRoot[] } = {}) {}

  initialize(): void {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    ipcMain.handle("paseo:monitor:open", (event) => {
      if (!isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Monitor opening requires a main application window");
      return this.open();
    });
    this.handlers.push("paseo:monitor:open");
    const handle = (suffix: string, callback: (view: MonitorView, value: unknown) => unknown) => {
      const channel = `paseo:monitor:${suffix}`;
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, value: unknown) =>
        callback(this.authorize(event), value),
      );
      this.handlers.push(channel);
    };
    handle("ready", (view) => this.viewState(view));
    handle("refresh", () => this.mutate(() => this.refresh()));
    handle("dashboard-size", (view, value) => {
      if (
        view.surface !== "dashboard" ||
        this.panels.get("dashboard") !== view ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value <= 0
      ) {
        throw new Error("Invalid dashboard content height");
      }
      const displays = this.displays();
      const current = view.window.getBounds();
      const area = nearestMonitorArea(current, displays);
      const height = Math.min(value, Math.max(1, area.height - 24));
      const next = clampMonitorPanel(
        {
          x: current.x,
          y: current.y + current.height - height,
          width: PANEL_SIZES.dashboard.width,
          height,
        },
        displays,
      );
      if (
        current.x !== next.x ||
        current.y !== next.y ||
        current.width !== next.width ||
        current.height !== next.height
      ) {
        view.window.setBounds(next);
      }
    });
    handle("surface", (view, value) => {
      if (value !== "dashboard" && value !== "history" && value !== "settings")
        throw new Error("Invalid monitor surface");
      return this.openPanel(view.orb, value);
    });
    handle("configure", (view, value) => this.mutate(() => this.configure(view.orb, value)));
    handle("select-orb", (view, value) =>
      this.mutate(() => {
        const target =
          typeof value === "string" && value.length <= 64 ? this.orbs.get(value) : undefined;
        if (view.surface !== "settings" || !target) throw new Error("Invalid orb selection");
        view.orb = target;
        view.board = null;
        target.interaction = ++this.interactionSequence;
        this.sendStates();
      }),
    );
    handle("orb-visible", (view, value) =>
      this.mutate(() => {
        if (typeof value !== "boolean") throw new Error("Invalid orb visibility");
        this.setOrbVisible(view.orb, value);
        return this.persist(true);
      }),
    );
    handle("orb-command", (view, value) => this.mutate(() => this.commandOrb(view, value)));
    handle("title-theme", (view, value) => this.mutate(() => this.commandTitleTheme(view, value)));
    handle("launch-at-login", (view, value) => {
      if (view.surface !== "settings" || typeof value !== "boolean")
        throw new Error("Invalid launch-at-login command");
      return this.setLaunchAtLogin(value);
    });
    handle("refresh-launch-at-login", (view) => {
      if (view.surface !== "settings") throw new Error("Launch-at-login requires settings");
      this.readLaunchAtLogin();
      this.sendStates();
    });
    handle("source-enabled", (view, value) =>
      this.mutate(async () => {
        this.requireSourceSettings(view);
        if (typeof value !== "boolean") throw new Error("Invalid OMP source state");
        if (value !== this.sourcePreferences.enabled || this.invalidSourcePreferences)
          await this.changeSource({ ...this.sourcePreferences, enabled: value });
      }),
    );
    handle("source-folder", (view, value) =>
      this.mutate(async () => {
        this.requireSourceSettings(view);
        if (value !== undefined) throw new Error("OMP source paths are native-owned");
        return this.chooseSourceFolder(view);
      }),
    );
    handle("source-folder-reset", (view, value) =>
      this.mutate(async () => {
        this.requireSourceSettings(view);
        if (value !== undefined) throw new Error("OMP source paths are native-owned");
        if (this.sourcePreferences.folder !== null || this.invalidSourcePreferences)
          await this.changeSource({ ...this.sourcePreferences, folder: null });
      }),
    );
    handle("effects-preview-start", (view) => this.startEffectsPreview(view));
    handle("effects-preview-stop", (view) => {
      if (view.surface !== "settings") throw new Error("Effects preview requires settings");
      this.stopEffectsPreview();
    });
    handle("scope", (view, value) => this.mutate(() => this.setScope(view.orb, value)));
    handle("new-window", (view) => this.mutate(() => this.addOrb(view.orb)));
    handle("new-board", (view) => this.mutate(() => this.addBoard(view.orb)));
    handle("configure-board", (view, value) => this.mutate(() => this.configureBoard(view, value)));
    handle("remove-board", (view, value) => this.mutate(() => this.removeBoard(view, value)));
    handle("select-board", (view, value) =>
      this.mutate(() => {
        const board =
          typeof value === "string"
            ? this.savedBoards.find((record) => record.id === value)
            : undefined;
        const orb = board ? this.orbs.get(board.orbId) : undefined;
        if (view.surface !== "settings" || !board || !orb)
          throw new Error("Invalid board selection");
        view.board = board;
        view.orb = orb;
        this.sendState(view);
      }),
    );
    handle("menu", (view) => this.showMenu(view));
    handle("drag-start", (view) => this.beginDrag(view));
    handle("drag-end", (view) => this.endDrag(view));
    handle("export-csv", (view, value) => this.exportCsv(view, value));
    handle("export-mode-csv", (view, value) => this.exportCsv(view, value, true));
    handle("network-enabled", (_view, value) =>
      this.mutate(async () => {
        if (typeof value !== "boolean") throw new Error("Invalid public-data setting");
        await this.sendWorkerCommand({ type: "pricing.configure", networkEnabled: value });
      }),
    );
    handle("auto-sync-prices", (_view, value) =>
      this.mutate(async () => {
        if (typeof value !== "boolean") throw new Error("Invalid price-sync setting");
        await this.sendWorkerCommand({ type: "pricing.configure", autoSyncPrices: value });
      }),
    );
    handle("currency", (_view, value) =>
      this.mutate(async () => {
        if (
          typeof value !== "string" ||
          !/^[A-Z]{3}$/.test(value) ||
          !this.pricing?.currencies.includes(value)
        )
          throw new Error("Unsupported monitor currency");
        await this.sendWorkerCommand({ type: "pricing.configure", currency: value });
      }),
    );
    handle("refresh-public-data", (view) => this.mutate(() => this.refreshPricing(view)));
    handle("check-prices", (view) => this.mutate(() => this.refreshPricing(view, "prices")));
    handle("refresh-rates", (view) => this.mutate(() => this.refreshPricing(view, "rates")));
    handle("close", (view) => {
      if (view.surface === "board" && view.board)
        return this.mutate(() =>
          this.configureBoard(view, { id: view.board!.id, patch: { visible: false } }),
        );
      if (view.surface === "settings") return this.closeSettings(view);
      if (view.surface === "orb") return this.closeOrb(view);
      view.window.close();
      return undefined;
    });
    handle("close-all", () => this.closeAll());
    ipcMain.handle("paseo:monitor:perf-card-ready", (event) => {
      if (!this.perfCard) throw new Error("Unauthorized performance tooltip sender");
      return this.perfCard.readyFrom(event);
    });
    ipcMain.handle("paseo:monitor:perf-card-size", (event, value: unknown) => {
      if (!this.perfCard) throw new Error("Unauthorized performance tooltip sender");
      this.perfCard.resizeFrom(event, value);
    });
    this.handlers.push("paseo:monitor:perf-card-ready", "paseo:monitor:perf-card-size");
    ipcMain.on("paseo:monitor:perf-card", this.onPerfCard);
    ipcMain.on("paseo:monitor:interactive", this.onInteractive);
    screen.on("display-added", this.onDisplaysChanged);
    screen.on("display-removed", this.onDisplaysChanged);
    screen.on("display-metrics-changed", this.onDisplaysChanged);
    nativeTheme.on("updated", this.onNativeThemeUpdated);
  }

  private authorize(event: IpcMainInvokeEvent | IpcMainEvent): MonitorView {
    const view = this.windows.get(event.sender.id);
    if (
      !view ||
      view.window.isDestroyed() ||
      event.sender !== view.window.webContents ||
      event.senderFrame !== view.window.webContents.mainFrame
    )
      throw new Error("Unauthorized monitor sender");
    return view;
  }

  private readonly onPerfCard = (event: IpcMainEvent, value: unknown): void => {
    let view: MonitorView;
    try {
      view = this.authorize(event);
    } catch {
      return;
    }
    if (
      this.disposed ||
      this.disposing ||
      this.closing ||
      (view.surface !== "dashboard" && view.surface !== "board")
    )
      return;
    if (value === null) {
      this.perfCard?.dismiss(view.window);
      return;
    }
    const surface = view.surface;
    const card = (this.perfCard ??= new OmpMonitorPerfCardWindow({
      webPreferences: this.webPreferences(),
      displays: () => this.displays(),
      ignoreMouse: (window) => (this.input ??= createMonitorWindowInput()).setIgnored(window, true),
    }));
    try {
      card.show(
        {
          window: view.window,
          surface,
          readState: () => {
            if (
              this.disposed ||
              this.disposing ||
              this.closing ||
              this.windows.get(view.window.webContents.id) !== view ||
              view.window.isDestroyed() ||
              view.surface !== surface
            )
              return null;
            const state = this.viewState(view);
            if (state.preferences.appearance !== "system") return state;
            return {
              ...state,
              preferences: {
                ...state.preferences,
                appearance: nativeTheme.shouldUseDarkColors ? "dark" : "light",
              },
            };
          },
        },
        value,
      );
    } catch {
      card.close();
    }
  };

  /** Serialize edits that share persisted orb identities and title references. */
  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutations.then(() => {
      if (this.disposed || this.closingAll) throw new Error("Monitor is closed");
      return operation();
    });
    this.mutations = result.catch(() => undefined);
    return result;
  }

  private async refreshPricing(_view: MonitorView, target?: "prices" | "rates"): Promise<void> {
    if (!this.pricing?.networkEnabled) throw new Error("Public-data updates are disabled");
    await this.sendWorkerCommand({ type: "pricing.refresh", ...(target ? { target } : {}) });
  }

  private async sendWorkerCommand(
    message:
      | PricingSettingsCommand
      | Extract<OmpMonitorWorkerRequest, { type: "refresh" | "pricing.refresh" }>,
  ): Promise<void> {
    await this.workerStopping;
    const configuring = message.type === "pricing.configure";
    this.startWorker(configuring);
    const worker = this.worker;
    if (!worker) throw new Error("OMP source worker is unavailable");
    if (configuring) {
      await this.acknowledgeWorkerCommand(worker, message);
      this.workerSettingsRecoveryRequired = false;
    } else this.post(message);
  }

  private acknowledgeWorkerCommand(
    worker: Worker,
    message: AcknowledgedWorkerCommand,
  ): Promise<void> {
    const requestId = ++this.workerCommandSequence;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.workerCommands.set(requestId, { worker, type: message.type, resolve, reject });
    try {
      worker.postMessage(
        { ...message, requestId } satisfies OmpMonitorWorkerRequest,
        NO_TRANSFERABLES,
      );
    } catch {
      this.rejectWorkerCommands(worker);
      if (message.type === "pricing.configure") this.stopWorker();
    }
    return promise;
  }

  private rejectWorkerCommands(worker: Worker): void {
    for (const [requestId, command] of this.workerCommands) {
      if (command.worker !== worker) continue;
      this.workerCommands.delete(requestId);
      if (command.type === "pricing.configure") this.workerSettingsRecoveryRequired = true;
      command.reject(
        new Error(
          command.type === "pricing.configure"
            ? SETTINGS_UNKNOWN_ERROR
            : "OMP source worker did not shut down cleanly",
        ),
      );
    }
  }

  private requireSourceSettings(view: MonitorView): void {
    if (
      view.surface !== "settings" ||
      this.panels.get("settings") !== view ||
      view.window.isDestroyed() ||
      this.disposed
    )
      throw new Error("OMP source configuration requires the Settings window");
  }

  private async chooseSourceFolder(view: MonitorView): Promise<OmpMonitorChooseSourceResult> {
    if (this.options.roots !== undefined)
      throw new Error("Injected OMP sources cannot open a folder picker");
    this.sourceChanging = true;
    this.sendStates();
    try {
      const zh = this.viewState(view).language === "zh";
      const answer = await dialog.showOpenDialog(view.window, {
        title: zh ? "选择 OMP 会话文件夹" : "Choose OMP sessions folder",
        buttonLabel: zh ? "选择文件夹" : "Select folder",
        properties: ["openDirectory", "dontAddToRecent"],
        ...((await regularDirectory(this.sourceFolder)) ? { defaultPath: this.sourceFolder } : {}),
      });
      this.requireSourceSettings(view);
      if (answer.canceled) return "cancelled";
      if (answer.filePaths.length !== 1) throw new Error("OMP folder selection is unavailable");
      const folder = await selectedOmpSourceFolder(answer.filePaths[0]);
      await this.changeSource({ ...this.sourcePreferences, folder });
      return "changed";
    } finally {
      this.sourceChanging = false;
      this.sendStates();
    }
  }

  private async sourceFolderFor(preferences: MonitorSourcePreferences): Promise<string> {
    const roots = this.options.roots;
    if (roots !== undefined) return roots[0] ? path.resolve(roots[0].path) : "";
    return preferences.folder ?? (await defaultOmpMonitorFolder());
  }

  private async changeSource(next: MonitorSourcePreferences): Promise<void> {
    const folder = await this.sourceFolderFor(next);
    this.sourceChanging = true;
    for (const orb of this.orbs.values()) {
      this.resetScope(orb, orb.record.scope);
      orb.workerError = false;
    }
    this.scopes = { profiles: [], projects: [] };
    this.sendStates();
    try {
      // Stop publication immediately, but let every already-posted poll/catalog command drain.
      await this.drainWorker();
      if (this.disposed) throw new Error("Monitor is closed");
      await writeMonitorSourcePreferences(
        this.sourcePreferencesFile,
        next,
        this.invalidSourcePreferences,
      );
      this.sourcePreferences = { ...next };
      this.sourceFolder = folder;
      this.invalidSourcePreferences = false;
      this.sourceError = false;
    } catch (error) {
      this.sourceError = true;
      throw error;
    } finally {
      this.sourceChanging = false;
      for (const orb of this.orbs.values()) orb.refreshing = this.sourcePreferences.enabled;
      this.startWorker();
      this.postScopes();
      this.sendStates();
    }
  }

  private sourceState(view: MonitorView): OmpMonitorSourceState {
    const snapshot = view.orb.snapshot;
    let status: OmpMonitorSourceState["status"];
    if (!this.sourcePreferences.enabled) status = "disabled";
    else if (this.sourceError || view.orb.workerError) status = "error";
    else if (this.sourceChanging || !snapshot) status = "scanning";
    else if (!snapshot.coverage.roots.some((root) => root.available)) status = "missing";
    else if (snapshot.coverage.issues.includes("scan_pending") || snapshot.performance.scanning)
      status = "scanning";
    else status = "ready";
    return {
      enabled: this.sourcePreferences.enabled,
      folder: view.surface === "settings" ? this.sourceFolder : "",
      usingDefaultFolder: this.sourcePreferences.folder === null,
      status,
      sessions: this.sourcePreferences.enabled ? (snapshot?.coverage.discoveredFiles ?? 0) : 0,
      changing: this.sourceChanging,
      canChangeFolder: this.options.roots === undefined,
    };
  }

  private readLaunchAtLogin(): void {
    try {
      this.launchAtLogin = { ...launchAtLoginController.get(), error: false };
    } catch {
      this.launchAtLogin = { ...this.launchAtLogin, error: true };
    }
  }

  private setLaunchAtLogin(enabled: boolean): void {
    try {
      this.launchAtLogin = { ...launchAtLoginController.set(enabled), error: false };
      if (this.launchAtLogin.enabled !== enabled)
        throw new Error("Startup setting was not applied");
    } catch {
      this.readLaunchAtLogin();
      this.launchAtLogin = { ...this.launchAtLogin, error: true };
      this.sendStates();
      throw new Error("Unable to change launch at login");
    }
    this.sendStates();
  }

  private startEffectsPreview(view: MonitorView): void {
    if (view.surface !== "settings") throw new Error("Effects preview requires settings");
    if (this.effectsPreview.active) return;
    const startedAt = Date.now();
    this.effectsPreview = {
      active: true,
      sequence: this.effectsPreview.sequence + 1,
      startedAt,
      endsAt: startedAt + 20_000,
    };
    this.previewTimer = setTimeout(() => this.stopEffectsPreview(), 20_000);
    this.previewTimer.unref?.();
    this.sendStates();
  }

  private stopEffectsPreview(): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    if (!this.effectsPreview.active) return;
    this.effectsPreview = {
      active: false,
      sequence: this.effectsPreview.sequence,
      startedAt: null,
      endsAt: null,
    };
    this.sendStates();
  }

  private async commandTitleTheme(
    view: MonitorView,
    command: unknown,
  ): Promise<OmpTitleThemeResult> {
    if (view.surface !== "settings") throw new Error("Title editing requires settings");
    const selectedTheme = view.orb.record.preferences.titleTheme;
    this.titleCommandRunning = true;
    try {
      const result = await this.titleThemes.execute(command, {
        selected: selectedTheme,
        references: this.savedOrbs.map((record) => ({
          instanceId: record.id,
          themeId: record.preferences.orbTitleTheme,
        })),
      });
      if (!result.ok) return result;
      if (this.disposed) return { ok: false, state: result.state, error: "storage" };
      let changed = false;
      for (const reference of result.referenceChanges ?? []) {
        const orb = this.orbs.get(reference.instanceId);
        if (!orb || orb.record.preferences.orbTitleTheme === reference.themeId) continue;
        orb.record.preferences = { ...orb.record.preferences, orbTitleTheme: reference.themeId };
        changed = true;
      }
      if (result.selected)
        for (const orb of this.orbs.values()) {
          if (orb.record.preferences.titleTheme === result.selected) continue;
          orb.record.preferences = { ...orb.record.preferences, titleTheme: result.selected };
          changed = true;
        }
      if (changed) {
        this.summaries = null;
        try {
          await this.persist(true);
        } catch {
          return { ok: false, state: this.titleThemes.state(), error: "storage" };
        }
      }
      return result;
    } finally {
      this.titleCommandRunning = false;
      this.sendStates();
    }
  }

  private async commandOrb(view: MonitorView, value: unknown): Promise<void> {
    if (view.surface !== "settings" || !value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid orb command");
    const command = value as Record<string, unknown>;
    const { type, instanceId } = command;
    requireOrbCommandKeys(command);
    if (type === "undo") return this.undoOrbEdit();
    if (type === "dismissUndo") {
      this.clearOrbUndo();
      this.sendStates();
      return;
    }
    const orb = typeof instanceId === "string" ? this.orbs.get(instanceId) : undefined;
    if (!orb) throw new Error("Unknown monitor orb");
    if (type === "duplicate") return this.addOrb(orb, true);
    if (type === "remove") return this.removeOrb(orb);
    if (type === "merge") return this.mergeOrbs(orb);
    if (type === "visible") {
      if (typeof command.visible !== "boolean") throw new Error("Invalid orb visibility");
      this.setOrbVisible(orb, command.visible);
    } else if (type === "resetPosition") {
      this.resetOrbPosition(orb);
    } else {
      this.moveOrb(orb, command.index);
    }
    await this.persist(true);
  }

  private moveOrb(orb: OrbSession, index: unknown): void {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.savedOrbs.length
    )
      throw new Error("Invalid orb order");
    const from = this.savedOrbs.indexOf(orb.record);
    this.savedOrbs.splice(from, 1);
    this.savedOrbs.splice(index, 0, orb.record);
    this.summaries = null;
    this.sendStates();
  }

  private clearOrbUndo(): void {
    clearTimeout(this.orbUndoTimer);
    this.orbUndoTimer = undefined;
    this.orbUndo = null;
  }

  private offerOrbUndo(kind: "remove" | "merge"): void {
    for (const orb of this.orbs.values()) if (!orb.window.isDestroyed()) this.rememberPosition(orb);
    this.clearOrbUndo();
    this.orbUndo = {
      kind,
      orbs: this.savedOrbs.map(copyOrbRecord),
      boardReferences: this.savedBoards.map(({ id, orbId }) => ({ id, orbId })),
      expiresAt: Date.now() + 8_000,
    };
    this.orbUndoTimer = setTimeout(() => {
      this.clearOrbUndo();
      this.sendStates();
    }, 8_000);
    this.orbUndoTimer.unref?.();
  }

  private async removeOrb(orb: OrbSession): Promise<void> {
    if (this.savedOrbs.length <= 1) throw new Error("The last orb cannot be removed");
    const anchor =
      this.savedOrbs.find((record) => record !== orb.record && record.visible) ??
      this.savedOrbs.find((record) => record !== orb.record)!;
    const target = this.orbs.get(anchor.id)!;
    this.offerOrbUndo("remove");
    this.savedOrbs = this.savedOrbs.filter((record) => record !== orb.record);
    for (const view of this.windows.values())
      if (view.surface !== "orb" && view.orb === orb) view.orb = target;
    for (const record of this.savedBoards) {
      if (record.orbId !== orb.record.id) continue;
      record.orbId = target.record.id;
      const board = this.boards.get(record.id);
      if (board) board.orb = target;
    }
    if (!orb.window.isDestroyed()) orb.window.destroy();
    this.summaries = null;
    this.sendStates();
    await this.persist(true);
  }

  private async mergeOrbs(kept: OrbSession): Promise<void> {
    if (this.savedOrbs.length <= 1) throw new Error("At least two orbs are required to merge");
    this.offerOrbUndo("merge");
    this.savedOrbs = [kept.record];
    kept.record.visible = true;
    kept.record.preferences = { ...kept.record.preferences, orbName: null };
    this.resetScope(kept, { profile: null, project: null });
    for (const view of this.windows.values()) if (view.surface !== "orb") view.orb = kept;
    for (const record of this.savedBoards) {
      record.orbId = kept.record.id;
      const board = this.boards.get(record.id);
      if (board) board.orb = kept;
    }
    for (const orb of this.orbs.values())
      if (orb !== kept && !orb.window.isDestroyed()) orb.window.destroy();
    this.applyOrbVisibility(kept);
    this.summaries = null;
    this.postScopes();
    this.updateVisibility();
    this.sendStates();
    await this.persist(true);
  }

  private async undoOrbEdit(): Promise<void> {
    const undo = this.orbUndo;
    if (!undo || undo.expiresAt <= Date.now()) {
      this.clearOrbUndo();
      this.sendStates();
      throw new Error("Orb undo has expired");
    }
    const global = this.savedOrbs[0]!.preferences;
    const customIds = new Set(this.titleThemes.state().custom.map((theme) => theme.id));
    const restored = undo.orbs.map((record) => restoredOrbRecord(record, global, customIds));
    const created: OrbSession[] = [];
    try {
      for (const record of restored)
        if (!this.orbs.has(record.id)) {
          await this.createOrb(record);
          const orb = this.orbs.get(record.id);
          if (orb) created.push(orb);
        }
    } catch (error) {
      for (const orb of created) if (!orb.window.isDestroyed()) orb.window.destroy();
      throw error;
    }
    this.savedOrbs = restored;
    const first = this.orbs.get(restored[0]!.id)!;
    for (const view of this.windows.values())
      if (view.surface !== "orb" && !restored.some((record) => record.id === view.orb.record.id))
        view.orb = first;
    this.restoreBoardReferences(undo, restored, first);
    this.closingAll = true;
    try {
      for (const orb of this.orbs.values())
        if (!restored.some((record) => record.id === orb.record.id)) orb.window.destroy();
      for (const record of restored) {
        const orb = this.orbs.get(record.id)!;
        const changedScope =
          orb.record.scope.profile !== record.scope.profile ||
          orb.record.scope.project !== record.scope.project;
        orb.record = record;
        if (changedScope) this.resetScope(orb, record.scope);
        orb.baseline = false;
        orb.previousPeak = 0;
        orb.activity.lastPeakAt = null;
        orb.window.setBounds(
          placeMonitorOrb(
            record.positions[monitorArrangement(this.displays())],
            record.preferences.size,
            this.displays(),
          ),
        );
        orb.window.setAlwaysOnTop(record.preferences.pinned);
        this.cancelDrag(orb);
        this.applyOrbVisibility(orb);
      }
    } finally {
      this.closingAll = false;
    }
    this.clearOrbUndo();
    this.summaries = null;
    this.postScopes();
    this.updateVisibility();
    this.sendStates();
    await this.persist(true);
  }

  private restoreBoardReferences(
    undo: OrbEditUndo,
    restored: readonly MonitorOrbRecord[],
    first: OrbSession,
  ): void {
    for (const record of this.savedBoards) {
      const previous = undo.boardReferences.find((reference) => reference.id === record.id);
      if (previous && this.orbs.has(previous.orbId)) record.orbId = previous.orbId;
      else if (!restored.some((orb) => orb.id === record.orbId)) record.orbId = first.record.id;
      const board = this.boards.get(record.id);
      if (board) board.orb = this.orbs.get(record.orbId)!;
      for (const view of this.windows.values())
        if (view.board === record) view.orb = this.orbs.get(record.orbId)!;
    }
  }

  async open(): Promise<void> {
    if (this.disposed || this.disposing || this.closing) return;
    this.initialize();
    if (this.opening) return this.opening;
    const operation = this.openMonitor();
    this.opening = operation;
    try {
      await operation;
    } finally {
      if (this.opening === operation) this.opening = null;
    }
  }

  private async openMonitor(): Promise<void> {
    await this.loadPreferences();
    if (this.disposed) return;
    if (!this.orbs.size) {
      if (!this.savedOrbs.length) this.savedOrbs.push(this.newRecord());
      for (const record of this.savedOrbs) await this.createOrb(record);
      for (const record of this.savedBoards) if (record.visible) await this.createBoard(record);
      await this.persist();
    }
    const orb = this.orbs.values().next().value as OrbSession | undefined;
    if (orb) await this.openPanel(orb, "dashboard");
  }

  private loadPreferences(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.readPreferences();
    return this.loading;
  }
  private async readPreferences(): Promise<void> {
    await this.titleThemes.load();
    const document = await readMonitorPreferences(
      this.preferencesFile,
      new Set(this.titleThemes.state().custom.map((theme) => theme.id)),
    );
    this.savedOrbs = document.orbs;
    this.savedBoards = document.boards;
    this.invalidPreferences = document.invalid;
    this.preferenceError = document.invalid;
    const source = await readMonitorSourcePreferences(this.sourcePreferencesFile);
    this.sourcePreferences = {
      enabled: source.enabled,
      folder: this.options.roots === undefined ? source.folder : null,
    };
    this.invalidSourcePreferences = source.invalid;
    this.sourceError = source.invalid;
    this.sourceFolder = await this.sourceFolderFor(this.sourcePreferences);
    this.readLaunchAtLogin();
    this.loaded = true;
  }

  private displays(): MonitorDisplay[] {
    const displays = screen
      .getAllDisplays()
      .filter((display) => display.workArea.width > 0 && display.workArea.height > 0);
    if (displays.length) return displays;
    const primary = screen.getPrimaryDisplay();
    if (primary.workArea.width <= 0 || primary.workArea.height <= 0)
      throw new Error("No available monitor display");
    return [primary];
  }

  private newRecord(template?: OrbSession): MonitorOrbRecord {
    return {
      id: randomUUID(),
      scope: template ? { ...template.record.scope } : { profile: null, project: null },
      preferences: {
        ...(template?.record.preferences ??
          this.savedOrbs[0]?.preferences ??
          DEFAULT_MONITOR_PREFERENCES),
      },
      visible: true,
      positions: Object.create(null),
    };
  }

  private async addOrb(template: OrbSession, duplicate = false): Promise<void> {
    if (this.orbs.size >= MAX_MONITOR_ORBS) throw new Error("Monitor window limit reached");
    if (this.orbs.get(template.record.id) !== template) throw new Error("Unknown monitor orb");
    const record = this.newRecord(template);
    if (duplicate) {
      record.visible = template.record.visible;
      record.preferences.orbName = duplicateMonitorOrbName(template.record.preferences.orbName);
    } else {
      record.preferences.orbName = null;
      record.preferences.orbRedlineOutput = null;
      record.preferences.orbRedlineTotal = null;
    }
    const displays = this.displays();
    record.positions[monitorArrangement(displays)] = this.newOrbPosition(
      template,
      record.preferences.size,
    );
    this.savedOrbs.splice(this.savedOrbs.indexOf(template.record) + 1, 0, record);
    try {
      await this.createOrb(record);
    } catch (error) {
      this.savedOrbs = this.savedOrbs.filter((entry) => entry !== record);
      throw error;
    }
    await this.persist(true);
  }

  /** Native PlaceNew: left, below, right, above; nearest free 24-DIP grid; +24 cascade. */
  private newOrbPosition(
    template: OrbSession,
    size: number,
    excluded?: OrbSession,
  ): { x: number; y: number } {
    const bounds = template.window.getBounds(),
      radius = size / 2;
    const center = {
      x: bounds.x + template.record.preferences.size * 0.75,
      y: bounds.y + template.record.preferences.size * 0.75,
    };
    const displays = this.displays(),
      area = nearestMonitorArea(center, displays);
    const others = [...this.orbs.values()]
      .filter(
        (orb) =>
          orb !== excluded && !orb.window.isDestroyed() && (orb === template || orb.record.visible),
      )
      .map((orb) => {
        const otherBounds = orb.window.getBounds(),
          otherSize = orb.record.preferences.size;
        return {
          x: otherBounds.x + otherSize * 0.75,
          y: otherBounds.y + otherSize * 0.75,
          radius: otherSize / 2,
        };
      });
    const free = (x: number, y: number): boolean => {
      if (
        x - radius < area.x + 12 ||
        x + radius > area.x + area.width - 12 ||
        y - radius < area.y + 12 ||
        y + radius > area.y + area.height - 12
      )
        return false;
      for (const other of others) {
        const dx = x - other.x,
          dy = y - other.y;
        if (dx * dx + dy * dy < (radius + other.radius + 12 - 0.5) ** 2) return false;
      }
      return true;
    };
    const reach = template.record.preferences.size / 2 + 12 + radius;
    const slots = [
      { x: center.x - reach, y: center.y },
      { x: center.x, y: center.y + reach },
      { x: center.x + reach, y: center.y },
      { x: center.x, y: center.y - reach },
    ];
    let chosen = slots.find((point) => free(point.x, point.y));
    if (!chosen) chosen = nearestOrbGridPosition(center, radius, area, free);
    const wanted = chosen ?? { x: center.x + 24, y: center.y + 24 };
    const lowX = area.x + radius + 12,
      highX = area.x + area.width - radius - 12;
    const lowY = area.y + radius + 12,
      highY = area.y + area.height - radius - 12;
    const next = {
      x: lowX > highX ? area.x + area.width / 2 : Math.max(lowX, Math.min(wanted.x, highX)),
      y: lowY > highY ? area.y + area.height / 2 : Math.max(lowY, Math.min(wanted.y, highY)),
    };
    const placed = placeMonitorOrb(
      { x: next.x - size * 0.75, y: next.y - size * 0.75 },
      size,
      displays,
    );
    return { x: placed.x, y: placed.y };
  }

  /** Native ResetPosition chooses the main display's default, or PlaceNew beside its nearest blocker. */
  private resetOrbPosition(orb: OrbSession): void {
    const displays = this.displays(),
      primary = screen.getPrimaryDisplay();
    const area =
      displays.find((display) => display.id === primary.id)?.workArea ?? displays[0]!.workArea;
    const size = orb.record.preferences.size,
      radius = size / 2;
    const lowX = area.x + radius + 24,
      highX = area.x + area.width - radius - 24;
    const lowY = area.y + radius + 24,
      highY = area.y + area.height - radius - 24;
    const start = {
      x: lowX > highX ? area.x + area.width / 2 : highX,
      y:
        lowY > highY
          ? area.y + area.height / 2
          : Math.max(lowY, Math.min(area.y + area.height - radius - 48, highY)),
    };
    let blocker: OrbSession | undefined,
      nearest = Infinity;
    for (const candidate of this.orbs.values()) {
      if (candidate === orb || !candidate.record.visible || candidate.window.isDestroyed())
        continue;
      const bounds = candidate.window.getBounds(),
        otherSize = candidate.record.preferences.size;
      const dx = start.x - bounds.x - otherSize * 0.75,
        dy = start.y - bounds.y - otherSize * 0.75;
      const distance = dx * dx + dy * dy;
      if (distance < (radius + otherSize / 2 + 12 - 0.5) ** 2 && distance < nearest) {
        nearest = distance;
        blocker = candidate;
      }
    }
    const point = blocker
      ? this.newOrbPosition(blocker, size, orb)
      : { x: start.x - size * 0.75, y: start.y - size * 0.75 };
    this.cancelDrag(orb);
    if (orb.window.isDestroyed()) throw new Error("Native orb input is unavailable");
    orb.window.setBounds(placeMonitorOrb(point, size, displays));
    orb.interaction = ++this.interactionSequence;
    this.rememberPosition(orb);
    this.sendStates();
    this.updateVisibility();
  }

  private async createOrb(record: MonitorOrbRecord): Promise<void> {
    if (this.disposed) return;
    const input = (this.input ??= createMonitorWindowInput());
    const displays = this.displays();
    const bounds = placeMonitorOrb(
      record.positions[monitorArrangement(displays)],
      record.preferences.size,
      displays,
      this.orbs.size,
    );
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      minWidth: 1,
      minHeight: 1,
      transparent: true,
      frame: false,
      backgroundColor: "#00000000",
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: record.preferences.pinned,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      webPreferences: this.webPreferences(),
    });
    try {
      input.setIgnored(window, true);
    } catch (error) {
      window.destroy();
      throw error;
    }
    const orb: OrbSession = {
      record,
      window,
      snapshot: null,
      workerError: false,
      refreshing: true,
      createdAt: Date.now(),
      baseline: false,
      lastResponse: 0,
      previousPeak: 0,
      day: "",
      peakMutedUntil: 0,
      activity: { responseSequence: 0, peakSequence: 0, lastResponseAt: null, lastPeakAt: null },
      interactive: false,
      inputBlocked: false,
      interaction: ++this.interactionSequence,
      pointer: null,
      drag: null,
    };
    this.orbs.set(record.id, orb);
    this.summaries = null;
    const view: MonitorView = { window, surface: "orb", orb, exporting: false, board: null };
    this.attachView(view);
    this.startWorker();
    this.postScopes();
    await this.loadView(view);
    if (!window.isDestroyed()) this.applyOrbVisibility(orb);
    this.rememberPosition(orb);
    this.updateVisibility();
    this.sendStates();
  }

  private boardSummary(record: OmpMonitorBoardRecord): OmpMonitorBoardSummary {
    return {
      id: record.id,
      orbId: record.orbId,
      visible: record.visible,
      style: record.style,
      size: record.size,
      showPerformance: record.showPerformance,
      showThinking: record.showThinking,
      showCost: record.showCost,
      pinned: record.pinned,
      clickThrough: record.clickThrough,
    };
  }

  private boardBounds(record: OmpMonitorBoardRecord, point?: { x: number; y: number }): Rectangle {
    const side = { small: 280, medium: 340, large: 420 }[record.size] + 80;
    const orb = this.orbs.get(record.orbId);
    const anchor =
      point ??
      record.positions[monitorArrangement(this.displays())] ??
      (orb && !orb.window.isDestroyed() ? orb.window.getBounds() : this.displays()[0]!.workArea);
    return clampMonitorPanel(
      { x: anchor.x, y: anchor.y, width: side, height: side },
      this.displays(),
    );
  }

  private async addBoard(orb: OrbSession): Promise<void> {
    if (this.disposed || this.savedBoards.length >= MAX_MONITOR_BOARDS)
      throw new Error("Monitor board limit reached");
    const record: OmpMonitorBoardRecord = {
      ...DEFAULT_BOARD_PREFERENCES,
      id: randomUUID(),
      orbId: orb.record.id,
      visible: true,
      positions: Object.create(null),
    };
    this.savedBoards.push(record);
    try {
      await this.createBoard(record);
    } catch (error) {
      this.savedBoards = this.savedBoards.filter((candidate) => candidate !== record);
      await this.persist();
      throw error;
    }
    this.sendStates();
    await this.persist(true);
  }

  private async createBoard(record: OmpMonitorBoardRecord): Promise<void> {
    const orb = this.orbs.get(record.orbId);
    if (this.disposed || !orb || orb.window.isDestroyed() || this.boards.has(record.id)) return;
    const window = new BrowserWindow({
      ...this.boardBounds(record),
      show: false,
      transparent: true,
      frame: false,
      backgroundColor: "#00000000",
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: record.pinned,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      webPreferences: this.webPreferences(),
    });
    try {
      (this.input ??= createMonitorWindowInput()).setIgnored(window, true);
    } catch (error) {
      window.destroy();
      throw error;
    }
    const board: BoardSession = { record, window, orb, ignored: true, unresponsive: false };
    this.boards.set(record.id, board);
    const view: MonitorView = { window, surface: "board", orb, board: record, exporting: false };
    this.attachView(view);
    window.on("moved", () => {
      if (window.isDestroyed()) return;
      const current = window.getBounds(),
        next = this.boardBounds(record, current);
      if (current.x !== next.x || current.y !== next.y) window.setBounds(next);
      this.rememberBoardPosition(board);
      void this.persist();
    });
    window.webContents.on("render-process-gone", () => {
      if (!window.isDestroyed()) window.destroy();
    });
    window.on("unresponsive", () => {
      board.unresponsive = true;
      this.setBoardInput(board, true);
    });
    window.on("responsive", () => {
      board.unresponsive = false;
    });
    await this.loadView(view);
    if (!window.isDestroyed() && record.visible) window.showInactive();
    this.rememberBoardPosition(board);
    this.startWorker();
    this.updateVisibility();
    this.sendStates();
  }

  private async configureBoard(view: MonitorView, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid board configuration");
    const { id, patch } = value as Record<string, unknown>;
    const record =
      typeof id === "string"
        ? this.savedBoards.find((candidate) => candidate.id === id)
        : undefined;
    if (
      !record ||
      (view.surface !== "settings" && view.surface !== "board") ||
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).length > 9
    )
      throw new Error("Invalid board configuration");
    if (view.surface === "board" && view.board !== record)
      throw new Error("A board can configure only itself");
    const targetOrb = this.updateBoardPreferences(record, patch as Record<string, unknown>);
    let board = this.boards.get(record.id);
    if (!board && record.visible) {
      await this.createBoard(record);
      board = this.boards.get(record.id);
    }
    if (board && !board.window.isDestroyed()) {
      this.updateBoardWindow(board, record, targetOrb);
    }
    if (view.board === record) view.orb = targetOrb;
    this.sendStates();
    this.updateVisibility();
    await this.persist(true);
  }

  private updateBoardPreferences(
    record: OmpMonitorBoardRecord,
    source: Record<string, unknown>,
  ): OrbSession {
    if (Object.hasOwn(source, "visible") && typeof source.visible !== "boolean")
      throw new Error("Invalid board visibility");
    let orbId = record.orbId;
    if (Object.hasOwn(source, "orbId")) {
      if (typeof source.orbId !== "string") throw new Error("Unknown board scope");
      orbId = source.orbId;
    }
    const targetOrb = this.orbs.get(orbId);
    if (!targetOrb) throw new Error("Unknown board scope");
    const preferencePatch: Record<string, unknown> = Object.create(null);
    for (const [key, setting] of Object.entries(source))
      if (key !== "visible" && key !== "orbId") preferencePatch[key] = setting;
    const next = configureMonitorBoard(preferencePatch, record);
    Object.assign(record, next);
    record.orbId = targetOrb.record.id;
    if (Object.hasOwn(source, "visible")) record.visible = source.visible as boolean;
    return targetOrb;
  }

  private updateBoardWindow(
    board: BoardSession,
    record: OmpMonitorBoardRecord,
    orb: OrbSession,
  ): void {
    board.orb = orb;
    const view = this.windows.get(board.window.webContents.id);
    if (view) view.orb = orb;
    const bounds = board.window.getBounds();
    board.window.setBounds(this.boardBounds(record, bounds));
    board.window.setAlwaysOnTop(record.pinned);
    this.setBoardInput(board, true);
    if (record.visible) board.window.showInactive();
    else board.window.hide();
    this.rememberBoardPosition(board);
  }

  private async removeBoard(view: MonitorView, value: unknown): Promise<void> {
    const record =
      typeof value === "string"
        ? this.savedBoards.find((candidate) => candidate.id === value)
        : undefined;
    if (!record || (view.surface !== "settings" && view.board !== record))
      throw new Error("Invalid board removal");
    const zh = this.viewState(view).language === "zh";
    const answer = await dialog.showMessageBox(view.window, {
      type: "question",
      title: zh ? "移除看板" : "Remove board",
      message: zh ? "移除此看板？" : "Remove this board?",
      detail: zh
        ? "不会删除 OMP 会话或用量历史。"
        : "OMP sessions and usage history will not be deleted.",
      buttons: zh ? ["取消", "移除"] : ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1 || this.disposed || !this.savedBoards.includes(record)) return;
    this.savedBoards = this.savedBoards.filter((candidate) => candidate !== record);
    for (const candidate of this.windows.values())
      if (candidate.board === record && candidate.surface !== "board") candidate.board = null;
    const board = this.boards.get(record.id);
    if (board && !board.window.isDestroyed()) board.window.destroy();
    this.boards.delete(record.id);
    this.sendStates();
    this.updateVisibility();
    await this.persist(true);
  }

  private setBoardInput(board: BoardSession, ignored: boolean): void {
    if (board.window.isDestroyed() || board.ignored === ignored) return;
    try {
      (this.input ??= createMonitorWindowInput()).setIgnored(board.window, ignored);
      board.ignored = ignored;
    } catch (error) {
      console.error("Local monitor board native input failed; closing the affected board", error);
      board.window.destroy();
    }
  }

  private rememberBoardPosition(board: BoardSession): void {
    if (board.window.isDestroyed()) return;
    const key = monitorArrangement(this.displays()),
      bounds = board.window.getBounds();
    delete board.record.positions[key];
    board.record.positions[key] = { x: bounds.x, y: bounds.y };
    const keys = Object.keys(board.record.positions);
    if (keys.length > 16) delete board.record.positions[keys[0]!];
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    };
  }

  private createPanelWindow(orb: OrbSession, surface: PanelSurface): BrowserWindow {
    const area = nearestMonitorArea(
      { x: orb.window.getBounds().x, y: orb.window.getBounds().y },
      this.displays(),
    );
    const size = PANEL_SIZES[surface];
    const nativeFrame = process.platform === "win32" && surface !== "dashboard";
    const bounds = clampMonitorPanel(
      {
        ...size,
        x: area.x + area.width - size.width - 12,
        y:
          surface === "dashboard"
            ? area.y + area.height - size.height - 12
            : area.y + Math.round((area.height - size.height) / 2),
      },
      this.displays(),
    );
    let minWidth = Math.min(368, area.width),
      minHeight = 1;
    if (surface !== "dashboard") {
      const minimum = MONITOR_NATIVE_PANEL_METRICS[surface];
      minWidth = nativeFrame ? minimum.minWidth : Math.min(minimum.minWidth, area.width);
      minHeight = nativeFrame ? minimum.minHeight : Math.min(minimum.minHeight, area.height);
    }
    return new BrowserWindow({
      ...bounds,
      show: false,
      frame: nativeFrame,
      transparent: false,
      useContentSize: nativeFrame ? false : undefined,
      backgroundColor: "#202020",
      title: this.panelTitle(orb, surface),
      hasShadow: true,
      skipTaskbar: surface === "dashboard",
      alwaysOnTop: surface === "dashboard",
      minWidth,
      minHeight,
      resizable: surface !== "dashboard",
      maximizable: surface !== "dashboard",
      minimizable: surface !== "dashboard",
      fullscreenable: false,
      webPreferences: this.webPreferences(),
    });
  }

  private async openPanel(orb: OrbSession, surface: PanelSurface): Promise<void> {
    if (this.disposed || this.disposing || this.closing || orb.window.isDestroyed()) return;
    const existing = this.panels.get(surface);
    if (existing && !existing.window.isDestroyed()) {
      await this.panelLoads.get(surface);
      if (existing.window.isDestroyed() || this.disposed || this.disposing || this.closing) return;
      existing.orb = orb;
      existing.board = null;
      if (existing.window.isMinimized()) existing.window.restore();
      this.sendState(existing);
      existing.window.show();
      existing.window.focus();
      return;
    }
    const window = this.createPanelWindow(orb, surface);
    const view: MonitorView = { window, surface, orb, exporting: false, board: null };
    this.panels.set(surface, view);
    this.attachView(view);
    const loading = this.loadView(view);
    this.panelLoads.set(surface, loading);
    try {
      await loading;
    } finally {
      if (this.panelLoads.get(surface) === loading) this.panelLoads.delete(surface);
    }
    if (!window.isDestroyed() && !this.disposed && !this.disposing && !this.closing) {
      window.show();
      window.focus();
    }
    this.updateVisibility();
    this.sendStates();
  }

  private attachView(view: MonitorView): void {
    const window = view.window;
    this.windows.set(window.webContents.id, view);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", preventNavigation);
    window.webContents.on("will-frame-navigate", preventNavigation);
    window.webContents.on("will-redirect", preventNavigation);
    window.webContents.on("will-attach-webview", preventNavigation);
    window.on("close", (event: ElectronEvent) => {
      const attempt = this.nativeCloseAttempts.get(window);
      if (attempt?.permitted) {
        attempt.permitted = false;
        queueMicrotask(() => {
          if (event.defaultPrevented)
            attempt.reject(new Error("The native monitor close was cancelled"));
        });
        return;
      }
      if (view.surface === "settings") {
        event.preventDefault();
        void this.closeSettings(view).catch(() => undefined); // Reported by the owning close attempt.
      } else if (view.surface === "orb") {
        event.preventDefault();
        void this.closeOrb(view).catch(() => undefined);
      }
    });
    window.on("show", this.updateVisibility);
    window.on("minimize", this.updateVisibility);
    window.on("hide", () => {
      if (view.surface === "orb") this.cancelDrag(view.orb);
      this.updateVisibility();
    });
    if (view.surface === "orb") {
      window.webContents.on("render-process-gone", () => this.cancelDrag(view.orb, true));
      window.on("unresponsive", () => this.cancelDrag(view.orb, true));
      window.on("responsive", () => {
        view.orb.inputBlocked = false;
        this.cancelDrag(view.orb);
      });
    }
    window.on("restore", () => {
      this.clampView(view);
      this.updateVisibility();
    });
    window.on("closed", () => this.closed(view));
  }

  private async loadView(view: MonitorView): Promise<void> {
    try {
      await view.window.loadURL(MONITOR_URL);
      if (view.surface === "orb" && !view.window.isDestroyed()) {
        view.orb.inputBlocked = false;
        this.cancelDrag(view.orb);
      }
      if (
        !this.disposed &&
        !view.window.isDestroyed() &&
        process.platform === "win32" &&
        (view.surface === "settings" || view.surface === "history")
      ) {
        this.readyNativePanels.add(view.window);
        this.updateNativePanel(view);
      }
      if (!this.disposed && !view.window.isDestroyed()) this.sendState(view);
    } catch {
      if (!view.window.isDestroyed()) view.window.destroy();
      throw new Error("Unable to open the local monitor");
    }
  }

  private closed(view: MonitorView): void {
    this.windows.delete(view.window.webContents.id);
    if (view.surface === "board") {
      const record = view.board;
      if (record) {
        this.boards.delete(record.id);
        if (!this.closingAll && !this.disposed && this.savedBoards.includes(record)) {
          record.visible = false;
          void this.persist();
        }
      }
    } else if (view.surface !== "orb") {
      if (this.panels.get(view.surface) === view) this.panels.delete(view.surface);
      if (view.surface === "settings") this.stopEffectsPreview();
    } else {
      this.closedOrb(view);
    }
    if (!this.orbs.size) {
      // Unexpected destruction also drains; normal close paths finish this before destroying any last orb.
      void this.drainWorker().catch((error) => this.reportCloseFailure(error));
      this.scopes = { profiles: [], projects: [] };
    } else this.postScopes();
    this.updateVisibility();
    this.sendStates();
  }

  private closedOrb(view: MonitorView): void {
    this.orbs.delete(view.orb.record.id);
    this.summaries = null;
    const settings = this.dependentSettings(view.orb);
    for (const panel of this.panels.values()) {
      if (panel.orb !== view.orb || panel.window.isDestroyed()) continue;
      if (panel.surface === "settings") {
        // An unexpected orb destruction is not permission to discard a live editor.
        const replacement = this.orbs.values().next().value as OrbSession | undefined;
        if (replacement) panel.orb = replacement;
        void this.closeSettings(panel).catch(() => undefined);
      } else panel.window.destroy();
    }
    for (const board of this.boards.values())
      if (board.orb === view.orb && !board.window.isDestroyed()) board.window.destroy();
    if (!this.closingAll && !this.disposed && !settings) {
      this.savedOrbs = this.savedOrbs.filter((record) => record.id !== view.orb.record.id);
      this.savedBoards = this.savedBoards.filter((record) => record.orbId !== view.orb.record.id);
      for (const candidate of this.windows.values())
        if (candidate.board?.orbId === view.orb.record.id) candidate.board = null;
      void this.persist();
    }
  }

  private setOrbVisible(orb: OrbSession, visible: boolean): void {
    orb.record.visible = visible;
    this.summaries = null;
    orb.pointer = null;
    if (visible && !orb.record.preferences.showOrbs) {
      for (const other of this.orbs.values()) {
        other.record.preferences = { ...other.record.preferences, showOrbs: true };
        this.applyOrbVisibility(other);
      }
    } else this.applyOrbVisibility(orb);
    this.updateVisibility();
    this.sendStates();
  }

  private applyOrbVisibility(orb: OrbSession): void {
    if (orb.window.isDestroyed()) return;
    const visible = orb.record.visible && orb.record.preferences.showOrbs;
    if (visible === orb.window.isVisible()) return;
    if (visible) orb.window.showInactive();
    else orb.window.hide();
  }

  private async configure(orb: OrbSession, patch: unknown): Promise<void> {
    if (this.orbs.get(orb.record.id) !== orb) throw new Error("Unknown monitor orb");
    const preferences = configureMonitorPreferences(
      patch,
      orb.record.preferences,
      new Set(this.titleThemes.state().custom.map((theme) => theme.id)),
    );
    const beforeSize = orb.record.preferences.size;
    const changedMetric = preferences.metric !== orb.record.preferences.metric;
    const showAll =
      preferences.showOrbs &&
      Object.hasOwn(patch as object, "showOrbs") &&
      this.savedOrbs.every((record) => !record.visible);
    orb.record.preferences = preferences;
    for (const other of this.orbs.values()) {
      const next = { ...other.record.preferences };
      for (const key of GLOBAL_MONITOR_KEYS)
        (next as unknown as Record<string, unknown>)[key] = preferences[key];
      other.record.preferences = next;
      if (changedMetric) {
        other.baseline = false;
        other.previousPeak = 0;
        other.activity.lastPeakAt = null;
        if (other.snapshot) this.updateActivity(other, other.snapshot);
      }
      if (showAll) other.record.visible = true;
      this.applyOrbVisibility(other);
    }
    this.summaries = null;
    orb.interaction = ++this.interactionSequence;
    if (preferences.clickThrough) this.cancelDrag(orb);
    if (beforeSize !== preferences.size) {
      const bounds = orb.window.getBounds();
      orb.window.setBounds(
        placeMonitorOrb(
          {
            x: bounds.x + (beforeSize - preferences.size) * 0.75,
            y: bounds.y + (beforeSize - preferences.size) * 0.75,
          },
          preferences.size,
          this.displays(),
        ),
      );
      this.rememberPosition(orb);
    }
    orb.window.setAlwaysOnTop(preferences.pinned);
    orb.pointer = null;
    if (!orb.drag && !this.setInput(orb, preferences.clickThrough || !orb.interactive))
      throw new Error("Native orb input is unavailable");
    this.sendStates();
    this.updateVisibility();
    await this.persist(true);
  }

  private async setScope(orb: OrbSession, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid monitor scope");
    const candidate = value as Record<string, unknown>;
    const { profile, project } = candidate;
    if (
      (profile !== null &&
        (typeof profile !== "string" ||
          profile.length > 160 ||
          !this.scopes.profiles.includes(profile))) ||
      (project !== null &&
        (typeof project !== "string" ||
          project.length > 160 ||
          !this.scopes.projects.includes(project)))
    )
      throw new Error("Unknown monitor scope");
    if (profile === orb.record.scope.profile && project === orb.record.scope.project) return;
    this.resetScope(orb, { profile, project } as OmpMonitorScope);
    this.summaries = null;
    this.startWorker();
    this.postScopes();
    this.sendStates();
    await this.persist(true);
  }

  private resetScope(orb: OrbSession, scope: OmpMonitorScope): void {
    orb.record.scope = { ...scope };
    orb.snapshot = null;
    orb.refreshing = true;
    orb.baseline = false;
    orb.createdAt = Date.now();
    orb.peakMutedUntil = orb.createdAt + 60_000;
    orb.previousPeak = 0;
    orb.lastResponse = 0;
    orb.day = "";
    orb.activity.lastResponseAt = null;
    orb.activity.lastPeakAt = null;
  }

  private async refresh(): Promise<void> {
    const reloads: Promise<void>[] = [];
    for (const orb of this.orbs.values()) {
      orb.refreshing = true;
      orb.workerError = false;
      const view = this.windows.get(orb.window.webContents.id);
      if (orb.inputBlocked && view) reloads.push(this.loadView(view));
    }
    await this.sendWorkerCommand({ type: "refresh" });
    this.sendStates();
    await Promise.all(reloads);
  }

  private startWorker(allowSettingsRecovery = false): void {
    if (
      this.worker ||
      this.disposed ||
      this.closingAll ||
      this.sourceChanging ||
      !this.orbs.size ||
      (this.workerSettingsRecoveryRequired && !allowSettingsRecovery)
    )
      return;
    if (this.workerStopping) {
      void this.workerStopping.then(
        () => this.startWorker(allowSettingsRecovery),
        () => this.startWorker(allowSettingsRecovery),
      );
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(path.join(__dirname, "worker.js"), {
        workerData: {
          sourceEnabled: this.sourcePreferences.enabled,
          roots: !this.sourcePreferences.enabled
            ? []
            : (this.options.roots ??
              (this.sourcePreferences.folder === null
                ? undefined
                : [{ path: this.sourcePreferences.folder, label: "default" }])),
          cacheDir: path.join(app.getPath("userData"), "local-monitor"),
          pricingRecoveryRequired: this.workerSettingsRecoveryRequired,
        },
      });
    } catch {
      this.workerFailed();
      return;
    }
    this.worker = worker;
    for (const orb of this.orbs.values()) orb.baseline = false;
    worker.on("message", (message: OmpMonitorWorkerResponse) => {
      if (this.worker !== worker || this.disposed) return;
      if (message.type === "command-result") {
        const command = this.workerCommands.get(message.requestId);
        if (!command || command.worker !== worker) return;
        this.workerCommands.delete(message.requestId);
        if (message.ok) command.resolve();
        else {
          if (command.type === "pricing.configure") this.workerSettingsRecoveryRequired = true;
          command.reject(new Error(SETTINGS_SAVE_ERROR));
        }
        return;
      }
      if (message.type === "error") {
        this.workerFailed(false);
        return;
      }
      if (this.sourceChanging || this.workerStopping) return;
      let accepted = false;
      for (const entry of message.snapshots) {
        const orb = this.orbs.get(entry.scopeId);
        if (
          !orb ||
          entry.snapshot.scope.profile !== orb.record.scope.profile ||
          entry.snapshot.scope.project !== orb.record.scope.project
        )
          continue;
        this.acceptSnapshot(orb, entry.snapshot);
        accepted = true;
      }
      if (accepted) this.sendStates();
    });
    const failed = () => {
      if (this.worker === worker && !this.disposed && !this.workerStopping) this.workerFailed();
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    this.postScopes();
    this.updateVisibility();
  }

  private workerFailed(stop = true): void {
    if (stop) this.stopWorker();
    for (const orb of this.orbs.values()) {
      orb.workerError = true;
      orb.refreshing = false;
    }
    this.sendStates();
  }

  private acceptSnapshot(orb: OrbSession, snapshot: OmpMonitorSnapshot): void {
    this.scopes = snapshot.scopes;
    this.pricing = snapshot.pricing;
    const { profile, project } = orb.record.scope;
    const missing =
      (profile !== null && !snapshot.scopes.profiles.includes(profile)) ||
      (project !== null && !snapshot.scopes.projects.includes(project));
    orb.snapshot = missing ? { ...snapshot, status: "unavailable" } : snapshot;
    orb.workerError = false;
    orb.refreshing = snapshot.status === "scanning";
    this.updateActivity(orb, snapshot);
  }

  private updateActivity(orb: OrbSession, snapshot: OmpMonitorSnapshot): void {
    const { lastResponseAt, peakObservedAt } = snapshot.activity;
    // Native NewPeak feedback stays output-driven, whatever the selected meter metric.
    const peak = snapshot.today.peakOutputTps;
    const now = snapshot.updatedAt;
    const day = snapshot.days.at(-1)?.date ?? "";
    if (orb.day !== day) {
      orb.previousPeak = 0;
      orb.day = day;
    }
    const freshResponse = isFreshActivity(lastResponseAt, orb.lastResponse, orb.createdAt, now);
    const freshPeak = isFreshActivity(
      peakObservedAt,
      orb.activity.lastPeakAt ?? 0,
      orb.createdAt,
      now,
    );
    if (orb.baseline && freshResponse && orb.record.preferences.responsePulses)
      orb.activity.responseSequence++;
    if (
      orb.baseline &&
      orb.record.preferences.celebratePeaks &&
      freshResponse &&
      freshPeak &&
      now >= orb.peakMutedUntil &&
      peak > orb.previousPeak + 1e-6
    )
      orb.activity.peakSequence++;
    orb.activity.lastResponseAt = lastResponseAt;
    if (peakObservedAt !== null)
      orb.activity.lastPeakAt = Math.max(orb.activity.lastPeakAt ?? 0, peakObservedAt);
    orb.lastResponse = Math.max(orb.lastResponse, lastResponseAt ?? 0);
    orb.previousPeak = Math.max(orb.previousPeak, peak);
    orb.baseline = true;
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    this.rejectWorkerCommands(worker);
    worker.removeAllListeners("message");
    worker.removeAllListeners("exit");
    const stopping = worker
      .terminate()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.workerStopping === stopping) this.workerStopping = null;
      });
    this.workerStopping = stopping;
  }

  private drainWorker(): Promise<void> {
    if (this.workerStopping) return this.workerStopping;
    const worker = this.worker;
    if (!worker)
      return this.workerSettingsRecoveryRequired
        ? Promise.reject(new Error(SETTINGS_UNKNOWN_ERROR))
        : Promise.resolve();
    const { promise: exited, resolve, reject } = Promise.withResolvers<void>();
    const failed = () => {
      this.rejectWorkerCommands(worker);
      reject(new Error("OMP source worker did not shut down cleanly"));
    };
    const onExit = (code: number) => {
      if (this.worker === worker) this.worker = null;
      // A zero exit without an acknowledgement is still an unknown command outcome.
      this.rejectWorkerCommands(worker);
      if (code === 0) resolve();
      else failed();
    };
    worker.once("error", failed);
    worker.once("exit", onExit);
    const acknowledgement = this.acknowledgeWorkerCommand(worker, { type: "shutdown" });
    const stopping = Promise.all([acknowledgement, exited])
      .then(() => undefined)
      .finally(() => {
        worker.removeListener("error", failed);
        worker.removeListener("exit", onExit);
        if (this.workerStopping === stopping) this.workerStopping = null;
      });
    this.workerStopping = stopping;
    return stopping;
  }
  private post(message: OmpMonitorWorkerRequest): void {
    this.worker?.postMessage(message, NO_TRANSFERABLES);
  }
  private postScopes(): void {
    this.post({
      type: "scopes",
      scopes: [...this.orbs.values()].map((orb) => ({
        id: orb.record.id,
        scope: orb.record.scope,
      })),
    });
  }

  private readonly updateVisibility = (): void => {
    let visible = false,
      needsPointer = false;
    for (const view of this.windows.values())
      if (!view.window.isDestroyed() && view.window.isVisible() && !view.window.isMinimized()) {
        visible = true;
        if (
          view.surface === "orb" &&
          !view.orb.inputBlocked &&
          (!view.orb.record.preferences.clickThrough || view.orb.drag)
        )
          needsPointer = true;
        if (view.surface === "board" && view.board && !view.board.clickThrough) needsPointer = true;
      }
    this.post({ type: "visibility", visible });
    if (needsPointer && !this.pointerTimer) this.pointerTimer = setInterval(this.pointerTick, 50);
    if (!needsPointer && this.pointerTimer) {
      clearInterval(this.pointerTimer);
      this.pointerTimer = undefined;
    }
  };

  private readonly pointerTick = (): void => {
    const cursor = screen.getCursorScreenPoint();
    for (const orb of this.orbs.values()) {
      if (orb.window.isDestroyed() || !orb.window.isVisible() || orb.inputBlocked) continue;
      if (orb.drag) {
        const position = {
          x: orb.drag.bounds.x + cursor.x - orb.drag.cursor.x,
          y: orb.drag.bounds.y + cursor.y - orb.drag.cursor.y,
        };
        orb.window.setBounds(
          placeMonitorOrb(position, orb.record.preferences.size, this.displays()),
        );
      }
      const bounds = orb.window.getBounds();
      const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
      if (orb.pointer?.x === point.x && orb.pointer.y === point.y) continue;
      orb.pointer = point;
      orb.window.webContents.send("paseo:monitor:pointer", point);
    }
    for (const board of this.boards.values()) {
      if (board.window.isDestroyed() || !board.window.isVisible()) continue;
      const bounds = board.window.getBounds();
      const side = { small: 280, medium: 340, large: 420 }[board.record.size];
      const x = cursor.x - bounds.x - 40,
        y = cursor.y - bounds.y - 40;
      const radius = { glass: 26, timing: 20, neon: 22 }[board.record.style];
      const cornerX = Math.max(radius - x, 0, x - side + radius);
      const cornerY = Math.max(radius - y, 0, y - side + radius);
      const inside =
        x >= 0 &&
        y >= 0 &&
        x <= side &&
        y <= side &&
        cornerX * cornerX + cornerY * cornerY <= radius * radius;
      this.setBoardInput(board, board.record.clickThrough || board.unresponsive || !inside);
    }
  };

  private setInput(orb: OrbSession, ignored: boolean): boolean {
    try {
      (this.input ??= createMonitorWindowInput()).setIgnored(orb.window, ignored);
      return true;
    } catch (error) {
      console.error("Local monitor native input failed; closing the affected orb", error);
      if (!orb.window.isDestroyed()) orb.window.destroy();
      return false;
    }
  }
  private readonly onInteractive = (event: IpcMainEvent, value: unknown): void => {
    const view = this.windows.get(event.sender.id);
    if (
      !view ||
      view.surface !== "orb" ||
      view.window.isDestroyed() ||
      view.orb.inputBlocked ||
      event.sender !== view.window.webContents ||
      event.senderFrame !== view.window.webContents.mainFrame ||
      typeof value !== "boolean"
    )
      return;
    view.orb.interactive = value;
    if (value) view.orb.interaction = ++this.interactionSequence;
    if (
      !view.orb.drag &&
      !this.setInput(view.orb, view.orb.record.preferences.clickThrough || !value)
    )
      return;
    this.sendStates();
  };

  private cancelDrag(orb: OrbSession, rendererFailure = false): void {
    orb.drag = null;
    orb.interactive = false;
    orb.pointer = null;
    if (rendererFailure) orb.inputBlocked = true;
    if (!orb.window.isDestroyed()) {
      if (!this.setInput(orb, true)) return;
      if (!orb.inputBlocked && !orb.window.webContents.isDestroyed())
        orb.window.webContents.send("paseo:monitor:drag-cancelled");
    }
    this.updateVisibility();
  }

  private beginDrag(view: MonitorView): void {
    if (
      view.surface !== "orb" ||
      view.orb.inputBlocked ||
      !view.window.isVisible() ||
      view.orb.record.preferences.clickThrough
    )
      throw new Error("This surface cannot drag an orb");
    if (!this.setInput(view.orb, false)) throw new Error("Native orb input is unavailable");
    view.orb.drag = { cursor: screen.getCursorScreenPoint(), bounds: view.window.getBounds() };
    view.orb.interaction = ++this.interactionSequence;
    this.updateVisibility();
  }
  private async endDrag(view: MonitorView): Promise<void> {
    if (view.surface !== "orb" || !view.orb.drag) return;
    const orb = view.orb;
    orb.drag = null;
    orb.window.setBounds(
      snapMonitorOrb(
        orb.window.getBounds(),
        orb.record.preferences.size,
        this.displays(),
        this.neighbours(orb),
      ),
    );
    orb.pointer = null;
    if (!this.setInput(orb, orb.record.preferences.clickThrough || !orb.interactive))
      throw new Error("Native orb input is unavailable");
    this.rememberPosition(orb);
    this.sendStates();
    this.updateVisibility();
    await this.persist(true);
  }
  private neighbours(orb: OrbSession): OrbNeighbour[] {
    const result: OrbNeighbour[] = [];
    for (const other of this.orbs.values())
      if (other !== orb && !other.window.isDestroyed() && other.window.isVisible())
        result.push({ bounds: other.window.getBounds(), size: other.record.preferences.size });
    return result;
  }
  private rememberPosition(orb: OrbSession): void {
    const key = monitorArrangement(this.displays());
    const bounds = orb.window.getBounds();
    delete orb.record.positions[key];
    orb.record.positions[key] = { x: bounds.x, y: bounds.y };
    const keys = Object.keys(orb.record.positions);
    if (keys.length > 16) delete orb.record.positions[keys[0]!];
  }

  private clampView(view: MonitorView): void {
    const bounds = view.window.getBounds();
    const next =
      view.surface === "orb"
        ? placeMonitorOrb(bounds, view.orb.record.preferences.size, this.displays())
        : clampMonitorPanel(bounds, this.displays());
    view.window.setBounds(next);
    if (view.surface === "orb") this.rememberPosition(view.orb);
  }
  private readonly onDisplaysChanged = (): void => {
    if (
      !screen
        .getAllDisplays()
        .some((display) => display.workArea.width > 0 && display.workArea.height > 0)
    ) {
      this.perfCard?.close();
      return;
    }
    const key = monitorArrangement(this.displays());
    for (const orb of this.orbs.values()) {
      const point = orb.record.positions[key] ?? orb.window.getBounds();
      orb.window.setBounds(placeMonitorOrb(point, orb.record.preferences.size, this.displays()));
      this.rememberPosition(orb);
      orb.pointer = null;
    }
    for (const panel of this.panels.values()) this.clampView(panel);
    for (const board of this.boards.values()) {
      if (board.window.isDestroyed()) continue;
      const point = board.record.positions[key] ?? board.window.getBounds();
      board.window.setBounds(this.boardBounds(board.record, point));
      this.rememberBoardPosition(board);
    }
    this.sendStates();
    void this.persist();
  };

  private orbSummaries(): OmpMonitorOrbSummary[] {
    if (this.summaries) return this.summaries;
    this.summaries = this.savedOrbs
      .filter((record) => this.orbs.has(record.id))
      .map((record) => ({
        instanceId: record.id,
        name: record.preferences.orbName ?? record.scope.project ?? record.scope.profile ?? "OMP",
        effectiveRedline: effectiveMonitorRedline(record.preferences),
        scope: record.scope,
        style: record.preferences.style,
        size: record.preferences.size,
        titleTheme: effectiveMonitorTitleTheme(record.preferences),
        visible: record.visible,
        clickThrough: record.preferences.clickThrough,
        pinned: record.preferences.pinned,
      }));
    return this.summaries;
  }

  private maximumFps(orb: OrbSession): 30 | 60 {
    let high = 0;
    let recent: OrbSession | undefined;
    for (const candidate of this.orbs.values()) {
      if (candidate.window.isDestroyed() || !candidate.window.isVisible()) continue;
      if (!recent || candidate.interaction > recent.interaction) recent = candidate;
      const snapshot = candidate.snapshot;
      if (
        !candidate.workerError &&
        snapshot &&
        snapshot.status !== "unavailable" &&
        snapshot.status !== "error" &&
        (candidate.record.preferences.metric === "total"
          ? snapshot.rate.measuredTotalTps + snapshot.rate.estimatedTotalTps
          : snapshot.rate.measuredTps + snapshot.rate.estimatedTps) >=
          effectiveMonitorRedline(candidate.record.preferences) * 0.75
      )
        high++;
    }
    return high >= 4 && recent !== orb ? 30 : 60;
  }

  private viewState(view: MonitorView): OmpMonitorViewState {
    const orb = view.orb;
    const plate = monitorNameplate(
      orb.window.isDestroyed() ? view.window.getBounds() : orb.window.getBounds(),
      orb.record.preferences.size,
      this.displays(),
      this.neighbours(orb),
    );
    let language = orb.record.preferences.language;
    if (language === "system")
      language = app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en";
    return {
      language,
      surface: view.surface,
      nativeFrame:
        process.platform === "win32" && (view.surface === "settings" || view.surface === "history"),
      instanceId: orb.record.id,
      orbVisible: orb.record.visible && orb.record.preferences.showOrbs,
      preferences: orb.record.preferences,
      effectiveRedline: effectiveMonitorRedline(orb.record.preferences),
      effectiveTitleTheme: effectiveMonitorTitleTheme(orb.record.preferences),
      orbName:
        orb.record.preferences.orbName ??
        orb.record.scope.project ??
        orb.record.scope.profile ??
        "OMP",
      titleThemes: this.titleThemes.state(),
      launchAtLogin: this.launchAtLogin,
      ompSource: this.sourceState(view),
      effectsPreview: this.effectsPreview,
      orbUndo:
        this.orbUndo && this.orbUndo.expiresAt > Date.now()
          ? { kind: this.orbUndo.kind, expiresAt: this.orbUndo.expiresAt }
          : null,
      orbManagement: { canSplit: false, canMerge: this.orbs.size > 1, reason: "single-omp-source" },
      nameplatePlacement: plate.placement,
      nameplateMaxWidth: plate.maxWidth,
      maxFps: view.surface === "orb" ? this.maximumFps(orb) : 60,
      activity: orb.activity,
      scope: orb.record.scope,
      scopes: this.scopes,
      snapshot: orb.snapshot,
      workerError: orb.workerError,
      preferenceError: this.preferenceError,
      refreshing: orb.refreshing,
      windowCount: this.orbs.size,
      orbs: this.orbSummaries(),
      maxWindows: MAX_MONITOR_ORBS,
      board: view.board ? this.boardSummary(view.board) : null,
      boards: this.savedBoards.map((record) => this.boardSummary(record)),
    };
  }
  private sendState(view: MonitorView): void {
    if (
      !this.disposed &&
      !this.titleCommandRunning &&
      !view.window.isDestroyed() &&
      !view.window.webContents.isDestroyed()
    ) {
      this.updateNativePanel(view);
      view.window.webContents.send("paseo:monitor:state", this.viewState(view));
      this.perfCard?.refresh(view.window);
    }
  }
  private sendStates(): void {
    for (const view of this.windows.values()) this.sendState(view);
  }

  private persist(reportFailure = false): Promise<void> {
    if (this.disposed) return this.preferenceWrites;
    const records = this.savedOrbs.map(copyOrbRecord);
    const boards = this.savedBoards.map((record) => ({
      ...record,
      positions: { ...record.positions },
    }));
    const operation = this.preferenceWrites.then(() =>
      writeMonitorPreferences(this.preferencesFile, records, this.invalidPreferences, boards),
    );
    this.preferenceWrites = operation.then(
      () => this.preferenceSaved(),
      () => this.preferenceFailed(),
    );
    return reportFailure ? operation : this.preferenceWrites;
  }
  private preferenceSaved(): void {
    this.invalidPreferences = false;
    this.preferenceError = false;
    this.sendStates();
  }
  private preferenceFailed(): void {
    this.preferenceError = true;
    this.sendStates();
  }

  private showBoardMenu(view: MonitorView): void {
    const record = view.board;
    if (!record) return;
    const zh = this.viewState(view).language === "zh";
    const choose = (patch: unknown) => {
      void this.mutate(() => this.configureBoard(view, { id: record.id, patch })).catch(() =>
        this.preferenceFailed(),
      );
    };
    const template: MenuItemConstructorOptions[] = [
      {
        label: view.orb.record.scope.project ?? view.orb.record.scope.profile ?? "OMP",
        enabled: false,
      },
      {
        label: zh ? "样式" : "Style",
        submenu: (["glass", "timing", "neon"] as const).map((style, index) => ({
          label: (zh ? ["玻璃", "计时塔", "霓虹"] : ["Glass", "Timing Tower", "Neon"])[index],
          type: "radio" as const,
          checked: record.style === style,
          click: () => choose({ style }),
        })),
      },
      {
        label: zh ? "大小" : "Size",
        submenu: (["small", "medium", "large"] as const).map((size, index) => ({
          label: (zh ? ["小", "中", "大"] : ["Small", "Medium", "Large"])[index],
          type: "radio" as const,
          checked: record.size === size,
          click: () => choose({ size }),
        })),
      },
      ...(["showPerformance", "showThinking", "showCost", "pinned", "clickThrough"] as const).map(
        (key, index) => ({
          label: (zh
            ? ["性能", "思考速度", "每秒费用", "置顶", "鼠标穿透"]
            : [
                "Performance",
                "Thinking rate",
                "Cost per second",
                "Always on top",
                "Click-through",
              ])[index],
          type: "checkbox" as const,
          checked: record[key],
          click: () => choose({ [key]: !record[key] }),
        }),
      ),
      { type: "separator" },
      {
        label: zh ? "设置" : "Settings",
        click: async () => {
          await this.openPanel(view.orb, "settings");
          const settings = this.panels.get("settings");
          if (settings) {
            settings.board = record;
            this.sendState(settings);
          }
        },
      },
      { label: zh ? "隐藏看板" : "Hide board", click: () => choose({ visible: false }) },
      {
        label: zh ? "移除看板…" : "Remove board…",
        click: () => {
          void this.mutate(() => this.removeBoard(view, record.id)).catch(() =>
            this.preferenceFailed(),
          );
        },
      },
    ];
    Menu.buildFromTemplate(template).popup({ window: view.window });
  }

  private showMenu(view: MonitorView): void {
    if (view.surface === "board") {
      this.showBoardMenu(view);
      return;
    }
    const orb = view.orb,
      p = orb.record.preferences;
    const zh = this.viewState(view).language === "zh";
    const choose = (patch: unknown) => {
      void this.mutate(() => this.configure(orb, patch)).catch(() => this.preferenceFailed());
    };
    const styles = {
      led: ["LED 仪表", "LED Gauge"],
      needle: ["指针转速表", "Needle Tachometer"],
      liquid: ["液态能量", "Liquid Energy"],
      reactor: ["反应堆", "Reactor"],
      minimal: ["极简圆环", "Minimal Ring"],
    };
    const template: MenuItemConstructorOptions[] = [
      {
        label:
          orb.record.preferences.orbName ??
          orb.record.scope.project ??
          orb.record.scope.profile ??
          "OMP",
        enabled: false,
      },
      {
        label: zh ? "样式" : "Style",
        submenu: Object.entries(styles).map(([style, names]) => ({
          label: names[zh ? 0 : 1],
          type: "radio" as const,
          checked: p.style === style,
          click: () => choose({ style }),
        })),
      },
      {
        label: zh ? "大小" : "Size",
        submenu: [112, 148, 196].map((size) => ({
          label: `${size} DIP`,
          type: "radio" as const,
          checked: p.size === size,
          click: () => choose({ size }),
        })),
      },
      {
        label: zh ? "特效" : "Effects",
        submenu: (["off", "soft", "standard", "max"] as const).map((effects, index) => ({
          label: (zh ? ["关闭", "柔和", "标准", "最大"] : ["Off", "Soft", "Standard", "Max"])[
            index
          ],
          type: "radio" as const,
          checked: p.effects === effects,
          click: () => choose({ effects }),
        })),
      },
      { type: "separator" },
      {
        label: zh ? "始终置顶" : "Always on top",
        type: "checkbox",
        checked: p.pinned,
        click: () => choose({ pinned: !p.pinned }),
      },
      {
        label: zh ? "鼠标穿透" : "Click-through",
        type: "checkbox",
        checked: p.clickThrough,
        click: () => choose({ clickThrough: !p.clickThrough }),
      },
      { type: "separator" },
      {
        label: zh ? "添加悬浮球" : "Add orb",
        enabled: this.orbs.size < MAX_MONITOR_ORBS,
        click: () => {
          void this.mutate(() => this.addOrb(orb)).catch(() => this.preferenceFailed());
        },
      },
      {
        label: zh ? "隐藏悬浮球" : "Hide orb",
        click: () => {
          void this.mutate(() => {
            this.setOrbVisible(orb, false);
            return this.persist(true);
          }).catch(() => this.preferenceFailed());
        },
      },
      {
        label: zh ? "移除悬浮球" : "Remove orb",
        enabled: this.orbs.size > 1,
        click: () => {
          void this.mutate(() => this.removeOrb(orb)).catch(() => this.preferenceFailed());
        },
      },
      { type: "separator" },
      {
        label: zh ? "仪表盘" : "Dashboard",
        click: () => {
          void this.openPanel(orb, "dashboard");
        },
      },
      {
        label: zh ? "设置" : "Settings",
        click: () => {
          void this.openPanel(orb, "settings");
        },
      },
      {
        label: zh ? "关闭监控" : "Quit monitor",
        click: () => {
          void this.closeAll().catch(() => undefined);
        },
      },
    ];
    Menu.buildFromTemplate(template).popup({ window: view.window });
  }

  private range(
    value: unknown,
    snapshot: OmpMonitorSnapshot,
    mode = false,
  ): OmpMonitorExportRange | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid history range");
    const source = value as Record<string, unknown>;
    if (
      Object.keys(source).length !== (mode ? 3 : 2) ||
      Object.keys(source).some(
        (key) => key !== "startDate" && key !== "endDate" && !(mode && key === "kind"),
      )
    )
      throw new Error("Invalid history range");
    const { startDate, endDate } = source;
    const now = new Date(Date.now());
    const today = `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
    const available = snapshot.historyRange;
    if (
      !isCalendarDate(startDate) ||
      !isCalendarDate(endDate) ||
      !isCalendarDate(available.startDate) ||
      !isCalendarDate(available.endDate) ||
      startDate > endDate ||
      endDate > today ||
      startDate < available.startDate ||
      endDate > available.endDate
    )
      throw new Error("Unavailable history range");
    return { startDate, endDate };
  }
  private modeExportKind(
    value: unknown,
    range: OmpMonitorExportRange | undefined,
  ): "effort" | "speed" {
    if (!value || typeof value !== "object" || Array.isArray(value) || !range)
      throw new Error("Invalid mode export");
    const source = value as Record<string, unknown>;
    if (
      (source.kind !== "effort" && source.kind !== "speed") ||
      Object.keys(source).length !== 3 ||
      Object.keys(source).some((key) => key !== "kind" && key !== "startDate" && key !== "endDate")
    )
      throw new Error("Invalid mode export");
    return source.kind;
  }

  private async exportCsv(
    view: MonitorView,
    value: unknown,
    mode = false,
  ): Promise<OmpMonitorExportResult> {
    const snapshot = view.orb.snapshot;
    if (view.exporting || !isExportableSnapshot(snapshot)) return "unavailable";
    const range = this.range(value, snapshot, mode);
    const kind = mode ? this.modeExportKind(value, range) : undefined;
    view.exporting = true;
    try {
      let title: string;
      if (this.viewState(view).language === "zh")
        title = kind ? "导出 OMP 执行模式 CSV" : "导出 OMP 本地监控 CSV";
      else title = kind ? "Export OMP execution modes CSV" : "Export OMP local monitor CSV";
      const result = await dialog.showSaveDialog(view.window, {
        title,
        defaultPath: `omp-monitor-${kind ? `${kind}-modes-` : ""}${range?.startDate ?? new Date(snapshot.updatedAt).toISOString().slice(0, 10)}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath) return "cancelled";
      const csv =
        kind && range
          ? buildMonitorModeCsv(snapshot, { ...range, kind })
          : buildMonitorCsv(snapshot, range);
      await writeFile(result.filePath, "\uFEFF" + csv, "utf8");
      return "saved";
    } catch {
      return "failed";
    } finally {
      view.exporting = false;
    }
  }

  private panelTitle(orb: OrbSession, surface: PanelSurface): string {
    const language = orb.record.preferences.language;
    const zh =
      language === "zh" ||
      (language === "system" && app.getLocale().toLowerCase().startsWith("zh"));
    if (surface === "settings") return `Agent Speed · ${zh ? "设置" : "Settings"}`;
    if (surface === "history") return zh ? "用量历史" : "Usage History";
    return "Agent Speed · OMP — dashboard";
  }

  private updateNativePanel(view: MonitorView): void {
    const window = view.window;
    if (
      this.disposed ||
      process.platform !== "win32" ||
      (view.surface !== "settings" && view.surface !== "history") ||
      !this.readyNativePanels.has(window) ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      return;
    const title = this.panelTitle(view.orb, view.surface);
    const titleChanged = this.nativePanelTitles.get(window) !== title;
    if (titleChanged) {
      window.setTitle(title);
      this.nativePanelTitles.set(window, title);
    }
    let appearance = view.orb.record.preferences.appearance;
    if (appearance === "system") appearance = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    if (!titleChanged && this.nativePanelAppearance.get(window) === appearance) return;
    this.nativePanelAppearance.set(window, appearance);
    try {
      this.windowChrome.apply(window, appearance);
    } catch (error) {
      // The SDK client stays opaque. A failed DWM request never implies Mica.
      console.error("Unable to apply native monitor window appearance", error);
    }
  }

  private readonly onNativeThemeUpdated = (): void => {
    for (const view of this.panels.values()) {
      // The system event can also change high-contrast/material policy with unchanged colors.
      this.nativePanelAppearance.delete(view.window);
      this.updateNativePanel(view);
    }
    this.perfCard?.refresh();
  };

  private dependentSettings(orb: OrbSession): MonitorView | undefined {
    const settings = this.panels.get("settings");
    return settings?.orb === orb && !settings.window.isDestroyed() ? settings : undefined;
  }

  /** One synchronous close-event permit, issued only after a successful real draft flush. */
  private async closeNativeView(view: MonitorView): Promise<void> {
    const window = view.window;
    if (window.isDestroyed())
      throw new Error("The monitor window disappeared before its saved close");
    const { promise: closed, resolve: onClosed, reject } = Promise.withResolvers<void>();
    window.once("closed", onClosed);
    this.nativeCloseAttempts.set(window, { permitted: true, reject });
    try {
      window.close();
      await closed;
    } finally {
      window.removeListener("closed", onClosed);
      this.nativeCloseAttempts.delete(window);
    }
  }

  private reportCloseFailure(error: unknown): void {
    console.error("Unable to save and close the local monitor", error);
    this.preferenceFailed();
  }

  /** Outside mutate: the immutable renderer hook submits genuine title commands to that queue. */
  private closeSettings(view: MonitorView, drainWorker = false): Promise<void> {
    const window = view.window;
    if (drainWorker) this.settingsCloseDrains.add(window);
    const pending = this.settingsCloseAttempts.get(window);
    if (pending) return pending;
    if (window.isDestroyed()) return Promise.resolve();
    const operation = Promise.resolve()
      .then(async () => {
        try {
          await flushMonitorSettingsDraft(window);
          await this.mutate(async () => {
            for (const orb of this.orbs.values())
              if (!orb.window.isDestroyed()) this.rememberPosition(orb);
            for (const board of this.boards.values()) this.rememberBoardPosition(board);
            await this.persist(true);
            if (this.settingsCloseDrains.has(window)) await this.drainWorker();
            // The renderer retains its inert lock until the actual native closed event.
            await this.closeNativeView(view);
          });
          return undefined;
        } catch (error) {
          let failure = error;
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            try {
              await releaseMonitorSettingsDraftLock(window);
            } catch (recoveryError) {
              failure = new AggregateError(
                [error, recoveryError],
                "Monitor close failed and restoring editor input also failed",
                { cause: error },
              );
            }
          }
          this.reportCloseFailure(failure);
          throw failure;
        }
      })
      .finally(() => {
        this.settingsCloseDrains.delete(window);
        if (this.settingsCloseAttempts.get(window) === operation)
          this.settingsCloseAttempts.delete(window);
      });
    this.settingsCloseAttempts.set(window, operation);
    return operation;
  }

  private closeOrb(view: MonitorView): Promise<void> {
    const pending = this.orbCloseAttempts.get(view.window);
    if (pending) return pending;
    if (view.window.isDestroyed()) return Promise.resolve();
    const operation = Promise.resolve()
      .then(async () => {
        const settings = this.dependentSettings(view.orb);
        try {
          if (settings) await this.closeSettings(settings, this.orbs.size === 1);
          await this.mutate(async () => {
            if (view.window.isDestroyed()) return;
            if (this.orbs.size === 1) {
              this.rememberPosition(view.orb);
              await this.persist(true);
              await this.drainWorker();
            }
            await this.closeNativeView(view);
          });
          return undefined;
        } catch (error) {
          this.reportCloseFailure(error);
          throw error;
        }
      })
      .finally(() => {
        if (this.orbCloseAttempts.get(view.window) === operation)
          this.orbCloseAttempts.delete(view.window);
      });
    this.orbCloseAttempts.set(view.window, operation);
    return operation;
  }

  private closeAll(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.disposed) return Promise.resolve();
    this.perfCard?.close();
    const operation = Promise.resolve()
      .then(async () => {
        const settings = this.panels.get("settings");
        if (settings && !settings.window.isDestroyed()) await this.closeSettings(settings, true);
        await this.mutate(async () => {
          this.closingAll = true;
          try {
            for (const orb of this.orbs.values())
              if (!orb.window.isDestroyed()) this.rememberPosition(orb);
            for (const board of this.boards.values()) this.rememberBoardPosition(board);
            await this.persist(true);
            await this.drainWorker();
            this.stopEffectsPreview();
            this.clearOrbUndo();
            for (const view of this.windows.values()) {
              if (view.window.isDestroyed()) continue;
              if (view.surface === "settings")
                throw new Error("A new Settings editor must be saved before closing");
              view.window.destroy();
            }
          } finally {
            this.closingAll = false;
          }
        }).catch((error) => {
          this.reportCloseFailure(error);
          throw error;
        });
        this.updateVisibility();
        return undefined;
      })
      .finally(() => {
        if (this.closing === operation) this.closing = null;
      });
    this.closing = operation;
    return operation;
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    if (this.disposed) return this.preferenceWrites;
    const operation = this.closeAll()
      .then(async () => {
        this.disposed = true;
        this.perfCard?.dispose();
        this.titleThemes.dispose();
        for (const channel of this.handlers) ipcMain.removeHandler(channel);
        this.handlers.length = 0;
        ipcMain.removeListener("paseo:monitor:interactive", this.onInteractive);
        ipcMain.removeListener("paseo:monitor:perf-card", this.onPerfCard);
        if (this.initialized) {
          screen.removeListener("display-added", this.onDisplaysChanged);
          screen.removeListener("display-removed", this.onDisplaysChanged);
          screen.removeListener("display-metrics-changed", this.onDisplaysChanged);
          nativeTheme.removeListener("updated", this.onNativeThemeUpdated);
        }
        clearInterval(this.pointerTimer);
        this.pointerTimer = undefined;
        this.windows.clear();
        this.orbs.clear();
        this.panels.clear();
        this.panelLoads.clear();
        this.boards.clear();
        await this.mutations;
        await this.preferenceWrites;
        await this.workerStopping;
        return undefined;
      })
      .finally(() => {
        if (this.disposing === operation) this.disposing = null;
      });
    this.disposing = operation;
    return operation;
  }
}
