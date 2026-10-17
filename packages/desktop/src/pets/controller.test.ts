import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from "../settings/desktop-settings.js";
import { DEFAULT_PET_ACTIVITY } from "./activity.js";
import type { PetDescriptor } from "./types.js";
import { DesktopPetController } from "./controller.js";

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => unknown>(),
  subscribers: new Set<(settings: DesktopSettings) => void>(),
  windows: [] as {
    destroy: () => void;
    webContents: { send: Mock; mainFrame: object };
    options: Record<string, unknown>;
    showInactive: Mock;
  }[],
  settings: {} as DesktopSettings,
  getSelected: vi.fn(),
  report: vi.fn(),
  patch: vi.fn(),
  menus: [] as { label?: string; click?: () => void }[][],
}));

vi.mock("electron-log/main", () => ({ default: { error: vi.fn() } }));
vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({ get: async () => mock.settings, patch: mock.patch }),
  subscribeDesktopSettingsChanges: (listener: (settings: DesktopSettings) => void) => {
    mock.subscribers.add(listener);
    return () => mock.subscribers.delete(listener);
  },
}));
vi.mock("./library.js", () => ({ getPetLibrary: () => ({ getSelected: mock.getSelected }) }));
vi.mock("../window/main-windows.js", () => ({
  getMainWindows: () => [],
  isMainWindowSender: (sender: { main: boolean }) => sender.main === true,
  onMainWindowRemoved: () => () => undefined,
}));
vi.mock("electron", async () => {
  // This hoisted Electron module-loading mock runs before static imports initialize.
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    destroyed = false;
    bounds = { x: 0, y: 0, width: 260, height: 228 };
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
    });
    showInactive = vi.fn();
    constructor(public options: Record<string, unknown>) {
      super();
      mock.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    setIgnoreMouseEvents = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    async loadURL() {}
    getBounds() {
      return this.bounds;
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
  }
  return {
    BrowserWindow: Window,
    dialog: { showErrorBox: mock.report },
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: (event: unknown, value?: unknown) => unknown) =>
        mock.handlers.set(channel, handler),
      removeHandler: (channel: string) => mock.handlers.delete(channel),
    }),
    Menu: {
      buildFromTemplate: vi.fn((template: (typeof mock.menus)[number]) => {
        mock.menus.push(template);
        return { popup: vi.fn() };
      }),
    },
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    }),
  };
});

const animation = { row: 0, frames: 2, fps: 4 };
const descriptor: PetDescriptor = {
  id: "iris",
  name: "Iris",
  description: "",
  builtIn: true,
  spriteUrl: "omp-desktop://app/pet-sprites/iris.png",
  previewUrl: "omp-desktop://app/pet-preview/iris.png",
  frameWidth: 128,
  frameHeight: 128,
  sheetWidth: 256,
  sheetHeight: 640,
  animations: {
    idle: animation,
    running: animation,
    blocked: animation,
    ready: animation,
    needs_input: animation,
  },
};
const controllers: DesktopPetController[] = [];

beforeEach(() => {
  mock.handlers.clear();
  mock.subscribers.clear();
  mock.windows.length = 0;
  mock.menus.length = 0;
  mock.settings = { ...DEFAULT_DESKTOP_SETTINGS, pet: { ...DEFAULT_DESKTOP_SETTINGS.pet } };
  mock.getSelected.mockReset().mockResolvedValue(descriptor);
  mock.report.mockReset();
  mock.patch.mockReset();
});
afterEach(() => {
  for (const instance of controllers) instance.dispose();
  controllers.length = 0;
});

function controller() {
  const openApp = vi.fn(),
    openTask = vi.fn();
  const instance = new DesktopPetController({ openApp, openTask });
  controllers.push(instance);
  return { instance, openApp, openTask };
}

async function changeSettings(pet: Partial<DesktopSettings["pet"]>) {
  mock.settings = { ...mock.settings, pet: { ...mock.settings.pet, ...pet } };
  for (const listener of mock.subscribers) listener(mock.settings);
  // Let queued selection and loadURL promise continuations finish before observing the native boundary.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("native companion controller", () => {
  it("creates no disabled window and exactly one enabled non-focusing sandboxed overlay", async () => {
    const { instance } = controller();
    await instance.initialize();
    expect(mock.windows).toHaveLength(0);
    await changeSettings({ enabled: true });
    await changeSettings({ size: "large" });
    expect(mock.windows).toHaveLength(1);
    expect(mock.windows[0].options).toMatchObject({
      transparent: true,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    expect(mock.windows[0].showInactive).toHaveBeenCalledOnce();
    const destroy = vi.spyOn(mock.windows[0], "destroy");
    await changeSettings({ enabled: false });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("authenticates snapshots and routes clicks to the actual priority task then clears attention", async () => {
    mock.settings.pet.enabled = true;
    const { instance, openApp, openTask } = controller();
    await instance.initialize();
    const publish = mock.handlers.get("paseo:pet:publishActivity")!;
    const mainFrame = {},
      sender = { id: 12, main: true, mainFrame };
    const event = { sender, senderFrame: mainFrame };
    const tasks = [
      { serverId: "local", agentId: "working", title: "Working", status: "running", updatedAt: 20 },
      {
        serverId: "remote",
        agentId: "permission",
        title: "Permission",
        status: "needs_input",
        updatedAt: 10,
      },
    ];
    expect(() =>
      publish({ sender: { ...sender, main: false }, senderFrame: mainFrame }, DEFAULT_PET_ACTIVITY),
    ).toThrow("main application window");
    expect(() => publish({ sender, senderFrame: {} }, DEFAULT_PET_ACTIVITY)).toThrow(
      "main application window",
    );
    publish(event, {
      ...DEFAULT_PET_ACTIVITY,
      connected: true,
      serverIds: ["local", "remote"],
      revisions: { local: { generation: "g1", seq: 1 }, remote: { generation: "g1", seq: 1 } },
      tasks,
    });
    const window = mock.windows[0];
    const overlayEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    mock.handlers.get("paseo:pet:open")!(overlayEvent);
    expect(openTask).toHaveBeenCalledWith(tasks[1]);
    publish(event, {
      ...DEFAULT_PET_ACTIVITY,
      connected: true,
      serverIds: ["local", "remote"],
      revisions: { local: { generation: "g1", seq: 2 }, remote: { generation: "g1", seq: 2 } },
      tasks: [],
    });
    mock.handlers.get("paseo:pet:open")!(overlayEvent);
    expect(openApp).toHaveBeenCalledOnce();
  });

  it("surfaces corrupt selected art rather than substituting a descriptor", async () => {
    mock.settings.pet.enabled = true;
    mock.settings.pet.selectedId = "corrupt";
    mock.getSelected.mockRejectedValue(new Error("Invalid selected spritesheet"));
    const { instance } = controller();
    await instance.initialize();
    expect(mock.windows).toHaveLength(0);
    expect(mock.report).toHaveBeenCalledWith("Desktop companion", "Invalid selected spritesheet");
  });

  it("keeps activity publication available while the app finishes quitting", async () => {
    mock.settings.pet.enabled = true;
    const { instance } = controller();
    await instance.initialize();
    const destroy = vi.spyOn(mock.windows[0], "destroy");

    instance.beginShutdown();

    expect(destroy).toHaveBeenCalledOnce();
    expect([...mock.handlers.keys()]).toEqual(["paseo:pet:publishActivity"]);
    expect(mock.subscribers.size).toBe(0);
    const publish = mock.handlers.get("paseo:pet:publishActivity")!;
    const mainFrame = {};
    expect(
      publish(
        { sender: { id: 12, main: true, mainFrame }, senderFrame: mainFrame },
        DEFAULT_PET_ACTIVITY,
      ),
    ).toEqual({ revalidate: [] });
    expect(mock.patch).not.toHaveBeenCalled();
  });

  it("fully disposes overlay and handlers without requesting a settings write", async () => {
    mock.settings.pet.enabled = true;
    const { instance } = controller();
    await instance.initialize();
    const destroy = vi.spyOn(mock.windows[0], "destroy");
    instance.dispose();
    expect(destroy).toHaveBeenCalledOnce();
    expect(mock.handlers.size).toBe(0);
    expect(mock.subscribers.size).toBe(0);
    expect(mock.patch).not.toHaveBeenCalled();
  });
  it.each([
    { name: "long Chinese name", title: "壁纸与宠物功能开发".repeat(6), compact: true },
    { name: "long emoji name", title: "🧑🏽‍💻".repeat(26), compact: true },
    { name: "short emoji name", title: "🧑🏽‍💻".repeat(8), compact: false },
  ])("bounds the $name without changing the selected task", async ({ title, compact }) => {
    mock.settings.pet.enabled = true;
    const { instance, openTask } = controller();
    await instance.initialize();
    const mainFrame = {};
    const task = {
      serverId: "local",
      agentId: "named-task",
      title,
      status: "running",
      updatedAt: 20,
    };
    mock.handlers.get("paseo:pet:publishActivity")!(
      { sender: { id: 12, main: true, mainFrame }, senderFrame: mainFrame },
      {
        ...DEFAULT_PET_ACTIVITY,
        connected: true,
        serverIds: ["local"],
        revisions: { local: null },
        tasks: [task],
      },
    );
    const window = mock.windows[0];
    mock.handlers.get("paseo:pet:menu")!({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    });
    const item = mock.menus.at(-1)![1];
    const prefix = `${DEFAULT_PET_ACTIVITY.labels.running} — `;
    expect(item.label?.startsWith(prefix)).toBe(true);
    const displayed = item.label!.slice(prefix.length);
    if (compact) {
      expect(displayed.endsWith("…")).toBe(true);
      expect(displayed.length).toBeLessThan(title.length);
      expect(title.startsWith(displayed.slice(0, -1))).toBe(true);
      let characters = 0;
      for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(displayed))
        characters++;
      expect(characters).toBeLessThanOrEqual(25);
      if (title.startsWith("🧑🏽‍💻")) expect(displayed).toMatch(/^(?:🧑🏽‍💻)+…$/u);
    } else {
      expect(displayed).toBe(title);
    }
    item.click!();
    expect(openTask).toHaveBeenCalledWith(task);
  });
});
