import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { OmpMonitorResources } from "./types.js";

interface ProcessSample {
  pid: number;
  identity: string;
  cpuMs: number;
  workingSetBytes: number;
  privateBytes: number | null;
}

interface ProcessProbe {
  processes: ProcessSample[];
  unreadable: number;
  limited: boolean;
}

interface SamplerOptions {
  now?: () => number;
  logicalCpus?: number;
  probe?: (signal: AbortSignal) => Promise<ProcessProbe>;
}

const MAX_PROCESSES = 64;
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const PROCESS_NAMES: Record<string, true> = {
  omp: true,
  "omp-windows-x64": true,
  "omp-windows-arm64": true,
  "omp-linux-x64": true,
  "omp-linux-arm64": true,
  "omp-darwin-arm64": true,
  "omp-darwin-x64": true,
  "oh-my-pi": true,
};
const WINDOWS_PROBE = `
$ErrorActionPreference = 'Stop'
$rows = @()
$unreadable = 0
$limited = $false
$sessionId = ([System.Diagnostics.Process]::GetCurrentProcess()).SessionId
foreach ($name in @('omp','omp-windows-x64','omp-windows-arm64','oh-my-pi')) {
  foreach ($p in [System.Diagnostics.Process]::GetProcessesByName($name)) {
    try {
      if ($p.SessionId -ne $sessionId) { continue }
      if ($rows.Count -ge 64) { $limited = $true; continue }
      $rows += [pscustomobject]@{
        pid = $p.Id
        identity = $p.StartTime.ToUniversalTime().Ticks.ToString()
        cpuMs = $p.TotalProcessorTime.TotalMilliseconds
        workingSetBytes = $p.WorkingSet64
        privateBytes = $p.PrivateMemorySize64
      }
    } catch { $unreadable++ } finally { $p.Dispose() }
  }
}
[pscustomobject]@{ processes = @($rows); unreadable = $unreadable; limited = $limited } | ConvertTo-Json -Compress -Depth 4
`;
function run(file: string, args: string[], signal: AbortSignal): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    file,
    args,
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4_500,
      maxBuffer: 512 * 1024,
      signal,
      env: { ...process.env, LC_ALL: "C" },
    },
    (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    },
  );
  return promise;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_VALUE;
}

function durationSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  const seconds =
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3]) * 60 +
    Number(match[4]);
  return finite(seconds) ? seconds : null;
}

async function probeWindowsProcesses(signal: AbortSignal): Promise<ProcessProbe> {
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const value: unknown = JSON.parse(
    await run(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE],
      signal,
    ),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("processes" in value) ||
    !Array.isArray(value.processes)
  )
    throw new Error("Invalid process sample");
  const processes: ProcessSample[] = [];
  let unreadable = "unreadable" in value && finite(value.unreadable) ? value.unreadable : 0;
  for (const entry of value.processes.slice(0, MAX_PROCESSES)) {
    if (!entry || typeof entry !== "object") {
      unreadable++;
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (
      !finite(row.pid) ||
      !Number.isInteger(row.pid) ||
      typeof row.identity !== "string" ||
      !/^\d{1,24}$/.test(row.identity) ||
      !finite(row.cpuMs) ||
      !finite(row.workingSetBytes) ||
      !finite(row.privateBytes)
    ) {
      unreadable++;
      continue;
    }
    processes.push({
      pid: row.pid,
      identity: row.identity,
      cpuMs: row.cpuMs,
      workingSetBytes: row.workingSetBytes,
      privateBytes: row.privateBytes,
    });
  }
  return {
    processes,
    unreadable,
    limited:
      ("limited" in value && value.limited === true) || value.processes.length > MAX_PROCESSES,
  };
}
async function probePosixProcesses(signal: AbortSignal): Promise<ProcessProbe> {
  // comm is the executable, not command arguments: no prompt or credential strings are read.
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("No local process owner");
  const stdout = await run("ps", ["-U", String(uid), "-o", "pid=,etime=,time=,rss=,comm="], signal);
  const processes: ProcessSample[] = [];
  let unreadable = 0;
  let limited = false;
  const now = Date.now();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+([\d:-]+)\s+([\d:.-]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const executable = path.basename(match[5]);
    if (PROCESS_NAMES[executable] !== true) continue;
    if (processes.length >= MAX_PROCESSES) {
      limited = true;
      continue;
    }
    const elapsed = durationSeconds(match[2]);
    const cpuSeconds = durationSeconds(match[3]);
    const rss = Number(match[4]) * 1024;
    if (elapsed === null || cpuSeconds === null || !finite(rss)) {
      unreadable++;
      continue;
    }
    // ps exposes start age at one-second precision; use its minute bin only as a PID-reuse guard.
    const startedMinute = Math.round((now - elapsed * 1000) / 60_000);
    processes.push({
      pid: Number(match[1]),
      identity: `${executable}:${startedMinute}`,
      cpuMs: cpuSeconds * 1000,
      workingSetBytes: rss,
      privateBytes: null,
    });
  }
  return { processes, unreadable, limited };
}

async function probeProcesses(signal: AbortSignal): Promise<ProcessProbe> {
  if (process.platform === "win32") return probeWindowsProcesses(signal);
  if (process.platform === "linux" || process.platform === "darwin")
    return probePosixProcesses(signal);
  const error = new Error("Unsupported platform");
  Object.assign(error, { code: "UNSUPPORTED" });
  throw error;
}

function aggregateProcessSample(
  result: ProcessProbe,
  previousSamples: ReadonlyMap<number, ProcessSample>,
  elapsed: number | null,
  sampledAt: number,
  logicalCpus: number,
): OmpMonitorResources {
  let completeInterval = elapsed !== null && elapsed > 0 && elapsed <= 30_000;
  let cpuDelta = 0;
  let workingSetBytes = 0;
  let privateBytes = 0;
  let privateAvailable = true;
  for (const row of result.processes) {
    const previous = previousSamples.get(row.pid);
    if (!previous || previous.identity !== row.identity || row.cpuMs < previous.cpuMs)
      completeInterval = false;
    else cpuDelta += row.cpuMs - previous.cpuMs;
    workingSetBytes = Math.min(MAX_VALUE, workingSetBytes + row.workingSetBytes);
    if (row.privateBytes === null) privateAvailable = false;
    else privateBytes = Math.min(MAX_VALUE, privateBytes + row.privateBytes);
  }
  return {
    status: result.unreadable || result.limited ? "partial" : "available",
    sampledAt,
    processCount: result.processes.length,
    cpuPercent:
      completeInterval && elapsed !== null
        ? Math.min(100, Math.max(0, (cpuDelta / elapsed / logicalCpus) * 100))
        : null,
    workingSetBytes,
    privateBytes: privateAvailable ? privateBytes : null,
    reason: result.unreadable ? "unreadable" : null,
  };
}

/** Read-only, unprivileged samples of identifiable native OMP executables only. */
export class OmpProcessSampler {
  private readonly now: () => number;
  private readonly logicalCpus: number;
  private readonly probe: (signal: AbortSignal) => Promise<ProcessProbe>;
  private readonly abort = new AbortController();
  private previous = new Map<number, ProcessSample>();
  private previousAt: number | null = null;
  private flight: Promise<OmpMonitorResources> | null = null;
  private disposed = false;

  constructor(options: SamplerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logicalCpus = Math.max(1, options.logicalCpus ?? availableParallelism());
    this.probe = options.probe ?? probeProcesses;
  }

  sample(): Promise<OmpMonitorResources> {
    if (this.flight) return this.flight;
    if (this.disposed) return Promise.resolve(this.unavailable("unreadable"));
    const flight = this.read();
    this.flight = flight;
    void flight.finally(() => {
      if (this.flight === flight) this.flight = null;
    });
    return flight;
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.previous.clear();
    this.previousAt = null;
  }

  private unavailable(reason: OmpMonitorResources["reason"]): OmpMonitorResources {
    return {
      status: "unavailable",
      sampledAt: this.now(),
      processCount: 0,
      cpuPercent: null,
      workingSetBytes: null,
      privateBytes: null,
      reason,
    };
  }

  private async read(): Promise<OmpMonitorResources> {
    try {
      const result = await this.probe(this.abort.signal);
      const sampledAt = this.now();
      const rows = result.processes;
      if (!rows.length) {
        this.previous.clear();
        this.previousAt = null;
        return this.unavailable(result.unreadable ? "unreadable" : "no_processes");
      }
      const elapsed = this.previousAt === null ? null : sampledAt - this.previousAt;
      const snapshot = aggregateProcessSample(
        result,
        this.previous,
        elapsed,
        sampledAt,
        this.logicalCpus,
      );
      this.previous.clear();
      for (const row of rows) this.previous.set(row.pid, row);
      this.previousAt = sampledAt;
      return snapshot;
    } catch (error) {
      this.previous.clear();
      this.previousAt = null;
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      const killed =
        error && typeof error === "object" && "killed" in error && error.killed === true;
      let reason: OmpMonitorResources["reason"] = "unreadable";
      if (code === "UNSUPPORTED") reason = "unsupported";
      else if (code === "ETIMEDOUT" || killed) reason = "timeout";
      return this.unavailable(reason);
    }
  }
}
