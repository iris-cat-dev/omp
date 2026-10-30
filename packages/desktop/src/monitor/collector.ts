import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { OmpFileDiscovery } from "./discovery.js";
import { currentDayUsage, OmpMonitorHistory } from "./history.js";
import { calendarDays, liveMetrics } from "./math.js";
import { emptyUsage, hashId, object, OmpNumericParser, safeLabel } from "./parser.js";
import type { NumericResponse, NumericSink } from "./parser.js";
import { getBundledPricingState } from "./pricing.js";
import type { OmpMonitorCostInput } from "./pricing.js";
import { OmpPerformanceMonitor } from "./performance-monitor.js";
import type { OmpPerformanceSource } from "./performance-reader-file.js";
import {
  coverageStatus,
  filterOptions,
  projectActivity,
  projectCoverage,
  scopeFiles,
  scopeResponses,
} from "./projection.js";
import { filesystemFailure, MAX_ROOTS, regularDirectory, resolveOmpMonitorRoots } from "./roots.js";
import type { RootResolution } from "./roots.js";
import {
  fileChanged,
  fileIdentity,
  MAX_CLOCK_MS,
  MONITOR_LIMITS,
  newFileState,
  normalizedPath,
  RECENT_MS,
  REDISCOVER_MS,
  scheduleFiles,
  STALE_MS,
} from "./state.js";
import type {
  Candidate,
  DiscoveredFile,
  FileReadCursor,
  FileState,
  MonitorIssue,
  ReadBudget,
  RootState,
} from "./state.js";
import type {
  OmpMonitorPricing,
  OmpMonitorRoot,
  OmpMonitorScope,
  OmpMonitorSnapshot,
} from "./types.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const RESPONSE_FIELDS: ReadonlyArray<keyof NumericResponse> = [
  "model",
  "provider",
  "serviceTier",
  "speedMode",
  "endMs",
  "startMs",
  "ttftMs",
  "sideCall",
  "completionState",
  ...(Object.keys(emptyUsage()) as Array<keyof NumericResponse>),
];

function sameCompletionFacts(left: NumericResponse, right: NumericResponse): boolean {
  return (
    left.endMs === right.endMs &&
    left.startMs === right.startMs &&
    left.outputTokens === right.outputTokens &&
    left.measuredDurationMs === right.measuredDurationMs &&
    left.failedRequests === right.failedRequests &&
    left.sideCall === right.sideCall &&
    left.completionState === right.completionState
  );
}

function sameResponseFacts(left: NumericResponse, right: NumericResponse): boolean {
  for (const field of RESPONSE_FIELDS) {
    if (field === "speedMode") {
      if (
        left.speedMode?.value !== right.speedMode?.value ||
        left.speedMode?.provider !== right.speedMode?.provider ||
        left.speedMode?.evidence !== right.speedMode?.evidence
      ) {
        return false;
      }
    } else if (left[field] !== right[field]) {
      return false;
    }
  }
  return true;
}

export interface OmpLocalMonitorOptions {
  roots?: OmpMonitorRoot[];
  now?: () => number;
  estimateCost?: (usage: OmpMonitorCostInput) => number | null;
  getPricing?: () => OmpMonitorPricing;
  performanceCacheDir?: string;
}

/** Read-only OMP session collector. No transcript text survives a complete line's numeric extraction. */
export class OmpLocalMonitor {
  private readonly configuredRoots: OmpMonitorRoot[] | undefined;
  private readonly clock: () => number;
  private readonly getPricing: () => OmpMonitorPricing;
  private readonly history: OmpMonitorHistory;
  private readonly performance: OmpPerformanceMonitor;
  private readonly files = new Map<string, FileState>();
  private readonly candidates = new Map<string, Map<string, Candidate>>();
  private readonly canonical = new Map<string, Candidate>();
  private readonly insertionOrder = new Map<string, { key: string; fileId: string }>();
  private readonly snapshots = new Map<string, OmpMonitorSnapshot>();
  private numericRevision = 0;
  private retainedCutoff: number | null = null;
  private discoveryIssues = new Set<MonitorIssue>();
  private roots: RootState[] = [];
  private pendingBytes = 0;
  private pendingTools = 0;
  private order = 0;
  private checkCursor = 0;
  private lastDiscovery = -Infinity;
  private currentNow = 0;
  private cutoff = 0;
  private droppedRecords = false;
  private discoverySkipped = 0;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: OmpLocalMonitorOptions = {}) {
    this.configuredRoots = options.roots
      ?.slice(0, MAX_ROOTS + 1)
      .map((root) => ({ path: path.resolve(root.path), label: safeLabel(root.label, "OMP") }));
    this.clock = options.now ?? Date.now;
    this.getPricing = options.getPricing ?? getBundledPricingState;
    this.history = new OmpMonitorHistory(options.estimateCost);
    this.performance = new OmpPerformanceMonitor({ cacheDir: options.performanceCacheDir });
    this.currentNow = this.readNow();
    this.cutoff = calendarDays(this.currentNow)[0]!.start;
    this.retainedCutoff = this.cutoff;
  }

  poll(options: { refresh?: boolean } = {}): Promise<OmpMonitorSnapshot> {
    const result = this.queue.then(() => this.collect(options.refresh === true));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.files.clear();
    this.candidates.clear();
    this.canonical.clear();
    this.insertionOrder.clear();
    this.snapshots.clear();
    this.history.clear();
    this.performance.dispose();
    this.pendingBytes = 0;
    this.pendingTools = 0;
    this.roots = [];
  }

  getSnapshot(scope: OmpMonitorScope = { profile: null, project: null }): OmpMonitorSnapshot {
    const selected: OmpMonitorScope = {
      profile: scope.profile === null ? null : safeLabel(scope.profile, ""),
      project: scope.project === null ? null : safeLabel(scope.project, ""),
    };
    const pricing = this.getPricing();
    const cacheKey = JSON.stringify([selected, pricing]);
    const cached = this.snapshots.get(cacheKey);
    if (cached) return cached;
    const now = this.currentNow;
    const priceVersion = `${pricing.prices.version}:${pricing.prices.fetchedAt ?? ""}:${Math.floor(now / 60_000)}`;
    const files = scopeFiles(this.files.values(), selected);
    const facts = scopeResponses(this.canonical.values(), files.ids, now);
    const activity = projectActivity(files, facts, now, (input) =>
      this.history.quoteCost(input, priceVersion),
    );
    const live = liveMetrics(facts.responses, activity.estimates, now);
    const history = this.history.getDays(
      selected,
      facts.responses,
      now,
      this.numericRevision,
      priceVersion,
    );
    const currentPeak = history.peaks.at(-1)!;
    const coverage = projectCoverage(files.all, this.roots, {
      issues: this.discoveryIssues,
      skipped: this.discoverySkipped,
      droppedRecords: this.droppedRecords,
      visibleCount: activity.visibleCount,
      numericLimited: history.limited,
    });
    const snapshot: OmpMonitorSnapshot = {
      updatedAt: now,
      scope: selected,
      scopes: filterOptions(files, this.roots),
      resources: {
        status: "unavailable",
        sampledAt: now,
        processCount: 0,
        cpuPercent: null,
        workingSetBytes: null,
        privateBytes: null,
        reason: "unsupported",
      },
      pricing,
      status: coverageStatus(coverage),
      activity: {
        lastResponseAt: history.lastResponseAt,
        peakAt: currentPeak.at,
        peakObservedAt: currentPeak.observedAt,
      },
      rate: {
        measuredTps: live.measuredTps,
        estimatedTps: live.estimatedTps,
        estimatedShare: live.estimatedShare,
        measuredThinkingTps: live.measuredThinkingTps,
        estimatedThinkingTps: live.estimatedThinkingTps,
      },
      today: currentDayUsage(history.days),
      days: history.days,
      performance: this.performance.getSnapshot(
        files.ids,
        now,
        new Set(activity.agents.map((agent) => agent.id)),
      ),
      agents: activity.agents,
      series: live.series,
      coverage,
    };
    if (this.snapshots.size >= 9) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(cacheKey, snapshot);
    return snapshot;
  }

  private readNow(): number {
    const now = this.clock();
    return Number.isFinite(now) ? Math.max(0, Math.min(MAX_CLOCK_MS, Math.trunc(now))) : Date.now();
  }

  private async collect(refresh: boolean): Promise<OmpMonitorSnapshot> {
    if (this.disposed) throw new Error("Monitor disposed");
    this.currentNow = this.readNow();
    this.snapshots.clear();
    const dates = calendarDays(this.currentNow);
    this.cutoff = dates[0]!.start;
    await this.refreshDiscovery(refresh);
    this.pruneRetention(dates.at(-1)!.end + STALE_MS);
    await this.readScheduled();
    for (const file of this.files.values()) {
      file.parser.discardStaleTools(this.currentNow);
      this.syncToolCount(file);
    }
    const performanceSources: OmpPerformanceSource[] = [];
    for (const file of this.files.values()) {
      const source: OmpPerformanceSource = {
        id: file.id,
        path: file.path,
        phase: this.currentNow - file.parser.lastActivityAt > STALE_MS ? "idle" : file.parser.phase,
      };
      if (file.identity) source.identity = file.identity;
      performanceSources.push(source);
    }
    await this.performance.poll(performanceSources, this.currentNow, {
      revision: this.numericRevision,
      owner: (key) => this.canonical.get(key)?.file.id,
    });
    this.snapshots.clear();
    return this.getSnapshot();
  }

  private async refreshDiscovery(refresh: boolean): Promise<void> {
    if (
      !refresh &&
      this.currentNow - this.lastDiscovery < REDISCOVER_MS &&
      this.currentNow >= this.lastDiscovery
    )
      return;
    try {
      await this.discover();
    } catch (error) {
      this.lastDiscovery = -Infinity;
      this.discoveryIssues.add("unreadable");
      throw error;
    }
  }

  private pruneRetention(futureLimit: number): void {
    if (this.retainedCutoff === this.cutoff) return;
    for (const [key, entries] of this.candidates) {
      for (const [fileId, candidate] of entries) {
        if (candidate.response.endMs < this.cutoff || candidate.response.endMs > futureLimit)
          this.removeCandidate(key, fileId);
      }
    }
    this.retainedCutoff = this.cutoff;
  }

  private async readScheduled(): Promise<void> {
    const scheduled = scheduleFiles([...this.files.values()], this.currentNow, this.checkCursor);
    this.checkCursor = scheduled.nextCursor;
    const budget: ReadBudget = { bytes: MONITOR_LIMITS.pollBytes, lines: MONITOR_LIMITS.pollLines };
    let checked = 0;
    // All selected live tails get their priority lane before any large-file history.
    for (const file of scheduled.files) {
      if (
        this.disposed ||
        checked++ >= MONITOR_LIMITS.pollFiles ||
        budget.bytes <= 0 ||
        budget.lines <= 0
      )
        break;
      file.readAllowance = MONITOR_LIMITS.perFileBytes;
      if (file.tail || file.observedMtime >= this.currentNow - RECENT_MS)
        await this.read(file, budget, true);
    }
    checked = 0;
    for (const file of scheduled.files) {
      if (
        this.disposed ||
        checked++ >= MONITOR_LIMITS.pollFiles ||
        budget.bytes <= 0 ||
        budget.lines <= 0
      )
        break;
      if (
        file.tail
          ? file.offset >= file.tail.start
          : file.observedMtime >= this.currentNow - RECENT_MS
      )
        continue;
      await this.read(file, budget, false);
    }
  }

  private resolveRoots(): Promise<RootResolution> {
    if (!this.configuredRoots) return resolveOmpMonitorRoots();
    return Promise.resolve({
      roots: this.configuredRoots.slice(0, MAX_ROOTS),
      limited: this.configuredRoots.length > MAX_ROOTS,
      unreadable: false,
    });
  }

  private async discover(): Promise<void> {
    this.lastDiscovery = this.currentNow;
    const result = await new OmpFileDiscovery(await this.resolveRoots()).scan();
    this.roots = result.roots;
    this.discoveryIssues = result.issues;
    this.discoverySkipped = result.skipped;
    for (const file of this.files.values()) {
      if (result.missingRoots.has(normalizedPath(file.root.path))) this.removeFile(file);
    }
    let complete = result.complete;
    for (const entry of result.files) if (!this.registerFile(entry)) complete = false;
    if (!complete) return;
    for (const [key, file] of this.files) if (!result.seen.has(key)) this.removeFile(file);
  }

  private registerFile(entry: DiscoveredFile): boolean {
    const key = normalizedPath(entry.path);
    const existing = this.files.get(key);
    if (existing) {
      if (existing.root.label !== entry.root.label) this.numericRevision++;
      existing.root = entry.root;
      existing.observedMtime = entry.stat.mtimeMs;
      existing.dirty ||= fileChanged(existing, entry.stat);
      return true;
    }
    if (this.files.size >= MONITOR_LIMITS.files) {
      this.discoveryIssues.add("file_limit");
      this.discoverySkipped++;
      return false;
    }
    this.files.set(key, newFileState(entry, this.order++));
    return true;
  }

  private reset(file: FileState): void {
    for (const key of file.keys) this.removeCandidate(key, file.id);
    this.pendingBytes -= file.pendingLength + (file.tail?.pendingLength ?? 0);
    this.pendingTools -= file.toolCount;
    file.toolCount = 0;
    file.parser = new OmpNumericParser(file.id);
    file.offset = 0;
    file.parts = [];
    file.pendingLength = 0;
    file.discardLine = false;
    file.tail = null;
    file.headerEnd = 0;
    file.feedbackStart = 0;
    file.ingestPosition = 0;
    file.ingestFeedback = true;
    file.initialized = false;
    file.complete = false;
    file.malformed = 0;
    file.issues.clear();
    file.prefixStart = 0;
    file.guardStart = 0;
    file.prefixHash = "";
    file.prefixLength = 0;
    file.guardHash = "";
    file.guardLength = 0;
  }

  private async inspectFile(file: FileState): Promise<Stats | null> {
    const info = await lstat(file.path);
    if (!info.isFile() || info.isSymbolicLink()) {
      this.removeFile(file);
      return null;
    }
    if (!(await regularDirectory(path.dirname(file.path)))) {
      // Permission failures remain partial, not a fabricated empty success.
      await lstat(path.dirname(file.path));
      this.removeFile(file);
      return null;
    }
    return info;
  }

  private async read(file: FileState, budget: ReadBudget, liveFirst: boolean): Promise<void> {
    if (file.readAllowance <= 0) return;
    let handle: FileHandle | undefined;
    try {
      const info = await this.inspectFile(file);
      if (!info) return;
      const identity = fileIdentity(info);
      file.observedMtime = info.mtimeMs;
      const changed = fileChanged(file, info);
      if (file.initialized && !changed && file.complete && !file.issues.has("unreadable")) {
        file.dirty = false;
        return;
      }
      handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (fileIdentity(await handle.stat()) !== identity) {
        file.dirty = true;
        return;
      }
      await this.prepareRead(file, handle, info, changed, identity);
      if (file.tail) {
        await this.readCursor(
          file,
          liveFirst ? file.tail : file,
          handle,
          liveFirst ? info.size : file.tail.start,
          budget,
          !liveFirst,
        );
      } else {
        await this.readCursor(file, file, handle, info.size, budget, false);
      }
      await this.finishRead(file, handle, info.size);
    } catch (error) {
      this.readFailure(file, error);
    } finally {
      await handle?.close();
    }
  }

  private async needsReset(
    file: FileState,
    handle: FileHandle,
    info: Stats,
    changed: boolean,
    identity: string,
  ): Promise<boolean> {
    if (!file.initialized) return false;
    if (
      identity !== file.identity ||
      info.size < Math.max(file.offset, file.tail?.offset ?? 0) ||
      (changed && info.size <= file.size)
    )
      return true;
    if (!changed) return false;
    if (!(await this.probeMatches(handle, file.prefixStart, file.prefixLength, file.prefixHash)))
      return true;
    return !(await this.probeMatches(handle, file.guardStart, file.guardLength, file.guardHash));
  }

  private async probeMatches(
    handle: FileHandle,
    start: number,
    length: number,
    hash: string,
  ): Promise<boolean> {
    if (!length) return true;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return bytesRead === length && hashId(buffer.toString("base64")) === hash;
  }

  private async prepareRead(
    file: FileState,
    handle: FileHandle,
    info: Stats,
    changed: boolean,
    identity: string,
  ): Promise<void> {
    if (await this.needsReset(file, handle, info, changed, identity)) this.reset(file);
    if (!file.initialized) await this.initializeFile(file, handle, info.size);
    else if (
      !file.tail &&
      info.size > MONITOR_LIMITS.perFileBytes &&
      info.size <= MONITOR_LIMITS.fileBytes &&
      file.observedMtime >= this.currentNow - RECENT_MS
    )
      await this.initializeTail(file, handle, info.size);
    file.identity = identity;
    file.size = info.size;
    file.mtime = info.mtimeMs;
    file.ctime = info.ctimeMs;
    file.dirty = false;
    file.issues.delete("unreadable");
    file.complete = false;
  }

  private probeHeaderLines(file: FileState, header: Buffer, tail: boolean): void {
    let start = 0;
    for (let line = 0; line < 2 && start < header.length; line++) {
      const newline = header.indexOf(10, start);
      if (newline < 0) break;
      let value: unknown;
      try {
        value = JSON.parse(utf8.decode(header.subarray(start, newline)));
      } catch {
        /* The ordinary reader accounts for malformed complete lines. */
      }
      if (line === 0 && object(value)?.type === "title") file.prefixStart = newline + 1;
      if (object(value)?.type === "session") {
        file.headerEnd = newline + 1;
        if (tail) this.apply(file, value);
      }
      start = newline + 1;
    }
  }

  private async initializeFile(file: FileState, handle: FileHandle, size: number): Promise<void> {
    const fastTail =
      size > MONITOR_LIMITS.perFileBytes &&
      size <= MONITOR_LIMITS.fileBytes &&
      file.observedMtime >= this.currentNow - RECENT_MS;
    const header = Buffer.allocUnsafe(Math.min(64 * 1_024, size));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    this.probeHeaderLines(
      file,
      header.subarray(0, bytesRead),
      fastTail || size > MONITOR_LIMITS.fileBytes,
    );
    file.prefixLength = Math.max(0, Math.min(512, bytesRead - file.prefixStart));
    file.prefixHash = hashId(
      header.subarray(file.prefixStart, file.prefixStart + file.prefixLength).toString("base64"),
    );
    if (size > MONITOR_LIMITS.fileBytes) {
      file.offset = size - MONITOR_LIMITS.tailBytes;
      file.discardLine = true;
      file.feedbackStart = size;
      file.issues.add("file_limit");
    } else if (fastTail) {
      await this.initializeTail(file, handle, size);
    }
    file.initialized = true;
  }

  private async initializeTail(file: FileState, handle: FileHandle, size: number): Promise<void> {
    const windowBytes = Math.max(
      1,
      Math.min(1_024 * 1_024, Math.floor(MONITOR_LIMITS.perFileBytes / 2)),
    );
    const start = size - windowBytes;
    if (!file.parser.headerSeen || file.offset >= start) return;
    const previous = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(previous, 0, 1, start - 1);
    const boundaryPending = bytesRead !== 1 || previous[0] !== 10;
    file.tail = {
      start,
      offset: start,
      parts: [],
      pendingLength: 0,
      discardLine: boundaryPending,
      boundaryPending,
    };
    file.feedbackStart = size;
    file.parser.startTailMerge();
  }

  private async readCursor(
    file: FileState,
    reader: FileReadCursor,
    handle: FileHandle,
    end: number,
    budget: ReadBudget,
    historyOnly: boolean,
  ): Promise<void> {
    while (
      reader.offset < end &&
      file.readAllowance > 0 &&
      budget.bytes > 0 &&
      budget.lines > 0 &&
      !this.disposed
    ) {
      const bytes = Math.min(256 * 1_024, file.readAllowance, budget.bytes, end - reader.offset);
      const buffer = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, reader.offset);
      if (!bytesRead) break;
      const consumed = this.consume(
        file,
        reader,
        buffer.subarray(0, bytesRead),
        budget,
        historyOnly,
      );
      reader.offset += consumed;
      budget.bytes -= bytesRead;
      file.readAllowance -= bytesRead;
      if (consumed < bytesRead) break;
    }
    file.read = true;
  }

  private async finishRead(file: FileState, handle: FileHandle, size: number): Promise<void> {
    if (
      file.tail &&
      !file.tail.boundaryPending &&
      file.offset >= file.tail.start &&
      file.parser.finishTailMerge()
    )
      this.syncToolCount(file);
    file.complete = file.tail
      ? !file.tail.boundaryPending && file.offset >= file.tail.start && file.tail.offset >= size
      : file.offset >= size;
    const offset = file.tail?.offset ?? file.offset;
    const start = Math.max(file.prefixStart, offset - 512);
    const length = Math.min(512, Math.max(0, offset - start));
    if (start !== file.guardStart || length !== file.guardLength || !file.guardHash) {
      file.guardStart = start;
      file.guardLength = length;
      if (length) {
        const guard = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(guard, 0, length, start);
        file.guardHash = hashId(guard.subarray(0, bytesRead).toString("base64"));
      }
    }
    const after = await lstat(file.path);
    if (after.isSymbolicLink() || !after.isFile()) {
      this.removeFile(file);
      return;
    }
    file.dirty = fileChanged(file, after);
  }

  private readFailure(file: FileState, error: unknown): void {
    if (!filesystemFailure(error)) throw error;
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      this.removeFile(file);
      return;
    }
    file.issues.add("unreadable");
    file.complete = true;
    file.dirty = false;
  }

  private releasePendingLine(reader: FileReadCursor): void {
    this.pendingBytes -= reader.pendingLength;
    reader.pendingLength = 0;
    reader.parts = [];
  }

  private discardLimitedLine(file: FileState, reader: FileReadCursor, length: number): void {
    if (reader.discardLine) return;
    if (
      reader.pendingLength + length <= MONITOR_LIMITS.lineBytes &&
      this.pendingBytes + length <= MONITOR_LIMITS.pendingBytes
    )
      return;
    file.issues.add("line_limit");
    this.releasePendingLine(reader);
    reader.discardLine = true;
  }

  private appendFragment(reader: FileReadCursor, fragment: Buffer): void {
    if (!fragment.length) return;
    reader.parts.push(Buffer.from(fragment));
    reader.pendingLength += fragment.length;
    this.pendingBytes += fragment.length;
  }

  private completeLine(
    file: FileState,
    reader: FileReadCursor,
    fragment: Buffer,
    position: number,
    historyOnly: boolean,
  ): void {
    let raw = fragment;
    if (reader.pendingLength) {
      reader.parts.push(fragment);
      raw = Buffer.concat(reader.parts, reader.pendingLength + fragment.length);
    }
    this.releasePendingLine(reader);
    let value: unknown;
    try {
      const text = utf8.decode(raw);
      if (!text.trim()) return;
      value = JSON.parse(text);
      if (!object(value)) {
        file.malformed++;
        return;
      }
    } catch {
      file.malformed++;
      return;
    }
    if (position <= file.headerEnd && object(value)?.type !== "session") return;
    file.ingestPosition = position;
    file.ingestFeedback = position > file.feedbackStart;
    this.apply(file, value, historyOnly && position <= file.feedbackStart);
  }

  private consume(
    file: FileState,
    reader: FileReadCursor,
    buffer: Buffer,
    budget: ReadBudget,
    historyOnly: boolean,
  ): number {
    let position = 0;
    while (position < buffer.length && budget.lines > 0) {
      const newline = buffer.indexOf(10, position);
      const end = newline < 0 ? buffer.length : newline;
      this.discardLimitedLine(file, reader, end - position);
      if (!reader.discardLine) {
        const fragment = buffer.subarray(position, end);
        if (newline < 0) this.appendFragment(reader, fragment);
        else this.completeLine(file, reader, fragment, reader.offset + end + 1, historyOnly);
      }
      if (newline < 0) return buffer.length;
      if (file.tail && reader === file.tail && file.tail.boundaryPending) {
        file.tail.start = reader.offset + end + 1;
        file.tail.boundaryPending = false;
      }
      reader.discardLine = false;
      budget.lines--;
      position = newline + 1;
    }
    return position;
  }

  private apply(file: FileState, value: unknown, historyOnly = false): void {
    file.parser.apply(value, this.sink(file), historyOnly, file.ingestPosition);
    this.syncToolCount(file);
  }

  private syncToolCount(file: FileState): void {
    const count = file.parser.retainedToolCount;
    this.pendingTools += count - file.toolCount;
    file.toolCount = count;
  }

  private sink(file: FileState): NumericSink {
    if (file.sink) return file.sink;
    return (file.sink = {
      acceptTools: (count) =>
        this.pendingTools - file.toolCount + count <= MONITOR_LIMITS.pendingTools,
      otherOwner: (key) => {
        const owner = this.canonical.get(key);
        return owner !== undefined && owner.file.id !== file.id && owner.file.order < file.order;
      },
      upsert: (response) => {
        return this.upsert(file, response);
      },
      limit: () => {
        file.issues.add("record_limit");
      },
    });
  }

  private upsert(file: FileState, response: NumericResponse): boolean {
    if (this.disposed) return false;
    if (response.endMs < this.cutoff || response.endMs > this.currentNow + STALE_MS) return true;
    const composite = `${file.id}:${response.key}`;
    const existing = this.candidates.get(response.key)?.get(file.id);
    // Tail-first extraction may encounter a newer revision before an older history copy.
    if (existing && existing.position > file.ingestPosition) return false;
    const sameCompletion =
      existing !== undefined && sameCompletionFacts(existing.response, response);
    response.feedbackEligible = sameCompletion
      ? existing.response.feedbackEligible
      : file.ingestFeedback;
    if (existing && sameResponseFacts(existing.response, response)) {
      existing.position = file.ingestPosition;
      return false;
    }
    if (!existing && this.insertionOrder.size >= MONITOR_LIMITS.records) {
      const oldest = this.insertionOrder.values().next().value;
      if (oldest) this.removeCandidate(oldest.key, oldest.fileId);
      this.droppedRecords = true;
    }
    const entries = this.candidates.get(response.key) ?? new Map<string, Candidate>();
    const candidate = { file, response, position: file.ingestPosition };
    entries.set(file.id, candidate);
    this.candidates.set(response.key, entries);
    file.keys.add(response.key);
    this.insertionOrder.delete(composite);
    this.insertionOrder.set(composite, { key: response.key, fileId: file.id });
    const canonical = this.canonical.get(response.key);
    if (!canonical || canonical.file.id === file.id || file.order < canonical.file.order) {
      this.canonical.set(response.key, candidate);
      this.numericRevision++;
    }
    return !sameCompletion;
  }

  private removeCandidate(key: string, fileId: string): void {
    const entries = this.candidates.get(key);
    const candidate = entries?.get(fileId);
    const owned = this.canonical.get(key)?.file.id === fileId;
    if (owned) this.numericRevision++;
    candidate?.file.keys.delete(key);
    entries?.delete(fileId);
    this.insertionOrder.delete(`${fileId}:${key}`);
    if (!entries?.size) {
      this.candidates.delete(key);
      this.canonical.delete(key);
      return;
    }
    if (!owned) return;
    let owner: Candidate | undefined;
    for (const alternative of entries.values()) {
      if (!owner || alternative.file.order < owner.file.order) owner = alternative;
    }
    if (owner) this.canonical.set(key, owner);
  }

  private removeFile(file: FileState): void {
    if (!this.files.has(normalizedPath(file.path))) return;
    for (const key of file.keys) this.removeCandidate(key, file.id);
    this.pendingBytes -= file.pendingLength + (file.tail?.pendingLength ?? 0);
    this.pendingTools -= file.toolCount;
    this.files.delete(normalizedPath(file.path));
  }
}
