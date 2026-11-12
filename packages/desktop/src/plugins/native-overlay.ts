import path from "node:path";
import { BrowserWindow, ipcMain, Menu, screen } from "electron";
import type { PluginActivationScope, PluginNativeOverlayRequest, PluginNativeOverlayLease } from "@omp-desktop/plugin/host";
export const NATIVE_OVERLAY_CSP = "default-src 'none'; img-src omp-desktop: data:; style-src 'unsafe-inline'; script-src 'nonce-omp-overlay-renderer' 'nonce-omp-pet-renderer'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const documents = new Map<string, string>();
const overlayChannels = new Map<number, { channel: string; bind(event: Electron.IpcMainInvokeEvent): void }>();
let bridgeRegistered = false;
export function getNativeOverlayDocument(pathname: string): string | null { return documents.get(pathname) ?? null; }
let nextOverlay = 0;
export function acquireNativeOverlay(request: PluginNativeOverlayRequest, scope: PluginActivationScope, installationId: string): PluginNativeOverlayLease {
  scope.assertCurrent();
  if (!bridgeRegistered) {
    bridgeRegistered = true;
    ipcMain.handle("paseo:overlay:bind", (event) => {
      const binding = overlayChannels.get(event.sender.id);
      if (!binding) throw new Error("Unauthorized overlay preload.");
      binding.bind(event);
      return binding.channel;
    });
  }
  const pathname = `/plugin-overlay/${installationId}/${scope.generation}/${++nextOverlay}`;
  const documentURL = `omp-desktop://overlay${pathname}`;
  documents.set(pathname, request.html);
  let state = request.state;
  let dimensions = { width: request.width, height: request.height };
  let released = false;
  let drag: { cursor: { x: number; y: number }; origin: { x: number; y: number } } | null = null;
  const bounds = (position: { x: number; y: number } | null) => {
    const primary = screen.getPrimaryDisplay();
    const areas = [primary.workArea, ...screen.getAllDisplays().filter((display) => display.id !== primary.id).map((display) => display.workArea)];
    const desired = position ?? { x: primary.workArea.x + primary.workArea.width - dimensions.width - 24, y: primary.workArea.y + primary.workArea.height - dimensions.height - 24 };
    let nearest = Infinity;
    let result: Electron.Rectangle | undefined;
    for (const area of areas) {
      const width = Math.min(dimensions.width, area.width), height = Math.min(dimensions.height, area.height);
      const x = Math.round(Math.max(area.x, Math.min(desired.x, area.x + area.width - width)));
      const y = Math.round(Math.max(area.y, Math.min(desired.y, area.y + area.height - height)));
      const distance = (x - desired.x) ** 2 + (y - desired.y) ** 2;
      if (distance < nearest) { nearest = distance; result = { x, y, width, height }; }
    }
    if (!result) throw new Error("No available display work area.");
    return result;
  };
  const window = new BrowserWindow({ ...bounds(request.position), show: false, transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, backgroundColor: "#00000000", webPreferences: { preload: path.join(__dirname, "overlay-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false } });
  const webContentsId = window.webContents.id;
  window.setIgnoreMouseEvents(true, { forward: true });
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  let documentEpoch = 0;
  let boundDocument: { frame: Electron.WebFrameMain; epoch: number } | null = null;
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      documentEpoch += 1;
      if (boundDocument || documentEpoch > 1) release();
    }
  });
  const authorized = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    scope.assertCurrent();
    if (released || window.isDestroyed() || event.sender !== window.webContents || !event.senderFrame ||
        event.senderFrame.detached || event.senderFrame !== window.webContents.mainFrame ||
        !boundDocument || boundDocument.frame !== event.senderFrame || boundDocument.epoch !== documentEpoch) {
      throw new Error("Unauthorized overlay document.");
    }
  };
  const channel = `paseo:overlay:${webContentsId}`;
  overlayChannels.set(webContentsId, { channel, bind(event) {
    scope.assertCurrent();
    if (released || window.isDestroyed() || event.sender !== window.webContents || !event.senderFrame ||
        event.senderFrame.detached || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== documentURL) throw new Error("Unauthorized overlay preload.");
    // mini-electron runs the preload on its empty bootstrap frame too. That
    // document must not claim the lease before the real overlay document binds.
    if (!boundDocument) boundDocument = { frame: event.senderFrame, epoch: documentEpoch };
    authorized(event);
  } });
  const action = async (event: Electron.IpcMainInvokeEvent, name: unknown, input: unknown) => {
    authorized(event);
    if (typeof name !== "string") throw new TypeError("Invalid overlay action.");
    if (name === "ready") return state;
    if (name === "drag-start") { const { x, y } = window.getBounds(); drag = { cursor: screen.getCursorScreenPoint(), origin: { x, y } }; window.setIgnoreMouseEvents(false); return; }
    if (name === "drag-end") { drag = null; const { x, y } = window.getBounds(); await request.onPosition({ x, y }); authorized(event); return; }
    const result = await request.onAction(name, input);
    authorized(event);
    return result;
  };
  const interactive = (event: Electron.IpcMainEvent, value: unknown) => { if (released || scope.signal.aborted || window.isDestroyed() || !boundDocument || boundDocument.epoch !== documentEpoch || event.sender !== window.webContents || event.senderFrame !== boundDocument.frame || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.detached) return; if (typeof value === "boolean" && !drag) window.setIgnoreMouseEvents(!value, { forward: true }); };
  ipcMain.handle(channel, action);
  ipcMain.on(`${channel}:interactive`, interactive);
  const displaysChanged = () => { if (released || window.isDestroyed()) return; window.setBounds(bounds(window.getBounds())); const { x, y } = window.getBounds(); void Promise.resolve(request.onPosition({ x, y })).catch((error) => request.onAction("error", error instanceof Error ? error.message : String(error))); };
  screen.on("display-added", displaysChanged);
  screen.on("display-removed", displaysChanged);
  screen.on("display-metrics-changed", displaysChanged);
  let lastPointer: { x: number; y: number } | null = null;
  const pointerTimer = setInterval(() => {
    if (released || window.isDestroyed() || scope.signal.aborted) return;
    const cursor = screen.getCursorScreenPoint();
    if (drag) window.setBounds(bounds({ x: drag.origin.x + cursor.x - drag.cursor.x, y: drag.origin.y + cursor.y - drag.cursor.y }));
    const current = window.getBounds();
    const x = cursor.x - current.x, y = cursor.y - current.y;
    if (!lastPointer || lastPointer.x !== x || lastPointer.y !== y) { lastPointer = { x, y }; window.webContents.send("paseo:overlay:pointer", lastPointer); }
  }, 50);
  const release = () => { if (released) return; released = true; overlayChannels.delete(webContentsId); documents.delete(pathname); clearInterval(pointerTimer); ipcMain.removeHandler(channel); ipcMain.removeListener(`${channel}:interactive`, interactive); screen.removeListener("display-added", displaysChanged); screen.removeListener("display-removed", displaysChanged); screen.removeListener("display-metrics-changed", displaysChanged); if (!window.isDestroyed()) window.destroy(); };
  window.on("closed", release);
  scope.own(release);
  void window.loadURL(documentURL).then(() => { if (released || scope.signal.aborted || window.isDestroyed()) return; window.webContents.send("paseo:overlay:state", state); window.showInactive(); }).catch((error) => { release(); if (!scope.signal.aborted) void request.onAction("error", error instanceof Error ? error.message : String(error)); });
  return {
    update(input) { scope.assertCurrent(); if (released) throw new Error("Overlay lease released."); if (Object.hasOwn(input, "state")) state = input.state; dimensions = { width: input.width ?? dimensions.width, height: input.height ?? dimensions.height }; window.setBounds(bounds(Object.hasOwn(input, "position") ? input.position ?? null : window.getBounds())); window.webContents.send("paseo:overlay:state", state); },
    showMenu(items) {
      scope.assertCurrent();
      if (released || !boundDocument || window.isDestroyed()) throw new Error("Overlay document is unavailable.");
      const document = boundDocument;
      Menu.buildFromTemplate(items.map((item) => item.type === "separator" ? { type: "separator" as const } : { label: item.label ?? item.id, click: () => {
        if (!released && !scope.signal.aborted && !window.isDestroyed() && document.epoch === documentEpoch &&
            !document.frame.detached && window.webContents.mainFrame === document.frame) void request.onAction(item.id);
      } })).popup({ window });
    },
    release,
  };
}
