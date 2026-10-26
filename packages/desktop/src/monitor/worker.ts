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
  if (
    request.currency !== undefined &&
    (typeof request.currency !== "string" || !/^[A-Z]{3}$/.test(request.currency))
  )
    return null;
  const settings: WorkerSettings = {};
  if (typeof request.networkEnabled === "boolean") settings.networkEnabled = request.networkEnabled;
  if (typeof request.currency === "string") settings.currency = request.currency;
  return settings;
}

/** Owns one collector and one non-overlapping poll loop for every monitor window. */
class OmpMonitorWorker {
  private readonly monitor: OmpLocalMonitor;
  private readonly sampler = new OmpProcessSampler();
  private readonly catalog: OmpPriceCatalog | undefined;
  private readonly catalogReady: Promise<void>;
  private catalogCommands: Promise<void>;
  private catalogFlight: Promise<void> | undefined;
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
  private hasSnapshot = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly port: MessagePort,
    input: unknown,
  ) {
    const data = object(input);
    const catalog = workerCatalog(data);
    this.catalog = catalog;
    this.monitor = new OmpLocalMonitor({
      roots: workerRoots(data),
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
      snapshot: { ...this.monitor.getSnapshot(entry.scope), resources: this.resources },
    }));
    this.post({ type: "snapshots", snapshots });
  }

  private async refreshReadyCatalog(catalog: OmpPriceCatalog, force: boolean): Promise<void> {
    if (this.disposed) return;
    const before = JSON.stringify(catalog.getState());
    await catalog.refresh({ force });
    if (before !== JSON.stringify(catalog.getState())) this.publish();
  }

  private refreshCatalog(force = false): void {
    const catalog = this.catalog;
    if (!catalog || this.catalogFlight || this.disposed) return;
    this.catalogFlight = this.catalogReady
      .then(() => this.refreshReadyCatalog(catalog, force))
      .catch(() => {
        this.reportError();
      })
      .finally(() => {
        this.catalogFlight = undefined;
      });
  }

  private async applyCatalogSettings(
    catalog: OmpPriceCatalog,
    settings: WorkerSettings,
  ): Promise<void> {
    if (this.disposed) return;
    await catalog.configure(settings);
    this.publish();
    this.refreshCatalog();
  }

  private configurePricing(request: Record<string, unknown>): void {
    const catalog = this.catalog;
    if (!catalog) return;
    const settings = readSettings(request);
    if (!settings) {
      this.reportError();
      return;
    }
    // Serialize settings persistence only; price/FX downloads run independently.
    this.catalogCommands = this.catalogCommands
      .then(() => this.applyCatalogSettings(catalog, settings))
      .catch(() => {
        this.reportError();
      });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed) return;
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
    if (this.disposed || this.running) return;
    this.running = true;
    clearTimeout(this.timer);
    try {
      await this.catalogReady;
      while (true) {
        if (this.disposed) break;
        const refresh = this.refreshPending;
        this.refreshPending = false;
        await this.monitor.poll({ refresh });
        if (this.disposed) break;
        await this.sampleResources();
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
    if (this.disposed || !request) return;
    switch (request.type) {
      case "refresh":
        this.refreshPending = true;
        void this.run();
        break;
      case "pricing.configure":
        this.configurePricing(request);
        break;
      case "pricing.refresh":
        this.refreshCatalog(true);
        break;
      case "visibility":
        this.setVisibility(request.visible);
        break;
      case "scopes":
        this.setScopes(request.scopes);
        break;
    }
  }

  private dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.monitor.dispose();
    this.sampler.dispose();
    this.catalog?.dispose();
  }
}

if (parentPort) new OmpMonitorWorker(parentPort, workerData).start();
