// Numeric-only Agent Speed task-record cache. Never persists events, paths, source digests or source contents.
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  MonitorTaskCounts,
  MonitorTaskDimensions,
  MonitorTaskRecord,
  MonitorTaskState,
} from "./task-types.js";
import { taskModel, taskEffort, taskObject } from "./task-parser-common.js";
import { calendarDays } from "./math.js";

const MAX_CACHE_BYTES = 8_388_608;
const MAX_RECORDS = 8192;
const CACHE_NAME = "omp-task-records-v150.json";
const STATES: Readonly<Record<MonitorTaskState, true>> = {
  none: true,
  unverified: true,
  passing: true,
  failing: true,
  pending: true,
};
const COUNT_KEYS: (keyof MonitorTaskCounts)[] = [
  "actions",
  "counted",
  "edits",
  "oscillations",
  "loopActions",
  "runs",
  "failingRuns",
  "episodes",
  "recovered",
  "recoverAttempts",
  "fixAttempts",
  "fixFailures",
];
const DIM_KEYS: (keyof MonitorTaskDimensions)[] = ["V", "C", "R", "E", "K"];
function bounded(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}
type RecordIdentity = Pick<MonitorTaskRecord, "agentId" | "day" | "ordinal" | "startMs" | "endMs">;
type RecordStatus = Pick<
  MonitorTaskRecord,
  "complete" | "state" | "score" | "firstPassMs" | "success" | "stalled" | "model" | "effort"
>;
function hasRecordIdentity(
  o: Record<string, unknown>,
): o is Record<string, unknown> & RecordIdentity {
  return (
    typeof o.agentId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(o.agentId) &&
    typeof o.day === "string" &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(o.day) &&
    bounded(o.ordinal, MAX_RECORDS) &&
    Number.isInteger(o.ordinal) &&
    bounded(o.startMs) &&
    bounded(o.endMs) &&
    o.endMs >= o.startMs
  );
}
function hasRecordStatus(o: Record<string, unknown>): o is Record<string, unknown> & RecordStatus {
  if (
    typeof o.complete !== "boolean" ||
    typeof o.state !== "string" ||
    !Object.hasOwn(STATES, o.state) ||
    (o.score !== null && !bounded(o.score, 100)) ||
    (o.firstPassMs !== null && !bounded(o.firstPassMs)) ||
    typeof o.success !== "boolean" ||
    typeof o.stalled !== "boolean"
  )
    return false;
  if (o.model !== null && taskModel(o.model) !== o.model) return false;
  return o.effort === null || taskEffort(o.effort) === o.effort;
}
function numericRows(value: unknown, width: number, max: number): number[][] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const output: number[][] = [];
  for (const row of value) {
    if (
      !Array.isArray(row) ||
      row.length !== width ||
      row.some(
        (n) =>
          typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER,
      )
    )
      return null;
    output.push([...row] as number[]);
  }
  return output;
}
function record(value: unknown): MonitorTaskRecord | null {
  const o = taskObject(value),
    dims = taskObject(o?.dims),
    counts = taskObject(o?.counts);
  if (!o || !dims || !counts || !hasRecordIdentity(o) || !hasRecordStatus(o)) return null;
  if (
    DIM_KEYS.some((k) => !bounded(dims[k], 100)) ||
    COUNT_KEYS.some((k) => !bounded(counts[k]) || !Number.isInteger(counts[k]))
  )
    return null;
  const snapshots = numericRows(o.snapshots, 9, 10),
    fixRows = numericRows(o.fixRows, 6, 16_384);
  if (!snapshots || !fixRows) return null;
  // Whitelist-copy every field. Extra keys (including content inserted into a corrupted cache) are never retained.
  return {
    agentId: o.agentId,
    day: o.day,
    ordinal: o.ordinal,
    startMs: o.startMs,
    endMs: o.endMs,
    complete: o.complete,
    model: o.model,
    effort: o.effort,
    state: o.state,
    score: o.score,
    dims: Object.fromEntries(DIM_KEYS.map((k) => [k, dims[k]])) as unknown as MonitorTaskDimensions,
    counts: Object.fromEntries(
      COUNT_KEYS.map((k) => [k, counts[k]]),
    ) as unknown as MonitorTaskCounts,
    firstPassMs: o.firstPassMs,
    success: o.success,
    stalled: o.stalled,
    snapshots,
    fixRows,
  };
}
export class OmpTaskRecordStorage {
  limited = false;
  private disposed = false;
  private readonly cached = new Map<string, { text: string; records: MonitorTaskRecord[] }>();
  private lastSaved = "";
  constructor(private readonly cacheDir?: string) {}
  async load(now: number): Promise<void> {
    if (!this.cacheDir || this.disposed) return;
    let file: FileHandle | undefined;
    try {
      if (!(await this.validRoot(this.cacheDir))) {
        this.limited = true;
        return;
      }
      const name = path.join(this.cacheDir, CACHE_NAME),
        before = await lstat(name);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CACHE_BYTES) {
        this.limited = true;
        return;
      }
      file = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const bytes = await this.readCache(file, before);
      if (bytes === null) return;
      if (this.disposed) {
        this.limited = true;
        return;
      }
      this.restoreCache(JSON.parse(bytes.toString("utf8")), now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.limited = true;
    } finally {
      await file?.close().catch(() => {});
    }
  }
  private async readCache(file: FileHandle, before: Stats): Promise<Buffer | null> {
    const check = await file.stat();
    if (
      !check.isFile() ||
      check.dev !== before.dev ||
      check.ino !== before.ino ||
      check.birthtimeMs !== before.birthtimeMs ||
      check.size !== before.size
    ) {
      this.limited = true;
      return null;
    }
    const bytes = Buffer.allocUnsafe(check.size),
      read = await file.read(bytes, 0, bytes.length, 0),
      after = await file.stat();
    if (
      read.bytesRead !== bytes.length ||
      after.size !== check.size ||
      after.mtimeMs !== check.mtimeMs ||
      this.disposed
    ) {
      this.limited = true;
      return null;
    }
    return bytes;
  }
  private restoreCache(value: unknown, now: number): void {
    const o = taskObject(value);
    if (o?.version !== 1 || !Array.isArray(o.records) || o.records.length > MAX_RECORDS) {
      this.limited = true;
      return;
    }
    const groups = new Map<string, MonitorTaskRecord[]>();
    const floor = calendarDays(now)[0]!.start;
    for (const raw of o.records) {
      const r = record(raw);
      if (!r) {
        this.cached.clear();
        this.limited = true;
        return;
      }
      if (r.endMs < floor || r.endMs > now) continue;
      const group = groups.get(r.agentId) ?? [];
      group.push(r);
      groups.set(r.agentId, group);
    }
    for (const [id, records] of groups)
      this.cached.set(id, { text: JSON.stringify(records), records });
  }
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.cached.keys()) if (!ids.has(id)) this.cached.delete(id);
  }
  reuse(id: string, freshlyRead: MonitorTaskRecord[]): MonitorTaskRecord[] {
    if (!this.cacheDir) return freshlyRead;
    // Cached facts cannot establish source coverage. Only byte-for-byte equal freshly recomposed numeric records
    // may reuse cached objects, after the real ordered source read finished. A rewrite can never revive old scores.
    const text = JSON.stringify(freshlyRead),
      cached = this.cached.get(id);
    if (cached?.text === text) return cached.records;
    this.cached.set(id, { text, records: freshlyRead });
    return freshlyRead;
  }
  async save(
    records: readonly MonitorTaskRecord[],
    now: number,
    alive: () => boolean,
  ): Promise<void> {
    if (!this.cacheDir || this.disposed || !alive()) return;
    const floor = calendarDays(now)[0]!.start,
      safe = records.filter((r) => r.endMs >= floor && r.endMs <= now).map(record);
    if (safe.some((r) => r === null)) {
      this.limited = true;
      return;
    }
    if (safe.length > MAX_RECORDS) {
      this.limited = true;
      return;
    }
    const text = JSON.stringify({ version: 1, records: safe });
    if (text === this.lastSaved) return;
    if (Buffer.byteLength(text) > MAX_CACHE_BYTES) {
      this.limited = true;
      return;
    }
    const temporary = path.join(this.cacheDir, `${CACHE_NAME}.${randomUUID()}.tmp`),
      name = path.join(this.cacheDir, CACHE_NAME);
    let file: FileHandle | undefined;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      if (!(await this.validRoot(this.cacheDir))) {
        this.limited = true;
        return;
      }
      const prior = await lstat(name).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (prior && (!prior.isFile() || prior.isSymbolicLink())) {
        this.limited = true;
        return;
      }
      if (this.disposed || !alive()) return;
      file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await file.writeFile(text, "utf8");
      await file.close();
      file = undefined;
      if (this.disposed || !alive()) return;
      await rename(temporary, name);
      this.lastSaved = text;
    } catch {
      this.limited = true;
    } finally {
      await file?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  private async validRoot(directory: string): Promise<boolean> {
    const root = await lstat(directory);
    return (
      root.isDirectory() &&
      !root.isSymbolicLink() &&
      this.canonical(await realpath(directory), path.resolve(directory))
    );
  }
  private canonical(a: string, b: string): boolean {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  dispose(): void {
    this.disposed = true;
    this.cached.clear();
    this.lastSaved = "";
  }
}
