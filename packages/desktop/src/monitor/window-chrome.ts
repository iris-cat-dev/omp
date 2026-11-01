import { createRequire } from "node:module";
import { release } from "node:os";
import type { BrowserWindow, Rectangle } from "electron";
import type * as Koffi from "koffi" with { "resolution-mode": "require" };

// Agent Speed v1.6.1 SettingsWindow.xaml / HistoryWindow.xaml: OUTER window DIP.
// The native caption and resize frame are not additional in-client UI.
export const MONITOR_NATIVE_PANEL_METRICS = {
  settings: { width: 900, height: 680, minWidth: 680, minHeight: 480 },
  history: { width: 920, height: 680, minWidth: 720, minHeight: 540 },
} as const;

export interface MonitorWindowChromeResult {
  available: boolean;
  highContrast: boolean | null;
  transparencyEnabled: boolean | null;
  compositionEnabled: boolean | null;
  darkCaption: "requested" | "system";
  corners: "system-default-requested" | "unavailable";
  backdrop: "main-window-requested" | "none-requested" | "unavailable";
  // mini-electron 0.1.28's framed renderer has an opaque background. A successful
  // DWM attribute request does NOT establish visible full-client Mica.
  clientMaterial: "opaque";
  hresult: { darkCaption: number | null; corners: number | null; backdrop: number | null };
}

export interface MonitorWindowMetrics {
  outerDip: Rectangle;
  clientDip: Rectangle;
  insetsDip: { left: number; top: number; right: number; bottom: number };
  native: {
    owner: "browser" | "renderer";
    processId: number;
    dpi: number;
    style: number;
    outerPixels: Rectangle;
    clientScreenPixels: Rectangle;
    visibleFramePixels: Rectangle | null;
    attributes: {
      darkMode: number | null;
      cornerPreference: number | null;
      backdropType: number | null;
    };
  } | null;
}

export interface MonitorWindowChrome {
  /** Call only for the standard framed Settings/History windows, before show and on resolved-theme changes. */
  apply(window: BrowserWindow, appearance: "light" | "dark"): MonitorWindowChromeResult;
  /** Read the exact SDK HWND, never a parent, child, class-wide search or renderer-provided handle. */
  measure(window: BrowserWindow): MonitorWindowMetrics;
}

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWA_SYSTEMBACKDROP_TYPE = 38;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMSBT_NONE = 1;
const DWMSBT_MAINWINDOW = 2;
const GWL_STYLE = -16;
const SPI_GETHIGHCONTRAST = 0x42;
const HKEY_CURRENT_USER = 0xffffffff80000001n;
const RRF_RT_REG_DWORD = 0x10;
const MONITOR_URL = "omp-desktop://monitor/local-monitor";

interface Win32Chrome {
  isWindow(handle: bigint): number;
  getWindowThreadProcessId(handle: bigint, processId: number[]): number;
  getWindowLongPtr(handle: bigint, index: number): number | bigint;
  getWindowRect(handle: bigint, rectangle: Buffer): number;
  getClientRect(handle: bigint, rectangle: Buffer): number;
  clientToScreen(handle: bigint, point: Buffer): number;
  getDpiForWindow(handle: bigint): number;
  systemParametersInfo(action: number, size: number, value: Buffer, flags: number): number;
  regGetValue(
    key: bigint,
    subkey: string,
    name: string,
    flags: number,
    type: number[],
    data: number[],
    size: number[],
  ): number;
  dwmSetWindowAttribute(handle: bigint, attribute: number, value: Buffer, size: number): number;
  dwmGetWindowAttribute(handle: bigint, attribute: number, value: Buffer, size: number): number;
  dwmIsCompositionEnabled(enabled: number[]): number;
  getLastError(): number;
  setLastError(code: number): void;
}

function loadWin32Chrome(): Win32Chrome {
  const koffi = createRequire(__filename)("koffi") as typeof Koffi;
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  // Bound Koffi function objects retain their libraries. No native hooks or callbacks.
  return {
    isWindow: user32.func("int __stdcall IsWindow(void *handle)"),
    getWindowThreadProcessId: user32.func(
      "uint32_t __stdcall GetWindowThreadProcessId(void *handle, _Out_ uint32_t *processId)",
    ),
    getWindowLongPtr: user32.func("intptr_t __stdcall GetWindowLongPtrW(void *handle, int index)"),
    getWindowRect: user32.func("int __stdcall GetWindowRect(void *handle, _Out_ void *rectangle)"),
    getClientRect: user32.func("int __stdcall GetClientRect(void *handle, _Out_ void *rectangle)"),
    clientToScreen: user32.func("int __stdcall ClientToScreen(void *handle, _Inout_ void *point)"),
    getDpiForWindow: user32.func("uint32_t __stdcall GetDpiForWindow(void *handle)"),
    systemParametersInfo: user32.func(
      "int __stdcall SystemParametersInfoW(uint32_t action, uint32_t size, _Inout_ void *value, uint32_t flags)",
    ),
    regGetValue: advapi32.func(
      "int32_t __stdcall RegGetValueW(void *key, str16 subkey, str16 name, uint32_t flags, _Out_ uint32_t *type, _Out_ uint32_t *data, _Inout_ uint32_t *size)",
    ),
    dwmSetWindowAttribute: dwmapi.func(
      "int32_t __stdcall DwmSetWindowAttribute(void *handle, uint32_t attribute, const void *value, uint32_t size)",
    ),
    dwmGetWindowAttribute: dwmapi.func(
      "int32_t __stdcall DwmGetWindowAttribute(void *handle, uint32_t attribute, _Out_ void *value, uint32_t size)",
    ),
    dwmIsCompositionEnabled: dwmapi.func(
      "int32_t __stdcall DwmIsCompositionEnabled(_Out_ int32_t *enabled)",
    ),
    getLastError: kernel32.func("uint32_t __stdcall GetLastError(void)"),
    setLastError: kernel32.func("void __stdcall SetLastError(uint32_t code)"),
  };
}

function liveContents(window: BrowserWindow) {
  if (window.isDestroyed())
    throw new Error("Monitor window chrome refuses a destroyed BrowserWindow");
  const contents = window.webContents;
  if (!contents || contents.isDestroyed())
    throw new Error("Monitor window chrome requires live bound WebContents");
  return contents;
}

function ownedHandle(window: BrowserWindow, native: Win32Chrome) {
  const contents = liveContents(window);
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length !== 8)
    throw new Error("Monitor window chrome requires an 8-byte Windows x64 SDK HWND buffer");
  const hwnd = handle.readBigUInt64LE();
  if (hwnd === 0n || !native.isWindow(hwnd))
    throw new Error("Monitor window chrome refuses an invalid HWND");
  const owner = [0];
  native.setLastError(0);
  if (!native.getWindowThreadProcessId(hwnd, owner))
    throw new Error(
      `Monitor window chrome: GetWindowThreadProcessId failed (${native.getLastError()})`,
    );
  // In the qualified 0.1.28 source this getter is the OS PID of THIS
  // WebContents' RendererProcess, not an Electron routing/process identifier.
  const rendererPid = contents.getProcessId();
  if (
    owner[0] !== process.pid &&
    !(Number.isSafeInteger(rendererPid) && rendererPid > 0 && owner[0] === rendererPid)
  )
    throw new Error(
      "Monitor window chrome refuses an HWND outside its browser or exact bound renderer process",
    );
  if (window.webContents !== contents || contents.isDestroyed() || window.isDestroyed())
    throw new Error("Monitor window chrome lost its BrowserWindow binding");
  return {
    hwnd,
    processId: owner[0]!,
    owner: owner[0] === process.pid ? ("browser" as const) : ("renderer" as const),
  };
}

function windowStyle(native: Win32Chrome, hwnd: bigint): number {
  native.setLastError(0);
  const style = BigInt(native.getWindowLongPtr(hwnd, GWL_STYLE));
  if (style === 0n && native.getLastError() !== 0)
    throw new Error("Monitor window chrome: GetWindowLongPtrW failed");
  return Number(BigInt.asUintN(32, style));
}

function rectangle(value: Buffer): Rectangle {
  const x = value.readInt32LE(0),
    y = value.readInt32LE(4);
  return { x, y, width: value.readInt32LE(8) - x, height: value.readInt32LE(12) - y };
}

function readHighContrast(native: Win32Chrome): boolean | null {
  const contrast = Buffer.alloc(16); // HIGHCONTRASTW: UINT cbSize, DWORD flags, LPWSTR (x64).
  contrast.writeUInt32LE(16);
  if (!native.systemParametersInfo(SPI_GETHIGHCONTRAST, 16, contrast, 0)) return null;
  return (contrast.readUInt32LE(4) & 1) !== 0;
}

function readTransparencyEnabled(native: Win32Chrome): boolean | null {
  const type = [0],
    data = [0],
    size = [4];
  const status = native.regGetValue(
    HKEY_CURRENT_USER,
    "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
    "EnableTransparency",
    RRF_RT_REG_DWORD,
    type,
    data,
    size,
  );
  // Missing preference uses Windows/original ThemeService's default. Other
  // read failures are unknown: never opt unknown accessibility state into effects.
  if (status === 2) return true;
  if (status === 0 && type[0] === 4 && size[0] === 4) return data[0] !== 0;
  return null;
}

function backdropRequestStatus(
  hresult: number | null,
  material: boolean,
): MonitorWindowChromeResult["backdrop"] {
  if (hresult !== 0) return "unavailable";
  return material ? "main-window-requested" : "none-requested";
}

/** Lazy, per-controller adapter; loading it performs no OS/window mutation. */
export function createMonitorWindowChrome(): MonitorWindowChrome {
  const supported = process.platform === "win32" && process.arch === "x64";
  let native: Win32Chrome | undefined;
  return {
    apply(window, appearance) {
      liveContents(window);
      if (!supported)
        return {
          available: false,
          highContrast: null,
          transparencyEnabled: null,
          compositionEnabled: null,
          darkCaption: "system",
          corners: "unavailable",
          backdrop: "unavailable",
          clientMaterial: "opaque",
          hresult: { darkCaption: null, corners: null, backdrop: null },
        };
      const win32 = (native ??= loadWin32Chrome()),
        { hwnd } = ownedHandle(window, win32);
      const style = windowStyle(win32, hwnd);
      if ((style & 0x00c80000) !== 0x00c80000 || (style & 0x40000000) !== 0)
        throw new Error(
          "Monitor window chrome requires the SDK's standard top-level caption and system menu",
        );
      const build = Number(release().split(".")[2]);
      const highContrast = readHighContrast(win32);
      const transparencyEnabled = readTransparencyEnabled(win32);
      const composed = [0];
      const compositionEnabled =
        win32.dwmIsCompositionEnabled(composed) === 0 ? composed[0] !== 0 : null;
      const value = Buffer.alloc(4);
      const set = (attribute: number, next: number) => {
        value.writeInt32LE(next);
        return win32.dwmSetWindowAttribute(hwnd, attribute, value, 4);
      };
      const dark = appearance === "dark" && highContrast === false;
      const darkResult = build >= 22000 ? set(DWMWA_USE_IMMERSIVE_DARK_MODE, dark ? 1 : 0) : null;
      // Settings/History never request Dashboard's forced ROUND preference.
      const cornerResult = build >= 22000 ? set(DWMWA_WINDOW_CORNER_PREFERENCE, 0) : null;
      const material =
        highContrast === false && transparencyEnabled === true && compositionEnabled === true;
      const backdropResult =
        build >= 22621
          ? set(DWMWA_SYSTEMBACKDROP_TYPE, material ? DWMSBT_MAINWINDOW : DWMSBT_NONE)
          : null;
      // Do not extend the frame through an opaque client or call the absent
      // setBackgroundMaterial SDK method. Native caption material is DWM's;
      // the renderer must keep its solid fallback, including on attribute failure.
      return {
        available: darkResult === 0 || cornerResult === 0 || backdropResult === 0,
        highContrast,
        transparencyEnabled,
        compositionEnabled,
        darkCaption: darkResult === 0 && dark ? "requested" : "system",
        corners: cornerResult === 0 ? "system-default-requested" : "unavailable",
        backdrop: backdropRequestStatus(backdropResult, material),
        clientMaterial: "opaque",
        hresult: { darkCaption: darkResult, corners: cornerResult, backdrop: backdropResult },
      };
    },
    measure(window) {
      liveContents(window);
      const outerDip = window.getBounds(),
        clientDip = window.getContentBounds();
      const result: MonitorWindowMetrics = {
        outerDip,
        clientDip,
        insetsDip: {
          left: clientDip.x - outerDip.x,
          top: clientDip.y - outerDip.y,
          right: outerDip.x + outerDip.width - clientDip.x - clientDip.width,
          bottom: outerDip.y + outerDip.height - clientDip.y - clientDip.height,
        },
        native: null,
      };
      if (!supported) return result;
      const win32 = (native ??= loadWin32Chrome()),
        owned = ownedHandle(window, win32),
        outer = Buffer.alloc(16),
        client = Buffer.alloc(16),
        origin = Buffer.alloc(8);
      for (const [name, ok] of [
        ["GetWindowRect", win32.getWindowRect(owned.hwnd, outer)],
        ["GetClientRect", win32.getClientRect(owned.hwnd, client)],
        ["ClientToScreen", win32.clientToScreen(owned.hwnd, origin)],
      ] as const)
        if (!ok) throw new Error(`Monitor window chrome: ${name} failed`);
      const dpi = win32.getDpiForWindow(owned.hwnd);
      if (!dpi) throw new Error("Monitor window chrome: GetDpiForWindow failed");
      const style = windowStyle(win32, owned.hwnd);
      const visible = Buffer.alloc(16),
        attribute = Buffer.alloc(4);
      const readAttribute = (id: number) =>
        win32.dwmGetWindowAttribute(owned.hwnd, id, attribute, 4) === 0
          ? attribute.readInt32LE()
          : null;
      const clientPixels = rectangle(client);
      result.native = {
        owner: owned.owner,
        processId: owned.processId,
        dpi,
        style,
        outerPixels: rectangle(outer),
        clientScreenPixels: { ...clientPixels, x: origin.readInt32LE(), y: origin.readInt32LE(4) },
        visibleFramePixels:
          win32.dwmGetWindowAttribute(owned.hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, visible, 16) === 0
            ? rectangle(visible)
            : null,
        attributes: {
          darkMode: readAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE),
          cornerPreference: readAttribute(DWMWA_WINDOW_CORNER_PREFERENCE),
          backdropType: readAttribute(DWMWA_SYSTEMBACKDROP_TYPE),
        },
      };
      return result;
    },
  };
}

// Fixed main-world source only. Never expose executeJavaScript/source/IDs via preload.
// SDK 0.1.28 awaits the returned Promise and propagates rejection/frame destruction.
const FLUSH_SETTINGS_DRAFT = String.raw`(async () => {
  const hook = Object.getOwnPropertyDescriptor(window, 'ompMonitorFlushTitleDrafts');
  if (typeof view === 'undefined' || !view || view.surface !== 'settings' ||
      typeof rendererDestroyed === 'undefined' || rendererDestroyed ||
      document.body.dataset.surface !== 'settings' || !hook ||
      hook.writable !== false || hook.configurable !== false || typeof hook.value !== 'function')
    throw new Error('Monitor settings title editor is unavailable');
  await window.ompMonitorFlushTitleDrafts();
  return 'omp-monitor-settings-title-draft-flushed';
})()`;

/** Must run OUTSIDE the controller mutate queue: flush submits real commands to that queue. */
export async function flushMonitorSettingsDraft(window: BrowserWindow): Promise<void> {
  const contents = liveContents(window),
    frame = contents.mainFrame;
  if (!frame || frame.detached || contents.getURL() !== MONITOR_URL)
    throw new Error("Monitor settings flush requires its exact local main frame");
  const result: unknown = await contents.executeJavaScript(FLUSH_SETTINGS_DRAFT);
  if (result !== "omp-monitor-settings-title-draft-flushed")
    throw new Error("Monitor settings did not acknowledge a title draft flush");
  if (
    liveContents(window) !== contents ||
    contents.mainFrame !== frame ||
    frame.detached ||
    contents.getURL() !== MONITOR_URL
  )
    throw new Error("Monitor settings main frame changed during title draft flush");
}

const RELEASE_SETTINGS_DRAFT_LOCK = String.raw`(async () => {
  const hook = Object.getOwnPropertyDescriptor(window, 'ompMonitorReleaseTitleDraftLock');
  if (typeof view === 'undefined' || !view || view.surface !== 'settings' ||
      typeof rendererDestroyed === 'undefined' || rendererDestroyed ||
      document.body.dataset.surface !== 'settings' || !hook ||
      hook.writable !== false || hook.configurable !== false || typeof hook.value !== 'function')
    throw new Error('Monitor settings title draft lock is unavailable');
  await window.ompMonitorReleaseTitleDraftLock();
  return 'omp-monitor-settings-title-draft-lock-released';
})()`;

/** Restore settings input if a later parent-owned close operation fails or is cancelled. */
export async function releaseMonitorSettingsDraftLock(window: BrowserWindow): Promise<void> {
  const contents = liveContents(window),
    frame = contents.mainFrame;
  if (!frame || frame.detached || contents.getURL() !== MONITOR_URL)
    throw new Error("Monitor settings draft release requires its exact local main frame");
  const result: unknown = await contents.executeJavaScript(RELEASE_SETTINGS_DRAFT_LOCK);
  if (result !== "omp-monitor-settings-title-draft-lock-released")
    throw new Error("Monitor settings did not acknowledge a title draft lock release");
  if (
    liveContents(window) !== contents ||
    contents.mainFrame !== frame ||
    frame.detached ||
    contents.getURL() !== MONITOR_URL
  )
    throw new Error("Monitor settings main frame changed during title draft lock release");
}
