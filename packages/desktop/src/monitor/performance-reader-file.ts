// Ordered, read-only OMP JSONL stream. Complete-prefix revision proofs; no path from transcript content.
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { setImmediate as yieldRead } from "node:timers/promises";
import { OmpPerformanceLineReader, PERFORMANCE_READER_LIMITS } from "./performance-reader.js";

export interface OmpPerformanceSource {
  id: string;
  path: string;
  phase: "generating" | "tools" | "idle";
  identity?: string;
}
export const PERFORMANCE_FILE_LIMITS = { chunkBytes: 65_536, maxChunks: 16_384 };
export interface PerformanceReadBudget {
  bytes: number;
  lines: number;
  deadline: number;
  alive: () => boolean;
}
interface ChunkProof {
  offset: number;
  length: number;
  hash: string;
}
const decoder = new TextDecoder("utf-8", { fatal: true });
export function performanceFileIdentity(stat: Pick<Stats, "dev" | "ino" | "birthtimeMs">): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function proof(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}
export class OmpOrderedPerformanceFile {
  stream: OmpPerformanceLineReader;
  source: OmpPerformanceSource;
  identity: string | null = null;
  generation = 0;
  scanning = true;
  unavailable = false;
  rejected = false;
  limited = false;
  size = 0;
  mtimeMs = 0;
  private ctimeMs = 0;
  private offset = 0;
  private readonly lineParts: Buffer[] = [];
  private pendingLength = 0;
  private deferred: Buffer | null = null;
  private droppingLine = false;
  private readonly proofs: ChunkProof[] = [];
  private verifyAt = 0;
  private verifying = false;
  private targetSize = 0;
  private targetMtime = 0;
  private targetCtime = 0;
  private initialized = false;
  private disposed = false;
  constructor(
    source: OmpPerformanceSource,
    private floorMs: number,
  ) {
    this.source = { ...source };
    this.stream = new OmpPerformanceLineReader(floorMs);
  }
  get retainedBytes(): number {
    return (
      512 +
      this.source.path.length * 2 +
      this.source.id.length * 2 +
      this.stream.retainedBytes +
      this.pendingLength +
      (this.deferred?.byteLength ?? 0) +
      this.lineParts.length * 24 +
      this.proofs.length * 64
    );
  }
  get caughtUp(): boolean {
    return (
      this.initialized &&
      !this.scanning &&
      !this.unavailable &&
      !this.rejected &&
      !this.stream.saturated &&
      !this.verifying &&
      this.offset === this.size &&
      this.pendingLength === 0 &&
      this.deferred === null &&
      !this.droppingLine
    );
  }
  advanceFloor(floorMs: number): void {
    const rewind = floorMs < this.floorMs;
    this.floorMs = floorMs;
    if (rewind) this.reset();
    else this.stream.advanceFloor(floorMs);
  }
  private reset(): void {
    this.generation++;
    this.stream.clear();
    this.stream = new OmpPerformanceLineReader(this.floorMs);
    this.offset = 0;
    this.lineParts.length = this.pendingLength = 0;
    this.deferred = null;
    this.droppingLine = false;
    this.proofs.length = 0;
    this.verifyAt = 0;
    this.verifying = false;
    this.scanning = true;
    this.initialized = false;
  }
  async poll(budget: PerformanceReadBudget): Promise<void> {
    if (!this.canRead(budget)) return;
    let handle: FileHandle | null = null;
    try {
      const identity = await this.inspectSource(budget);
      if (identity === null) return;
      handle = await open(this.source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat(),
        checked = await lstat(this.source.path);
      if (this.disposed || !budget.alive() || !this.acceptOpened(opened, checked, identity)) return;
      this.prepareScan(opened);
      if (!(await this.verifyPrefix(handle, budget))) return;
      if (!(await this.scanChunks(handle, budget))) return;
      const after = await handle.stat(),
        named = await lstat(this.source.path);
      if (this.disposed || !budget.alive()) return;
      this.finishScan(after, named, identity);
    } catch {
      this.reset();
      this.unavailable = this.limited = true;
      this.scanning = false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  private async inspectSource(budget: PerformanceReadBudget): Promise<string | null> {
    if (
      !path.isAbsolute(this.source.path) ||
      path.extname(this.source.path).toLowerCase() !== ".jsonl"
    ) {
      this.reject();
      return null;
    }
    const before = await lstat(this.source.path);
    if (this.disposed || !budget.alive()) return null;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !samePath(await realpath(this.source.path), path.resolve(this.source.path))
    ) {
      this.reject();
      return null;
    }
    const identity = performanceFileIdentity(before);
    if (this.source.identity && identity !== this.source.identity) {
      this.reject();
      return null;
    }
    if (this.identity !== null && identity !== this.identity) this.reset();
    this.identity = identity;
    return identity;
  }
  private acceptOpened(opened: Stats, checked: Stats, identity: string): boolean {
    if (
      !opened.isFile() ||
      checked.isSymbolicLink() ||
      !checked.isFile() ||
      performanceFileIdentity(opened) !== identity ||
      performanceFileIdentity(checked) !== identity
    ) {
      this.reject();
      return false;
    }
    this.unavailable = this.rejected = false;
    return true;
  }
  private prepareScan(opened: Stats): void {
    if (
      this.initialized &&
      (opened.size < this.offset ||
        (opened.size === this.size &&
          (opened.mtimeMs !== this.mtimeMs || opened.ctimeMs !== this.ctimeMs)))
    )
      this.reset();
    if (
      !this.initialized ||
      opened.size !== this.targetSize ||
      opened.mtimeMs !== this.targetMtime ||
      opened.ctimeMs !== this.targetCtime
    ) {
      // A middle rewrite plus append invalidates the complete prefix, not just head/tail anchors.
      if (this.offset > 0) {
        this.verifying = true;
        this.verifyAt = 0;
      }
      this.targetSize = opened.size;
      this.targetMtime = opened.mtimeMs;
      this.targetCtime = opened.ctimeMs;
      this.scanning = true;
    }
    this.initialized = true;
  }
  private async verifyPrefix(handle: FileHandle, budget: PerformanceReadBudget): Promise<boolean> {
    while (this.verifying && this.verifyAt < this.proofs.length && this.canRead(budget)) {
      const prior = this.proofs[this.verifyAt];
      if (prior.length > budget.bytes) break;
      const buffer = Buffer.allocUnsafe(prior.length),
        read = await handle.read(buffer, 0, buffer.length, prior.offset);
      budget.bytes -= read.bytesRead;
      if (this.disposed || !budget.alive()) return false;
      if (read.bytesRead !== prior.length || proof(buffer) !== prior.hash) {
        this.reset();
        this.initialized = true;
        break;
      }
      this.verifyAt++;
      await yieldRead();
    }
    if (this.verifying && this.verifyAt === this.proofs.length) {
      this.verifying = false;
      this.verifyAt = 0;
    }
    return true;
  }
  private async scanChunks(handle: FileHandle, budget: PerformanceReadBudget): Promise<boolean> {
    if (this.verifying) return true;
    if (this.deferred !== null) {
      const chunk = this.deferred;
      this.deferred = null;
      this.consume(chunk, budget);
    }
    while (this.offset < this.targetSize && !this.stream.saturated && this.canRead(budget)) {
      if (this.proofs.length >= PERFORMANCE_FILE_LIMITS.maxChunks) {
        this.limited = true;
        break;
      }
      const length = Math.min(
          PERFORMANCE_FILE_LIMITS.chunkBytes,
          budget.bytes,
          this.targetSize - this.offset,
        ),
        buffer = Buffer.allocUnsafe(length),
        read = await handle.read(buffer, 0, length, this.offset);
      if (this.disposed || !budget.alive()) return false;
      budget.bytes -= read.bytesRead;
      if (!read.bytesRead) {
        this.reset();
        break;
      }
      const chunk = buffer.subarray(0, read.bytesRead);
      this.proofs.push({ offset: this.offset, length: read.bytesRead, hash: proof(chunk) });
      this.offset += read.bytesRead;
      this.consume(chunk, budget);
      await yieldRead();
    }
    return true;
  }
  private finishScan(after: Stats, named: Stats, identity: string): void {
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      performanceFileIdentity(after) !== identity ||
      performanceFileIdentity(named) !== identity
    ) {
      this.reject();
      return;
    }
    if (
      after.size < this.offset ||
      (after.size === this.targetSize &&
        (after.mtimeMs !== this.targetMtime || after.ctimeMs !== this.targetCtime))
    )
      this.reset();
    this.size = after.size;
    this.mtimeMs = after.mtimeMs;
    this.ctimeMs = after.ctimeMs;
    this.scanning =
      this.verifying ||
      this.offset < after.size ||
      this.targetSize !== after.size ||
      this.targetMtime !== after.mtimeMs ||
      this.targetCtime !== after.ctimeMs ||
      this.pendingLength > 0 ||
      this.deferred !== null ||
      this.droppingLine;
    if (this.stream.saturated || this.proofs.length >= PERFORMANCE_FILE_LIMITS.maxChunks) {
      this.limited = true;
      this.scanning = false;
    }
  }
  private canRead(budget: PerformanceReadBudget): boolean {
    return (
      !this.disposed &&
      budget.alive() &&
      budget.bytes > 0 &&
      budget.lines > 0 &&
      performance.now() < budget.deadline
    );
  }
  private consume(chunk: Buffer, budget: PerformanceReadBudget): void {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      if (budget.lines <= 0 || performance.now() >= budget.deadline) {
        this.deferred = chunk.subarray(start);
        return;
      }
      if (!this.droppingLine) this.consumeLine(chunk.subarray(start, end));
      this.lineParts.length = this.pendingLength = 0;
      this.droppingLine = false;
      budget.lines--;
      start = end + 1;
    }
    if (start < chunk.length && !this.droppingLine) {
      const rest = chunk.subarray(start),
        length = this.pendingLength + rest.length;
      if (length > PERFORMANCE_READER_LIMITS.maxLineBytes || this.lineParts.length >= 16_384) {
        this.lineParts.length = this.pendingLength = 0;
        this.droppingLine = true;
        this.stream.markGap();
      } else {
        this.lineParts.push(Buffer.from(rest));
        this.pendingLength = length;
      }
    }
    // No EOF flush: a JSON object without its JSONL newline is not a fact.
  }
  private consumeLine(final: Buffer): void {
    const length = this.pendingLength + final.length;
    if (length > PERFORMANCE_READER_LIMITS.maxLineBytes) {
      this.stream.markGap();
      return;
    }
    const line = this.lineParts.length ? Buffer.concat([...this.lineParts, final], length) : final;
    try {
      this.stream.read(decoder.decode(line));
    } catch {
      this.stream.markGap();
    }
  }
  private reject(): void {
    this.reset();
    this.rejected = this.limited = true;
    this.scanning = false;
  }
  dispose(): void {
    this.disposed = true;
    this.stream.clear();
    this.lineParts.length = this.pendingLength = 0;
    this.deferred = null;
    this.proofs.length = 0;
  }
}
