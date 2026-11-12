import type { EventEmitter as EventEmitterType } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createActivationScope, type PluginActivationScope } from "@omp-desktop/plugin/host";
import { acquireNativeOverlay, getNativeOverlayDocument } from "./native-overlay.js";
interface TestOverlayWindow extends EventEmitterType { destroyed: boolean; bounds: { x: number; y: number; width: number; height: number }; options: Record<string, unknown>; webContents: EventEmitterType & { id: number; mainFrame: { url?: string; detached?: boolean }; send: Mock }; showInactive: Mock; setIgnoreMouseEvents: Mock }
interface NodeEventsModule { EventEmitter: typeof EventEmitterType }
type TestIpcHandler = (...args: unknown[]) => unknown;
const mock = vi.hoisted(() => ({ windows: [] as TestOverlayWindow[], handlers: new Map<string, TestIpcHandler>(), cursor: { x: -900, y: 200 }, load: null as Promise<void> | null, menus: [] as Electron.MenuItemConstructorOptions[][] }));
vi.mock("electron", async () => {
  // Hoisted Electron factory runs before static runtime imports initialize.
  const { EventEmitter } = await vi.importActual<NodeEventsModule>("node:events");
  class Window extends EventEmitter {
    destroyed = false;
    bounds: { x: number; y: number; width: number; height: number };
    webContents = Object.assign(new EventEmitter(), { id: mock.windows.length + 1, mainFrame: { url: "", detached: false }, send: vi.fn(), setWindowOpenHandler: vi.fn() });
    showInactive = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    constructor(public options: { x: number; y: number; width: number; height: number; [key: string]: unknown }) { super(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; mock.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
    loadURL(url: string) { this.webContents.mainFrame.url = url; return mock.load ?? Promise.resolve(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("closed"); }
  }
  return { BrowserWindow: Window, ipcMain: Object.assign(new EventEmitter(), { handle: (name: string, callback: TestIpcHandler) => mock.handlers.set(name, callback), removeHandler: (name: string) => mock.handlers.delete(name) }), Menu: { buildFromTemplate: (items: Electron.MenuItemConstructorOptions[]) => { mock.menus.push(items); return { popup: vi.fn() }; } }, screen: Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { id: 2, workArea: { x: -1280, y: 80, width: 1280, height: 720 } }], getCursorScreenPoint: () => mock.cursor }) };
});
const scopes: PluginActivationScope[] = [];
beforeEach(() => { vi.useFakeTimers(); mock.windows.length = 0; mock.menus.length = 0; mock.load = null; mock.cursor = { x: -900, y: 200 }; });
afterEach(async () => { await Promise.all(scopes.splice(0).map((scope) => scope.dispose())); vi.useRealTimers(); });
function overlay(bind = true) {
  const scope = createActivationScope(4); scopes.push(scope);
  const onAction = vi.fn(), onPosition = vi.fn(async () => undefined);
  const lease = acquireNativeOverlay({ id: "test", html: "<!doctype html>", width: 260, height: 228, position: { x: -1000, y: 200 }, state: { ready: true }, onAction, onPosition }, scope, "test-plugin");
  const window = mock.windows.at(-1)!;
  if (bind) mock.handlers.get("paseo:overlay:bind")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { scope, lease, window, onAction, onPosition };
}
describe("native overlay leases", () => {
  it("keeps negative display coordinates and a non-focusing isolated window", async () => { const { window } = overlay(); await Promise.resolve(); expect(window.bounds).toMatchObject({ x: -1000, y: 200 }); expect(window.options).toMatchObject({ show: false, transparent: true, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } }); expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true }); expect(window.showInactive).toHaveBeenCalledOnce(); });
  it("rejects the bootstrap frame before binding the genuine overlay document", async () => {
    const { window } = overlay(false);
    const bootstrap = window.webContents.mainFrame;
    const documentURL = bootstrap.url;
    const bind = mock.handlers.get("paseo:overlay:bind")!;
    bootstrap.url = "";
    expect(() => bind({ sender: window.webContents, senderFrame: bootstrap })).toThrow("Unauthorized overlay preload");
    bootstrap.detached = true;
    const documentFrame = { url: documentURL, detached: false };
    window.webContents.mainFrame = documentFrame;
    expect(() => bind({ sender: window.webContents, senderFrame: documentFrame })).not.toThrow();
    const ready = mock.handlers.get(`paseo:overlay:${window.webContents.id}`)!;
    await expect(ready({ sender: window.webContents, senderFrame: documentFrame }, "ready")).resolves.toEqual({ ready: true });
    expect(() => bind({ sender: window.webContents, senderFrame: bootstrap })).toThrow("Unauthorized overlay preload");
    expect(() => bind({ sender: window.webContents, senderFrame: { ...documentFrame } })).toThrow("Unauthorized overlay preload");
  });
  it("rejects a wrong frame and revoked generation actions", async () => { const { window, scope, onAction } = overlay(); const handler = mock.handlers.get(`paseo:overlay:${window.webContents.id}`)!; await expect(handler({ sender: window.webContents, senderFrame: {} }, "open")).rejects.toThrow("Unauthorized"); await handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, "open"); expect(onAction).toHaveBeenCalledWith("open", undefined); await scope.dispose(); await expect(handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, "open")).rejects.toThrow("no longer active"); });
  it("never shows a window whose generation was revoked during document load", async () => { const { promise, resolve } = Promise.withResolvers<void>(); mock.load = promise; const { scope, window } = overlay(); await scope.dispose(); resolve(); await Promise.resolve(); expect(window.destroyed).toBe(true); expect(window.showInactive).not.toHaveBeenCalled(); });
  it("drags inside display bounds and persists the real screen position", async () => { const { window, onPosition } = overlay(); const handler = mock.handlers.get(`paseo:overlay:${window.webContents.id}`)!; const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }; await handler(event, "drag-start"); mock.cursor = { x: -2000, y: 300 }; vi.advanceTimersByTime(50); expect(window.bounds.x).toBe(-1280); await handler(event, "drag-end"); expect(onPosition).toHaveBeenCalledWith({ x: -1280, y: 300 }); });
  it("never dispatches retained menu callbacks to a replacement frame or revoked generation", async () => {
    const f = overlay(); f.lease.showMenu([{ id: "open", label: "Open" }]);
    const invoke = mock.menus.at(-1)![0].click as () => void;
    const frame = f.window.webContents.mainFrame;
    f.window.webContents.mainFrame = {}; invoke(); expect(f.onAction).not.toHaveBeenCalled();
    f.window.webContents.mainFrame = frame; invoke(); expect(f.onAction).toHaveBeenCalledWith("open");
    f.onAction.mockClear(); await f.scope.dispose(); invoke(); expect(f.onAction).not.toHaveBeenCalled();
  });
  it("revokes before full navigation and rejects an asynchronous old-document completion", async () => {
    const f = overlay();
    const { promise, resolve } = Promise.withResolvers<void>(); f.onAction.mockReturnValue(promise);
    const handler = mock.handlers.get(`paseo:overlay:${f.window.webContents.id}`)!;
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    const pending = Promise.resolve(handler(event, "open"));
    const rejected = expect(pending).rejects.toThrow("Unauthorized overlay document");
    f.window.webContents.emit("did-start-navigation", {}, "omp-desktop://overlay/replaced", false, true);
    expect(f.window.destroyed).toBe(true); resolve(); await rejected;
    expect(() => mock.handlers.get("paseo:overlay:bind")!(event)).toThrow("Unauthorized");
  });
  it("revokes the document and retained actions after Native closes the window", async () => {
    const f = overlay();
    const sender = f.window.webContents;
    const pathname = new URL(sender.mainFrame.url!).pathname;
    const handler = mock.handlers.get(`paseo:overlay:${sender.id}`)!;
    f.window.destroyed = true;
    Object.defineProperty(f.window, "webContents", { get: () => undefined });
    f.window.emit("closed");
    expect(getNativeOverlayDocument(pathname)).toBeNull();
    await expect(handler({ sender, senderFrame: sender.mainFrame }, "open")).rejects.toThrow();
    expect(f.onAction).not.toHaveBeenCalled();
  });
  it("keeps the same document bound through fragment and subframe navigation", async () => {
    const f = overlay();
    f.window.webContents.emit("did-start-navigation", {}, "omp-desktop://overlay/#same", true, true);
    f.window.webContents.emit("did-start-navigation", {}, "omp-desktop://overlay/subframe", false, false);
    const handler = mock.handlers.get(`paseo:overlay:${f.window.webContents.id}`)!;
    await handler({ sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame }, "open");
    expect(f.onAction).toHaveBeenCalledWith("open", undefined); expect(f.window.destroyed).toBe(false);
  });
});
