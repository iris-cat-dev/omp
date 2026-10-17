import path from "node:path";
import { BrowserWindow, dialog, ipcMain, Menu, screen, type IpcMainInvokeEvent } from "electron";
import log from "electron-log/main";
import {
  getDesktopSettingsStore,
  subscribeDesktopSettingsChanges,
} from "../settings/desktop-settings-electron.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getMainWindows, isMainWindowSender, onMainWindowRemoved } from "../window/main-windows.js";
import { getPetLibrary } from "./library.js";
import { clampPetBounds } from "./geometry.js";
import { PetActivitySnapshots, parsePetActivity } from "./activity.js";
import type { DesktopPetSettings, DesktopPetTask, PetDescriptor } from "./types.js";

const MENU_TASK_TITLE_LENGTH = 20;
let menuTitleSegmenter: Intl.Segmenter | undefined;

function compactMenuTaskTitle(title: string): string {
  if (title.length <= MENU_TASK_TITLE_LENGTH) return title;
  menuTitleSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let characters = 0;
  for (const { index } of menuTitleSegmenter.segment(title)) {
    if (characters++ === MENU_TASK_TITLE_LENGTH) return `${title.slice(0, index)}…`;
  }
  return title;
}

interface PetControllerOptions {
  openApp: () => void | Promise<void>;
  openTask: (task: DesktopPetTask) => void;
}

export class DesktopPetController {
  private window: BrowserWindow | null = null;
  private descriptor: PetDescriptor | null = null;
  private preferences: DesktopPetSettings | null = null;
  private readonly snapshots = new PetActivitySnapshots();
  private stopped = false;
  private applyQueue: Promise<void> = Promise.resolve();
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeWindows: (() => void) | null = null;
  private pointerTimer: NodeJS.Timeout | undefined;
  private drag: { cursor: { x: number; y: number }; origin: { x: number; y: number } } | null =
    null;
  private readonly handlers: string[] = [];

  constructor(private readonly options: PetControllerOptions) {}

  async initialize(): Promise<void> {
    this.unsubscribeSettings = subscribeDesktopSettingsChanges((settings) => {
      for (const window of getMainWindows())
        window.webContents.send("paseo:event:desktop-settings-changed", settings);
      this.enqueueSettings(settings);
    });
    this.unsubscribeWindows = onMainWindowRemoved((senderId) => this.clearActivity(senderId));
    ipcMain.handle("paseo:pet:publishActivity", (event, value: unknown) => {
      if (!isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Pet activity requires a main application window");
      if (this.stopped) return { revalidate: [] };
      const result = this.snapshots.publish(event.sender.id, parsePetActivity(value));
      this.sendState();
      return result;
    });
    this.handlers.push("paseo:pet:publishActivity");
    const handle = (
      channel: string,
      callback: (event: IpcMainInvokeEvent, value: unknown) => unknown,
    ) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        if (
          !this.window ||
          event.sender !== this.window.webContents ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("Unauthorized companion sender");
        return callback(event, value);
      });
      this.handlers.push(channel);
    };
    handle("paseo:pet:ready", () => this.renderState());
    handle("paseo:pet:open", () => this.openPriorityTask());
    handle("paseo:pet:menu", () => this.showMenu());
    handle("paseo:pet:drag-start", () => {
      const bounds = this.window!.getBounds();
      this.drag = { cursor: screen.getCursorScreenPoint(), origin: { x: bounds.x, y: bounds.y } };
      this.window!.setIgnoreMouseEvents(false);
    });
    handle("paseo:pet:drag-end", async () => {
      this.drag = null;
      await this.persistPosition();
    });
    handle("paseo:pet:error", (_event, message) => {
      if (typeof message !== "string") throw new Error("Invalid companion error");
      this.destroyWindow();
      this.reportError(new Error(message));
    });
    ipcMain.on("paseo:pet:interactive", this.onInteractive);
    screen.on("display-added", this.onDisplaysChanged);
    screen.on("display-removed", this.onDisplaysChanged);
    screen.on("display-metrics-changed", this.onDisplaysChanged);
    this.enqueueSettings(await getDesktopSettingsStore().get());
    await this.applyQueue;
  }

  clearActivity(senderId: number): void {
    this.snapshots.remove(senderId);
    this.sendState();
  }

  beginShutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeSettings?.();
    this.unsubscribeWindows?.();
    for (const channel of this.handlers) {
      if (channel !== "paseo:pet:publishActivity") ipcMain.removeHandler(channel);
    }
    ipcMain.removeListener("paseo:pet:interactive", this.onInteractive);
    screen.removeListener("display-added", this.onDisplaysChanged);
    screen.removeListener("display-removed", this.onDisplaysChanged);
    screen.removeListener("display-metrics-changed", this.onDisplaysChanged);
    this.destroyWindow();
  }

  dispose(): void {
    this.beginShutdown();
    for (const channel of this.handlers) ipcMain.removeHandler(channel);
    this.handlers.length = 0;
  }

  private enqueueSettings(settings: DesktopSettings): void {
    this.applyQueue = this.applyQueue
      .then(async () => {
        if (this.stopped) return undefined;
        this.preferences = settings.pet;
        if (!settings.pet.enabled) {
          this.destroyWindow();
          return undefined;
        }
        if (this.descriptor?.id !== settings.pet.selectedId) {
          this.destroyWindow();
          this.descriptor = await getPetLibrary().getSelected(settings.pet.selectedId);
        }
        if (this.stopped) return undefined;
        if (!this.window) await this.createWindow();
        this.clampWindow(settings.pet.position);
        this.sendState();
        return undefined;
      })
      .catch((error: unknown) => {
        this.destroyWindow();
        this.reportError(error);
      });
  }

  private async createWindow(): Promise<void> {
    const bounds = this.getBounds(this.preferences!.position);
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });
    this.window = window;
    window.setIgnoreMouseEvents(true, { forward: true });
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      clearInterval(this.pointerTimer);
      this.pointerTimer = undefined;
      this.drag = null;
    });
    let lastPointer: { x: number; y: number } | null = null;
    this.pointerTimer = setInterval(() => {
      if (window.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      const current = window.getBounds();
      if (this.drag) {
        const desired = {
          x: this.drag.origin.x + cursor.x - this.drag.cursor.x,
          y: this.drag.origin.y + cursor.y - this.drag.cursor.y,
        };
        if (desired.x !== current.x || desired.y !== current.y)
          window.setBounds(this.getBounds(desired));
      }
      const moved = this.drag ? window.getBounds() : current;
      const x = cursor.x - moved.x,
        y = cursor.y - moved.y;
      if (!lastPointer || x !== lastPointer.x || y !== lastPointer.y) {
        lastPointer = { x, y };
        window.webContents.send("paseo:pet:pointer", lastPointer);
      }
    }, 50);
    // Chromium shares zoom by origin. Main-window zoom must not resize the companion.
    await window.loadURL("omp-desktop://pet/desktop-pet");
    if (this.stopped || window.isDestroyed()) return;
    this.sendState();
    window.showInactive();
  }

  private readonly onInteractive = (event: Electron.IpcMainEvent, interactive: unknown): void => {
    if (
      !this.window ||
      event.sender !== this.window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof interactive !== "boolean" ||
      this.drag
    )
      return;
    this.window.setIgnoreMouseEvents(!interactive, { forward: true });
  };

  private readonly onDisplaysChanged = (): void => {
    if (!this.window || !this.preferences) return;
    this.clampWindow(this.window.getBounds());
    void this.persistPosition().catch((error: unknown) => this.reportError(error));
  };

  private getBounds(position: DesktopPetSettings["position"]): Electron.Rectangle {
    const primary = screen.getPrimaryDisplay();
    const displays = screen.getAllDisplays();
    const areas = [
      primary.workArea,
      ...displays.filter((display) => display.id !== primary.id).map((display) => display.workArea),
    ];
    return clampPetBounds(position, this.preferences!.size, areas);
  }

  private clampWindow(position: DesktopPetSettings["position"]): void {
    this.window?.setBounds(this.getBounds(position));
  }

  private async persistPosition(): Promise<void> {
    if (!this.window) return;
    this.clampWindow(this.window.getBounds());
    const { x, y } = this.window.getBounds();
    await getDesktopSettingsStore().patch({ pet: { position: { x, y } } });
  }

  private renderState() {
    if (!this.descriptor || !this.preferences) throw new Error("Companion is not initialized");
    return {
      descriptor: this.descriptor,
      size: this.preferences.size,
      activity: this.snapshots.get(),
    };
  }

  private sendState(): void {
    if (this.window && !this.window.isDestroyed() && this.descriptor)
      this.window.webContents.send("paseo:pet:state", this.renderState());
  }

  private openPriorityTask(): void | Promise<void> {
    const task = this.snapshots.get().tasks[0];
    return task ? this.options.openTask(task) : this.options.openApp();
  }

  private showMenu(): void {
    const activity = this.snapshots.get();
    const labels = activity.labels;
    const invoke = (action: () => void | Promise<unknown>) => {
      void Promise.resolve()
        .then(action)
        .catch((error: unknown) => this.reportError(error));
    };
    Menu.buildFromTemplate([
      { label: labels.openApp, click: () => invoke(this.options.openApp) },
      ...activity.tasks.map((task) => ({
        label: `${labels[task.status]} — ${compactMenuTaskTitle(task.title || labels.openTask)}`,
        click: () => this.options.openTask(task),
      })),
      { type: "separator" },
      {
        label: labels.hide,
        click: () => invoke(() => getDesktopSettingsStore().patch({ pet: { enabled: false } })),
      },
      {
        label: labels.resetPosition,
        click: () => invoke(() => getDesktopSettingsStore().patch({ pet: { position: null } })),
      },
    ]).popup({ window: this.window! });
  }

  private destroyWindow(): void {
    this.window?.destroy();
    this.window = null;
    this.descriptor = null;
    this.drag = null;
    clearInterval(this.pointerTimer);
    this.pointerTimer = undefined;
  }

  private reportError(error: unknown): void {
    log.error("[desktop pet]", error);
    if (!this.stopped)
      dialog.showErrorBox(
        "Desktop companion",
        error instanceof Error ? error.message : String(error),
      );
  }
}
