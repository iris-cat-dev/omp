// Numeric-only Agent Speed v1.6.0 performance cache. Not compatible with, and never reads, task-IQ caches.
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MonitorPerformanceRecord, MonitorPerformanceSums } from "./performance-types.js";
import { object } from "./parser.js";
import { performanceModel } from "./performance-reader.js";
import { calendarDays } from "./math.js";

export const PERFORMANCE_CACHE_NAME = "omp-performance-records-v160.json";
const CACHE_SCHEMA = "omp-performance-v160";
const MAX_CACHE_BYTES = 8_388_608;
const MAX_RECORDS = 8192;
const COUNT_KEYS = [
  "n",
  "outputSum",
  "durationMsSum",
  "reasonN",
  "reasonOutput",
  "reasonDurationMsSum",
  "cacheN",
  "cacheInput",
  "cacheCached",
  "toolN",
  "toolFailed",
  "activeMs",
] as const;
function bounded(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
interface CacheIdentity {
  agentId: string;
  source: "omp";
  model: string;
  day: string;
}
function cacheIdentity(
  row: Record<string, unknown>,
): row is Record<string, unknown> & CacheIdentity {
  return (
    typeof row.agentId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(row.agentId) &&
    row.source === "omp" &&
    typeof row.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
    typeof row.model === "string" &&
    (row.model === "" || performanceModel(row.model) === row.model)
  );
}
function cacheRecord(value: unknown): MonitorPerformanceRecord | null {
  const row = object(value);
  if (!row || !cacheIdentity(row)) return null;
  if (
    COUNT_KEYS.some((key) => !bounded(row[key]) || !Number.isInteger(row[key])) ||
    !bounded(row.toolLnSum) ||
    !Array.isArray(row.latencyBins) ||
    row.latencyBins.length !== 64 ||
    row.latencyBins.some((count) => !bounded(count) || !Number.isInteger(count))
  )
    return null;
  const sums = Object.fromEntries(COUNT_KEYS.map((key) => [key, row[key]])) as unknown as Omit<
    MonitorPerformanceSums,
    "latencyBins" | "toolLnSum"
  >;
  if (
    sums.reasonN > sums.n ||
    sums.cacheN > sums.n ||
    sums.cacheCached > sums.cacheInput ||
    sums.toolFailed > sums.toolN ||
    row.latencyBins.reduce((sum: number, count: number) => sum + count, 0) > sums.n
  )
    return null;
  // Whitelist-copy: extra properties in a corrupted cache never survive or cross the renderer boundary.
  return {
    agentId: row.agentId,
    day: row.day,
    source: "omp",
    model: row.model,
    ...sums,
    toolLnSum: row.toolLnSum,
    latencyBins: [...row.latencyBins] as number[],
  };
}
export class OmpPerformanceStorage {
  limited = false;
  private disposed = false;
  private readonly cached = new Map<
    string,
    { text: string; records: MonitorPerformanceRecord[] }
  >();
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
      const name = path.join(this.cacheDir, PERFORMANCE_CACHE_NAME),
        before = await lstat(name);
      if (this.disposed) return;
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CACHE_BYTES) {
        this.limited = true;
        return;
      }
      file = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (this.disposed) return;
      const bytes = await this.readCache(file, before);
      if (bytes === null || this.disposed) return;
      this.restore(JSON.parse(bytes.toString("utf8")), now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.limited = true;
    } finally {
      await file?.close().catch(() => {});
    }
  }
  private async readCache(file: FileHandle, before: Stats): Promise<Buffer | null> {
    const checked = await file.stat();
    if (
      this.disposed ||
      !checked.isFile() ||
      checked.dev !== before.dev ||
      checked.ino !== before.ino ||
      checked.birthtimeMs !== before.birthtimeMs ||
      checked.size !== before.size
    ) {
      this.limited = true;
      return null;
    }
    const bytes = Buffer.allocUnsafe(checked.size),
      read = await file.read(bytes, 0, bytes.length, 0),
      after = await file.stat();
    if (
      read.bytesRead !== bytes.length ||
      after.size !== checked.size ||
      after.mtimeMs !== checked.mtimeMs ||
      after.ctimeMs !== checked.ctimeMs ||
      this.disposed
    ) {
      this.limited = true;
      return null;
    }
    return bytes;
  }
  private restore(value: unknown, now: number): void {
    const cache = object(value);
    if (
      cache?.schema !== CACHE_SCHEMA ||
      cache.version !== 1 ||
      !Array.isArray(cache.records) ||
      cache.records.length > MAX_RECORDS
    ) {
      this.limited = true;
      return;
    }
    const dates = new Set(calendarDays(now).map((day) => day.date)),
      groups = new Map<string, MonitorPerformanceRecord[]>();
    for (const raw of cache.records) {
      const record = cacheRecord(raw);
      if (!record) {
        this.cached.clear();
        this.limited = true;
        return;
      }
      if (!dates.has(record.day)) continue;
      const records = groups.get(record.agentId!) ?? [];
      records.push(record);
      groups.set(record.agentId!, records);
    }
    for (const [id, records] of groups)
      this.cached.set(id, { text: JSON.stringify(records), records });
  }
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.cached.keys()) if (!ids.has(id)) this.cached.delete(id);
  }
  reuse(id: string, records: MonitorPerformanceRecord[]): MonitorPerformanceRecord[] {
    if (!this.cacheDir) return records;
    // A cache never proves source identity, coverage or freshness: reuse only after an identical ordered source read.
    const text = JSON.stringify(records),
      previous = this.cached.get(id);
    if (previous?.text === text) return previous.records;
    this.cached.set(id, { text, records });
    return records;
  }
  async save(
    records: readonly MonitorPerformanceRecord[],
    now: number,
    alive: () => boolean,
  ): Promise<void> {
    if (!this.cacheDir || this.disposed || !alive()) return;
    const dates = new Set(calendarDays(now).map((day) => day.date)),
      safe = records.filter((row) => dates.has(row.day)).map(cacheRecord);
    if (safe.length > MAX_RECORDS || safe.some((row) => row === null)) {
      this.limited = true;
      return;
    }
    const text = JSON.stringify({ schema: CACHE_SCHEMA, version: 1, records: safe });
    if (text === this.lastSaved) return;
    if (Buffer.byteLength(text) > MAX_CACHE_BYTES) {
      this.limited = true;
      return;
    }
    const temporary = path.join(this.cacheDir, `${PERFORMANCE_CACHE_NAME}.${randomUUID()}.tmp`),
      name = path.join(this.cacheDir, PERFORMANCE_CACHE_NAME);
    let file: FileHandle | undefined;
    try {
      if (!(await this.prepareTarget(this.cacheDir, name, alive))) return;
      file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      if (this.disposed || !alive()) return;
      await file.writeFile(text, "utf8");
      await file.close();
      file = undefined;
      if (!(await this.validRoot(this.cacheDir))) return;
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
  private async prepareTarget(
    directory: string,
    name: string,
    alive: () => boolean,
  ): Promise<boolean> {
    await mkdir(directory, { recursive: true });
    if (!(await this.validRoot(directory)) || this.disposed || !alive()) return false;
    const prior = await lstat(name).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (prior && (!prior.isFile() || prior.isSymbolicLink())) {
      this.limited = true;
      return false;
    }
    return !this.disposed && alive();
  }
  private async validRoot(directory: string): Promise<boolean> {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    const actual = await realpath(directory),
      expected = path.resolve(directory);
    return process.platform === "win32"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  }
  dispose(): void {
    this.disposed = true;
    this.cached.clear();
    this.lastSaved = "";
  }
}
