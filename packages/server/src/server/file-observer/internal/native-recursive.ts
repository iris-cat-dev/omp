import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { BackendDiagnostics, ObservationBackend, ObservationHost } from "./contracts.js";
import type { ObserverPaths } from "./paths.js";
import { isMissingPathError, toError } from "./paths.js";

const MAX_TRACKED_ENTRIES = 250_000;
const MAX_CONCURRENT_CLASSIFICATIONS = 8;
const WORK_SLICE_ENTRIES = 512;
const AUDIT_QUIET_MS = 500;
const AUDIT_MAX_DIRTY_MS = 5_000;
const OPTIONAL_AUDIT_QUIET_MS = 8_000;
const OPTIONAL_AUDIT_MAX_DIRTY_MS = 8_000;
const FULL_AUDIT_QUIET_MS = 30_000;
const FULL_AUDIT_MIN_INTERVAL_MS = 30_000;
const FULL_AUDIT_MAX_DIRTY_MS = 5 * 60_000;

interface DirectoryEntry {
  directories: Set<string>;
  files: Set<string>;
}

interface Inventory {
  directories: Set<string>;
  entries: Map<string, DirectoryEntry>;
  files: Set<string>;
}

export function createNativeRecursiveBackend(
  host: ObservationHost,
  paths: ObserverPaths,
): ObservationBackend {
  return new NativeRecursiveBackend(host, paths);
}

class NativeRecursiveBackend implements ObservationBackend {
  private watcher: FSWatcher | null = null;
  private files = new Set<string>();
  private directories = new Set<string>();
  private entries = new Map<string, DirectoryEntry>();
  private readonly classifications = new Set<Promise<void>>();
  private readonly pendingClassifications = new Map<string, boolean>();
  private readonly activeClassificationPaths = new Set<string>();
  private readonly localScopes = new Set<string>();
  private readonly changeScopes = new Set<string>();
  private readonly recursiveScopes = new Set<string>();
  private reconcileTail: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private inFlight = false;
  private auditTimer: NodeJS.Timeout | null = null;
  private fullAuditTimer: NodeJS.Timeout | null = null;
  private fullAuditRequested = false;
  private auditDirty = false;
  private auditDirtySince: number | null = null;
  private auditLastDirtyAt: number | null = null;
  private auditQueued = false;
  private auditRunning = false;
  private safetyAuditPending = false;
  private safetyAuditDirtySince: number | null = null;
  private safetyAuditLastDirtyAt: number | null = null;
  private lastFullAuditAt = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly host: ObservationHost,
    private readonly paths: ObserverPaths,
  ) {}

  async start(): Promise<void> {
    this.watchRoot();
    this.fullAuditRequested = true;
    this.auditQueued = true;
    await this.enqueueAudit(false, this.generation);
  }

  async updateIgnore(): Promise<void> {
    this.generation += 1;
    this.cancelAudits();
    this.fullAuditRequested = true;
    this.auditQueued = true;
    await this.enqueueAudit(true, this.generation);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.cancelAudits();
    this.watcher?.close();
    this.watcher = null;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  getDiagnostics(): BackendDiagnostics {
    return {
      nativeHandleCount: this.watcher ? 1 : 0,
      nativeTrackedFileCount: this.files.size,
      pendingReconciliationWorkCount:
        this.localScopes.size +
        this.changeScopes.size +
        this.recursiveScopes.size +
        this.classifications.size +
        this.pendingClassifications.size +
        this.queueDepth +
        Number(this.auditTimer !== null || this.auditQueued || this.auditDirty),
      reconciliationInFlight: this.inFlight,
    };
  }

  private async finishClose(): Promise<void> {
    await this.reconcileTail;
    await Promise.allSettled(this.classifications);
    this.watcher?.close();
    this.watcher = null;
    this.files.clear();
    this.directories.clear();
    this.entries.clear();
  }

  private watchRoot(): void {
    const watcher = watch(this.host.root, { recursive: true }, (eventType, filename) => {
      if (!this.host.isActive()) return;
      this.host.metrics.nativeEventCount += 1;
      if (!filename) {
        this.host.metrics.nativePathlessEventCount += 1;
        this.host.queueEvent("update", this.host.root);
        this.requestAudit(this.host.root);
        return;
      }
      const path = resolve(this.host.root, filename.toString());
      if (this.host.isIgnored(path)) return;
      const scope = path === this.host.root ? this.host.root : dirname(path);
      if (eventType === "change") {
        this.host.metrics.nativeChangeEventCount += 1;
        this.host.queueEvent("update", path);
        this.requestChangeAudit(scope);
        if (this.directories.has(path)) this.requestAudit(path, true);
        return;
      }
      this.host.metrics.nativeRenameEventCount += 1;
      const knownDirectory = this.directories.has(path);
      this.classify(path, knownDirectory);
      this.requestChangeAudit(scope);
      if (knownDirectory) this.requestAudit(scope);
    });
    watcher.on("error", (error) => {
      if (this.host.isActive()) this.host.fail(toError(error));
    });
    this.watcher = watcher;
  }

  private enqueueAudit(emitDiff: boolean, generation: number): Promise<void> {
    this.queueDepth += 1;
    const result = this.reconcileTail
      .then(() => this.runAudit(emitDiff, generation))
      .finally(() => {
        this.queueDepth -= 1;
      });
    this.reconcileTail = result.catch(() => undefined);
    return result;
  }

  private async runAudit(emitDiff: boolean, generation: number): Promise<void> {
    this.auditQueued = false;
    if (!this.canCommit(generation)) return;
    const fullAudit = this.fullAuditRequested;
    const localScopes = [...this.localScopes];
    const changeScopes = [...this.changeScopes];
    const recursiveScopes = [...this.recursiveScopes];
    this.fullAuditRequested = false;
    this.localScopes.clear();
    this.changeScopes.clear();
    this.recursiveScopes.clear();
    if (fullAudit) this.clearSafetyAudit();
    this.auditRunning = true;
    this.auditDirty = false;
    this.auditDirtySince = null;
    this.auditLastDirtyAt = null;
    this.inFlight = true;
    const startedAt = performance.now();
    try {
      if (fullAudit) {
        const next = await this.scanTree(this.host.root);
        if (!this.canCommit(generation)) return;
        if (emitDiff) await this.queueDiff(next.files, this.files, generation);
        if (!this.canCommit(generation)) return;
        this.replaceInventory(next);
        this.lastFullAuditAt = performance.now();
        this.host.metrics.fullReconciliationCount += 1;
      } else {
        await this.reconcileScopes(localScopes, changeScopes, recursiveScopes, generation);
        this.host.metrics.scopedReconciliationCount += 1;
      }
    } catch (error) {
      this.host.metrics.reconciliationFailureCount += 1;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      this.host.metrics.reconciliationCount += 1;
      this.host.metrics.lastReconciliationDurationMs = durationMs;
      this.host.metrics.maxReconciliationDurationMs = Math.max(
        this.host.metrics.maxReconciliationDurationMs,
        durationMs,
      );
      this.inFlight = false;
      this.auditRunning = false;
      if (this.safetyAuditPending && this.host.isActive()) this.scheduleFullAudit();
      if (this.auditDirty && this.host.isActive()) this.scheduleAudit();
    }
  }

  private async scanTree(root: string): Promise<Inventory> {
    const files = new Set<string>();
    const directories = new Set<string>();
    const entries = new Map<string, DirectoryEntry>();
    const pending = [root];
    const generation = this.generation;
    let work = 0;
    while (pending.length > 0 && this.host.isActive()) {
      const directory = pending.pop();
      if (!directory) continue;
      let children: Dirent[];
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingPathError(error) && !this.host.isActive()) {
          return { directories, entries, files };
        }
        if (!isMissingPathError(error) || directory === this.host.root) throw error;
        continue;
      }
      directories.add(directory);
      this.assertWithinLimit(files.size + directories.size);
      const entry: DirectoryEntry = { directories: new Set(), files: new Set() };
      for (const child of children) {
        if (++work % WORK_SLICE_ENTRIES === 0) {
          await yieldToEventLoop();
          if (!this.canCommit(generation)) return { directories, entries, files };
        }
        const path = join(directory, child.name);
        if (this.host.isIgnored(path)) continue;
        if (child.isDirectory()) {
          entry.directories.add(path);
          pending.push(path);
        } else {
          entry.files.add(path);
          files.add(path);
          this.assertWithinLimit(files.size + directories.size);
        }
      }
      entries.set(directory, entry);
    }
    return { directories, entries, files };
  }

  private async reconcileScopes(
    localScopes: string[],
    changeScopes: string[],
    recursiveScopes: string[],
    generation: number,
  ): Promise<void> {
    const forcedLocalScopes = new Set(localScopes);
    const forcedRecursiveScopes = this.paths.collapse(recursiveScopes);
    for (const directory of new Set(localScopes)) {
      await this.reconcileDirectory(directory, generation);
      if (!this.canCommit(generation)) return;
    }
    for (const directory of new Set(recursiveScopes)) {
      await this.reconcileSubtree(directory, generation);
      if (!this.canCommit(generation)) return;
    }
    for (const directory of this.paths.collapse(changeScopes)) {
      const alreadyCovered =
        forcedLocalScopes.has(directory) ||
        forcedRecursiveScopes.some((scope) => this.host.isPathInside(scope, directory));
      if (alreadyCovered) continue;
      await this.reconcileDirectory(directory, generation);
      if (!this.canCommit(generation)) return;
    }
  }

  private async reconcileDirectory(directory: string, generation: number): Promise<void> {
    if (this.host.isIgnored(directory)) {
      await this.removeSubtree(directory, false, generation);
      return;
    }
    if (directory !== this.host.root && !this.directories.has(directory)) {
      await this.reconcileUnknownSubtree(directory, generation);
      return;
    }
    const next = await this.readDirectory(directory);
    if (!this.canCommit(generation)) return;
    if (!next) {
      await this.removeSubtree(directory, true, generation);
      return;
    }
    const previous = this.entries.get(directory) ?? {
      directories: new Set<string>(),
      files: new Set<string>(),
    };
    for (const path of previous.files) {
      if (!next.files.has(path)) {
        this.files.delete(path);
        this.host.queueEvent("delete", path);
      }
    }
    for (const path of previous.directories) {
      if (!next.directories.has(path)) await this.removeSubtree(path, true, generation);
      if (!this.canCommit(generation)) return;
    }
    for (const path of next.files) {
      if (!previous.files.has(path)) {
        this.files.add(path);
        this.host.queueEvent("create", path);
      }
    }
    for (const path of next.directories) {
      if (previous.directories.has(path)) continue;
      const inventory = await this.scanTree(path);
      if (!this.canCommit(generation)) return;
      if (!inventory.directories.has(path)) {
        next.directories.delete(path);
        continue;
      }
      await this.mergeInventory(inventory, true, generation);
      if (!this.canCommit(generation)) return;
    }
    this.directories.add(directory);
    this.entries.set(directory, next);
    this.assertWithinLimit(this.files.size + this.directories.size);
  }

  private async reconcileUnknownSubtree(directory: string, generation: number): Promise<void> {
    const inventory = await this.scanTree(directory);
    if (!this.canCommit(generation)) return;
    if (!inventory.directories.has(directory)) {
      await this.removeSubtree(directory, true, generation);
      return;
    }
    this.entries.get(dirname(directory))?.directories.add(directory);
    await this.mergeInventory(inventory, true, generation);
  }

  private async readDirectory(directory: string): Promise<DirectoryEntry | null> {
    this.host.metrics.nativeShallowScanCount += 1;
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPathError(error) || directory === this.host.root) throw error;
      return null;
    }
    const entry: DirectoryEntry = { directories: new Set(), files: new Set() };
    const generation = this.generation;
    let work = 0;
    for (const child of children) {
      if (++work % WORK_SLICE_ENTRIES === 0) {
        await yieldToEventLoop();
        if (!this.canCommit(generation)) return null;
      }
      const path = join(directory, child.name);
      if (this.host.isIgnored(path)) continue;
      if (child.isDirectory()) entry.directories.add(path);
      else entry.files.add(path);
    }
    return entry;
  }

  private async reconcileSubtree(directory: string, generation: number): Promise<void> {
    if (!this.directories.has(directory) || this.host.isIgnored(directory)) return;
    const inventory = await this.scanTree(directory);
    if (!this.canCommit(generation)) return;
    await this.queueDiff(inventory.files, this.files, generation, directory);
    if (!this.canCommit(generation)) return;
    await this.removeSubtree(directory, false, generation);
    if (!this.canCommit(generation)) return;
    await this.mergeInventory(inventory, false, generation);
  }

  private async queueDiff(
    nextFiles: Set<string>,
    previousFiles: Set<string>,
    generation: number,
    scope?: string,
  ): Promise<void> {
    let work = 0;
    for (const path of nextFiles) {
      if (!previousFiles.has(path)) this.host.queueEvent("create", path);
      if (++work % WORK_SLICE_ENTRIES === 0) {
        await yieldToEventLoop();
        if (!this.canCommit(generation)) return;
      }
    }
    for (const path of previousFiles) {
      if ((!scope || this.host.isPathInside(scope, path)) && !nextFiles.has(path))
        this.host.queueEvent("delete", path);
      if (++work % WORK_SLICE_ENTRIES === 0) {
        await yieldToEventLoop();
        if (!this.canCommit(generation)) return;
      }
    }
  }

  private replaceInventory(inventory: Inventory): void {
    this.files = inventory.files;
    this.directories = inventory.directories;
    this.entries = inventory.entries;
  }

  private async mergeInventory(
    inventory: Inventory,
    emitCreates: boolean,
    generation: number,
  ): Promise<void> {
    let work = 0;
    for (const [directory, entry] of inventory.entries) {
      this.directories.add(directory);
      this.entries.set(directory, entry);
      if (++work % WORK_SLICE_ENTRIES === 0) {
        await yieldToEventLoop();
        if (!this.canCommit(generation)) return;
      }
    }
    for (const path of inventory.files) {
      const added = !this.files.has(path);
      this.files.add(path);
      if (emitCreates && added) this.host.queueEvent("create", path);
      if (++work % WORK_SLICE_ENTRIES === 0) {
        await yieldToEventLoop();
        if (!this.canCommit(generation)) return;
      }
    }
    this.assertWithinLimit(this.files.size + this.directories.size);
  }

  private async removeSubtree(
    root: string,
    emitDeletes: boolean,
    generation: number,
  ): Promise<void> {
    // Walk the existing directory index, not every tracked path once per child.
    const pending = [root];
    let work = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const entry = this.entries.get(directory);
      if (entry) {
        for (const child of entry.directories) pending.push(child);
        for (const path of entry.files) {
          this.files.delete(path);
          if (emitDeletes) this.host.queueEvent("delete", path);
          if (++work % WORK_SLICE_ENTRIES !== 0) continue;
          await yieldToEventLoop();
          if (!this.canCommit(generation)) return;
        }
      }
      this.directories.delete(directory);
      this.entries.delete(directory);
      if (++work % WORK_SLICE_ENTRIES === 0) {
        await yieldToEventLoop();
        if (!this.canCommit(generation)) return;
      }
    }
    const parent = this.entries.get(dirname(root));
    parent?.directories.delete(root);
    parent?.files.delete(root);
  }

  private requestAudit(scope: string, recursive = false): void {
    if (!this.host.isActive()) return;
    if (recursive) this.recursiveScopes.add(scope);
    else this.localScopes.add(scope);
    this.markAuditDirty();
  }

  private requestChangeAudit(scope: string): void {
    if (!this.host.isActive()) return;
    this.changeScopes.add(scope);
    this.markAuditDirty();
  }

  private markAuditDirty(): void {
    this.requestSafetyAudit();
    const now = performance.now();
    this.auditDirty = true;
    this.auditDirtySince ??= now;
    this.auditLastDirtyAt = now;
    if (this.auditQueued || this.auditRunning) return;
    if (this.auditTimer) clearTimeout(this.auditTimer);
    this.auditTimer = null;
    this.scheduleAudit();
  }

  private scheduleAudit(): void {
    if (
      !this.host.isActive() ||
      !this.auditDirty ||
      this.auditQueued ||
      this.auditRunning ||
      this.auditTimer
    ) {
      return;
    }
    const now = performance.now();
    const optionalOnly = this.isOptionalOnly();
    const quietMs = optionalOnly ? OPTIONAL_AUDIT_QUIET_MS : AUDIT_QUIET_MS;
    const maxDirtyMs = optionalOnly ? OPTIONAL_AUDIT_MAX_DIRTY_MS : AUDIT_MAX_DIRTY_MS;
    const deadline = Math.min(
      (this.auditLastDirtyAt ?? now) + quietMs,
      (this.auditDirtySince ?? now) + maxDirtyMs,
    );
    this.auditTimer = setTimeout(() => this.runScheduledAudit(), Math.max(0, deadline - now));
    this.auditTimer.unref();
  }

  private runScheduledAudit(): void {
    this.auditTimer = null;
    if (!this.host.isActive()) return;
    const now = performance.now();
    const optionalOnly = this.isOptionalOnly();
    const quietMs = optionalOnly ? OPTIONAL_AUDIT_QUIET_MS : AUDIT_QUIET_MS;
    const maxDirtyMs = optionalOnly ? OPTIONAL_AUDIT_MAX_DIRTY_MS : AUDIT_MAX_DIRTY_MS;
    const deadline = Math.min(
      (this.auditLastDirtyAt ?? now) + quietMs,
      (this.auditDirtySince ?? now) + maxDirtyMs,
    );
    if (now < deadline) {
      this.scheduleAudit();
      return;
    }
    this.auditQueued = true;
    void this.enqueueAudit(true, this.generation).catch((error: unknown) =>
      this.host.fail(toError(error)),
    );
  }

  private isOptionalOnly(): boolean {
    return (
      !this.fullAuditRequested &&
      this.localScopes.size === 0 &&
      this.recursiveScopes.size === 0 &&
      this.changeScopes.size > 0
    );
  }

  private requestSafetyAudit(): void {
    const now = performance.now();
    this.safetyAuditPending = true;
    this.safetyAuditDirtySince ??= now;
    this.safetyAuditLastDirtyAt = now;
    this.scheduleFullAudit();
  }

  private scheduleFullAudit(): void {
    if (
      !this.host.isActive() ||
      !this.safetyAuditPending ||
      this.auditRunning ||
      this.fullAuditTimer
    ) {
      return;
    }
    const now = performance.now();
    const deadline = this.fullAuditDeadline(now);
    this.fullAuditTimer = setTimeout(
      () => this.runScheduledFullAudit(),
      Math.max(0, deadline - now),
    );
    this.fullAuditTimer.unref();
  }

  private runScheduledFullAudit(): void {
    this.fullAuditTimer = null;
    if (!this.host.isActive() || !this.safetyAuditPending || this.auditRunning) return;
    const now = performance.now();
    if (now < this.fullAuditDeadline(now)) {
      this.scheduleFullAudit();
      return;
    }
    this.safetyAuditPending = false;
    this.fullAuditRequested = true;
    this.auditDirty = true;
    this.auditDirtySince ??= now;
    this.scheduleAudit();
  }

  private fullAuditDeadline(now: number): number {
    const quietDeadline = (this.safetyAuditLastDirtyAt ?? now) + FULL_AUDIT_QUIET_MS;
    const intervalDeadline = this.lastFullAuditAt + FULL_AUDIT_MIN_INTERVAL_MS;
    const starvationDeadline = (this.safetyAuditDirtySince ?? now) + FULL_AUDIT_MAX_DIRTY_MS;
    return Math.min(starvationDeadline, Math.max(intervalDeadline, quietDeadline));
  }

  private clearSafetyAudit(): void {
    this.safetyAuditPending = false;
    this.safetyAuditDirtySince = null;
    this.safetyAuditLastDirtyAt = null;
    if (this.fullAuditTimer) clearTimeout(this.fullAuditTimer);
    this.fullAuditTimer = null;
  }

  private cancelAudits(): void {
    if (this.auditTimer) clearTimeout(this.auditTimer);
    if (this.fullAuditTimer) clearTimeout(this.fullAuditTimer);
    this.auditTimer = null;
    this.fullAuditTimer = null;
    this.localScopes.clear();
    this.changeScopes.clear();
    this.recursiveScopes.clear();
    this.pendingClassifications.clear();
    this.fullAuditRequested = false;
    this.auditDirty = false;
    this.auditDirtySince = null;
    this.auditLastDirtyAt = null;
    this.safetyAuditPending = false;
    this.safetyAuditDirtySince = null;
    this.safetyAuditLastDirtyAt = null;
  }

  private classify(path: string, knownDirectory: boolean): void {
    this.pendingClassifications.set(
      path,
      knownDirectory || this.pendingClassifications.get(path) === true,
    );
    // A bounded audit reconstructs paths beyond this burst queue's limit.
    if (this.pendingClassifications.size > MAX_TRACKED_ENTRIES) {
      this.pendingClassifications.clear();
      this.fullAuditRequested = true;
      this.markAuditDirty();
    }
    this.drainClassifications();
  }

  private drainClassifications(): void {
    for (const [path, knownDirectory] of this.pendingClassifications) {
      if (this.classifications.size >= MAX_CONCURRENT_CLASSIFICATIONS) break;
      if (this.activeClassificationPaths.has(path)) continue;
      this.pendingClassifications.delete(path);
      if (!this.host.isActive() || this.host.isIgnored(path)) continue;
      const generation = this.generation;
      this.host.metrics.nativeClassificationCount += 1;
      this.activeClassificationPaths.add(path);
      let classification!: Promise<void>;
      classification = stat(path)
        .then((stats) => {
          if (!this.canCommit(generation) || this.host.isIgnored(path)) return undefined;
          this.host.queueEvent("create", path);
          if (stats.isDirectory()) {
            if (knownDirectory) this.requestAudit(path, true);
            else this.requestAudit(dirname(path));
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (!this.canCommit(generation) || this.host.isIgnored(path)) return;
          if (isMissingPathError(error)) this.host.queueEvent("delete", path);
          else this.host.fail(toError(error));
        })
        .finally(() => {
          this.classifications.delete(classification);
          this.activeClassificationPaths.delete(path);
          this.drainClassifications();
        });
      this.classifications.add(classification);
    }
  }

  private assertWithinLimit(entryCount: number): void {
    if (entryCount <= MAX_TRACKED_ENTRIES) return;
    throw new Error(
      `Recursive file observation exceeded ${MAX_TRACKED_ENTRIES} entries under ${this.host.root}`,
    );
  }

  private canCommit(generation: number): boolean {
    return this.host.isActive() && generation === this.generation;
  }
}
