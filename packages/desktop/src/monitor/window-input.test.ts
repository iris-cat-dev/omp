import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modules = vi.hoisted(() => ({ require: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: () => modules.require }));

const HWND = 0x1234567890abcdefn;
const TRANSPARENT = 0x20n;
const PASSTHROUGH = TRANSPARENT | 0x80000n;
// NOACTIVATE | NOREDIRECTIONBITMAP | TOOLWINDOW | TOPMOST, without WS_EX_LAYERED.
const COMPOSITION_STYLE = 0x08200088n;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;

interface NativeWindowState {
  alive: boolean;
  ownerPid: number;
  style: bigint;
}

/** Independent OS state: setters return the OLD signed LONG_PTR, not the requested value. */
class WindowsModel {
  windows = new Map<bigint, NativeWindowState>();
  mutations: Array<{ handle: bigint; previous: bigint; next: bigint }> = [];
  lastError = 1234;
  ownerFailure = 0;
  readFailure = 0;
  writeFailure = 0;
  loadFailure: Error | undefined;

  private lookup(handle: bigint): NativeWindowState | undefined {
    const window = this.windows.get(handle);
    if (window?.alive) return window;
    this.lastError = 1400;
    return undefined;
  }

  private longPointer(value: bigint): number | bigint {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }

  private isWindow(handle: bigint): number {
    return this.windows.get(handle)?.alive ? 1 : 0;
  }

  private getOwner(handle: bigint, output: number[]): number {
    const window = this.lookup(handle);
    if (!window) return 0;
    if (this.ownerFailure) {
      this.lastError = this.ownerFailure;
      return 0; // Win32 leaves the output parameter unchanged on failure.
    }
    output[0] = window.ownerPid;
    return 712;
  }

  private getStyle(handle: bigint, index: number): number | bigint {
    const window = this.lookup(handle);
    if (!window) return 0;
    if (index !== -20 || this.readFailure) {
      this.lastError = this.readFailure || 87;
      return 0;
    }
    // Successful Win32 getters/setters need not clear the caller's last error.
    return this.longPointer(window.style);
  }

  private setStyle(handle: bigint, index: number, value: number | bigint): number | bigint {
    const window = this.lookup(handle);
    if (!window) return 0;
    if (index !== -20 || this.writeFailure) {
      this.lastError = this.writeFailure || 87;
      return 0;
    }
    const next = BigInt(value);
    if (next !== BigInt.asIntN(64, next)) throw new Error("LONG_PTR must remain signed 64-bit");
    const previous = window.style;
    window.style = next;
    this.mutations.push({ handle, previous, next });
    return this.longPointer(previous);
  }

  load(name: string) {
    if (this.loadFailure) throw this.loadFailure;
    let functions: Record<string, unknown>;
    if (name === "user32.dll") {
      functions = {
        "int __stdcall IsWindow(void *handle)": this.isWindow.bind(this),
        "uint32_t __stdcall GetWindowThreadProcessId(void *handle, _Out_ uint32_t *processId)":
          this.getOwner.bind(this),
        "intptr_t __stdcall GetWindowLongPtrW(void *handle, int index)": this.getStyle.bind(this),
        "intptr_t __stdcall SetWindowLongPtrW(void *handle, int index, intptr_t value)":
          this.setStyle.bind(this),
      };
    } else if (name === "kernel32.dll") {
      functions = {
        "uint32_t __stdcall GetLastError(void)": () => this.lastError,
        "void __stdcall SetLastError(uint32_t code)": (code: number) => {
          this.lastError = code;
        },
      };
    } else {
      throw new Error(`Unexpected native library: ${name}`);
    }
    return {
      func(definition: string) {
        const bound = functions[definition];
        if (typeof bound !== "function") throw new Error(`Unsupported native ABI: ${definition}`);
        return bound;
      },
    };
  }
}

class BrowserWindowModel {
  destroyed = false;
  sdkIgnored = false;
  nativeHandle: unknown;
  nativeHandleFailure: Error | undefined;
  sdkFailure: Error | undefined;

  constructor(handle: bigint) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(handle);
    this.nativeHandle = buffer;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getNativeWindowHandle(): unknown {
    if (this.nativeHandleFailure) throw this.nativeHandleFailure;
    return this.nativeHandle;
  }

  setIgnoreMouseEvents(ignored: boolean, options: { forward?: boolean }): void {
    if (this.sdkFailure) throw this.sdkFailure;
    if (options.forward !== true) throw new Error("SDK mouse-move forwarding was disabled");
    this.sdkIgnored = ignored;
  }
}

let os: WindowsModel;
function runtime(platform: NodeJS.Platform, arch = "x64"): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}
function owned(style = COMPOSITION_STYLE) {
  const native: NativeWindowState = { alive: true, ownerPid: process.pid, style };
  os.windows.set(HWND, native);
  const sdk = new BrowserWindowModel(HWND);
  return { native, sdk, window: sdk as unknown as BrowserWindow };
}
function inputModule() {
  // Each case resets the module-scoped native cache; static imports bypass that loading boundary.
  return import("./window-input.js");
}
async function createInput() {
  const { createMonitorWindowInput } = await inputModule();
  return createMonitorWindowInput();
}

beforeEach(() => {
  vi.resetModules();
  runtime("win32");
  os = new WindowsModel();
  modules.require.mockReset().mockImplementation((name: string) => {
    if (name !== "koffi") throw new Error(`Unexpected native module: ${name}`);
    return { load: (library: string) => os.load(library) };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  vi.restoreAllMocks();
});

describe("owned Windows monitor input", () => {
  it.each([0n, 0x80000n])(
    "pairs cross-process passthrough flags and restores the original layering (%s)",
    async (layered) => {
      const { native, sdk, window } = owned(COMPOSITION_STYLE | layered);
      const input = await createInput();
      input.setIgnored(window, true);
      expect(native.style).toBe(COMPOSITION_STYLE | PASSTHROUGH);
      expect(sdk.sdkIgnored).toBe(true);

      // A compositor/SDK style change after enabling passthrough must not be lost on disable.
      native.style |= 0x02000000n;
      input.setIgnored(window, false);
      expect(native.style).toBe(COMPOSITION_STYLE | layered | 0x02000000n);
      expect(native.style & 0x80000n).toBe(layered);
      expect(sdk.sdkIgnored).toBe(false);
    },
  );

  it.each([0x80000088n, 0x0123456789abc088n, BigInt.asIntN(64, 0xfedcba980a200088n)])(
    "retains the exact HWND and all signed LONG_PTR bits (%s)",
    async (style) => {
      const { native, window } = owned(style);
      const input = await createInput();
      input.setIgnored(window, true);
      expect(native.style).toBe(style | PASSTHROUGH);
      input.setIgnored(window, false);
      expect(native.style).toBe(style);
      expect(os.mutations).toEqual([
        { handle: HWND, previous: style, next: style | PASSTHROUGH },
        { handle: HWND, previous: style | PASSTHROUGH, next: style },
      ]);
    },
  );

  it("accepts a zero style and zero previous value despite a stale Win32 error", async () => {
    const { native, sdk, window } = owned(0n);
    const input = await createInput();
    os.lastError = 5;
    input.setIgnored(window, true);
    expect(native.style).toBe(PASSTHROUGH);
    expect(sdk.sdkIgnored).toBe(true);
    os.lastError = 1400;
    input.setIgnored(window, false);
    expect(native.style).toBe(0n);
    expect(sdk.sdkIgnored).toBe(false);
  });

  it("refuses a destroyed BrowserWindow before attempting to access its native handle", async () => {
    const { native, sdk, window } = owned();
    sdk.destroyed = true;
    sdk.nativeHandleFailure = new Error("Destroyed native handles must not be accessed");
    const input = await createInput();
    expect(() => input.setIgnored(window, true)).toThrow(/destroyed BrowserWindow/);
    expect(native.style).toBe(COMPOSITION_STYLE);
    expect(sdk.sdkIgnored).toBe(false);
    expect(os.mutations).toEqual([]);
  });

  it.each([Buffer.alloc(0), Buffer.alloc(4), Buffer.alloc(16), new Uint8Array(8), Buffer.alloc(8)])(
    "rejects a malformed or null native handle without changing OS or SDK state (%s)",
    async (handle) => {
      const { native, sdk, window } = owned();
      sdk.nativeHandle = handle;
      const input = await createInput();
      expect(() => input.setIgnored(window, true)).toThrow(/HWND/);
      expect(native.style).toBe(COMPOSITION_STYLE);
      expect(sdk.sdkIgnored).toBe(false);
      expect(os.mutations).toEqual([]);
    },
  );

  it("refuses an HWND that is no longer an OS window", async () => {
    const { native, sdk, window } = owned();
    native.alive = false;
    const input = await createInput();
    expect(() => input.setIgnored(window, true)).toThrow(/invalid HWND/);
    expect(native.style).toBe(COMPOSITION_STYLE);
    expect(sdk.sdkIgnored).toBe(false);
    expect(os.mutations).toEqual([]);
  });

  it("refuses a foreign process's live HWND before reading or mutating its style", async () => {
    const { native, sdk, window } = owned();
    native.ownerPid = process.pid + 1;
    os.readFailure = 5;
    const input = await createInput();
    expect(() => input.setIgnored(window, true)).toThrow(/outside the current process/);
    expect(native.style).toBe(COMPOSITION_STYLE);
    expect(sdk.sdkIgnored).toBe(false);
    expect(os.mutations).toEqual([]);
  });

  it("rechecks ownership even when the requested ignore state has not changed", async () => {
    const { native, sdk, window } = owned();
    const input = await createInput();
    input.setIgnored(window, true);
    native.ownerPid = process.pid + 1;
    native.style = COMPOSITION_STYLE;
    expect(() => input.setIgnored(window, true)).toThrow(/outside the current process/);
    expect(native.style).toBe(COMPOSITION_STYLE);
    expect(sdk.sdkIgnored).toBe(true);
    expect(os.mutations).toHaveLength(1);
  });

  it("does not mistake a failed ownership query's unchanged output for current ownership", async () => {
    const { native, sdk, window } = owned();
    const input = await createInput();
    input.setIgnored(window, true);
    os.ownerFailure = 1400;
    expect(() => input.setIgnored(window, false)).toThrow(
      /GetWindowThreadProcessId failed \(Win32 error 1400\)/,
    );
    expect(native.style).toBe(COMPOSITION_STYLE | PASSTHROUGH);
    expect(sdk.sdkIgnored).toBe(true);
    expect(os.mutations).toHaveLength(1);
  });

  it("does not turn a failed style read into a successful zero-style write", async () => {
    const { native, sdk, window } = owned();
    os.readFailure = 5;
    const input = await createInput();
    expect(() => input.setIgnored(window, true)).toThrow(
      /GetWindowLongPtrW failed \(Win32 error 5\)/,
    );
    expect(native.style).toBe(COMPOSITION_STYLE);
    expect(sdk.sdkIgnored).toBe(false);
    expect(os.mutations).toEqual([]);
  });

  it.each([true, false])("propagates a failed native style transition to %s", async (ignored) => {
    const original = COMPOSITION_STYLE | (ignored ? 0n : TRANSPARENT);
    const { native, sdk, window } = owned(original);
    sdk.sdkIgnored = !ignored;
    os.writeFailure = 5;
    const input = await createInput();
    expect(() => input.setIgnored(window, ignored)).toThrow(
      /SetWindowLongPtrW failed \(Win32 error 5\)/,
    );
    expect(native.style).toBe(original);
    expect(sdk.sdkIgnored).toBe(!ignored);
    expect(os.mutations).toEqual([]);
  });

  it("surfaces an SDK failure after the native transition instead of pretending both states changed", async () => {
    const { native, sdk, window } = owned();
    sdk.sdkFailure = new Error("SDK window input failed");
    const input = await createInput();
    expect(() => input.setIgnored(window, true)).toThrow(sdk.sdkFailure);
    expect(native.style).toBe(COMPOSITION_STYLE | PASSTHROUGH);
    expect(sdk.sdkIgnored).toBe(false);
  });
});

describe("native input binding lifetime", () => {
  it("does not resolve the addon at import, but fails synchronously when the Windows factory needs it", async () => {
    const unavailable = new Error("Native input binding unavailable");
    modules.require.mockImplementation(() => {
      throw unavailable;
    });
    const { createMonitorWindowInput } = await inputModule();
    expect(() => createMonitorWindowInput()).toThrow(unavailable);
  });

  it("propagates a DLL load failure synchronously from the factory", async () => {
    os.loadFailure = new Error("user32.dll could not be loaded");
    const { createMonitorWindowInput } = await inputModule();
    expect(() => createMonitorWindowInput()).toThrow(os.loadFailure);
  });

  it("retains resolved functions across factories without requiring or loading the addon again", async () => {
    const { native, sdk, window } = owned();
    const { createMonitorWindowInput } = await inputModule();
    const first = createMonitorWindowInput();
    os.loadFailure = new Error("Native DLL binding was loaded again");
    modules.require.mockImplementation(() => {
      throw new Error("Native input binding was resolved again");
    });
    const second = createMonitorWindowInput();
    first.setIgnored(window, true);
    second.setIgnored(window, false);
    expect(native.style).toBe(COMPOSITION_STYLE);
    expect(sdk.sdkIgnored).toBe(false);
    expect(os.mutations).toHaveLength(2);
  });

  it.each(["ia32", "arm64"])(
    "rejects unsupported Windows architecture %s before addon resolution",
    async (arch) => {
      runtime("win32", arch);
      modules.require.mockImplementation(() => {
        throw new Error("Unsupported architecture must not load a native addon");
      });
      const { createMonitorWindowInput } = await inputModule();
      expect(() => createMonitorWindowInput()).toThrow(/requires Windows x64/);
    },
  );

  it.each(["darwin", "linux"] as const)(
    "uses only SDK state on %s without loading native code",
    async (platform) => {
      runtime(platform, "arm64");
      modules.require.mockImplementation(() => {
        throw new Error("Non-Windows must not load a native addon");
      });
      const { native, sdk, window } = owned();
      sdk.nativeHandleFailure = new Error("Non-Windows must not request an HWND");
      const input = await createInput();
      input.setIgnored(window, true);
      expect(sdk.sdkIgnored).toBe(true);
      input.setIgnored(window, false);
      expect(sdk.sdkIgnored).toBe(false);
      expect(native.style).toBe(COMPOSITION_STYLE);
      expect(os.mutations).toEqual([]);
    },
  );
});
