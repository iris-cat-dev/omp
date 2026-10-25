import { createRequire } from "node:module";
import type { BrowserWindow } from "electron";
import type * as Koffi from "koffi" with { "resolution-mode": "require" };

export interface MonitorWindowInput {
  setIgnored(window: BrowserWindow, ignored: boolean): void;
}

const esmRequire = createRequire(__filename);
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20n;
const WS_EX_LAYERED = 0x80000n;
const FORWARD_MOUSE_EVENTS = { forward: true };

type LongPointer = number | bigint;
interface Win32Input {
  isWindow(handle: bigint): number;
  getWindowThreadProcessId(handle: bigint, processId: number[]): number;
  getWindowLongPtr(handle: bigint, index: number): LongPointer;
  setWindowLongPtr(handle: bigint, index: number, value: bigint): LongPointer;
  getLastError(): number;
  setLastError(code: number): void;
}
let cachedWin32Input: Win32Input | undefined;
const layeredForPassthrough = new WeakSet<BrowserWindow>();

function loadWin32Input(): Win32Input {
  if (cachedWin32Input) return cachedWin32Input;
  const koffi = esmRequire("koffi") as typeof Koffi;
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  // Koffi's cached function objects retain their DLL handles for the process lifetime.
  cachedWin32Input = {
    isWindow: user32.func("int __stdcall IsWindow(void *handle)"),
    getWindowThreadProcessId: user32.func(
      "uint32_t __stdcall GetWindowThreadProcessId(void *handle, _Out_ uint32_t *processId)",
    ),
    getWindowLongPtr: user32.func("intptr_t __stdcall GetWindowLongPtrW(void *handle, int index)"),
    setWindowLongPtr: user32.func(
      "intptr_t __stdcall SetWindowLongPtrW(void *handle, int index, intptr_t value)",
    ),
    getLastError: kernel32.func("uint32_t __stdcall GetLastError(void)"),
    setLastError: kernel32.func("void __stdcall SetLastError(uint32_t code)"),
  };
  return cachedWin32Input;
}

function assertLive(window: BrowserWindow): void {
  if (window.isDestroyed())
    throw new Error("Monitor window input refuses a destroyed BrowserWindow");
}

function win32Failure(operation: string, code: number): Error {
  return new Error(`Monitor window input: ${operation} failed (Win32 error ${code})`);
}

/** Initialize on first orb creation, before allocating its native window, never at app startup. */
export function createMonitorWindowInput(): MonitorWindowInput {
  if (process.platform !== "win32") {
    return {
      setIgnored(window, ignored) {
        assertLive(window);
        window.setIgnoreMouseEvents(ignored, FORWARD_MOUSE_EVENTS);
      },
    };
  }
  if (process.arch !== "x64") {
    throw new Error(`Monitor native window input requires Windows x64, received ${process.arch}`);
  }
  const native = loadWin32Input();
  const ownerProcessId = [0];
  return {
    setIgnored(window, ignored) {
      assertLive(window);
      const handle = window.getNativeWindowHandle();
      if (!Buffer.isBuffer(handle) || handle.length !== 8) {
        throw new Error("Monitor native window input requires an 8-byte Windows x64 HWND buffer");
      }
      // HWND is the pointer stored in this buffer, not a pointer to the buffer itself.
      const hwnd = handle.readBigUInt64LE();
      if (hwnd === 0n || !native.isWindow(hwnd)) {
        throw new Error("Monitor native window input refuses an invalid HWND");
      }
      ownerProcessId[0] = 0;
      native.setLastError(0);
      if (native.getWindowThreadProcessId(hwnd, ownerProcessId) === 0) {
        throw win32Failure("GetWindowThreadProcessId", native.getLastError());
      }
      if (ownerProcessId[0] !== process.pid) {
        throw new Error("Monitor native window input refuses an HWND outside the current process");
      }

      native.setLastError(0);
      // Koffi returns safe integers as numbers, larger signed LONG_PTR values as BigInt.
      const current = BigInt(native.getWindowLongPtr(hwnd, GWL_EXSTYLE));
      if (current === 0n) {
        const code = native.getLastError();
        if (code !== 0) throw win32Failure("GetWindowLongPtrW", code);
      }
      // Windows requires LAYERED + TRANSPARENT for cross-process passthrough.
      // DirectComposition accepts layered HWNDs; retain its NOREDIRECTIONBITMAP
      // and restore only a layering bit that this adapter added. Do not call
      // SetLayeredWindowAttributes, which would interfere with CPU alpha painting.
      const remove = WS_EX_TRANSPARENT | (layeredForPassthrough.has(window) ? WS_EX_LAYERED : 0n);
      const next = ignored ? current | WS_EX_TRANSPARENT | WS_EX_LAYERED : current & ~remove;
      if (next !== current) {
        native.setLastError(0);
        const previous = BigInt(native.setWindowLongPtr(hwnd, GWL_EXSTYLE, next));
        if (previous === 0n) {
          const code = native.getLastError();
          if (code !== 0) throw win32Failure("SetWindowLongPtrW", code);
        }
      }
      if (ignored && (current & WS_EX_LAYERED) === 0n) layeredForPassthrough.add(window);
      else if (!ignored) layeredForPassthrough.delete(window);
      // mini-electron also needs its internal event-discard/forward state updated.
      window.setIgnoreMouseEvents(ignored, FORWARD_MOUSE_EVENTS);
    },
  };
}
