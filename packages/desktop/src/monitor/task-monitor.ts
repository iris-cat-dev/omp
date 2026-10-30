// Agent Speed v1.5.0 local OMP task monitor (MIT). Independent ordered reader; no network/reporting.
import type {
  MonitorTaskEvaluation,
  MonitorTaskRecord,
  MonitorTaskStatus,
  OmpMonitorTasks,
} from "./task-types.js";
import type { MonitorTaskEvent } from "./task-events.js";
import { createTaskRecords, currentTask, evaluateTask, predictTask } from "./task-score.js";
import { OmpOrderedTaskFile } from "./task-reader-file.js";
import type { OmpTaskSource, TaskReadBudget } from "./task-reader-file.js";
import type { OmpTaskLineReader } from "./task-reader.js";
import { OmpTaskRecordStorage } from "./task-storage.js";
import { calendarDays } from "./math.js";
import { MONITOR_LIMITS } from "./state.js";
export type { OmpTaskSource } from "./task-reader-file.js";

export const TASK_MONITOR_LIMITS = {
  pollBytes: 1_048_576,
  fileBytes: 262_144,
  pollMs: 24,
  maxFiles: Number(MONITOR_LIMITS.files),
  maxRetainedBytes: 33_554_432,
  maxRecords: 8192,
};
interface Derived {
  stream: OmpTaskLineReader;
  revision: number;
  ownerVersion: number;
  idleComplete: boolean;
  future: boolean;
  events: MonitorTaskEvent[];
  records: MonitorTaskRecord[];
  evaluation: MonitorTaskEvaluation | null;
  startMs: number | null;
  currentReady: boolean;
}
interface SelectedTask {
  id: string;
  file: OmpOrderedTaskFile;
  facts: Derived;
}
interface ScopeHistory {
  version: number;
  floor: number;
  selection: string;
  records: MonitorTaskRecord[];
  limited: boolean;
}
function compareRecords(a: MonitorTaskRecord, b: MonitorTaskRecord): number {
  const time = a.endMs - b.endMs;
  if (time) return time;
  if (a.agentId < b.agentId) return -1;
  if (a.agentId > b.agentId) return 1;
  return a.ordinal - b.ordinal;
}
const none = (): MonitorTaskStatus => ({
  taskStartMs: null,
  result: null,
  predictions: null,
  form: "none",
});
export class OmpTaskMonitor {
  private readonly files = new Map<string, OmpOrderedTaskFile>();
  private readonly derived = new Map<string, Derived>();
  private readonly lastServed = new Map<string, number>();
  private readonly storage: OmpTaskRecordStorage;
  private owners = new Map<string, string>();
  private ownersDirty = true;
  private readonly ownerVersions = new Map<string, number>();
  private tick = 0;
  private disposed = false;
  private loading: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private sourceLimited = false;
  private memoryLimited = false;
  private historyVersion = 0;
  private scopeCache = new Map<string, ScopeHistory>();
  private lastPersisted: readonly MonitorTaskRecord[] | null = null;
  private cutoff = -Infinity;
  constructor(options: { cacheDir?: string } = {}) {
    this.storage = new OmpTaskRecordStorage(options.cacheDir);
  }
  async poll(sources: OmpTaskSource[], now: number): Promise<void> {
    if (this.disposed) return;
    // Parent calls are sequential; overlapping ticks share one read rather than interleave file order.
    if (this.polling) return this.polling;
    const running = this.pollSources(sources, now);
    this.polling = running;
    try {
      await running;
    } finally {
      if (this.polling === running) this.polling = null;
    }
  }
  private async pollSources(sources: OmpTaskSource[], now: number): Promise<void> {
    this.loading ??= this.storage.load(now);
    await this.loading;
    if (this.disposed) return;
    const wanted = this.selectSources(sources);
    this.reconcileSources(wanted, now);
    await this.readSources();
    if (this.disposed) return;
    this.refreshOwners();
    // History-only composition does not evaluate 20,000 current cards or per-agent predictions.
    const snapshot = this.getSnapshot(new Set(this.files.keys()), now, new Set());
    if (snapshot.records !== this.lastPersisted) {
      await this.storage.save(snapshot.records, now, () => !this.disposed);
      this.lastPersisted = snapshot.records;
    }
  }
  private selectSources(sources: OmpTaskSource[]): Map<string, OmpTaskSource> {
    const wanted = new Map<string, OmpTaskSource>();
    this.sourceLimited = sources.length > TASK_MONITOR_LIMITS.maxFiles;
    for (const source of [...sources].sort(
      (a, b) => Number(a.phase === "idle") - Number(b.phase === "idle"),
    )) {
      if (wanted.size >= TASK_MONITOR_LIMITS.maxFiles) break;
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
  private reconcileSources(wanted: ReadonlyMap<string, OmpTaskSource>, now: number): void {
    for (const [id, file] of this.files)
      if (!wanted.has(id)) {
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
        file = new OmpOrderedTaskFile(source, floor);
        this.files.set(id, file);
      } else {
        file.source = { ...source };
        if (changedDate) {
          file.advanceFloor(floor);
          this.ownersDirty = true;
        }
      }
    }
  }
  private async readSources(): Promise<void> {
    const start = performance.now(),
      budget: TaskReadBudget = {
        bytes: TASK_MONITOR_LIMITS.pollBytes,
        deadline: start + TASK_MONITOR_LIMITS.pollMs,
        alive: () => !this.disposed,
      };
    const order = [...this.files.values()].sort(
      (a, b) => (this.lastServed.get(a.source.id) ?? 0) - (this.lastServed.get(b.source.id) ?? 0),
    );
    const active = order.filter((f) => f.source.phase !== "idle"),
      idle = order.filter((f) => f.source.phase === "idle");
    // One complete accounting pass per poll, then constant-time deltas for each scheduled file.
    let retained = order.reduce((sum, file) => sum + file.retainedBytes, 0);
    this.memoryLimited = retained >= TASK_MONITOR_LIMITS.maxRetainedBytes;
    const read = async (file: OmpOrderedTaskFile, phaseDeadline: number): Promise<void> => {
      if (retained >= TASK_MONITOR_LIMITS.maxRetainedBytes) {
        this.memoryLimited = true;
        return;
      }
      const local: TaskReadBudget = {
        bytes: Math.min(budget.bytes, TASK_MONITOR_LIMITS.fileBytes),
        deadline: Math.min(budget.deadline, phaseDeadline),
        alive: budget.alive,
      };
      const bytesBefore = local.bytes,
        beforeMemory = file.retainedBytes,
        generation = file.generation,
        requests = file.stream.requests.size,
        ready = file.caughtUp;
      await file.poll(local);
      budget.bytes -= bytesBefore - local.bytes;
      retained += file.retainedBytes - beforeMemory;
      this.lastServed.set(file.source.id, ++this.tick);
      if (generation !== file.generation || requests !== file.stream.requests.size)
        this.ownersDirty = true;
      if (ready !== file.caughtUp) this.historyVersion++;
    };
    // Active files get the first 2/3; an idle-history reservation prevents an always-active session starving history.
    const activeDeadline = idle.length
      ? start + (TASK_MONITOR_LIMITS.pollMs * 2) / 3
      : budget.deadline;
    for (const file of active) {
      if (
        budget.bytes <= (idle.length ? TASK_MONITOR_LIMITS.fileBytes : 0) ||
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
        performance.now() >= budget.deadline ||
        this.disposed ||
        this.memoryLimited
      )
        break;
      await read(file, budget.deadline);
    }
  }
  private refreshOwners(): void {
    if (!this.ownersDirty) return;
    this.ownersDirty = false;
    const next = new Map<string, string>(),
      changed = new Set<string>();
    for (const [id, file] of this.files)
      for (const request of file.stream.requests.keys())
        if (!next.has(request)) next.set(request, id);
    for (const [key, id] of this.owners) {
      const replacement = next.get(key);
      if (replacement !== id) {
        changed.add(id);
        if (replacement) changed.add(replacement);
      }
    }
    for (const [key, id] of next) if (this.owners.get(key) !== id) changed.add(id);
    this.owners = next;
    for (const id of changed) this.ownerVersions.set(id, (this.ownerVersions.get(id) ?? 0) + 1);
    if (changed.size) this.historyVersion++;
  }
  private facts(id: string, file: OmpOrderedTaskFile, now: number, needsCurrent: boolean): Derived {
    const idleComplete = now - file.stream.lastLineMs >= 30 * 60_000,
      prior = this.derived.get(id),
      ownerVersion = this.ownerVersions.get(id) ?? 0;
    const future = file.stream.lastLineMs > now;
    let facts = prior;
    if (
      !prior ||
      prior.stream !== file.stream ||
      prior.revision !== file.stream.revision ||
      prior.ownerVersion !== ownerVersion ||
      prior.idleComplete !== idleComplete ||
      future ||
      prior.future
    ) {
      const events = file.stream.snapshotEvents((key) => this.owners.get(key) === id);
      const records = this.storage.reuse(
        id,
        createTaskRecords(id, events, file.stream.notes, now, file.stream.lastLineMs),
      );
      facts = {
        stream: file.stream,
        revision: file.stream.revision,
        ownerVersion,
        idleComplete,
        future,
        events,
        records,
        evaluation: null,
        startMs: null,
        currentReady: false,
      };
      this.derived.set(id, facts);
      this.historyVersion++;
    }
    if (needsCurrent && !facts!.currentReady) {
      const task = file.stream.hasIncompleteCurrentTask ? null : currentTask(facts!.events, now);
      facts!.evaluation = task ? evaluateTask(task.events, now) : null;
      facts!.startMs = task?.startMs ?? null;
      facts!.currentReady = true;
    }
    return facts!;
  }
  getSnapshot(
    ids: ReadonlySet<string>,
    now: number,
    currentIds: ReadonlySet<string> = ids,
  ): OmpMonitorTasks {
    if (this.disposed) return { current: {}, records: [], scanning: false, limited: false };
    this.refreshOwners();
    const current = Object.create(null) as Record<string, MonitorTaskStatus>,
      selected: SelectedTask[] = [];
    let scanning = false,
      limited = this.sourceLimited || this.memoryLimited || this.storage.limited;
    for (const id of ids) {
      const file = this.files.get(id);
      if (!file) continue;
      scanning ||= file.scanning;
      limited ||= file.limited || file.stream.limited || file.unavailable || file.rejected;
      if (!file.caughtUp || !file.stream.headerSeen) {
        if (currentIds.has(id)) current[id] = none();
        continue;
      }
      selected.push({ id, file, facts: this.facts(id, file, now, currentIds.has(id)) });
    }
    const cached = this.historyRecords(ids, selected, now);
    for (const { id, file, facts } of selected) {
      if (!currentIds.has(id)) continue;
      current[id] = this.currentStatus(file, facts, cached.records, now);
    }
    return { current, records: cached.records, scanning, limited: limited || cached.limited };
  }
  private historyRecords(
    ids: ReadonlySet<string>,
    selected: SelectedTask[],
    now: number,
  ): ScopeHistory {
    const scope = JSON.stringify([...ids].sort()),
      floor = calendarDays(now)[0]!.start,
      selection = JSON.stringify(selected.map((s) => s.id));
    let cached = this.scopeCache.get(scope);
    if (
      !cached ||
      cached.version !== this.historyVersion ||
      cached.floor !== floor ||
      cached.selection !== selection
    ) {
      let records = selected
        .flatMap((s) => s.facts.records)
        .filter((r) => r.endMs >= floor && r.endMs <= now)
        .sort(compareRecords);
      const clipped = records.length > TASK_MONITOR_LIMITS.maxRecords;
      if (clipped) records = records.slice(-TASK_MONITOR_LIMITS.maxRecords);
      cached = { version: this.historyVersion, floor, selection, records, limited: clipped };
      this.scopeCache.set(scope, cached);
      if (this.scopeCache.size > 16) this.scopeCache.delete(this.scopeCache.keys().next().value!);
    }
    return cached;
  }
  private currentStatus(
    file: OmpOrderedTaskFile,
    facts: Derived,
    records: MonitorTaskRecord[],
    now: number,
  ): MonitorTaskStatus {
    const result = facts.evaluation,
      live =
        file.source.phase !== "idle" &&
        now - file.stream.lastLineMs <= 300_000 &&
        file.stream.lastLineMs <= now;
    let form: MonitorTaskStatus["form"] = "none";
    if (result && result.score !== null) form = live ? "live" : "resting";
    return {
      taskStartMs: facts.startMs,
      result,
      predictions:
        result?.score !== null && result?.score !== undefined ? predictTask(result, records) : null,
      form,
    };
  }
  dispose(): void {
    this.disposed = true;
    for (const file of this.files.values()) file.dispose();
    this.files.clear();
    this.derived.clear();
    this.owners.clear();
    this.ownerVersions.clear();
    this.lastServed.clear();
    this.scopeCache.clear();
    this.storage.dispose();
    this.lastPersisted = null;
  }
}
