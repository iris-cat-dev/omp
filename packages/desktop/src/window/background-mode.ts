export interface BackgroundModeWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  hide(): void;
  close(): void;
  on(event: "close", listener: (event: BackgroundModeCloseEvent) => void): void;
}

export interface BackgroundModeCloseEvent {
  preventDefault(): void;
}

export type BackgroundModeCloseChoice = "background" | "quit" | "cancel";

interface BackgroundModeDependencies {
  promptForCloseChoice(window: BackgroundModeWindow): Promise<BackgroundModeCloseChoice>;
  createTray(actions: { restore: () => void; quit: () => void }): void;
  destroyTray(): void;
  getWindows(): BackgroundModeWindow[];
  createWindow(): Promise<BackgroundModeWindow>;
  showWindow(window: BackgroundModeWindow, focus: boolean): void;
  quitApp(): void;
  onError(error: unknown): void;
}

export class BackgroundModeController {
  private readonly backgroundWindows = new Set<BackgroundModeWindow>();
  private readonly pendingPrompts = new Set<BackgroundModeWindow>();
  private readonly immediateCloseWindows = new WeakSet<BackgroundModeWindow>();
  private readonly rendererUnavailableWindows = new WeakSet<BackgroundModeWindow>();
  private trayCreated = false;
  private trayEnabled = true;
  private appQuitting = false;

  constructor(private readonly dependencies: BackgroundModeDependencies) {}

  registerWindow(window: BackgroundModeWindow): void {
    window.on("close", (event) => {
      this.handleWindowClose(window, event);
    });
  }
  setTrayEnabled(enabled: boolean): void {
    this.trayEnabled = enabled;
    if (enabled) {
      this.ensureTray();
    } else if (this.trayCreated) {
      this.dependencies.destroyTray();
      this.trayCreated = false;
    }
  }

  markAppQuitting(): void {
    this.appQuitting = true;
  }

  closeWindow(window: BackgroundModeWindow): void {
    if (window.isDestroyed()) return;
    this.immediateCloseWindows.add(window);
    window.close();
  }

  markWindowRendererUnavailable(window: BackgroundModeWindow): void {
    this.rendererUnavailableWindows.add(window);
  }

  restoreWindows(): void {
    void this.restoreWindowsAsync().catch(this.dependencies.onError);
  }

  quitApp(): void {
    this.appQuitting = true;
    this.dependencies.quitApp();
  }

  private handleWindowClose(window: BackgroundModeWindow, event: BackgroundModeCloseEvent): void {
    if (this.immediateCloseWindows.delete(window) || this.rendererUnavailableWindows.has(window)) {
      return;
    }

    if (this.appQuitting) {
      return;
    }

    event.preventDefault();
    if (this.pendingPrompts.has(window)) {
      return;
    }

    this.pendingPrompts.add(window);
    void this.applyCloseChoice(window);
  }

  private async applyCloseChoice(window: BackgroundModeWindow): Promise<void> {
    try {
      const choice = await this.dependencies.promptForCloseChoice(window);
      if (choice === "quit") {
        this.appQuitting = true;
        if (!window.isDestroyed()) window.hide();
        this.dependencies.quitApp();
        return;
      }
      if (choice === "cancel") {
        return;
      }
      if (window.isDestroyed()) {
        return;
      }

      this.ensureTray();
      this.backgroundWindows.add(window);
      window.hide();
    } catch (error) {
      this.dependencies.onError(error);
    } finally {
      this.pendingPrompts.delete(window);
    }
  }

  private ensureTray(): void {
    if (!this.trayEnabled || this.trayCreated || this.appQuitting) {
      return;
    }

    this.dependencies.createTray({
      restore: () => this.restoreWindows(),
      quit: () => this.quitApp(),
    });
    this.trayCreated = true;
  }

  private async restoreWindowsAsync(): Promise<void> {
    if (this.appQuitting) return;
    const backgroundWindows = [...this.backgroundWindows].filter((window) => !window.isDestroyed());
    this.backgroundWindows.clear();

    const windows =
      backgroundWindows.length > 0
        ? backgroundWindows
        : this.dependencies.getWindows().filter((window) => !window.isDestroyed());
    if (windows.length === 0) {
      const window = await this.dependencies.createWindow();
      if (!this.appQuitting && !window.isDestroyed()) {
        this.dependencies.showWindow(window, true);
      }
      return;
    }

    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      if (window) this.dependencies.showWindow(window, index === 0);
    }
  }
}
