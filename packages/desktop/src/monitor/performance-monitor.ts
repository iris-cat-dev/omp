// Agent Speed v1.6.0 (MIT). Ordered OMP performance facts only; no reporters or extra collection sources.
import {
  createPerformanceRecorder,
  evaluatePerformance,
  performanceBaseline,
} from "./performance.js";
import { OmpOrderedPerformanceFile } from "./performance-reader-file.js";
import type { OmpPerformanceSource, PerformanceReadBudget } from "./performance-reader-file.js";
import type { OmpPerformanceFacts, OmpPerformanceLineReader } from "./performance-reader.js";
import { OmpPerformanceStorage } from "./performance-storage.js";
import type {
  MonitorPerformanceEvaluation,
  MonitorPerformanceRecord,
  OmpMonitorPerformance,
} from "./performance-types.js";
import { calendarDays } from "./math.js";
import { MONITOR_LIMITS } from "./state.js";
export type { OmpPerformanceSource } from "./performance-reader-file.js";

export const PERFORMANCE_MONITOR_LIMITS = {
  pollBytes: 1_048_576,
  fileBytes: 262_144,
  pollLines: 4096,
  fileLines: 1024,
  pollMs: 24,
  maxFiles: Number(MONITOR_LIMITS.files),
  maxRetainedBytes: 33_554_432,
  maxRecords: 8192,
};
/** The numeric collector's canonical request owner, shared without copying numeric billing records. */
export interface PerformanceOwnership {
  revision: number;
  owner: (key: string) => string | undefined;
}
interface Derived {
  stream: OmpPerformanceLineReader;
  revision: number;
  ownerVersion: number;
  floor: number;
  atMs: number;
  nextFutureMs: number;
  facts: OmpPerformanceFacts;
  records: MonitorPerformanceRecord[];
  retainedBytes: number;
}
interface HistorySelection {
  version: number;
  records: MonitorPerformanceRecord[];
  limited: boolean;
}
function compareRecords(a: MonitorPerformanceRecord, b: MonitorPerformanceRecord): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.model !== b.model) return a.model < b.model ? -1 : 1;
  const left = a.agentId ?? "",
    right = b.agentId ?? "";
  return left < right ? -1 : Number(left > right);
}
function localDay(atMs: number): string | null {
  const date = new Date(atMs),
    year = date.getFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) return null;
  return `${year.toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}
export class OmpPerformanceMonitor {
  private readonly files = new Map<string, OmpOrderedPerformanceFile>();
  private readonly derived = new Map<string, Derived>();
  private readonly lastServed = new Map<string, number>();
  private readonly storage: OmpPerformanceStorage;
  private owners = new Map<string, string>();
  private ownersDirty = true;
  private ownership: PerformanceOwnership | undefined;
  private ownershipRevision: number | undefined;
  private readonly ownerVersions = new Map<string, number>();
  private tick = 0;
  private disposed = false;
  private loading: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private sourceLimited = false;
  private memoryLimited = false;
  private historyVersion = 0;
  private history: HistorySelection = { version: -1, records: [], limited: false };
  private readonly scopes = new Map<string, HistorySelection>();
  private lastPersisted: readonly MonitorPerformanceRecord[] | null = null;
  private baselineVersion = -1;
  private baselineToday = "";
  private readonly baselineScores = new Map<string, number | null>();
  private cutoff = -Infinity;
  constructor(options: { cacheDir?: string } = {}) {
    this.storage = new OmpPerformanceStorage(options.cacheDir);
  }
  async poll(
    sources: OmpPerformanceSource[],
    now: number,
    ownership?: PerformanceOwnership,
  ): Promise<void> {
    if (this.disposed) return;
    if (this.polling) return this.polling;
    const running = this.pollSources(sources, now, ownership);
    this.polling = running;
    try {
      await running;
    } finally {
      if (this.polling === running) this.polling = null;
    }
  }
  private async pollSources(
    sources: OmpPerformanceSource[],
    now: number,
    ownership?: PerformanceOwnership,
  ): Promise<void> {
    this.loading ??= this.storage.load(now);
    await this.loading;
    if (this.disposed) return;
    if (
      this.ownershipRevision !== ownership?.revision ||
      Boolean(this.ownership) !== Boolean(ownership)
    )
      this.ownersDirty = true;
    this.ownership = ownership;
    this.ownershipRevision = ownership?.revision;
    const wanted = this.selectSources(sources);
    this.reconcileSources(wanted, now);
    await this.readSources();
    if (this.disposed) return;
    this.refreshOwners();
    const history = this.allHistory(now);
    if (history.records !== this.lastPersisted) {
      await this.storage.save(history.records, now, () => !this.disposed);
      if (!this.disposed) this.lastPersisted = history.records;
    }
  }
  private selectSources(sources: OmpPerformanceSource[]): Map<string, OmpPerformanceSource> {
    const wanted = new Map<string, OmpPerformanceSource>();
    this.sourceLimited = sources.length > PERFORMANCE_MONITOR_LIMITS.maxFiles;
    for (const source of sources) {
      if (wanted.size >= PERFORMANCE_MONITOR_LIMITS.maxFiles) break;
      if (
        typeof source.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(source.id) ||
        typeof source.path !== "string" ||
        !["generating", "tools", "idle"].includes(source.phase) ||
        wanted.has(source.id)
      ) {
        this.sourceLimited = true;
        continue;
      }
      wanted.set(source.id, source);
    }
    return wanted;
  }
  private reconcileSources(wanted: ReadonlyMap<string, OmpPerformanceSource>, now: number): void {
    for (const [id, file] of this.files) {
      if (wanted.has(id)) continue;
      file.dispose();
      this.files.delete(id);
      this.derived.delete(id);
      this.lastServed.delete(id);
      this.ownerVersions.delete(id);
      this.ownersDirty = true;
      this.historyVersion++;
    }
    this.storage.retain(new Set(wanted.keys()));
    const floor = calendarDays(now)[0]!.start,
      changedDate = floor !== this.cutoff;
    this.cutoff = floor;
    for (const [id, source] of wanted) {
      let file = this.files.get(id);
      if (
        file &&
        (file.source.path !== source.path ||
          (source.identity && file.identity && source.identity !== file.identity))
      ) {
        file.dispose();
        this.files.delete(id);
        this.derived.delete(id);
        this.ownersDirty = true;
        this.historyVersion++;
        file = undefined;
      }
      if (!file) {
        this.files.set(id, new OmpOrderedPerformanceFile(source, floor));
        this.ownersDirty = true;
        this.historyVersion++;
      } else {
        file.source = { ...source };
        if (changedDate) {
          file.advanceFloor(floor);
          this.ownersDirty = true;
          this.historyVersion++;
        }
      }
    }
  }
  private async readSources(): Promise<void> {
    const start = performance.now(),
      budget: PerformanceReadBudget = {
        bytes: PERFORMANCE_MONITOR_LIMITS.pollBytes,
        lines: PERFORMANCE_MONITOR_LIMITS.pollLines,
        deadline: start + PERFORMANCE_MONITOR_LIMITS.pollMs,
        alive: () => !this.disposed,
      };
    const order = [...this.files.values()].sort(
        (a, b) => (this.lastServed.get(a.source.id) ?? 0) - (this.lastServed.get(b.source.id) ?? 0),
      ),
      active = order.filter((file) => file.source.phase !== "idle"),
      idle = order.filter((file) => file.source.phase === "idle");
    let retained = this.retainedBytes();
    this.memoryLimited = retained >= PERFORMANCE_MONITOR_LIMITS.maxRetainedBytes;
    const read = async (file: OmpOrderedPerformanceFile, deadline: number): Promise<void> => {
      if (retained >= PERFORMANCE_MONITOR_LIMITS.maxRetainedBytes) {
        this.memoryLimited = true;
        return;
      }
      const local: PerformanceReadBudget = {
          bytes: Math.min(budget.bytes, PERFORMANCE_MONITOR_LIMITS.fileBytes),
          lines: Math.min(budget.lines, PERFORMANCE_MONITOR_LIMITS.fileLines),
          deadline: Math.min(budget.deadline, deadline),
          alive: budget.alive,
        },
        beforeBytes = local.bytes,
        beforeLines = local.lines,
        beforeMemory = file.retainedBytes,
        generation = file.generation,
        revision = file.stream.revision,
        requests = file.stream.requests.size,
        ready = file.caughtUp;
      await file.poll(local);
      budget.bytes -= beforeBytes - local.bytes;
      budget.lines -= beforeLines - local.lines;
      retained += file.retainedBytes - beforeMemory;
      this.lastServed.set(file.source.id, ++this.tick);
      if (generation !== file.generation || requests !== file.stream.requests.size)
        this.ownersDirty = true;
      if (
        revision !== file.stream.revision ||
        ready !== file.caughtUp ||
        generation !== file.generation
      ) {
        retained -= this.derived.get(file.source.id)?.retainedBytes ?? 0;
        this.derived.delete(file.source.id);
        this.historyVersion++;
      }
    };
    const activeDeadline = idle.length
      ? start + (PERFORMANCE_MONITOR_LIMITS.pollMs * 2) / 3
      : budget.deadline;
    for (const file of active) {
      if (
        budget.bytes <= (idle.length ? PERFORMANCE_MONITOR_LIMITS.fileBytes : 0) ||
        budget.lines <= (idle.length ? PERFORMANCE_MONITOR_LIMITS.fileLines : 0) ||
        performance.now() >= activeDeadline ||
        this.disposed ||
        this.memoryLimited
      )
        break;
      await read(file, activeDeadline);
    }
    for (const file of idle) {
      if (
        budget.bytes <= 0 ||
        budget.lines <= 0 ||
        performance.now() >= budget.deadline ||
        this.disposed ||
        this.memoryLimited
      )
        break;
      await read(file, budget.deadline);
    }
  }
  private retainedBytes(): number {
    let bytes = 0;
    for (const file of this.files.values()) bytes += file.retainedBytes;
    for (const facts of this.derived.values()) bytes += facts.retainedBytes;
    return bytes;
  }
  private refreshOwners(): void {
    if (!this.ownersDirty) return;
    this.ownersDirty = false;
    const next = new Map<string, string>(),
      changed = new Set<string>();
    for (const [id, file] of this.files) {
      for (const request of file.stream.requests) {
        const owner = this.ownership ? this.ownership.owner(request) : (next.get(request) ?? id);
        if (owner !== undefined) next.set(request, owner);
      }
    }
    for (const [key, id] of this.owners) {
      if (next.get(key) === id) continue;
      changed.add(id);
      const replacement = next.get(key);
      if (replacement) changed.add(replacement);
    }
    for (const [key, id] of next) if (this.owners.get(key) !== id) changed.add(id);
    this.owners = next;
    for (const id of changed) this.ownerVersions.set(id, (this.ownerVersions.get(id) ?? 0) + 1);
    if (changed.size) this.historyVersion++;
  }
  private facts(id: string, file: OmpOrderedPerformanceFile, now: number): Derived {
    const previous = this.derived.get(id),
      ownerVersion = this.ownerVersions.get(id) ?? 0;
    if (
      previous &&
      previous.stream === file.stream &&
      previous.revision === file.stream.revision &&
      previous.ownerVersion === ownerVersion &&
      previous.floor === this.cutoff &&
      now >= previous.atMs &&
      now < previous.nextFutureMs
    )
      return previous;
    const facts = file.stream.facts((key) => {
      const owner = this.owners.get(key);
      return owner === id || (owner === undefined && !file.stream.requests.has(key));
    });
    const recorder = createPerformanceRecorder((atMs) => (atMs <= now ? localDay(atMs) : null));
    let nextFutureMs = Infinity;
    for (const completion of facts.completions) {
      if ("key" in completion) {
        const response = file.stream.responses.get(completion.key);
        if (!response) continue;
        recorder.response(id, "omp", response);
        if (response.endMs > now) nextFutureMs = Math.min(nextFutureMs, response.endMs);
      } else {
        recorder.action(id, "omp", completion.action);
        if (completion.action.resultMs !== null && completion.action.resultMs > now)
          nextFutureMs = Math.min(nextFutureMs, completion.action.resultMs);
      }
    }
    const firstDay = localDay(this.cutoff) ?? "";
    const records: MonitorPerformanceRecord[] = [];
    for (const record of recorder.rows()) {
      if (record.day < firstDay) continue;
      record.agentId = id;
      records.push(record);
    }
    const derived: Derived = {
      stream: file.stream,
      revision: file.stream.revision,
      ownerVersion,
      floor: this.cutoff,
      atMs: now,
      nextFutureMs,
      facts,
      records: this.storage.reuse(id, records),
      retainedBytes:
        facts.responses.length * 16 +
        facts.actions.length * 96 +
        facts.completions.length * 96 +
        records.length * 1024,
    };
    this.derived.set(id, derived);
    this.historyVersion++;
    return derived;
  }
  private allHistory(now: number): HistorySelection {
    const selected: Derived[] = [];
    for (const [id, file] of this.files)
      if (file.caughtUp && file.stream.headerSeen) selected.push(this.facts(id, file, now));
    this.memoryLimited = this.retainedBytes() >= PERFORMANCE_MONITOR_LIMITS.maxRetainedBytes;
    if (this.history.version === this.historyVersion) return this.history;
    let records = selected.flatMap((item) => item.records).sort(compareRecords);
    const limited = records.length > PERFORMANCE_MONITOR_LIMITS.maxRecords;
    if (limited) records = records.slice(-PERFORMANCE_MONITOR_LIMITS.maxRecords);
    this.history = { version: this.historyVersion, records, limited };
    return this.history;
  }
  private scopedHistory(ids: ReadonlySet<string>, all: HistorySelection): HistorySelection {
    const key = JSON.stringify([...ids].sort()),
      cached = this.scopes.get(key);
    if (cached?.version === all.version) return cached;
    const selected = {
      version: all.version,
      records: all.records.filter((row) => ids.has(row.agentId!)),
      limited: all.limited,
    };
    this.scopes.set(key, selected);
    if (this.scopes.size > 16) this.scopes.delete(this.scopes.keys().next().value!);
    return selected;
  }
  private currentValue(
    id: string,
    file: OmpOrderedPerformanceFile,
    now: number,
    records: MonitorPerformanceRecord[],
    today: string,
  ): MonitorPerformanceEvaluation {
    const facts = file.caughtUp && file.stream.headerSeen ? this.facts(id, file, now).facts : null,
      lastLineMs = file.stream.lastLineMs,
      phase = now - lastLineMs > 300_000 || lastLineMs > now ? "idle" : file.source.phase;
    return evaluatePerformance(
      { id, source: "omp", phase, lastLineMs },
      facts?.responses ?? [],
      facts?.actions ?? [],
      now,
      records,
      today,
    );
  }
  getSnapshot(
    ids: ReadonlySet<string>,
    now: number,
    currentIds: ReadonlySet<string> = ids,
  ): OmpMonitorPerformance {
    if (this.disposed)
      return { current: {}, records: [], baselines: [], scanning: false, limited: false };
    this.refreshOwners();
    const all = this.allHistory(now),
      selected = this.scopedHistory(ids, all),
      current = Object.create(null) as Record<string, MonitorPerformanceEvaluation>,
      today = localDay(now) ?? "";
    let scanning = false,
      limited =
        this.sourceLimited || this.memoryLimited || this.storage.limited || selected.limited;
    for (const id of ids) {
      const file = this.files.get(id);
      if (!file) continue;
      scanning ||= file.scanning;
      limited ||= file.limited || file.stream.limited || file.unavailable || file.rejected;
      if (!currentIds.has(id)) continue;
      current[id] = this.currentValue(id, file, now, all.records, today);
    }
    const models = new Set(selected.records.map((row) => row.model));
    for (const evaluation of Object.values(current))
      if (evaluation.n > 0) models.add(evaluation.model ?? "");
    if (this.baselineVersion !== all.version || this.baselineToday !== today) {
      this.baselineScores.clear();
      this.baselineVersion = all.version;
      this.baselineToday = today;
    }
    const baselines = [...models].sort().map((model) => {
      if (!this.baselineScores.has(model))
        this.baselineScores.set(model, performanceBaseline(all.records, "omp", model, today));
      return { source: "omp", model, score: this.baselineScores.get(model) ?? null };
    });
    return { current, records: selected.records, baselines, scanning, limited };
  }
  dispose(): void {
    this.disposed = true;
    for (const file of this.files.values()) file.dispose();
    this.files.clear();
    this.derived.clear();
    this.owners.clear();
    this.ownerVersions.clear();
    this.lastServed.clear();
    this.scopes.clear();
    this.baselineScores.clear();
    this.history = { version: -1, records: [], limited: false };
    this.storage.dispose();
    this.lastPersisted = null;
  }
}
