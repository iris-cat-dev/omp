import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from "electron";
import type {
  Event as ElectronEvent,
  IpcMainInvokeEvent,
  IpcMainEvent,
  Rectangle,
  MenuItemConstructorOptions,
} from "electron";
import { isMainWindowSender } from "../window/main-windows.js";
import { buildMonitorCsv } from "./csv.js";
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
  DEFAULT_MONITOR_PREFERENCES,
  GLOBAL_MONITOR_KEYS,
  MAX_MONITOR_ORBS,
  readMonitorPreferences,
  writeMonitorPreferences,
  type MonitorOrbRecord,
} from "./window-preferences.js";
import { createMonitorWindowInput } from "./window-input.js";
import type { MonitorWindowInput } from "./window-input.js";
import type {
  OmpMonitorRoot,
  OmpMonitorScope,
  OmpMonitorSnapshot,
  OmpMonitorWorkerRequest,
  OmpMonitorWorkerResponse,
} from "./types.js";
import type {
  OmpMonitorActivityEvents,
  OmpMonitorExportRange,
  OmpMonitorExportResult,
  OmpMonitorOrbSummary,
  OmpMonitorSurface,
  OmpMonitorViewState,
} from "./view-types.js";
import { DEFAULT_BOARD_PREFERENCES, MAX_MONITOR_BOARDS } from "./board-types.js";
import type { OmpMonitorBoardRecord, OmpMonitorBoardSummary } from "./board-types.js";

const MONITOR_URL = "omp-desktop://monitor/local-monitor";
const NO_TRANSFERABLES: [] = [];
const PANEL_SIZES = {
  dashboard: { width: 368, height: 840 },
  history: { width: 920, height: 680 },
  settings: { width: 800, height: 680 },
} as const;
type PanelSurface = keyof typeof PANEL_SIZES;
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

function preventNavigation(event: ElectronEvent): void {
  event.preventDefault();
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
  private readonly boards = new Map<string, BoardSession>();
  private readonly handlers: string[] = [];
  private worker: Worker | null = null;
  private input: MonitorWindowInput | null = null;
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
  private pointerTimer: NodeJS.Timeout | undefined;
  private scopes: OmpMonitorSnapshot["scopes"] = { profiles: [], projects: [] };
  private summaries: OmpMonitorOrbSummary[] | null = null;
  private interactionSequence = 0;
  private readonly preferencesFile = path.join(
    app.getPath("userData"),
    "local-monitor",
    "windows.json",
  );

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
    handle("refresh", () => this.refresh());
    handle("surface", (view, value) => {
      if (value !== "dashboard" && value !== "history" && value !== "settings")
        throw new Error("Invalid monitor surface");
      return this.openPanel(view.orb, value);
    });
    handle("configure", (view, value) => this.configure(view.orb, value));
    handle("select-orb", (view, value) => {
      const target =
        typeof value === "string" && value.length <= 64 ? this.orbs.get(value) : undefined;
      if (view.surface !== "settings" || !target) throw new Error("Invalid orb selection");
      view.orb = target;
      view.board = null;
      target.interaction = ++this.interactionSequence;
      this.sendStates();
    });
    handle("orb-visible", (view, value) => {
      if (typeof value !== "boolean") throw new Error("Invalid orb visibility");
      this.setOrbVisible(view.orb, value);
      return this.persist();
    });
    handle("scope", (view, value) => this.setScope(view.orb, value));
    handle("new-window", (view) => this.addOrb(view.orb));
    handle("new-board", (view) => this.addBoard(view.orb));
    handle("configure-board", (view, value) => this.configureBoard(view, value));
    handle("remove-board", (view, value) => this.removeBoard(view, value));
    handle("select-board", (view, value) => {
      const board =
        typeof value === "string"
          ? this.savedBoards.find((record) => record.id === value)
          : undefined;
      const orb = board ? this.orbs.get(board.orbId) : undefined;
      if (view.surface !== "settings" || !board || !orb) throw new Error("Invalid board selection");
      view.board = board;
      view.orb = orb;
      this.sendState(view);
    });
    handle("menu", (view) => this.showMenu(view));
    handle("drag-start", (view) => this.beginDrag(view));
    handle("drag-end", (view) => this.endDrag(view));
    handle("export-csv", (view, value) => this.exportCsv(view, value));
    handle("network-enabled", (_view, value) => {
      if (typeof value !== "boolean") throw new Error("Invalid public-data setting");
      this.startWorker();
      this.post({ type: "pricing.configure", networkEnabled: value });
    });
    handle("currency", (view, value) => {
      if (
        typeof value !== "string" ||
        !/^[A-Z]{3}$/.test(value) ||
        !view.orb.snapshot?.pricing.currencies.includes(value)
      )
        throw new Error("Unsupported monitor currency");
      this.startWorker();
      this.post({ type: "pricing.configure", currency: value });
    });
    handle("refresh-public-data", (view) => {
      if (!view.orb.snapshot?.pricing.networkEnabled)
        throw new Error("Public-data updates are disabled");
      this.startWorker();
      this.post({ type: "pricing.refresh" });
    });
    handle("close", (view) => {
      if (view.surface === "board" && view.board)
        return this.configureBoard(view, { id: view.board.id, patch: { visible: false } });
      view.window.close();
      return undefined;
    });
    handle("close-all", () => this.closeAll());
    ipcMain.on("paseo:monitor:interactive", this.onInteractive);
    screen.on("display-added", this.onDisplaysChanged);
    screen.on("display-removed", this.onDisplaysChanged);
    screen.on("display-metrics-changed", this.onDisplaysChanged);
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

  async open(): Promise<void> {
    if (this.disposed) return;
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
    const document = await readMonitorPreferences(this.preferencesFile);
    this.savedOrbs = document.orbs;
    this.savedBoards = document.boards;
    this.invalidPreferences = document.invalid;
    this.preferenceError = document.invalid;
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

  private async addOrb(template: OrbSession): Promise<void> {
    if (this.orbs.size >= MAX_MONITOR_ORBS) throw new Error("Monitor window limit reached");
    const record = this.newRecord(template);
    this.savedOrbs.push(record);
    try {
      await this.createOrb(record);
    } catch (error) {
      this.savedOrbs = this.savedOrbs.filter((entry) => entry !== record);
      throw error;
    }
    await this.persist();
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
    if (!window.isDestroyed() && record.visible) window.showInactive();
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
    await this.persist();
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
    await this.persist();
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
    await this.persist();
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

  private async openPanel(orb: OrbSession, surface: PanelSurface): Promise<void> {
    if (this.disposed || orb.window.isDestroyed()) return;
    const existing = this.panels.get(surface);
    if (existing && !existing.window.isDestroyed()) {
      existing.orb = orb;
      existing.board = null;
      if (existing.window.isMinimized()) existing.window.restore();
      this.sendState(existing);
      existing.window.show();
      existing.window.focus();
      return;
    }
    const area = nearestMonitorArea(
      { x: orb.window.getBounds().x, y: orb.window.getBounds().y },
      this.displays(),
    );
    const size = PANEL_SIZES[surface];
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
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: "#202020",
      title: `Agent Speed · OMP — ${surface}`,
      hasShadow: true,
      skipTaskbar: surface === "dashboard",
      alwaysOnTop: surface === "dashboard",
      minWidth: Math.min(surface === "dashboard" ? 368 : 640, area.width),
      minHeight: Math.min(surface === "dashboard" ? 400 : 480, area.height),
      resizable: surface !== "dashboard",
      maximizable: surface !== "dashboard",
      minimizable: surface !== "dashboard",
      fullscreenable: false,
      webPreferences: this.webPreferences(),
    });
    const view: MonitorView = { window, surface, orb, exporting: false, board: null };
    this.panels.set(surface, view);
    this.attachView(view);
    await this.loadView(view);
    if (!window.isDestroyed()) {
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
    } else {
      this.orbs.delete(view.orb.record.id);
      this.summaries = null;
      for (const panel of this.panels.values())
        if (panel.orb === view.orb && !panel.window.isDestroyed()) panel.window.destroy();
      for (const board of this.boards.values())
        if (board.orb === view.orb && !board.window.isDestroyed()) board.window.destroy();
      if (!this.closingAll && !this.disposed) {
        this.savedOrbs = this.savedOrbs.filter((record) => record.id !== view.orb.record.id);
        this.savedBoards = this.savedBoards.filter((record) => record.orbId !== view.orb.record.id);
        for (const candidate of this.windows.values())
          if (candidate.board?.orbId === view.orb.record.id) candidate.board = null;
        void this.persist();
      }
    }
    if (!this.orbs.size) {
      this.stopWorker();
      this.scopes = { profiles: [], projects: [] };
    } else this.postScopes();
    this.updateVisibility();
    this.sendStates();
  }

  private setOrbVisible(orb: OrbSession, visible: boolean): void {
    orb.record.visible = visible;
    this.summaries = null;
    orb.pointer = null;
    if (visible) orb.window.showInactive();
    else orb.window.hide();
    this.updateVisibility();
    this.sendStates();
  }

  private async configure(orb: OrbSession, patch: unknown): Promise<void> {
    const preferences = configureMonitorPreferences(patch, orb.record.preferences);
    const source = patch as Record<string, unknown>;
    const beforeSize = orb.record.preferences.size;
    orb.record.preferences = preferences;
    for (const other of this.orbs.values()) {
      const next = { ...other.record.preferences };
      for (const key of GLOBAL_MONITOR_KEYS)
        if (Object.hasOwn(source, key))
          (next as unknown as Record<string, unknown>)[key] = preferences[key];
      other.record.preferences = next;
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
    await this.persist();
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
    orb.record.scope = { profile, project } as OmpMonitorScope;
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
    this.summaries = null;
    this.startWorker();
    this.postScopes();
    this.sendStates();
    await this.persist();
  }

  private async refresh(): Promise<void> {
    const reloads: Promise<void>[] = [];
    for (const orb of this.orbs.values()) {
      orb.refreshing = true;
      orb.workerError = false;
      const view = this.windows.get(orb.window.webContents.id);
      if (orb.inputBlocked && view) reloads.push(this.loadView(view));
    }
    this.startWorker();
    this.post({ type: "refresh" });
    this.sendStates();
    await Promise.all(reloads);
  }

  private startWorker(): void {
    if (this.worker || this.disposed || !this.orbs.size) return;
    let worker: Worker;
    try {
      worker = new Worker(path.join(__dirname, "worker.js"), {
        workerData: {
          roots: this.options.roots,
          cacheDir: path.join(app.getPath("userData"), "local-monitor"),
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
      if (message.type === "error") {
        this.workerFailed(false);
        return;
      }
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
      if (this.worker === worker && !this.disposed) this.workerFailed();
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
    if (orb.baseline && freshResponse) orb.activity.responseSequence++;
    if (
      orb.baseline &&
      freshResponse &&
      freshPeak &&
      now >= orb.peakMutedUntil &&
      snapshot.today.peakOutputTps > orb.previousPeak + 1e-6
    )
      orb.activity.peakSequence++;
    orb.activity.lastResponseAt = lastResponseAt;
    if (peakObservedAt !== null)
      orb.activity.lastPeakAt = Math.max(orb.activity.lastPeakAt ?? 0, peakObservedAt);
    orb.lastResponse = Math.max(orb.lastResponse, lastResponseAt ?? 0);
    orb.previousPeak = Math.max(orb.previousPeak, snapshot.today.peakOutputTps);
    orb.baseline = true;
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.removeAllListeners("message");
    worker.removeAllListeners("exit");
    void worker.terminate().catch(() => undefined);
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
    await this.persist();
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
    )
      return;
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
    this.summaries = [...this.orbs.values()].map(({ record }) => ({
      instanceId: record.id,
      scope: record.scope,
      style: record.preferences.style,
      size: record.preferences.size,
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
        snapshot.rate.measuredTps + snapshot.rate.estimatedTps >=
          candidate.record.preferences.redline * 0.75
      )
        high++;
    }
    return high >= 4 && recent !== orb ? 30 : 60;
  }

  private viewState(view: MonitorView): OmpMonitorViewState {
    const orb = view.orb;
    const plate = monitorNameplate(
      orb.window.getBounds(),
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
      instanceId: orb.record.id,
      orbVisible: orb.record.visible,
      preferences: orb.record.preferences,
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
    if (!this.disposed && !view.window.isDestroyed() && !view.window.webContents.isDestroyed())
      view.window.webContents.send("paseo:monitor:state", this.viewState(view));
  }
  private sendStates(): void {
    for (const view of this.windows.values()) this.sendState(view);
  }

  private persist(): Promise<void> {
    if (this.disposed) return this.preferenceWrites;
    const records = this.savedOrbs.map((record) => ({
      ...record,
      positions: { ...record.positions },
    }));
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
    return this.preferenceWrites;
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
      void this.configureBoard(view, { id: record.id, patch });
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
          void this.removeBoard(view, record.id);
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
      void this.configure(orb, patch);
    };
    const styles = {
      led: ["LED 仪表", "LED Gauge"],
      needle: ["指针转速表", "Needle Tachometer"],
      liquid: ["液态能量", "Liquid Energy"],
      reactor: ["反应堆", "Reactor"],
      minimal: ["极简圆环", "Minimal Ring"],
    };
    const template: MenuItemConstructorOptions[] = [
      { label: orb.record.scope.project ?? orb.record.scope.profile ?? "omp", enabled: false },
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
          void this.addOrb(orb).catch(() => this.preferenceFailed());
        },
      },
      {
        label: zh ? "隐藏悬浮球" : "Hide orb",
        click: () => {
          this.setOrbVisible(orb, false);
          void this.persist();
        },
      },
      {
        label: zh ? "移除悬浮球" : "Remove orb",
        enabled: this.orbs.size > 1,
        click: () => orb.window.close(),
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
      { label: zh ? "关闭监控" : "Quit monitor", click: () => this.closeAll() },
    ];
    Menu.buildFromTemplate(template).popup({ window: view.window });
  }

  private range(value: unknown, snapshot: OmpMonitorSnapshot): OmpMonitorExportRange | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid history range");
    const { startDate, endDate } = value as Record<string, unknown>;
    if (
      typeof startDate !== "string" ||
      typeof endDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      startDate > endDate ||
      !snapshot.days.some((day) => day.date === startDate) ||
      !snapshot.days.some((day) => day.date === endDate)
    )
      throw new Error("Unavailable history range");
    return { startDate, endDate };
  }
  private async exportCsv(view: MonitorView, value: unknown): Promise<OmpMonitorExportResult> {
    const snapshot = view.orb.snapshot;
    if (
      !snapshot ||
      view.exporting ||
      snapshot.status === "unavailable" ||
      snapshot.status === "error" ||
      (snapshot.status === "scanning" && snapshot.coverage.readFiles === 0)
    )
      return "unavailable";
    const range = this.range(value, snapshot);
    view.exporting = true;
    try {
      const result = await dialog.showSaveDialog(view.window, {
        title:
          this.viewState(view).language === "zh"
            ? "导出 OMP 本地监控 CSV"
            : "Export OMP local monitor CSV",
        defaultPath: `omp-monitor-${range?.startDate ?? new Date(snapshot.updatedAt).toISOString().slice(0, 10)}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath) return "cancelled";
      await writeFile(result.filePath, "\uFEFF" + buildMonitorCsv(snapshot, range), "utf8");
      return "saved";
    } catch {
      return "failed";
    } finally {
      view.exporting = false;
    }
  }

  private closeAll(): void {
    this.closingAll = true;
    for (const orb of this.orbs.values()) if (!orb.window.isDestroyed()) this.rememberPosition(orb);
    for (const board of this.boards.values()) this.rememberBoardPosition(board);
    void this.persist();
    for (const view of this.windows.values()) if (!view.window.isDestroyed()) view.window.destroy();
    this.closingAll = false;
    this.stopWorker();
    this.updateVisibility();
  }
  dispose(): Promise<void> {
    if (this.disposed) return this.preferenceWrites;
    this.disposed = true;
    for (const channel of this.handlers) ipcMain.removeHandler(channel);
    this.handlers.length = 0;
    ipcMain.removeListener("paseo:monitor:interactive", this.onInteractive);
    if (this.initialized) {
      screen.removeListener("display-added", this.onDisplaysChanged);
      screen.removeListener("display-removed", this.onDisplaysChanged);
      screen.removeListener("display-metrics-changed", this.onDisplaysChanged);
    }
    clearInterval(this.pointerTimer);
    this.pointerTimer = undefined;
    this.stopWorker();
    for (const view of this.windows.values()) if (!view.window.isDestroyed()) view.window.destroy();
    this.windows.clear();
    this.orbs.clear();
    this.panels.clear();
    this.boards.clear();
    return this.preferenceWrites;
  }
}
