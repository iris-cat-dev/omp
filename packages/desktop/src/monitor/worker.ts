import { parentPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { OmpLocalMonitor } from "./collector.js";
import { object } from "./parser.js";
import { OmpProcessSampler } from "./resources.js";
import { OmpPriceCatalog } from "./pricing.js";
import type { OmpMonitorCostInput } from "./pricing.js";
import type {
  OmpMonitorResources,
  OmpMonitorRoot,
  OmpMonitorScope,
  OmpMonitorWorkerResponse,
} from "./types.js";

// Snapshots are cloned; the collector retains ownership of every buffer.
const NO_TRANSFERABLES: [] = [];

interface WorkerSettings {
  networkEnabled?: boolean;
  autoSyncPrices?: boolean;
  currency?: string;
}
interface ScopedWindow {
  id: string;
  scope: OmpMonitorScope;
}
type WorkerData = Record<string, unknown> | null;

function monitorRoot(candidate: unknown): candidate is OmpMonitorRoot {
  const root = object(candidate);
  return (
    typeof root?.path === "string" &&
    root.path.length <= 4_096 &&
    typeof root.label === "string" &&
    root.label.length <= 160
  );
}

function workerRoots(data: WorkerData): OmpMonitorRoot[] | undefined {
  if (!Array.isArray(data?.roots)) return undefined;
  return data.roots.slice(0, 65).filter(monitorRoot);
}

function workerCatalog(data: WorkerData): OmpPriceCatalog | undefined {
  if (typeof data?.cacheDir !== "string" || data.cacheDir.length > 4_096) return undefined;
  return new OmpPriceCatalog({ cacheDir: data.cacheDir });
}

function validScopePart(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 160);
}

function readScope(candidate: unknown): OmpMonitorScope | null {
  const scope = object(candidate);
  if (!scope || !validScopePart(scope.profile) || !validScopePart(scope.project)) return null;
  return { profile: scope.profile, project: scope.project };
}

function readScopes(input: unknown): ScopedWindow[] | null {
  if (!Array.isArray(input)) return null;
  const scopes: ScopedWindow[] = [];
  const ids = new Set<string>();
  for (const candidate of input.slice(0, 8)) {
    const entry = object(candidate);
    const scope = readScope(entry?.scope);
    if (
      typeof entry?.id !== "string" ||
      !entry.id ||
      entry.id.length > 128 ||
      ids.has(entry.id) ||
      !scope
    )
      continue;
    ids.add(entry.id);
    scopes.push({ id: entry.id, scope });
  }
  return scopes;
}

function readSettings(request: Record<string, unknown>): WorkerSettings | null {
  if (request.networkEnabled !== undefined && typeof request.networkEnabled !== "boolean")
    return null;
  if (request.autoSyncPrices !== undefined && typeof request.autoSyncPrices !== "boolean")
    return null;
  if (
    request.currency !== undefined &&
    (typeof request.currency !== "string" || !/^[A-Z]{3}$/.test(request.currency))
  )
    return null;
  const settings: WorkerSettings = {};
  if (typeof request.networkEnabled === "boolean") settings.networkEnabled = request.networkEnabled;
  if (typeof request.autoSyncPrices === "boolean") settings.autoSyncPrices = request.autoSyncPrices;
  if (typeof request.currency === "string") settings.currency = request.currency;
  return settings;
}

/** Owns one collector and one non-overlapping poll loop for every monitor window. */
export class OmpMonitorWorker {
  private readonly monitor: OmpLocalMonitor;
  private readonly sourceEnabled: boolean;
  private readonly sampler = new OmpProcessSampler();
  private readonly catalog: OmpPriceCatalog | undefined;
  private readonly catalogReady: Promise<void>;
  private catalogCommands: Promise<void>;
  private readonly catalogFlights: Partial<Record<"prices" | "rates", Promise<void>>> = {};
  private resources: OmpMonitorResources = {
    status: "unavailable",
    sampledAt: Date.now(),
    processCount: 0,
    cpuPercent: null,
    workingSetBytes: null,
    privateBytes: null,
    reason: "unreadable",
  };
  private sampledAt = -Infinity;
  private scopes: ScopedWindow[] = [];
  private visible = false;
  private running = false;
  private refreshPending = false;
  private disposed = false;
  private stopping = false;
  private pricingRecoveryRequired: boolean;
  private runFinished: Promise<void> = Promise.resolve();
  private hasSnapshot = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly port: MessagePort,
    input: unknown,
  ) {
    const data = object(input);
    this.sourceEnabled = data?.sourceEnabled !== false;
    this.pricingRecoveryRequired = data?.pricingRecoveryRequired === true;
    if (!this.sourceEnabled) {
      this.resources = {
        status: "unavailable",
        sampledAt: Date.now(),
        processCount: 0,
        cpuPercent: null,
        workingSetBytes: null,
        privateBytes: null,
        // Disabled sources are not sampled; there is no probe failure to report.
        reason: null,
      };
    }
    const catalog = workerCatalog(data);
    this.catalog = catalog;
    this.monitor = new OmpLocalMonitor({
      roots: this.sourceEnabled ? workerRoots(data) : [],
      ...(typeof data?.cacheDir === "string" && data.cacheDir.length <= 4096
        ? { performanceCacheDir: data.cacheDir }
        : {}),
      ...(catalog
        ? {
            estimateCost: (usage: OmpMonitorCostInput) => catalog.estimateCost(usage),
            getPricing: () => catalog.getState(),
          }
        : {}),
    });
    this.catalogReady = catalog
      ? catalog.initialize().catch(() => {
          this.reportError();
        })
      : Promise.resolve();
    this.catalogCommands = this.catalogReady;
  }

  start(): void {
    this.port.on("message", (input: unknown) => {
      this.handleRequest(input);
    });
    this.port.once("close", () => {
      this.dispose();
    });
    void this.run();
  }

  private post(message: OmpMonitorWorkerResponse): void {
    if (!this.disposed) this.port.postMessage(message, NO_TRANSFERABLES);
  }

  private reportError(): void {
    this.post({ type: "error" });
  }

  private publish(fromPoll = false): void {
    if (!this.hasSnapshot || this.disposed || !this.scopes.length || (this.running && !fromPoll))
      return;
    const snapshots = this.scopes.map((entry) => ({
      scopeId: entry.id,
      snapshot: {
        ...this.monitor.getSnapshot(entry.scope),
        ...(this.pricingRecoveryRequired && this.catalog
          ? {
              pricing: { ...this.catalog.getState(), networkEnabled: false, autoSyncPrices: false },
            }
          : {}),
        resources: this.resources,
      },
    }));
    this.post({ type: "snapshots", snapshots });
  }

  private async refreshReadyCatalog(
    catalog: OmpPriceCatalog,
    force: boolean,
    target: "prices" | "rates",
  ): Promise<void> {
    if (this.disposed) return;
    const before = JSON.stringify(catalog.getState());
    const refresh = catalog.refresh({ force, target });
    await Promise.resolve();
    const started = JSON.stringify(catalog.getState());
    if (before !== started) this.publish();
    await refresh;
    if (started !== JSON.stringify(catalog.getState())) this.publish();
  }

  private refreshCatalog(force = false, target?: "prices" | "rates"): void {
    if (target === undefined) {
      this.refreshCatalog(force, "prices");
      this.refreshCatalog(force, "rates");
      return;
    }
    const catalog = this.catalog;
    if (
      !catalog ||
      (!force && this.catalogFlights[target]) ||
      this.disposed ||
      this.stopping ||
      this.pricingRecoveryRequired
    )
      return;
    // Manual actions still reach the catalog's per-resource singleflight; a pending
    // scheduled no-op must not swallow a forced check, or block the other resource.
    const flight = this.catalogCommands
      .then(() => this.refreshReadyCatalog(catalog, force, target))
      .catch(() => {
        this.reportError();
      })
      .finally(() => {
        if (this.catalogFlights[target] === flight) delete this.catalogFlights[target];
      });
    this.catalogFlights[target] = flight;
  }

  private async applyCatalogSettings(
    catalog: OmpPriceCatalog,
    settings: WorkerSettings,
  ): Promise<void> {
    if (this.disposed) throw new Error("Monitor worker is closed");
    try {
      await catalog.configure(settings);
      this.pricingRecoveryRequired = false;
    } finally {
      // Failed durable writes still retain and publish the in-memory opt-out.
      this.publish();
    }
    this.refreshCatalog();
  }

  private configurePricing(request: Record<string, unknown>): void {
    const requestId = this.readRequestId(request);
    if (requestId === null) return;
    const catalog = this.catalog,
      settings = readSettings(request);
    if (!catalog || !settings) {
      this.post({ type: "command-result", requestId, ok: false });
      return;
    }
    // Recovery never reloads an unconfirmed opt-out as permission to fetch.
    // Only this explicit settings command may save and leave the recovery gate.
    const patch = this.pricingRecoveryRequired
      ? { networkEnabled: false, autoSyncPrices: false, ...settings }
      : settings;
    // Serialize settings persistence only; price/FX downloads run independently.
    this.catalogCommands = this.catalogCommands
      .then(() => this.applyCatalogSettings(catalog, patch))
      .then(() => this.post({ type: "command-result", requestId, ok: true }))
      .catch(() => {
        this.post({ type: "command-result", requestId, ok: false });
      });
  }

  private readRequestId(request: Record<string, unknown>): number | null {
    if (
      typeof request.requestId === "number" &&
      Number.isSafeInteger(request.requestId) &&
      request.requestId > 0
    )
      return request.requestId;
    this.reportError();
    return null;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.stopping) return;
    this.timer = setTimeout(
      () => {
        void this.run();
      },
      this.visible ? 1_000 : 5_000,
    );
  }

  private async sampleResources(): Promise<void> {
    if (Date.now() - this.sampledAt < 5_000) return;
    try {
      this.resources = await this.sampler.sample();
    } catch {
      this.resources = {
        status: "unavailable",
        sampledAt: Date.now(),
        processCount: 0,
        cpuPercent: null,
        workingSetBytes: null,
        privateBytes: null,
        reason: "unreadable",
      };
    }
    this.sampledAt = Date.now();
  }

  private async run(): Promise<void> {
    if (this.disposed || this.stopping || this.running) return;
    this.running = true;
    const { promise: runFinished, resolve: finish } = Promise.withResolvers<void>();
    this.runFinished = runFinished;
    clearTimeout(this.timer);
    try {
      await this.catalogReady;
      while (true) {
        if (this.disposed || this.stopping) break;
        const refresh = this.refreshPending;
        this.refreshPending = false;
        await this.monitor.poll({ refresh });
        if (this.disposed || this.stopping) break;
        if (this.sourceEnabled) await this.sampleResources();
        this.hasSnapshot = true;
        this.publish(true);
        this.refreshCatalog();
        if (!this.refreshPending) break;
      }
    } catch {
      this.reportError();
    } finally {
      this.running = false;
      this.schedule();
      finish();
    }
  }

  private setVisibility(visible: unknown): void {
    if (typeof visible !== "boolean") return;
    const becameVisible = !this.visible && visible;
    this.visible = visible;
    if (becameVisible) void this.run();
    else if (!this.running) this.schedule();
  }

  private setScopes(input: unknown): void {
    const scopes = readScopes(input);
    if (!scopes) return;
    this.scopes = scopes;
    try {
      this.publish();
    } catch {
      this.reportError();
    }
  }

  private handleRequest(input: unknown): void {
    const request = object(input);
    if (this.disposed || this.stopping || !request) return;
    switch (request.type) {
      case "shutdown":
        {
          const requestId = this.readRequestId(request);
          if (requestId === null) break;
          this.stopping = true;
          clearTimeout(this.timer);
          void this.shutdown(requestId);
        }
        break;
      case "refresh":
        this.refreshPending = true;
        void this.run();
        break;
      case "pricing.configure":
        this.configurePricing(request);
        break;
      case "pricing.refresh":
        if (
          request.target !== undefined &&
          request.target !== "prices" &&
          request.target !== "rates"
        )
          this.reportError();
        else this.refreshCatalog(true, request.target);
        break;
      case "visibility":
        this.setVisibility(request.visible);
        break;
      case "scopes":
        this.setScopes(request.scopes);
        break;
    }
  }

  private async shutdown(requestId: number): Promise<void> {
    try {
      await this.runFinished;
      await this.catalogCommands;
      await Promise.all(Object.values(this.catalogFlights));
      await this.catalog?.waitForIdle();
      if (this.pricingRecoveryRequired) throw new Error("Monitor settings save is unconfirmed");
    } catch {
      // A rejected drain is a veto, not permission to destroy the only in-memory opt-out.
      this.stopping = false;
      this.post({ type: "command-result", requestId, ok: false });
      this.schedule();
      return;
    }
    this.post({ type: "command-result", requestId, ok: true });
    this.dispose();
    this.port.close();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.monitor.dispose();
    this.sampler.dispose();
    this.catalog?.dispose();
  }
}

if (parentPort) new OmpMonitorWorker(parentPort, workerData).start();
