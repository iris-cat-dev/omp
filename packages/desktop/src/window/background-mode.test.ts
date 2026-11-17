import { describe, expect, it, vi } from "vitest";
import {
  BackgroundModeController,
  type BackgroundModeCloseChoice,
  type BackgroundModeCloseEvent,
  type BackgroundModeWindow,
} from "./background-mode.js";

class FakeWindow implements BackgroundModeWindow {
  visible = true;
  destroyed = false;
  hiddenCount = 0;
  shownCount = 0;
  focusedCount = 0;
  private closeListener: ((event: BackgroundModeCloseEvent) => void) | null = null;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  hide(): void {
    this.visible = false;
    this.hiddenCount += 1;
  }

  show(): void {
    this.visible = true;
    this.shownCount += 1;
  }

  focus(): void {
    this.focusedCount += 1;
  }

  on(_event: "close", listener: (event: BackgroundModeCloseEvent) => void): void {
    this.closeListener = listener;
  }

  close(): { prevented: boolean } {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    this.closeListener?.(event);
    if (!event.prevented) this.destroyed = true;
    return event;
  }
}

function showWindow(window: BackgroundModeWindow, focus: boolean): void {
  const nativeWindow = window as FakeWindow;
  if (!nativeWindow.isVisible()) nativeWindow.show();
  if (focus) nativeWindow.focus();
}

function createHarness(choice: BackgroundModeCloseChoice) {
  const window = new FakeWindow();
  const quitApp = vi.fn();
  let trayActions: { restore: () => void; quit: () => void } | null = null;
  const promptForCloseChoice = vi.fn().mockResolvedValue(choice);
  const controller = new BackgroundModeController({
    promptForCloseChoice,
    createTray: (actions) => {
      trayActions = actions;
    },
    destroyTray: () => {
      trayActions = null;
    },
    getWindows: () => [window],
    createWindow: vi.fn().mockResolvedValue(window),
    showWindow,
    quitApp,
    onError: (error) => {
      throw error;
    },
  });
  controller.registerWindow(window);
  return {
    controller,
    window,
    quitApp,
    promptForCloseChoice,
    getTrayActions: () => trayActions,
  };
}

describe("background window mode", () => {
  it("presents a created replacement through the same restore policy", async () => {
    const window = new FakeWindow();
    window.visible = false;
    const controller = new BackgroundModeController({
      promptForCloseChoice: vi.fn(),
      createTray: vi.fn(),
      destroyTray: vi.fn(),
      getWindows: () => [],
      createWindow: async () => window,
      showWindow,
      quitApp: vi.fn(),
      onError: vi.fn(),
    });
    controller.restoreWindows();
    await vi.waitFor(() => expect(window.visible).toBe(true));
    expect(window.shownCount).toBe(1);
    expect(window.focusedCount).toBe(1);
  });

  it("restores every hidden window while focusing only the first", () => {
    const first = new FakeWindow();
    const second = new FakeWindow();
    first.hide();
    second.hide();
    const controller = new BackgroundModeController({
      promptForCloseChoice: vi.fn(),
      createTray: vi.fn(),
      destroyTray: vi.fn(),
      getWindows: () => [first, second],
      createWindow: vi.fn(),
      showWindow,
      quitApp: vi.fn(),
      onError: vi.fn(),
    });
    controller.restoreWindows();
    expect(first.visible).toBe(true);
    expect(second.visible).toBe(true);
    expect(first.focusedCount).toBe(1);
    expect(second.focusedCount).toBe(0);
  });

  it("does not reveal a newly created window if shutdown begins during creation", async () => {
    const window = new FakeWindow();
    window.visible = false;
    let finish!: (window: BackgroundModeWindow) => void;
    const creation = new Promise<BackgroundModeWindow>((resolve) => {
      finish = resolve;
    });
    const controller = new BackgroundModeController({
      promptForCloseChoice: vi.fn(),
      createTray: vi.fn(),
      destroyTray: vi.fn(),
      getWindows: () => [],
      createWindow: () => creation,
      showWindow,
      quitApp: vi.fn(),
      onError: vi.fn(),
    });
    controller.restoreWindows();
    controller.markAppQuitting();
    finish(window);
    await creation;
    expect(window.visible).toBe(false);
    expect(window.focusedCount).toBe(0);
    controller.restoreWindows();
    expect(window.focusedCount).toBe(0);
  });

  it("keeps a disabled startup tray hidden when a window enters background mode", async () => {
    const harness = createHarness("background");
    harness.controller.setTrayEnabled(false);

    harness.window.close();
    await vi.waitFor(() => expect(harness.window.visible).toBe(false));
    expect(harness.getTrayActions()).toBeNull();
    expect(harness.quitApp).not.toHaveBeenCalled();

    harness.controller.restoreWindows();
    expect(harness.window.visible).toBe(true);
  });

  it("removes the tray immediately and recreates a working restore menu when re-enabled", async () => {
    const harness = createHarness("background");
    harness.controller.setTrayEnabled(true);
    const originalActions = harness.getTrayActions();

    harness.controller.setTrayEnabled(false);
    expect(harness.getTrayActions()).toBeNull();
    harness.window.close();
    await vi.waitFor(() => expect(harness.window.visible).toBe(false));
    expect(harness.getTrayActions()).toBeNull();

    harness.controller.setTrayEnabled(true);
    const restoredActions = harness.getTrayActions();
    expect(restoredActions).not.toBeNull();
    expect(restoredActions).not.toBe(originalActions);
    restoredActions?.restore();
    expect(harness.window.visible).toBe(true);
    expect(harness.window.focusedCount).toBe(1);
    expect(harness.quitApp).not.toHaveBeenCalled();
  });

  it("keeps the window alive in the tray and restores it on tray click", async () => {
    const harness = createHarness("background");

    expect(harness.window.close().prevented).toBe(true);
    await vi.waitFor(() => expect(harness.window.hiddenCount).toBe(1));

    const trayActions = harness.getTrayActions();
    expect(trayActions).not.toBeNull();
    trayActions?.restore();
    await vi.waitFor(() => expect(harness.window.shownCount).toBe(1));
    expect(harness.window.focusedCount).toBe(1);
    expect(harness.quitApp).not.toHaveBeenCalled();
  });

  it("hides the window before starting the asynchronous exit lifecycle", async () => {
    const harness = createHarness("quit");

    expect(harness.window.close().prevented).toBe(true);
    await vi.waitFor(() => expect(harness.quitApp).toHaveBeenCalledOnce());
    expect(harness.window.hiddenCount).toBe(1);
    expect(harness.window.visible).toBe(false);
    expect(harness.getTrayActions()).toBeNull();
  });

  it("keeps the window open when the close dialog is dismissed", async () => {
    const harness = createHarness("cancel");

    expect(harness.window.close().prevented).toBe(true);
    await vi.waitFor(() => expect(harness.promptForCloseChoice).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      harness.window.close();
      expect(harness.promptForCloseChoice).toHaveBeenCalledTimes(2);
    });
    expect(harness.quitApp).not.toHaveBeenCalled();
    expect(harness.window.visible).toBe(true);
    expect(harness.getTrayActions()).toBeNull();
  });

  it("lets a user close a window whose renderer can no longer answer the background prompt", () => {
    const harness = createHarness("quit");
    harness.controller.markWindowRendererUnavailable(harness.window);

    const event = harness.window.close();

    expect(event.prevented).toBe(false);
    expect(harness.window.destroyed).toBe(true);
    expect(harness.promptForCloseChoice).not.toHaveBeenCalled();
    expect(harness.quitApp).not.toHaveBeenCalled();
  });

  it("closes a replaced renderer window without entering background or quit lifecycle", () => {
    const harness = createHarness("quit");

    harness.controller.closeWindow(harness.window);

    expect(harness.window.destroyed).toBe(true);
    expect(harness.window.hiddenCount).toBe(0);
    expect(harness.promptForCloseChoice).not.toHaveBeenCalled();
    expect(harness.quitApp).not.toHaveBeenCalled();
  });

  it("quits from the tray menu without reopening the close dialog", async () => {
    const harness = createHarness("background");
    harness.window.close();
    await vi.waitFor(() => expect(harness.getTrayActions()).not.toBeNull());

    harness.getTrayActions()?.quit();
    expect(harness.quitApp).toHaveBeenCalledOnce();
    expect(harness.window.close().prevented).toBe(false);
  });
});
