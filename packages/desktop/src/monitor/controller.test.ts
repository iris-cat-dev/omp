import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { OmpMonitorController } from "./controller.js";
import type { OmpMonitorScope, OmpMonitorSnapshot } from "./types.js";
import type { OmpMonitorSurface, OmpMonitorViewState } from "./view-types.js";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
type MockWindow = EventEmitter & {
  options: Record<string, unknown>;
  bounds: Bounds;
  visible: boolean;
  minimized: boolean;
  destroyed: boolean;
  ignored: boolean;
  pinned: boolean;
  webContents: EventEmitter & {
    id: number;
    mainFrame: object;
    send: Mock;
    setWindowOpenHandler: Mock;
  };
  destroy: () => void;
  close: () => void;
  hide: () => void;
  getBounds: () => Bounds;
  setBounds: (value: Bounds) => void;
  setIgnoreMouseEvents: (value: boolean) => void;
};
type MockWorker = EventEmitter & { postMessage: Mock; terminate: Mock };
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => unknown>(),
  listeners: new Map<string, (event: unknown, value?: unknown) => unknown>(),
  windows: [] as MockWindow[],
  workers: [] as MockWorker[],
  area: { x: 0, y: 0, width: 1920, height: 1040 },
  cursor: { x: 0, y: 0 },
  userData: "",
  now: Date.UTC(2026, 9, 24, 12),
  save: vi.fn(),
  menu: [] as Array<Record<string, unknown>>,
  inputError: null as "startup" | "set" | null,
}));
vi.mock("../window/main-windows.js", () => ({
  isMainWindowSender: (sender: { main?: boolean }) => sender.main === true,
}));
vi.mock("./window-input.js", () => ({
  createMonitorWindowInput() {
    if (mock.inputError === "startup") throw new Error("Native binding unavailable");
    return {
      setIgnored(window: Pick<MockWindow, "setIgnoreMouseEvents">, ignored: boolean) {
        if (mock.inputError === "set") throw new Error("Native input update failed");
        window.setIgnoreMouseEvents(ignored);
      },
    };
  },
}));
vi.mock("node:worker_threads", async () => {
  // Hoisted vi.mock factories run before static imports initialize; load the emitter inside this module-loading boundary.
  const { EventEmitter: Emitter } = await import("node:events");
  class Worker extends Emitter {
    postMessage = vi.fn();
    terminate = vi.fn().mockResolvedValue(0);
    constructor() {
      super();
      mock.workers.push(this);
    }
  }
  return { Worker };
});
vi.mock("electron", async () => {
  // Hoisted vi.mock factories run before static imports initialize; load the emitter inside this module-loading boundary.
  const { EventEmitter: Emitter } = await import("node:events");
  class Window extends Emitter {
    destroyed = false;
    visible = false;
    minimized = false;
    ignored = true;
    pinned: boolean;
    bounds: Bounds;
    webContents = Object.assign(new Emitter(), {
      id: mock.windows.length + 1,
      mainFrame: {},
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => this.destroyed,
    });
    constructor(public options: Record<string, unknown>) {
      super();
      this.pinned = options.alwaysOnTop === true;
      this.bounds = {
        x: Number(options.x),
        y: Number(options.y),
        width: Number(options.width),
        height: Number(options.height),
      };
      mock.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return this.minimized;
    }
    show() {
      this.visible = true;
      this.emit("show");
    }
    showInactive() {
      this.show();
    }
    hide() {
      this.visible = false;
      this.emit("hide");
    }
    focus = vi.fn();
    restore() {
      this.minimized = false;
      this.emit("restore");
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
    close() {
      this.destroy();
    }
    async loadURL() {}
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(value: Bounds) {
      this.bounds = { ...value };
    }
    setAlwaysOnTop(value: boolean) {
      this.pinned = value;
    }
    setIgnoreMouseEvents(value: boolean) {
      this.ignored = value;
    }
  }
  return {
    app: { getLocale: () => "zh-CN", getPath: () => mock.userData },
    BrowserWindow: Window,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, value?: unknown) => unknown) =>
        mock.handlers.set(channel, handler),
      removeHandler: (channel: string) => mock.handlers.delete(channel),
      on: (channel: string, listener: (event: unknown, value?: unknown) => unknown) =>
        mock.listeners.set(channel, listener),
      removeListener: (channel: string) => mock.listeners.delete(channel),
    },
    dialog: { showSaveDialog: mock.save },
    Menu: {
      buildFromTemplate: (template: Array<Record<string, unknown>>) => {
        mock.menu = template;
        return { popup() {} };
      },
    },
    screen: Object.assign(new Emitter(), {
      getPrimaryDisplay: () => ({ id: "primary", workArea: mock.area }),
      getAllDisplays: () => [{ id: "primary", workArea: mock.area }],
      getCursorScreenPoint: () => ({ ...mock.cursor }),
    }),
  };
});
const controllers: OmpMonitorController[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  mock.handlers.clear();
  mock.listeners.clear();
  mock.windows.length = 0;
  mock.workers.length = 0;
  mock.area = { x: 0, y: 0, width: 1920, height: 1040 };
  mock.cursor = { x: 0, y: 0 };
  mock.now = Date.UTC(2026, 9, 24, 12);
  mock.userData = await mkdtemp(path.join(tmpdir(), "omp-monitor-controller-"));
  mock.save.mockReset().mockResolvedValue({ canceled: true });
  mock.menu = [];
  mock.inputError = null;
  vi.spyOn(Date, "now").mockImplementation(() => mock.now);
});
afterEach(async () => {
  for (const instance of controllers) await instance.dispose();
  controllers.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(mock.userData, { recursive: true, force: true });
});
function controller(): OmpMonitorController {
  const instance = new OmpMonitorController({
    roots: [{ path: "C:/isolated-fixture", label: "fixture" }],
  });
  controllers.push(instance);
  instance.initialize();
  return instance;
}
function invoke(
  channel: string,
  window: MockWindow,
  value?: unknown,
  frame = window.webContents.mainFrame,
): unknown {
  const handler = mock.handlers.get("paseo:monitor:" + channel);
  if (!handler) throw new Error("Missing test handler");
  return handler({ sender: window.webContents, senderFrame: frame }, value);
}
function state(window: MockWindow): OmpMonitorViewState {
  return invoke("ready", window) as OmpMonitorViewState;
}
function surfaces(surface: OmpMonitorSurface): MockWindow[] {
  return mock.windows.filter((window) => !window.destroyed && state(window).surface === surface);
}
function snapshot(scope: OmpMonitorScope = { profile: null, project: null }): OmpMonitorSnapshot {
  const usage = {
    requests: 1,
    failedRequests: 0,
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    totalTokens: 150,
    costUsd: 0.01,
    unpricedRequests: 0,
    estimatedCostUsd: 0.02,
    unestimatedRequests: 0,
    measuredOutputTokens: 40,
    measuredDurationMs: 1000,
    peakOutputTps: 40,
  };
  const feed = {
    status: "bundled" as const,
    version: "fixture",
    updatedAt: null,
    fetchedAt: null,
    lastAttemptAt: null,
    source: "fixture",
  };
  return {
    updatedAt: mock.now,
    scope,
    scopes: { profiles: ["default", "second"], projects: ["A", "B"] },
    resources: {
      status: "unavailable",
      sampledAt: 0,
      processCount: 0,
      cpuPercent: null,
      workingSetBytes: null,
      privateBytes: null,
      reason: "no_processes",
    },
    pricing: {
      networkEnabled: false,
      currency: "USD",
      currencies: ["USD", "CNY"],
      prices: feed,
      rates: feed,
      exchangeRate: 1,
      attribution: null,
    },
    status: "ready",
    rate: { measuredTps: 40, estimatedTps: 0, estimatedShare: 0 },
    activity: { lastResponseAt: null, peakAt: null, peakObservedAt: null },
    today: usage,
    days: [{ ...usage, date: "2026-10-24" }],
    agents: [],
    series: [],
    coverage: {
      roots: [{ label: "fixture", available: true }],
      discoveredFiles: 1,
      readFiles: 1,
      skippedFiles: 0,
      malformedLines: 0,
      limited: false,
      issues: [],
    },
  };
}
function publish(window: MockWindow, value = snapshot(), worker = mock.workers.at(-1)!): void {
  worker.emit("message", {
    type: "snapshots",
    snapshots: [{ scopeId: state(window).instanceId, snapshot: value }],
  });
}
function interact(window: MockWindow, value: boolean, frame = window.webContents.mainFrame): void {
  mock.listeners.get("paseo:monitor:interactive")!(
    { sender: window.webContents, senderFrame: frame },
    value,
  );
}

describe("original-design native OMP monitor", () => {
  it("does not create a leaking window when the native input binding cannot initialize", async () => {
    const instance = controller();
    mock.inputError = "startup";
    await expect(instance.open()).rejects.toThrow();
    expect(mock.windows).toEqual([]);
    mock.inputError = null;
    await instance.open();
    expect(surfaces("orb")[0]?.visible).toBe(true);
  });

  it("closes only the failing native orb without throwing from interactivity events", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    const dashboard = surfaces("dashboard")[0]!;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("surface", second, "dashboard");
    mock.inputError = "set";
    expect(() => interact(first, true)).not.toThrow();
    expect(first.destroyed).toBe(true);
    expect(surfaces("orb")).toEqual([second]);
    expect(dashboard.destroyed).toBe(false);
    mock.inputError = null;
    interact(second, true);
    expect(second.ignored).toBe(false);
  });

  it("authorizes exact owned frames, including pointer control, and keeps panels independent of orb lifetime", async () => {
    const instance = controller(),
      opening = mock.handlers.get("paseo:monitor:open")!;
    const mainFrame = {};
    expect(() => opening({ sender: { main: false, mainFrame }, senderFrame: mainFrame })).toThrow();
    expect(() => opening({ sender: { main: true, mainFrame }, senderFrame: {} })).toThrow();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    expect(state(dashboard).instanceId).toBe(state(orb).instanceId);
    expect(() => invoke("refresh", orb, undefined, {})).toThrow();
    interact(orb, true, {});
    expect(orb.ignored).toBe(true);
    interact(orb, true);
    expect(orb.ignored).toBe(false);
    dashboard.close();
    expect(orb.destroyed).toBe(false);
    expect(state(orb).windowCount).toBe(1);
    await instance.dispose();
    expect(mock.handlers.size).toBe(0);
    expect(mock.listeners.size).toBe(0);
  });

  it("caps actual orbs at eight without counting the shared dashboard, history or settings panels", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    for (let index = 1; index < 8; index++) await invoke("new-window", first);
    await invoke("surface", first, "history");
    await invoke("surface", first, "settings");
    await expect(invoke("new-window", first)).rejects.toThrow("limit");
    expect(surfaces("orb")).toHaveLength(8);
    expect(surfaces("dashboard")).toHaveLength(1);
    expect(surfaces("history")).toHaveLength(1);
    expect(surfaces("settings")).toHaveLength(1);
    expect(state(first).windowCount).toBe(8);
    expect(mock.workers).toHaveLength(1);
  });

  it("shares a scope between an orb and its panels, retargets the singleton panel and rejects stale or arbitrary scopes", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    publish(second);
    await expect(
      invoke("scope", first, { profile: null, project: "C:/private/session.jsonl" }),
    ).rejects.toThrow();
    await invoke("scope", first, { profile: "second", project: "A" });
    publish(first);
    expect(state(first).snapshot).toBeNull();
    const scoped = snapshot({ profile: "second", project: "A" });
    publish(first, scoped);
    expect(state(first).snapshot?.scope).toEqual(scoped.scope);
    const dashboard = surfaces("dashboard")[0]!;
    expect(state(dashboard).snapshot?.scope).toEqual(scoped.scope);
    await invoke("surface", second, "dashboard");
    expect(surfaces("dashboard")).toHaveLength(1);
    expect(state(dashboard).instanceId).toBe(state(second).instanceId);
    expect(state(second).scope).toEqual({ profile: null, project: null });
  });

  it("persists genuine per-orb preferences and native positions while global appearance is shared", async () => {
    const firstController = controller();
    await firstController.open();
    const first = surfaces("orb")[0]!;
    await invoke("configure", first, {
      style: "minimal",
      size: 72,
      titleTheme: "cultivation",
      clickThrough: true,
      appearance: "light",
      opacity: 0.65,
    });
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("configure", second, { style: "needle", size: 196, pinned: false });
    const firstId = state(first).instanceId,
      secondId = state(second).instanceId;
    const firstBounds = first.getBounds();
    await invoke("close-all", first);
    await firstController.dispose();
    const nextController = controller();
    await nextController.open();
    const restored = surfaces("orb").find((window) => state(window).instanceId === firstId)!;
    const other = surfaces("orb").find((window) => state(window).instanceId === secondId)!;
    expect(state(restored).preferences).toMatchObject({
      style: "minimal",
      size: 72,
      titleTheme: "cultivation",
      clickThrough: true,
      appearance: "light",
      opacity: 0.65,
    });
    expect(restored.getBounds()).toEqual(firstBounds);
    expect(state(other).preferences).toMatchObject({
      style: "needle",
      size: 196,
      pinned: false,
      appearance: "light",
    });
    expect(restored.ignored).toBe(true);
    expect(other.pinned).toBe(false);
  });

  it("applies a valid sibling snapshot when another scope changed during the same poll", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    publish(first);
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    publish(second);
    await invoke("scope", first, { profile: null, project: "A" });
    const next = snapshot();
    next.today.requests = 7;
    mock.workers.at(-1)!.emit("message", {
      type: "snapshots",
      snapshots: [
        { scopeId: state(first).instanceId, snapshot: snapshot() },
        { scopeId: state(second).instanceId, snapshot: next },
      ],
    });
    expect(state(first).scope.project).toBe("A");
    expect(state(first).snapshot).toBeNull();
    expect(state(first).refreshing).toBe(true);
    expect(state(second).snapshot?.today.requests).toBe(7);
    expect(state(second).refreshing).toBe(false);
  });

  it("keeps click-through recoverable from the dashboard and a hidden orb can be restored without recreation", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    interact(orb, true);
    await invoke("configure", dashboard, { clickThrough: true });
    interact(orb, true);
    expect(orb.ignored).toBe(true);
    await invoke("configure", dashboard, { clickThrough: false });
    interact(orb, true);
    expect(orb.ignored).toBe(false);
    await invoke("orb-visible", dashboard, false);
    expect(orb.visible).toBe(false);
    expect(state(dashboard).orbVisible).toBe(false);
    await invoke("orb-visible", dashboard, true);
    expect(orb.visible).toBe(true);
    expect(surfaces("orb")).toHaveLength(1);
  });

  it("does not accept invalid preference payloads or allow panel frames to move the native orb", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!,
      dashboard = surfaces("dashboard")[0]!;
    for (const value of [
      { size: Infinity },
      { opacity: 0 },
      { effects: "unsafe" },
      { arbitraryCommand: "exec" },
      null,
    ])
      await expect(invoke("configure", orb, value)).rejects.toThrow();
    expect(() => invoke("drag-start", dashboard)).toThrow();
    await invoke("configure", orb, { style: "minimal", size: 72 });
    await invoke("configure", orb, { style: "needle" });
    expect(state(orb).preferences.size).toBe(96);
  });

  it("moves from native cursor deltas, snaps the visible disc to the screen edge and saves the released position", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    mock.cursor = { x: 500, y: 300 };
    invoke("drag-start", orb);
    const before = orb.getBounds();
    mock.cursor = { x: 500 - before.x - 30, y: 320 };
    vi.advanceTimersByTime(50);
    await invoke("drag-end", orb);
    const after = orb.getBounds();
    expect(after.x + state(orb).preferences.size * 0.25).toBe(12);
    expect(after.y).toBe(before.y + 20);
    const saved = JSON.parse(
      await readFile(path.join(mock.userData, "local-monitor", "windows.json"), "utf8"),
    );
    expect(Object.values(saved.orbs[0].positions)).toContainEqual({ x: after.x, y: after.y });
  });

  it("emits live completion and measured peak sequences using completion provenance, never initial history or estimates", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const initial = snapshot();
    initial.activity = {
      lastResponseAt: mock.now - 10,
      peakAt: mock.now - 60_000,
      peakObservedAt: mock.now - 10,
    };
    publish(orb, initial);
    expect(state(orb).activity).toMatchObject({ responseSequence: 0, peakSequence: 0 });
    mock.now += 2000;
    const fresh = snapshot();
    fresh.today.peakOutputTps = 80;
    fresh.activity = {
      lastResponseAt: mock.now - 5,
      peakAt: mock.now - 30_000,
      peakObservedAt: mock.now - 5,
    };
    publish(orb, fresh);
    expect(state(orb).activity).toMatchObject({
      responseSequence: 1,
      peakSequence: 1,
      lastPeakAt: fresh.activity.peakObservedAt,
    });
    mock.now += 1000;
    const estimated = {
      ...fresh,
      updatedAt: mock.now,
      rate: { measuredTps: 0, estimatedTps: 50_000, estimatedShare: 1 },
    };
    publish(orb, estimated);
    expect(state(orb).activity).toMatchObject({ responseSequence: 1, peakSequence: 1 });
    const old = snapshot();
    old.today.peakOutputTps = 5000;
    old.activity = {
      lastResponseAt: mock.now - 50_000,
      peakAt: mock.now - 100_000,
      peakObservedAt: mock.now - 50_000,
    };
    publish(orb, old);
    expect(state(orb).activity.peakSequence).toBe(1);
  });

  it("keeps partial scans live without replaying a fresh completion when history fills a higher peak", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const initial = snapshot();
    initial.status = "partial";
    initial.coverage.issues = ["scan_pending"];
    publish(orb, initial);
    expect(state(orb).refreshing).toBe(false);
    mock.now += 2000;
    const fresh = snapshot();
    fresh.status = "partial";
    fresh.today.peakOutputTps = 80;
    fresh.activity = {
      lastResponseAt: mock.now - 5,
      peakAt: mock.now - 3000,
      peakObservedAt: mock.now - 5,
    };
    publish(orb, fresh);
    expect(state(orb).activity).toMatchObject({ responseSequence: 1, peakSequence: 1 });
    mock.now += 100;
    const backfilled = {
      ...fresh,
      updatedAt: mock.now,
      today: { ...fresh.today, peakOutputTps: 120 },
    };
    publish(orb, backfilled);
    expect(state(orb).activity).toMatchObject({ responseSequence: 1, peakSequence: 1 });
    publish(orb, {
      ...backfilled,
      activity: { ...fresh.activity, peakObservedAt: mock.now - 60_000 },
    });
    publish(orb, { ...backfilled, today: { ...backfilled.today, peakOutputTps: 140 } });
    expect(state(orb).activity).toMatchObject({
      responseSequence: 1,
      peakSequence: 1,
      lastPeakAt: fresh.activity.peakObservedAt,
    });
    mock.now += 100;
    const next = snapshot();
    next.status = "partial";
    next.today.peakOutputTps = 200;
    next.activity = {
      lastResponseAt: mock.now - 5,
      peakAt: mock.now - 3000,
      peakObservedAt: mock.now - 5,
    };
    publish(orb, next);
    expect(state(orb).activity).toMatchObject({ responseSequence: 2, peakSequence: 2 });
  });

  it("suppresses peaks after a scope change and recovers a failed worker without accepting its late messages", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    publish(orb);
    await invoke("scope", orb, { profile: null, project: "A" });
    publish(orb, snapshot({ profile: null, project: "A" }));
    mock.now += 2000;
    const fresh = snapshot({ profile: null, project: "A" });
    fresh.today.peakOutputTps = 200;
    fresh.activity = { lastResponseAt: mock.now, peakAt: mock.now, peakObservedAt: mock.now };
    publish(orb, fresh);
    expect(state(orb).activity.peakSequence).toBe(0);
    const oldWorker = mock.workers[0]!;
    oldWorker.emit("error", new Error("private path must not escape"));
    expect(state(orb).workerError).toBe(true);
    await invoke("refresh", orb);
    oldWorker.emit("message", {
      type: "snapshots",
      snapshots: [
        {
          scopeId: state(orb).instanceId,
          snapshot: { ...fresh, today: { ...fresh.today, requests: 999 } },
        },
      ],
    });
    expect(state(orb).snapshot?.today.requests).toBe(1);
    publish(orb, fresh);
    expect(state(orb).workerError).toBe(false);
    expect(JSON.stringify(state(orb))).not.toContain("private path");
  });

  it.each(["unavailable", "error", "scanning"] as const)(
    "refuses an unknown %s report rather than exporting fabricated zero usage",
    async (status) => {
      const instance = controller();
      await instance.open();
      const orb = surfaces("orb")[0]!;
      const data = snapshot();
      data.status = status;
      data.coverage.readFiles = 0;
      publish(orb, data);
      expect(await invoke("export-csv", orb)).toBe("unavailable");
    },
  );

  it("rejects out-of-scope history dates and exports exactly the selected available dates", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const data = snapshot();
    data.days.unshift({ ...data.today, date: "2026-10-23", requests: 7 });
    publish(orb, data);
    await expect(
      invoke("export-csv", orb, { startDate: "2000-01-01", endDate: "2026-10-24" }),
    ).rejects.toThrow();
    const destination = path.join(mock.userData, "selected.csv");
    mock.save.mockResolvedValue({ canceled: false, filePath: destination });
    expect(
      await invoke("export-csv", orb, { startDate: "2026-10-23", endDate: "2026-10-23" }),
    ).toBe("saved");
    const csv = await readFile(destination, "utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"daily"');
    expect(csv).toContain('"2026-10-23"');
    expect(csv).not.toContain('"today"');
    expect(csv).not.toContain('"resources"');
  });

  it("recovers a hidden click-through secondary orb through the original settings selector", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    await invoke("new-window", first);
    const second = surfaces("orb")[1]!;
    await invoke("configure", second, { clickThrough: true });
    await invoke("orb-visible", second, false);
    await invoke("surface", first, "settings");
    const settings = surfaces("settings")[0]!;
    expect(() => invoke("select-orb", first, state(second).instanceId)).toThrow();
    expect(() => invoke("select-orb", settings, "unknown-id")).toThrow();
    invoke("select-orb", settings, state(second).instanceId);
    expect(state(settings).instanceId).toBe(state(second).instanceId);
    expect(
      state(settings).orbs.find((orb) => orb.instanceId === state(second).instanceId),
    ).toMatchObject({ visible: false, clickThrough: true });
    await invoke("configure", settings, { clickThrough: false });
    await invoke("orb-visible", settings, true);
    interact(second, true);
    expect(second.visible).toBe(true);
    expect(second.ignored).toBe(false);
    expect(state(first).preferences.clickThrough).toBe(false);
  });

  it.each(["renderer loss", "unresponsive", "hidden", "click-through"])(
    "cancels native cursor tracking on %s and never traps input",
    async (reason) => {
      const instance = controller();
      await instance.open();
      const orb = surfaces("orb")[0]!,
        dashboard = surfaces("dashboard")[0]!;
      mock.cursor = { x: 500, y: 300 };
      invoke("drag-start", orb);
      if (reason === "renderer loss") orb.webContents.emit("render-process-gone");
      else if (reason === "unresponsive") orb.emit("unresponsive");
      else if (reason === "hidden") await invoke("orb-visible", dashboard, false);
      else await invoke("configure", dashboard, { clickThrough: true });
      const bounds = orb.getBounds();
      mock.cursor = { x: 800, y: 600 };
      vi.advanceTimersByTime(100);
      expect(orb.getBounds()).toEqual(bounds);
      expect(orb.ignored).toBe(true);
      if (reason === "renderer loss" || reason === "unresponsive") {
        interact(orb, true);
        expect(orb.ignored).toBe(true);
        await invoke("refresh", dashboard);
        interact(orb, true);
        expect(orb.ignored).toBe(false);
      }
    },
  );

  it("resets a high-water peak when switching to a lower-peak project on the same day", async () => {
    const instance = controller();
    await instance.open();
    const orb = surfaces("orb")[0]!;
    const all = snapshot();
    all.today.peakOutputTps = 1000;
    publish(orb, all);
    await invoke("scope", orb, { profile: null, project: "A" });
    const baseline = snapshot({ profile: null, project: "A" });
    baseline.today.peakOutputTps = 100;
    publish(orb, baseline);
    mock.now += 61_000;
    const fresh = snapshot({ profile: null, project: "A" });
    fresh.today.peakOutputTps = 150;
    fresh.activity = {
      lastResponseAt: mock.now - 10,
      peakAt: mock.now - 10,
      peakObservedAt: mock.now - 10,
    };
    publish(orb, fresh);
    expect(state(orb).activity.peakSequence).toBe(1);
  });

  it("downgrades four simultaneous redline orbs except the most recently interacted one", async () => {
    const instance = controller();
    await instance.open();
    const first = surfaces("orb")[0]!;
    for (let index = 1; index < 4; index++) await invoke("new-window", first);
    const orbs = surfaces("orb");
    for (const orb of orbs) {
      const data = snapshot();
      data.rate = { measuredTps: 3000, estimatedTps: 0, estimatedShare: 0 };
      publish(orb, data);
    }
    expect(orbs.map((orb) => state(orb).maxFps)).toEqual([30, 30, 30, 60]);
    interact(first, true);
    expect(orbs.map((orb) => state(orb).maxFps)).toEqual([60, 30, 30, 30]);
  });
});
