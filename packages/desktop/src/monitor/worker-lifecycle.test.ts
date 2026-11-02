import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { OmpMonitorWorkerResponse } from "./types.js";

type TestPort = EventEmitter & { postMessage: Mock; close: Mock };
const mock = vi.hoisted(() => ({
  port: null as TestPort | null,
  sourceEnabled: true,
  pricingRecoveryRequired: false,
  construct: vi.fn(),
  poll: vi.fn(),
  monitorDispose: vi.fn(),
  sample: vi.fn(),
  samplerDispose: vi.fn(),
  initialize: vi.fn(),
  configure: vi.fn(),
  refresh: vi.fn(),
  waitForIdle: vi.fn(),
  catalogDispose: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({
  get parentPort() {
    return mock.port;
  },
  get workerData() {
    return {
      roots: [],
      cacheDir: "owned-test-cache",
      sourceEnabled: mock.sourceEnabled,
      pricingRecoveryRequired: mock.pricingRecoveryRequired,
    };
  },
}));
vi.mock("./collector.js", () => ({
  OmpLocalMonitor: class {
    constructor(options: unknown) {
      mock.construct(options);
    }
    poll = mock.poll;
    getSnapshot() {
      return {};
    }
    dispose = mock.monitorDispose;
  },
}));
vi.mock("./resources.js", () => ({
  OmpProcessSampler: class {
    sample = mock.sample;
    dispose = mock.samplerDispose;
  },
}));
vi.mock("./pricing.js", () => ({
  OmpPriceCatalog: class {
    initialize = mock.initialize;
    configure = mock.configure;
    refresh = mock.refresh;
    waitForIdle = mock.waitForIdle;
    dispose = mock.catalogDispose;
    estimateCost() {
      return null;
    }
    getState() {
      return {};
    }
  },
}));
beforeEach(() => {
  vi.resetModules();
  mock.sourceEnabled = true;
  mock.pricingRecoveryRequired = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const fn of [
    mock.construct,
    mock.poll,
    mock.monitorDispose,
    mock.sample,
    mock.samplerDispose,
    mock.initialize,
    mock.configure,
    mock.refresh,
    mock.waitForIdle,
    mock.catalogDispose,
  ])
    fn.mockReset();
  mock.initialize.mockResolvedValue(undefined);
  mock.configure.mockResolvedValue(undefined);
  mock.refresh.mockResolvedValue(undefined);
  mock.waitForIdle.mockResolvedValue(undefined);
  mock.sample.mockResolvedValue({ status: "unavailable", sampledAt: 0 });
  mock.port = Object.assign(new EventEmitter(), { postMessage: vi.fn(), close: vi.fn() });
});
afterEach(() => {
  mock.port?.emit("close");
  vi.useRealTimers();
});

describe("source worker clean handoff", () => {
  it("drains an active poll and queued catalog command before closing, with no new polling or public-data refresh", async () => {
    const polling = Promise.withResolvers<void>();
    const pollFinished = Promise.withResolvers<void>();
    const idleStarted = Promise.withResolvers<void>();
    const catalogIdle = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    mock.poll.mockImplementation(() => {
      polling.resolve();
      return pollFinished.promise;
    });
    mock.waitForIdle.mockImplementation(() => {
      idleStarted.resolve();
      return catalogIdle.promise;
    });
    mock.port!.close.mockImplementation(() => {
      mock.port!.emit("close");
      closed.resolve();
    });
    // A fresh module load is the real parentPort bootstrap boundary; a static import would start it before this test owns the port.
    await import("./worker.js");
    await polling.promise;
    mock.port!.emit("message", { type: "pricing.configure", requestId: 1, networkEnabled: false });
    mock.port!.emit("message", { type: "shutdown", requestId: 2 });
    expect(mock.port!.close).not.toHaveBeenCalled();
    expect(mock.monitorDispose).not.toHaveBeenCalled();
    pollFinished.resolve();
    await idleStarted.promise;
    expect(mock.configure).toHaveBeenCalledWith({ networkEnabled: false });
    expect(mock.port!.close).not.toHaveBeenCalled();
    expect(mock.sample).not.toHaveBeenCalled();
    expect(mock.refresh).not.toHaveBeenCalled();
    catalogIdle.resolve();
    await closed.promise;
    expect(mock.poll).toHaveBeenCalledTimes(1);
    expect(mock.monitorDispose).toHaveBeenCalledTimes(1);
    expect(mock.samplerDispose).toHaveBeenCalledTimes(1);
    expect(mock.catalogDispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    mock.port!.emit("message", { type: "refresh" });
    mock.port!.emit("message", { type: "pricing.configure", requestId: 3, networkEnabled: true });
    expect(mock.poll).toHaveBeenCalledTimes(1);
    expect(mock.configure).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit empty source list and drains startup commands without discovering real roots after shutdown", async () => {
    const initialized = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    mock.initialize.mockReturnValue(initialized.promise);
    mock.port!.close.mockImplementation(() => {
      mock.port!.emit("close");
      closed.resolve();
    });
    // Reload the worker entry point only after this test owns its blocked startup catalog and parentPort.
    await import("./worker.js");
    mock.port!.emit("message", { type: "pricing.configure", requestId: 1, autoSyncPrices: false });
    mock.port!.emit("message", { type: "shutdown", requestId: 2 });
    expect(mock.port!.close).not.toHaveBeenCalled();
    initialized.resolve();
    await closed.promise;
    expect(mock.construct).toHaveBeenCalledWith(expect.objectContaining({ roots: [] }));
    expect(mock.configure).toHaveBeenCalledWith({ autoSyncPrices: false });
    expect(mock.waitForIdle).toHaveBeenCalledTimes(1);
    expect(mock.poll).not.toHaveBeenCalled();
    expect(mock.refresh).not.toHaveBeenCalled();
    expect(mock.monitorDispose).toHaveBeenCalledTimes(1);
  });
});

describe("worker settings acknowledgements and recovery", () => {
  it("acknowledges settings only after configure persistence settles and orders an immediate shutdown behind it", async () => {
    const write = Promise.withResolvers<void>(),
      writing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>(),
      order: string[] = [];
    mock.poll.mockResolvedValue(undefined);
    mock.configure.mockImplementation(async () => {
      writing.resolve();
      await write.promise;
      order.push("settings-durable");
    });
    mock.port!.postMessage.mockImplementation((message: OmpMonitorWorkerResponse) => {
      if (message.type === "command-result") order.push(`ack:${message.requestId}:${message.ok}`);
    });
    mock.port!.close.mockImplementation(() => {
      order.push("closed");
      mock.port!.emit("close");
      closed.resolve();
    });
    // Bootstrap must read this test's blocked configure and owned parentPort, not a static-import port.
    await import("./worker.js");
    mock.port!.emit("message", { type: "pricing.configure", requestId: 1, autoSyncPrices: false });
    await writing.promise;
    mock.port!.emit("message", { type: "shutdown", requestId: 2 });
    try {
      expect(order).toEqual([]);
      expect(mock.waitForIdle).not.toHaveBeenCalled();
      expect(mock.port!.close).not.toHaveBeenCalled();
    } finally {
      write.resolve();
    }
    await closed.promise;
    expect(order).toEqual(["settings-durable", "ack:1:true", "ack:2:true", "closed"]);
    expect(mock.configure).toHaveBeenCalledTimes(1);
    expect(mock.waitForIdle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports failed settings and repeated drain vetoes without closing the recovery worker or implicitly retrying settings", async () => {
    let dirty = false;
    const replies = new Map<number, { promise: Promise<boolean>; resolve(value: boolean): void }>();
    for (const requestId of [1, 2, 3, 4, 5])
      replies.set(requestId, Promise.withResolvers<boolean>());
    mock.poll.mockResolvedValue(undefined);
    mock.configure
      .mockImplementationOnce(async () => {
        dirty = true;
        throw new Error("Owned private storage failure");
      })
      .mockImplementationOnce(async () => {
        dirty = false;
      });
    mock.waitForIdle.mockImplementation(async () => {
      if (dirty) throw new Error("Settings are not durable");
    });
    mock.port!.postMessage.mockImplementation((message: OmpMonitorWorkerResponse) => {
      if (message.type === "command-result") replies.get(message.requestId)!.resolve(message.ok);
    });
    const closed = Promise.withResolvers<void>();
    mock.port!.close.mockImplementation(() => {
      mock.port!.emit("close");
      closed.resolve();
    });
    // Each fresh entry-point load binds the test-owned port and its current persistence failure.
    await import("./worker.js");
    mock.port!.emit("message", { type: "pricing.configure", requestId: 1, networkEnabled: false });
    expect(await replies.get(1)!.promise).toBe(false);
    for (const requestId of [2, 3]) {
      mock.port!.emit("message", { type: "shutdown", requestId });
      expect(await replies.get(requestId)!.promise).toBe(false);
      expect(mock.port!.close).not.toHaveBeenCalled();
      expect(mock.catalogDispose).not.toHaveBeenCalled();
      expect(mock.monitorDispose).not.toHaveBeenCalled();
      expect(mock.configure).toHaveBeenCalledTimes(1);
    }
    mock.port!.emit("message", { type: "pricing.configure", requestId: 4, networkEnabled: false });
    expect(await replies.get(4)!.promise).toBe(true);
    mock.port!.emit("message", { type: "shutdown", requestId: 5 });
    expect(await replies.get(5)!.promise).toBe(true);
    await closed.promise;
    expect(mock.configure).toHaveBeenCalledTimes(2);
    expect(mock.waitForIdle).toHaveBeenCalledTimes(3);
    expect(mock.catalogDispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses every startup and scheduled public refresh after an unknown settings outcome until an explicit conservative save succeeds", async () => {
    mock.pricingRecoveryRequired = true;
    mock.sourceEnabled = false;
    mock.poll.mockResolvedValue(undefined);
    const saved = Promise.withResolvers<boolean>();
    mock.port!.postMessage.mockImplementation((message: OmpMonitorWorkerResponse) => {
      if (message.type === "command-result" && message.requestId === 1) saved.resolve(message.ok);
      if (message.type === "snapshots") {
        for (const entry of message.snapshots)
          expect(entry.snapshot.pricing).toMatchObject({
            networkEnabled: false,
            autoSyncPrices: false,
          });
      }
    });
    // Recovery workerData and parentPort are fixed only after this test installs its startup guard.
    await import("./worker.js");
    mock.port!.emit("message", {
      type: "scopes",
      scopes: [{ id: "owned-orb", scope: { profile: null, project: null } }],
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(mock.poll.mock.calls.length).toBeGreaterThan(1);
    expect(mock.refresh).not.toHaveBeenCalled();
    expect(mock.configure).not.toHaveBeenCalled();
    // The mock catalog has no pricing state; only startup recovery publications assert its overlay.
    mock.port!.postMessage.mockImplementation((message: OmpMonitorWorkerResponse) => {
      if (message.type === "command-result" && message.requestId === 1) saved.resolve(message.ok);
    });
    mock.port!.emit("message", { type: "pricing.configure", requestId: 1, currency: "USD" });
    expect(await saved.promise).toBe(true);
    expect(mock.configure).toHaveBeenCalledWith({
      networkEnabled: false,
      autoSyncPrices: false,
      currency: "USD",
    });
    expect(mock.configure).toHaveBeenCalledTimes(1);
  });
});

describe("disabled OMP source sampling", () => {
  it("keeps numeric roots empty and never samples processes while the source is disabled", async () => {
    mock.sourceEnabled = false;
    mock.poll.mockResolvedValue(undefined);
    const published = Promise.withResolvers<{
      snapshots: Array<{ snapshot: { resources: { status: string } } }>;
    }>();
    mock.port!.postMessage.mockImplementation(
      (message: {
        type: string;
        snapshots: Array<{ snapshot: { resources: { status: string } } }>;
      }) => {
        if (message.type === "snapshots") published.resolve(message);
      },
    );
    // The module reads workerData once at bootstrap, after this test establishes the disabled source.
    await import("./worker.js");
    mock.port!.emit("message", {
      type: "scopes",
      scopes: [{ id: "owned-orb", scope: { profile: null, project: null } }],
    });
    const message = await published.promise;
    expect(mock.construct).toHaveBeenCalledWith(expect.objectContaining({ roots: [] }));
    expect(mock.sample).not.toHaveBeenCalled();
    expect(message.snapshots[0]!.snapshot.resources.status).toBe("unavailable");
  });
});
