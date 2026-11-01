import { runInNewContext } from "node:vm";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMonitorWindowChrome,
  flushMonitorSettingsDraft,
  releaseMonitorSettingsDraftLock,
} from "./window-chrome.js";

const modules = vi.hoisted(() => ({ require: vi.fn(), release: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: () => modules.require }));
vi.mock("node:os", () => ({ release: modules.release }));

const HWND = 0x12345678n;
const RENDERER_PID = 0x7654321;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;

class NativeModel {
  alive = true;
  ownerPid = process.pid;
  ownerFailure = false;
  style = 0x80cf0000n;
  contrast: boolean | null = false;
  transparency = 1;
  registryStatus = 0;
  composed = 1;
  compositionResult = 0;
  lastError = 0;
  failures = new Map<number, number>();
  attributes = new Map<number, number>([
    [20, 1],
    [33, 0],
    [38, 2],
  ]);
  writes: Array<{ handle: bigint; attribute: number; value: number }> = [];
  libraries: string[] = [];

  load(library: string) {
    this.libraries.push(library);
    const functions: Record<string, unknown> = {
      IsWindow: (handle: bigint) => (handle === HWND && this.alive ? 1 : 0),
      GetWindowThreadProcessId: (_handle: bigint, output: number[]) => {
        if (this.ownerFailure) {
          this.lastError = 1400;
          return 0;
        }
        output[0] = this.ownerPid;
        return 123;
      },
      GetWindowLongPtrW: (_handle: bigint, index: number) => {
        expect(index).toBe(-16);
        return this.style;
      },
      GetWindowRect: (_handle: bigint, value: Buffer) => {
        [100, 100, 1000, 780].forEach((part, index) => value.writeInt32LE(part, index * 4));
        return 1;
      },
      GetClientRect: (_handle: bigint, value: Buffer) => {
        [0, 0, 884, 641].forEach((part, index) => value.writeInt32LE(part, index * 4));
        return 1;
      },
      ClientToScreen: (_handle: bigint, value: Buffer) => {
        value.writeInt32LE(108);
        value.writeInt32LE(131, 4);
        return 1;
      },
      GetDpiForWindow: () => 96,
      SystemParametersInfoW: (action: number, size: number, value: Buffer, flags: number) => {
        expect([action, size, value.length, value.readUInt32LE(), flags]).toEqual([
          0x42, 16, 16, 16, 0,
        ]);
        if (this.contrast === null) return 0;
        value.writeUInt32LE(this.contrast ? 1 : 0, 4);
        return 1;
      },
      RegGetValueW: (
        key: bigint,
        subkey: string,
        name: string,
        flags: number,
        type: number[],
        data: number[],
        size: number[],
      ) => {
        expect([key, subkey, name, flags, size[0]]).toEqual([
          0xffffffff80000001n,
          "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
          "EnableTransparency",
          0x10,
          4,
        ]);
        if (this.registryStatus !== 0) return this.registryStatus;
        type[0] = 4;
        data[0] = this.transparency;
        size[0] = 4;
        return 0;
      },
      DwmIsCompositionEnabled: (value: number[]) => {
        value[0] = this.composed;
        return this.compositionResult;
      },
      DwmSetWindowAttribute: (handle: bigint, attribute: number, value: Buffer, size: number) => {
        expect(size).toBe(4);
        expect(value.length).toBe(4);
        const next = value.readInt32LE();
        this.writes.push({ handle, attribute, value: next });
        const status = this.failures.get(attribute) ?? 0;
        if (status === 0) this.attributes.set(attribute, next);
        return status;
      },
      DwmGetWindowAttribute: (_handle: bigint, attribute: number, value: Buffer, size: number) => {
        if (attribute === 9) {
          expect(size).toBe(16);
          [107, 100, 993, 773].forEach((part, index) => value.writeInt32LE(part, index * 4));
          return 0;
        }
        if (!this.attributes.has(attribute)) return -2147024809;
        value.writeInt32LE(this.attributes.get(attribute)!);
        return 0;
      },
      GetLastError: () => this.lastError,
      SetLastError: (value: number) => {
        this.lastError = value;
      },
    };
    return {
      func(definition: string) {
        const name = /__stdcall (\w+)\(/.exec(definition)?.[1];
        const fn = name && functions[name];
        if (typeof fn !== "function") throw new Error(`Unsupported native prototype ${definition}`);
        return fn;
      },
    };
  }
}

class WindowModel {
  destroyed = false;
  handle: unknown = Buffer.alloc(8);
  rendererPid = RENDERER_PID;
  contentsDestroyed = false;
  url = "omp-desktop://monitor/local-monitor";
  frame = { detached: false };
  contents = {
    isDestroyed: () => this.contentsDestroyed,
    getProcessId: () => this.rendererPid,
    getURL: () => this.url,
    mainFrame: this.frame,
    executeJavaScript: vi.fn().mockResolvedValue("omp-monitor-settings-title-draft-flushed"),
  };
  constructor() {
    (this.handle as Buffer).writeBigUInt64LE(HWND);
  }
  isDestroyed() {
    return this.destroyed;
  }
  get webContents() {
    return this.contents;
  }
  getNativeWindowHandle() {
    return this.handle;
  }
  getBounds() {
    return { x: 100, y: 100, width: 900, height: 680 };
  }
  getContentBounds() {
    return { x: 108, y: 131, width: 884, height: 641 };
  }
}

let os: NativeModel;
function runtime(platform: NodeJS.Platform, arch = "x64") {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}
function ownedWindow() {
  const sdk = new WindowModel();
  return { sdk, window: sdk as unknown as BrowserWindow };
}

beforeEach(() => {
  runtime("win32");
  os = new NativeModel();
  modules.release.mockReset().mockReturnValue("10.0.26200");
  modules.require.mockReset().mockImplementation((name: string) => {
    if (name !== "koffi") throw new Error(`Unexpected native module ${name}`);
    return { load: os.load.bind(os) };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  vi.restoreAllMocks();
});

describe("exact owned standard native monitor chrome", () => {
  it("lazily applies native appearance without reloading its libraries", async () => {
    const chrome = createMonitorWindowChrome();
    expect(modules.require).not.toHaveBeenCalled();
    const { window } = ownedWindow(),
      result = chrome.apply(window, "dark");
    expect(os.writes).toEqual([
      { handle: HWND, attribute: 20, value: 1 },
      { handle: HWND, attribute: 33, value: 0 },
      { handle: HWND, attribute: 38, value: 2 },
    ]);
    expect(result).toMatchObject({
      available: true,
      darkCaption: "requested",
      corners: "system-default-requested",
      backdrop: "main-window-requested",
      clientMaterial: "opaque",
    });
    chrome.apply(window, "light");
    expect(modules.require).toHaveBeenCalledTimes(1);
    expect(os.writes[3]).toEqual({ handle: HWND, attribute: 20, value: 0 });
  });

  it("accepts only the browser PID or this exact WebContents' OS renderer PID", async () => {
    const { window, sdk } = ownedWindow(),
      chrome = createMonitorWindowChrome();
    os.ownerPid = RENDERER_PID;
    expect(chrome.apply(window, "dark").available).toBe(true);
    os.writes.length = 0;
    sdk.rendererPid = 0;
    expect(() => chrome.apply(window, "dark")).toThrow(/exact bound renderer/);
    expect(os.writes).toHaveLength(0);
    sdk.rendererPid = RENDERER_PID;
    os.ownerPid = RENDERER_PID + 1;
    expect(() => chrome.apply(window, "dark")).toThrow(/exact bound renderer/);
    expect(os.writes).toHaveLength(0);
  });

  it("refuses invalid, destroyed, foreign and frameless HWNDs before DWM mutation", async () => {
    const { window, sdk } = ownedWindow(),
      chrome = createMonitorWindowChrome();
    sdk.handle = Buffer.alloc(4);
    expect(() => chrome.apply(window, "dark")).toThrow(/8-byte/);
    sdk.handle = Buffer.alloc(8);
    expect(() => chrome.apply(window, "dark")).toThrow(/invalid HWND/);
    (sdk.handle as Buffer).writeBigUInt64LE(HWND);
    os.alive = false;
    expect(() => chrome.apply(window, "dark")).toThrow(/invalid HWND/);
    os.alive = true;
    os.ownerFailure = true;
    expect(() => chrome.apply(window, "dark")).toThrow(/GetWindowThreadProcessId/);
    os.ownerFailure = false;
    sdk.contentsDestroyed = true;
    expect(() => chrome.apply(window, "dark")).toThrow(/live bound/);
    sdk.contentsDestroyed = false;
    sdk.destroyed = true;
    expect(() => chrome.apply(window, "dark")).toThrow(/destroyed/);
    sdk.destroyed = false;
    os.style &= ~0x80000n;
    expect(() => chrome.apply(window, "dark")).toThrow(/standard top-level/);
    os.style = 0x40cf0000n;
    expect(() => chrome.apply(window, "dark")).toThrow(/standard top-level/);
    expect(os.writes).toHaveLength(0);
  });

  it.each([
    "contrast",
    "contrast-unknown",
    "transparency-off",
    "transparency-unknown",
    "composition-off",
  ])("keeps effects off for %s without claiming client Mica", async (condition) => {
    if (condition === "contrast") os.contrast = true;
    if (condition === "contrast-unknown") os.contrast = null;
    if (condition === "transparency-off") os.transparency = 0;
    if (condition === "transparency-unknown") os.registryStatus = 5;
    if (condition === "composition-off") os.composed = 0;
    const { window } = ownedWindow(),
      result = createMonitorWindowChrome().apply(window, "dark");
    expect(result.backdrop).toBe("none-requested");
    expect(result.clientMaterial).toBe("opaque");
    expect(os.writes.at(-1)).toEqual({ handle: HWND, attribute: 38, value: 1 });
    if (condition.startsWith("contrast")) expect(os.writes[0]?.value).toBe(0);
  });

  it("reports unavailable OS attributes and native errors without inventing an effect", async () => {
    const { window } = ownedWindow(),
      chrome = createMonitorWindowChrome();
    modules.release.mockReturnValue("10.0.19045");
    expect(chrome.apply(window, "dark")).toMatchObject({
      available: false,
      backdrop: "unavailable",
      clientMaterial: "opaque",
    });
    expect(os.writes).toHaveLength(0);
    modules.release.mockReturnValue("10.0.22000");
    expect(chrome.apply(window, "dark").hresult.backdrop).toBeNull();
    expect(os.writes.map((write) => write.attribute)).toEqual([20, 33]);
    modules.release.mockReturnValue("10.0.26200");
    os.failures.set(38, -2147024809);
    expect(chrome.apply(window, "dark")).toMatchObject({
      backdrop: "unavailable",
      hresult: { backdrop: -2147024809 },
      clientMaterial: "opaque",
    });
  });

  it.each([
    ["darwin", "x64"],
    ["win32", "arm64"],
  ] as const)("preserves native platform fallback on %s/%s", async (platform, arch) => {
    runtime(platform, arch);
    const { window } = ownedWindow(),
      chrome = createMonitorWindowChrome();
    expect(chrome.apply(window, "dark").available).toBe(false);
    expect(chrome.measure(window).native).toBeNull();
    expect(modules.require).not.toHaveBeenCalled();
  });

  it("measures true outer/client/nonclient extents rather than a PNG capture canvas", async () => {
    const { window } = ownedWindow(),
      metrics = createMonitorWindowChrome().measure(window);
    expect(metrics.outerDip).toMatchObject({ width: 900, height: 680 });
    expect(metrics.clientDip).toMatchObject({ width: 884, height: 641 });
    expect(metrics.insetsDip).toEqual({ left: 8, top: 31, right: 8, bottom: 8 });
    expect(metrics.native).toMatchObject({
      owner: "browser",
      processId: process.pid,
      dpi: 96,
      style: 0x80cf0000,
      outerPixels: { x: 100, y: 100, width: 900, height: 680 },
      clientScreenPixels: { x: 108, y: 131, width: 884, height: 641 },
      visibleFramePixels: { x: 107, y: 100, width: 886, height: 673 },
      attributes: { darkMode: 1, cornerPreference: 0, backdropType: 2 },
    });
    expect(os.writes).toHaveLength(0);
  });
});

describe("fixed main-world settings title flush boundary", () => {
  it("awaits a real acknowledged Promise, never a queue-idle or optimistic completion", async () => {
    const { window, sdk } = ownedWindow();
    let settle!: (value: string) => void;
    sdk.contents.executeJavaScript.mockReturnValue(
      new Promise<string>((resolve) => {
        settle = resolve;
      }),
    );
    let completed = false;
    const flush = flushMonitorSettingsDraft(window).then(() => {
      completed = true;
      return completed;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(sdk.contents.executeJavaScript).toHaveBeenCalledTimes(1);
    settle("omp-monitor-settings-title-draft-flushed");
    await flush;
    expect(completed).toBe(true);
  });

  it("propagates storage failure and rejects missing acknowledgements or changed frames", async () => {
    const { window, sdk } = ownedWindow();
    const storage = new Error("Title editor has an uncommitted field");
    sdk.contents.executeJavaScript.mockRejectedValueOnce(storage);
    await expect(flushMonitorSettingsDraft(window)).rejects.toBe(storage);
    sdk.contents.executeJavaScript.mockResolvedValueOnce(undefined);
    await expect(flushMonitorSettingsDraft(window)).rejects.toThrow(/acknowledge/);
    sdk.contents.executeJavaScript.mockImplementationOnce(async () => {
      sdk.contents.mainFrame = { detached: false };
      return "omp-monitor-settings-title-draft-flushed";
    });
    await expect(flushMonitorSettingsDraft(window)).rejects.toThrow(/main frame changed/);
    sdk.url = "https://example.invalid/";
    sdk.contents.executeJavaScript.mockClear();
    await expect(flushMonitorSettingsDraft(window)).rejects.toThrow(/exact local main frame/);
    expect(sdk.contents.executeJavaScript).not.toHaveBeenCalled();
    expect(modules.require).not.toHaveBeenCalled();
  });

  it("executes only the immutable flush hook and awaits its actual Promise", async () => {
    const { window, sdk } = ownedWindow(),
      mainWorld = {};
    let settle!: () => void;
    const hook = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    Object.defineProperty(mainWorld, "ompMonitorFlushTitleDrafts", {
      value: hook,
      writable: false,
      configurable: false,
    });
    sdk.contents.executeJavaScript.mockImplementation((code: string) =>
      runInNewContext(code, {
        window: mainWorld,
        view: { surface: "settings" },
        rendererDestroyed: false,
        document: { body: { dataset: { surface: "settings" } } },
      }),
    );
    let completed = false;
    const flush = flushMonitorSettingsDraft(window).then(() => {
      completed = true;
      return completed;
    });
    await Promise.resolve();
    expect(hook).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    settle();
    await flush;
    expect(completed).toBe(true);
  });

  it("refuses a mutable or missing main-world flush hook without invoking it", async () => {
    const { window, sdk } = ownedWindow(),
      hook = vi.fn();
    const mainWorld: { ompMonitorFlushTitleDrafts?: () => void } = {
      ompMonitorFlushTitleDrafts: hook,
    };
    sdk.contents.executeJavaScript.mockImplementation((code: string) =>
      runInNewContext(code, {
        window: mainWorld,
        view: { surface: "settings" },
        rendererDestroyed: false,
        document: { body: { dataset: { surface: "settings" } } },
      }),
    );
    await expect(flushMonitorSettingsDraft(window)).rejects.toThrow(/title editor is unavailable/);
    delete mainWorld.ompMonitorFlushTitleDrafts;
    await expect(flushMonitorSettingsDraft(window)).rejects.toThrow(/title editor is unavailable/);
    expect(hook).not.toHaveBeenCalled();
  });

  it("releases a successful-close lock only through its immutable acknowledged hook", async () => {
    const { window, sdk } = ownedWindow(),
      mainWorld = {};
    let locked = true,
      settle!: () => void;
    const hook = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = () => {
            locked = false;
            resolve();
          };
        }),
    );
    Object.defineProperty(mainWorld, "ompMonitorReleaseTitleDraftLock", {
      value: hook,
      writable: false,
      configurable: false,
    });
    sdk.contents.executeJavaScript.mockImplementation((code: string) =>
      runInNewContext(code, {
        window: mainWorld,
        view: { surface: "settings" },
        rendererDestroyed: false,
        document: { body: { dataset: { surface: "settings" } } },
      }),
    );
    const release = releaseMonitorSettingsDraftLock(window);
    await Promise.resolve();
    expect(locked).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
    settle();
    await release;
    expect(locked).toBe(false);
    const failure = new Error("Release interrupted");
    sdk.contents.executeJavaScript.mockRejectedValueOnce(failure);
    await expect(releaseMonitorSettingsDraftLock(window)).rejects.toBe(failure);
    sdk.contents.executeJavaScript.mockResolvedValueOnce(undefined);
    await expect(releaseMonitorSettingsDraftLock(window)).rejects.toThrow(/acknowledge/);
    sdk.contents.executeJavaScript.mockImplementationOnce(async () => {
      sdk.contents.mainFrame = { detached: false };
      return "omp-monitor-settings-title-draft-lock-released";
    });
    await expect(releaseMonitorSettingsDraftLock(window)).rejects.toThrow(/main frame changed/);
    sdk.url = "https://example.invalid/";
    sdk.contents.executeJavaScript.mockClear();
    await expect(releaseMonitorSettingsDraftLock(window)).rejects.toThrow(/exact local main frame/);
    expect(sdk.contents.executeJavaScript).not.toHaveBeenCalled();
  });
});
