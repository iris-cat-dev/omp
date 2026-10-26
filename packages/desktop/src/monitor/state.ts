import type { Stats } from "node:fs";
import path from "node:path";
import { hashId, OmpNumericParser } from "./parser.js";
import type { NumericResponse, NumericSink } from "./parser.js";
import type { OmpMonitorAgentKind, OmpMonitorCoverage, OmpMonitorRoot } from "./types.js";

export const MONITOR_LIMITS = {
  files: 20_000,
  directoryEntries: 80_000,
  depth: 6,
  records: 100_000,
  agents: 256,
  pendingTools: 8_192,
  lineBytes: 32 * 1_024 * 1_024,
  pendingBytes: 32 * 1_024 * 1_024,
  fileBytes: 256 * 1_024 * 1_024,
  tailBytes: 64 * 1_024 * 1_024,
  pollBytes: 8 * 1_024 * 1_024,
  perFileBytes: 2 * 1_024 * 1_024,
  pollFiles: 128,
  pollLines: 20_000,
} as const;
export const REDISCOVER_MS = 10_000;
export const STALE_MS = 5 * 60_000;
export const RECENT_MS = 10 * 60_000;
export const FALLBACK_MS = 30 * 60_000;
// Calendar headroom at the ISO year limit, including the largest local UTC offset.
export const MAX_CLOCK_MS = 253_402_128_000_000;
export type MonitorIssue = OmpMonitorCoverage["issues"][number];

/** Independent fragments are required when the live tail leads the history cursor. */
export interface FileReadCursor {
  offset: number;
  parts: Buffer[];
  pendingLength: number;
  discardLine: boolean;
}

export interface FileTailCursor extends FileReadCursor {
  /** Exclusive history boundary, advanced once to the first complete tail line. */
  start: number;
  boundaryPending: boolean;
}

export interface FileState extends FileReadCursor {
  path: string;
  id: string;
  root: OmpMonitorRoot;
  kind: OmpMonitorAgentKind;
  parentPath: string | null;
  parser: OmpNumericParser;
  order: number;
  identity: string;
  size: number;
  mtime: number;
  observedMtime: number;
  ctime: number;
  initialized: boolean;
  complete: boolean;
  dirty: boolean;
  read: boolean;
  malformed: number;
  issues: Set<MonitorIssue>;
  prefixStart: number;
  prefixLength: number;
  prefixHash: string;
  guardStart: number;
  guardLength: number;
  guardHash: string;
  tail: FileTailCursor | null;
  headerEnd: number;
  feedbackStart: number;
  ingestPosition: number;
  ingestFeedback: boolean;
  readAllowance: number;
  keys: Set<string>;
  sink?: NumericSink;
  toolCount: number;
}

export interface Candidate {
  file: FileState;
  response: NumericResponse;
  position: number;
}
export interface ReadBudget {
  bytes: number;
  lines: number;
}
export interface RootState {
  root: OmpMonitorRoot;
  available: boolean;
}
export interface DiscoveredFile {
  path: string;
  root: OmpMonitorRoot;
  stat: Stats;
}

export function fileIdentity(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

export function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function fileChanged(file: FileState, info: Stats): boolean {
  return (
    fileIdentity(info) !== file.identity ||
    info.size !== file.size ||
    info.mtimeMs !== file.mtime ||
    info.ctimeMs !== file.ctime
  );
}

export function newFileState(entry: DiscoveredFile, order: number): FileState {
  const key = normalizedPath(entry.path);
  const id = hashId(`omp-file:${key}`);
  const depth = path.relative(entry.root.path, entry.path).split(path.sep).length;
  let kind: OmpMonitorAgentKind = "main";
  if (depth >= 3) {
    kind = /^__advisor(?:\.|$)/.test(path.basename(entry.path, ".jsonl")) ? "advisor" : "subagent";
  }
  return {
    path: entry.path,
    id,
    root: entry.root,
    kind,
    parentPath: depth >= 3 ? `${path.dirname(entry.path)}.jsonl` : null,
    parser: new OmpNumericParser(id),
    order,
    identity: "",
    size: 0,
    mtime: 0,
    ctime: 0,
    observedMtime: entry.stat.mtimeMs,
    offset: 0,
    initialized: false,
    complete: false,
    dirty: true,
    read: false,
    malformed: 0,
    issues: new Set(),
    parts: [],
    pendingLength: 0,
    discardLine: false,
    toolCount: 0,
    prefixStart: 0,
    prefixLength: 0,
    prefixHash: "",
    guardStart: 0,
    guardLength: 0,
    guardHash: "",
    keys: new Set(),
    tail: null,
    headerEnd: 0,
    feedbackStart: 0,
    ingestPosition: 0,
    ingestFeedback: true,
    readAllowance: 0,
  };
}

export interface ScheduledFiles {
  files: Set<FileState>;
  nextCursor: number;
}

/** Recent files receive a bounded priority lane; the remaining slots advance history. */
export function scheduleFiles(files: FileState[], now: number, cursor: number): ScheduledFiles {
  files.sort((a, b) => b.observedMtime - a.observedMtime || a.order - b.order);
  const check = new Set<FileState>();
  const recentSlots = Math.floor(MONITOR_LIMITS.pollFiles / 4);
  for (const file of files) {
    if (check.size >= recentSlots || file.observedMtime < now - RECENT_MS) break;
    check.add(file);
  }
  for (const file of files) if (!file.complete || file.dirty) check.add(file);
  for (let count = 0; count < Math.min(MONITOR_LIMITS.pollFiles, files.length); count++) {
    check.add(files[(cursor + count) % files.length]!);
  }
  const nextCursor = files.length ? (cursor + MONITOR_LIMITS.pollFiles) % files.length : 0;
  return { files: check, nextCursor };
}
