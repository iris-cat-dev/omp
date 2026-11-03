import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  BackgroundProcess,
  BackgroundProcessOutput,
} from "@omp-desktop/protocol/background-processes";

import { resolveOmpDiagnosticPaths } from "./provider-config.js";
import { resolveOmpSdkInstallation, resolveOmpSdkBrokerEndpoint } from "./sdk-installation.js";

const OUTPUT_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const STATES: Record<string, true> = {
  starting: true,
  running: true,
  ready: true,
  restarting: true,
  stopping: true,
  exited: true,
  failed: true,
};
type Row = BackgroundProcess & { providerOwnerId: string | null };
type Json = Record<string, unknown>;
interface Daemon {
  snapshot: Json;
  command: string;
  cwd: string;
  generation: string;
  pty: boolean;
}
interface LogFile {
  handle: fs.FileHandle;
  identity: string;
  size: number;
  mtime: number;
}
interface Position {
  cursor: number;
  generation: string;
  tail: Buffer;
  files: Array<{ identity: string; size: number; mtime: number }>;
}

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function code(error: unknown): string | undefined {
  return object(error)?.code as string | undefined;
}

function safeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:]/u.test(value) &&
    !value.includes("\0")
  );
}

async function jsonFile(file: string): Promise<Json | undefined> {
  try {
    return object(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (code(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function entries(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
}

async function canonical(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch (error) {
    if (code(error) === "ENOENT") return path.resolve(dir);
    throw error;
  }
}

function daemon(snapshot: unknown, spec: unknown, cwd: string): Daemon | undefined {
  const s = object(snapshot);
  if (
    !s ||
    typeof s.id !== "string" ||
    !s.id ||
    !safeName(s.name) ||
    typeof s.state !== "string" ||
    STATES[s.state] !== true
  )
    return undefined;
  const launch = object(spec);
  const application = typeof launch?.application === "string" ? launch.application : "";
  const args = Array.isArray(launch?.args)
    ? launch.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return {
    snapshot: s,
    command: [application, ...args].join(" ").trim(),
    cwd: typeof launch?.cwd === "string" ? launch.cwd : cwd,
    generation: `${s.id}:${s.startedAt}:${s.restartCount}`,
    pty: launch?.pty === true,
  };
}

interface OutputWindow {
  offset: number;
  reset: boolean;
  lostHistory: boolean;
}

async function resolveOutputWindow(
  files: LogFile[],
  saved: Position | undefined,
  cursor: number | undefined,
  generation: string,
): Promise<OutputWindow> {
  let reset =
    cursor === undefined || !saved || cursor !== saved.cursor || saved.generation !== generation;
  let offset = 0;
  let lostHistory = false;
  if (!reset && saved) {
    const last = saved.files.at(-1);
    const index = last ? files.findIndex((file) => file.identity === last.identity) : -1;
    if (
      last &&
      index >= 0 &&
      files[index]!.size >= last.size &&
      !(files[index]!.size === last.size && files[index]!.mtime !== last.mtime)
    ) {
      const boundary = Buffer.alloc(saved.tail.length);
      await files[index]!.handle.read(boundary, 0, boundary.length, last.size - boundary.length);
      if (boundary.equals(saved.tail)) {
        offset = files.slice(0, index).reduce((sum, file) => sum + file.size, 0) + last.size;
      } else {
        reset = true;
      }
    } else if (last || files.length > 0) {
      reset = true;
      lostHistory = last !== undefined && index < 0;
    }
  }
  return { offset, reset, lostHistory };
}

async function readLogBytes(files: LogFile[], offset: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let base = 0;
  for (const file of files) {
    const start = Math.max(0, offset - base);
    base += file.size;
    if (start >= file.size) continue;
    const buffer = Buffer.allocUnsafe(file.size - start);
    let read = 0;
    while (read < buffer.length) {
      const result = await file.handle.read(buffer, read, buffer.length - read, start + read);
      if (result.bytesRead === 0) throw new Error("OMP daemon log truncated during inspection");
      read += result.bytesRead;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function utf8CodePointWidth(byte: number): number {
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  return 1;
}

function completeUtf8End(raw: Buffer): number {
  const end = raw.length;
  if (end === 0) return 0;
  let lead = end - 1;
  while (lead > 0 && (raw[lead]! & 0xc0) === 0x80 && end - lead < 4) lead--;
  return end - lead < utf8CodePointWidth(raw[lead]!) ? lead : end;
}

function completeUtf8Start(raw: Buffer, end: number): number {
  let start = 0;
  while (start < end && (raw[start]! & 0xc0) === 0x80) start++;
  return start;
}

function snapshotLogPositions(
  files: LogFile[],
  deferredBytes: number,
): Array<{ identity: string; size: number; mtime: number }> {
  const positions = files.map(({ identity, size, mtime }) => ({ identity, size, mtime }));
  let deferred = deferredBytes;
  for (let index = positions.length - 1; index >= 0 && deferred > 0; index--) {
    const count = Math.min(positions[index]!.size, deferred);
    positions[index]!.size -= count;
    deferred -= count;
    if (positions[index]!.size === 0) positions.pop();
  }
  return positions;
}

async function readPositionTail(
  files: LogFile[],
  positions: Array<{ identity: string; size: number; mtime: number }>,
): Promise<Buffer> {
  const last = positions.at(-1);
  const tail = Buffer.alloc(last ? Math.min(64, last.size) : 0);
  if (last && tail.length) {
    await files[positions.length - 1]!.handle.read(tail, 0, tail.length, last.size - tail.length);
  }
  return tail;
}

/** Passive scope inspection: never acquires a lease, publishes owners, or starts a broker. */
export class OmpBackgroundDaemons {
  private readonly cwd: string;
  private readonly command: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly stopDaemon?: (name: string) => Promise<void>;
  private readonly resolveBrokerEndpoint: (dir: string) => string | Promise<string>;
  private readonly sockets = new Set<net.Socket>();
  private readonly known = new Map<string, Daemon>();
  private readonly positions = new Map<string, Position>();
  private readonly outputQueues = new Map<string, Promise<unknown>>();
  private runtimeDir: string | undefined;
  private endpoint: string | undefined;
  private listing: Promise<Row[]> | undefined;
  private disposed = false;
  private nextCursor = 1;

  constructor(options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    command?: string[];
    stopDaemon?: (name: string) => Promise<void>;
    resolveBrokerEndpoint?: (dir: string) => string | Promise<string>;
  }) {
    this.cwd = path.resolve(options.cwd);
    this.env = { ...process.env, ...options.env };
    // Profile flags override the inherited environment, just as in OMP's bootstrap.
    const command = options.command ?? [this.env.OMP_COMMAND ?? "omp"];
    this.command = command;
    this.stopDaemon = options.stopDaemon;
    this.resolveBrokerEndpoint =
      options.resolveBrokerEndpoint ??
      (async (dir) => {
        if (process.platform !== "win32") return path.join(dir, "broker.sock");
        const installation = await resolveOmpSdkInstallation(undefined, this.env);
        return resolveOmpSdkBrokerEndpoint(installation, dir);
      });
    for (let i = 1; i < command.length; i++) {
      const arg = command[i]!;
      if (arg === "--profile") {
        const profile = command[++i];
        if (!profile) throw new Error("Missing OMP profile argument");
        this.env.OMP_PROFILE = profile;
      } else if (arg.startsWith("--profile=")) {
        this.env.OMP_PROFILE = arg.slice("--profile=".length);
      }
    }
    const profile = (this.env.OMP_PROFILE ?? this.env.PI_PROFILE)?.trim();
    if (
      profile &&
      profile !== "default" &&
      (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profile) ||
        profile.endsWith(".") ||
        /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu.test(profile))
    ) {
      throw new Error("Invalid OMP profile");
    }
  }

  list(): Promise<Row[]> {
    if (this.disposed)
      return Promise.reject(new Error("OMP background daemon adapter is disposed"));
    if (!this.listing) {
      this.listing = this.collect().finally(() => {
        this.listing = undefined;
      });
    }
    return this.listing;
  }

  output(processId: string, cursor?: number): Promise<BackgroundProcessOutput> {
    if (this.disposed)
      return Promise.reject(new Error("OMP background daemon adapter is disposed"));
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
      return Promise.reject(new Error("Invalid background output cursor"));
    const previous = this.outputQueues.get(processId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => this.readOutput(processId, cursor));
    this.outputQueues.set(processId, result);
    void result
      .finally(() => {
        if (this.outputQueues.get(processId) === result) this.outputQueues.delete(processId);
      })
      .catch(() => undefined);
    return result;
  }
  async stop(processId: string): Promise<boolean> {
    this.assertOpen();
    if (!this.known.has(processId)) await this.list();
    const entry = this.known.get(processId);
    if (!entry) throw new Error("Unknown OMP background process");
    if (this.stopDaemon) {
      await this.stopDaemon(String(entry.snapshot.name));
    } else {
      const [executable, ...baseArgs] = this.command;
      if (!executable) throw new Error("OMP command is unavailable");
      await execFileAsync(
        executable,
        [
          ...baseArgs,
          "ps",
          "stop",
          String(entry.snapshot.name),
          "--dir",
          this.cwd,
          "--timeout",
          "2",
        ],
        {
          env: this.env,
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
      );
    }
    await this.list();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const socket of this.sockets)
      socket.destroy(new Error("OMP background daemon adapter is disposed"));
    this.sockets.clear();
    this.known.clear();
    this.positions.clear();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("OMP background daemon adapter is disposed");
  }

  private async discover(): Promise<string | undefined> {
    if (this.runtimeDir) return this.runtimeDir;
    const project = await canonical(this.cwd);
    const home = this.env.HOME ?? this.env.USERPROFILE ?? homedir();
    const root = path.join(
      resolveOmpDiagnosticPaths(this.env, home).xdgStateRoot,
      "run",
      "daemons",
    );
    // `omp ps` currently uses an auto-reviving client, even for list. Scope metadata
    // is its authoritative inverse mapping; inspecting it avoids that lifecycle race.
    for (const entry of await entries(root)) {
      if (!entry.isDirectory() || !/^[0-9a-f]{16}$/u.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      let scope = await jsonFile(path.join(dir, "scope.json"));
      if (typeof scope?.projectDir !== "string") {
        for (const client of await entries(path.join(dir, "clients"))) {
          if (!client.isFile()) continue;
          const presence = await jsonFile(path.join(dir, "clients", client.name));
          if (typeof presence?.projectDir === "string") {
            scope = presence;
            break;
          }
        }
      }
      if (
        typeof scope?.projectDir === "string" &&
        (await canonical(scope.projectDir)) === project
      ) {
        this.runtimeDir = await canonical(dir);
        return this.runtimeDir;
      }
    }
    return undefined;
  }

  private async brokerAlive(dir: string): Promise<boolean> {
    const lease = await jsonFile(path.join(dir, "broker.pid"));
    if (!Number.isSafeInteger(lease?.pid) || Number(lease?.pid) <= 0) return false;
    try {
      process.kill(Number(lease!.pid), 0);
      return true;
    } catch (error) {
      if (code(error) === "ESRCH") return false;
      if (code(error) === "EPERM") return true;
      throw error;
    }
  }

  private async brokerList(dir: string): Promise<unknown[] | undefined> {
    let token: string;
    try {
      token = (await fs.readFile(path.join(dir, "broker.token"), "utf8")).trim();
    } catch (error) {
      if (code(error) === "ENOENT" && !(await this.brokerAlive(dir))) return undefined;
      throw new Error("Cannot read OMP daemon broker credentials", { cause: error });
    }
    if (!token) throw new Error("Invalid OMP daemon broker credentials");
    const endpoint = (this.endpoint ??= await this.resolveBrokerEndpoint(dir));
    try {
      this.assertOpen();
      return await new Promise<unknown[]>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        this.sockets.add(socket);
        const id = randomUUID();
        let buffer = "";
        let bytes = 0;
        let settled = false;
        const finish = (error?: Error, result?: unknown[]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.sockets.delete(socket);
          socket.destroy();
          if (error) reject(error);
          else resolve(result!);
        };
        const timer = setTimeout(
          () => finish(new Error("OMP daemon broker request timed out")),
          5_000,
        );
        socket.setEncoding("utf8");
        socket.once("connect", () =>
          socket.write(`${JSON.stringify({ id, token, operation: { op: "list" } })}\n`),
        );
        socket.once("error", (error) => finish(error));
        socket.once("close", () => finish(new Error("OMP daemon broker closed before responding")));
        socket.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > RESPONSE_LIMIT) {
            finish(new Error("OMP daemon broker response is too large"));
            return;
          }
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const message = object(JSON.parse(line));
              if (message?.id !== id) continue;
              const result = object(message.result);
              if (message.ok !== true) throw new Error("OMP daemon broker rejected inspection");
              if (result?.op !== "list" || !Array.isArray(result.daemons))
                throw new Error("Invalid OMP daemon broker response");
              finish(undefined, result.daemons);
              return;
            } catch {
              finish(new Error("Invalid or rejected OMP daemon broker response"));
              return;
            }
          }
        });
      });
    } catch (error) {
      if (
        (code(error) === "ENOENT" || code(error) === "ECONNREFUSED") &&
        !(await this.brokerAlive(dir))
      )
        return undefined;
      throw error;
    }
  }

  private async collect(): Promise<Row[]> {
    const dir = await this.discover();
    this.assertOpen();
    if (!dir) return [];
    const persisted = new Map<string, { daemon: Daemon; spec: unknown }>();
    for (const entry of await entries(path.join(dir, "daemons"))) {
      if (!entry.isDirectory() || !safeName(entry.name)) continue;
      const metadata = await jsonFile(path.join(dir, "daemons", entry.name, "meta.json"));
      const decoded = daemon(metadata?.daemon, metadata?.spec, this.cwd);
      if (decoded?.snapshot.name === entry.name)
        persisted.set(entry.name, { daemon: decoded, spec: metadata?.spec });
    }
    const live = await this.brokerList(dir);
    const daemons =
      live === undefined
        ? [...persisted.values()].map((item) => item.daemon)
        : live.map((snapshot) => {
            const name = object(snapshot)?.name;
            const decoded = daemon(
              snapshot,
              typeof name === "string" ? persisted.get(name)?.spec : undefined,
              this.cwd,
            );
            if (!decoded) throw new Error("Invalid OMP daemon snapshot");
            return decoded;
          });
    this.assertOpen();
    this.known.clear();
    const rows = daemons.map((item) => {
      const s = item.snapshot;
      const id = s.id as string;
      this.known.set(id, item);
      const providerOwnerId = typeof s.owner === "string" ? s.owner : null;
      const terminal = s.state === "exited" || s.state === "failed";
      return {
        id,
        name: s.name as string,
        command: item.command,
        cwd: item.cwd,
        providerOwnerId,
        ownerAgentId: null,
        scope: providerOwnerId === null ? "workspace" : "agent",
        source: "omp-daemon",
        status: live === undefined && !terminal ? "unknown" : s.state,
        startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
        endedAt: terminal && typeof s.exitedAt === "number" ? s.exitedAt : null,
        exitCode: terminal && typeof s.exitCode === "number" ? s.exitCode : null,
        terminalId: null,
      } as Row;
    });
    for (const id of this.positions.keys()) if (!this.known.has(id)) this.positions.delete(id);
    return rows;
  }

  private async openLog(file: string): Promise<LogFile | undefined> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid OMP daemon log file");
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
          throw new Error("OMP daemon log changed during inspection");
        return {
          handle,
          identity: `${opened.dev}:${opened.ino}:${opened.birthtimeMs}`,
          size: opened.size,
          mtime: opened.mtimeMs,
        };
      } catch (error) {
        await handle.close();
        throw error;
      }
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readOutput(processId: string, cursor?: number): Promise<BackgroundProcessOutput> {
    this.assertOpen();
    const known = this.known.get(processId);
    if (!known || !this.runtimeDir) throw new Error("Unknown OMP background process");
    const dir = path.join(this.runtimeDir, "daemons", known.snapshot.name as string);
    if ((await canonical(dir)) !== dir) throw new Error("Invalid OMP daemon log directory");
    const metadata = await jsonFile(path.join(dir, "meta.json"));
    const latest = daemon(metadata?.daemon, metadata?.spec, this.cwd);
    if (!latest) throw new Error("OMP background process metadata is unavailable");
    if (latest.snapshot.id !== processId) throw new Error("OMP background process was replaced");
    const generation = latest.generation;
    const files: LogFile[] = [];
    try {
      // Open current first: a concurrent rotation cannot accidentally include the
      // same inode twice. There is no synthetic newline in the raw byte stream.
      const current = await this.openLog(path.join(dir, "output.log"));
      if (current) files.push(current);
      const previous = await this.openLog(path.join(dir, "output.previous.log"));
      if (previous) {
        if (previous.identity === current?.identity) await previous.handle.close();
        else files.unshift(previous);
      }
      const saved = this.positions.get(processId);
      const window = await resolveOutputWindow(files, saved, cursor, generation);
      const total = files.reduce((sum, file) => sum + file.size, 0);
      const bounded = total - window.offset > OUTPUT_LIMIT;
      const truncated = bounded || window.lostHistory;
      const offset = bounded ? total - OUTPUT_LIMIT : window.offset;
      const reset = bounded || window.reset;
      const raw = await readLogBytes(files, offset);
      // Leave a partial trailing UTF-8 code point for the next poll, rather than
      // corrupting it with a replacement character at each append boundary.
      const end = completeUtf8End(raw);
      const start = bounded ? completeUtf8Start(raw, end) : 0;
      const positions = snapshotLogPositions(files, raw.length - end);
      const tail = await readPositionTail(files, positions);
      const next = !reset && end === 0 && saved ? saved.cursor : this.nextCursor++;
      this.assertOpen();
      this.positions.set(processId, { cursor: next, generation, tail, files: positions });
      return {
        text: raw.subarray(start, end).toString("utf8"),
        cursor: next,
        reset,
        truncated,
        format: latest.pty ? "terminal" : "text",
      };
    } finally {
      await Promise.all(files.map((file) => file.handle.close()));
    }
  }
}
