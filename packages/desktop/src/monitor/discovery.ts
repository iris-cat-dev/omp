import { lstat, opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { filesystemFailure, regularDirectory } from "./roots.js";
import type { RootResolution } from "./roots.js";
import { MONITOR_LIMITS, normalizedPath } from "./state.js";
import type { DiscoveredFile, MonitorIssue, RootState } from "./state.js";
import type { OmpMonitorRoot } from "./types.js";

interface DirectoryCandidate {
  path: string;
  depth: number;
}
export interface DiscoveryResult {
  roots: RootState[];
  files: DiscoveredFile[];
  seen: Set<string>;
  missingRoots: Set<string>;
  issues: Set<MonitorIssue>;
  skipped: number;
  complete: boolean;
}

function discoveryOrder(a: DiscoveredFile, b: DiscoveredFile): number {
  const modified = a.stat.mtimeMs - b.stat.mtimeMs;
  if (modified) return modified;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

/** One bounded, no-symlink enumeration; no transcript content is opened here. */
export class OmpFileDiscovery {
  private entries = 0;
  private readonly uniqueRoots = new Set<string>();
  private readonly result: DiscoveryResult = {
    roots: [],
    files: [],
    seen: new Set(),
    missingRoots: new Set(),
    issues: new Set(),
    skipped: 0,
    complete: true,
  };

  constructor(private readonly resolution: RootResolution) {
    if (resolution.limited) this.result.issues.add("file_limit");
    if (resolution.unreadable) this.result.issues.add("unreadable");
  }

  async scan(): Promise<DiscoveryResult> {
    for (const root of this.resolution.roots) await this.scanRoot(root);
    this.result.files.sort(discoveryOrder);
    return this.result;
  }

  private async scanRoot(root: OmpMonitorRoot): Promise<void> {
    const key = normalizedPath(root.path);
    if (this.uniqueRoots.has(key)) return;
    this.uniqueRoots.add(key);
    const available = await regularDirectory(root.path);
    this.result.roots.push({ root, available });
    if (!available) {
      this.result.missingRoots.add(key);
      await this.inspectMissingRoot(root.path);
      return;
    }
    const queue: DirectoryCandidate[] = [{ path: root.path, depth: 0 }];
    for (let directoryIndex = 0; directoryIndex < queue.length; directoryIndex++) {
      await this.scanDirectory(queue[directoryIndex]!, root, queue);
      if (this.exceededBudget()) {
        this.markLimited();
        break;
      }
    }
  }

  private async inspectMissingRoot(rootPath: string): Promise<void> {
    try {
      await lstat(rootPath);
    } catch (error) {
      if (!filesystemFailure(error)) throw error;
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") this.result.issues.add("unreadable");
    }
  }

  private async scanDirectory(
    directory: DirectoryCandidate,
    root: OmpMonitorRoot,
    queue: DirectoryCandidate[],
  ): Promise<void> {
    try {
      const info = await lstat(directory.path);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      const folder = await opendir(directory.path);
      for await (const entry of folder) {
        this.entries++;
        if (this.exceededBudget()) {
          this.markLimited();
          break;
        }
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        await this.scanEntry(entry, directory, root, queue);
      }
    } catch (error) {
      if (!filesystemFailure(error)) throw error;
      this.result.issues.add("unreadable");
      this.result.complete = false;
    }
  }

  private async scanEntry(
    entry: Dirent,
    directory: DirectoryCandidate,
    root: OmpMonitorRoot,
    queue: DirectoryCandidate[],
  ): Promise<void> {
    const entryPath = path.join(directory.path, entry.name);
    const depth = directory.depth + 1;
    if (entry.isDirectory()) {
      if (depth < MONITOR_LIMITS.depth) queue.push({ path: entryPath, depth });
      else this.markLimited();
      return;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || depth < 2) return;
    await this.addFile(entryPath, root);
  }

  private async addFile(filePath: string, root: OmpMonitorRoot): Promise<void> {
    try {
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      const key = normalizedPath(filePath);
      if (this.result.seen.has(key)) return;
      this.result.seen.add(key);
      this.result.files.push({ path: filePath, root, stat });
    } catch (error) {
      if (!filesystemFailure(error)) throw error;
      this.result.issues.add("unreadable");
      this.result.skipped++;
      this.result.complete = false;
    }
  }

  private exceededBudget(): boolean {
    return (
      this.entries > MONITOR_LIMITS.directoryEntries ||
      this.result.files.length >= MONITOR_LIMITS.files
    );
  }

  private markLimited(): void {
    this.result.issues.add("file_limit");
    this.result.complete = false;
  }
}
