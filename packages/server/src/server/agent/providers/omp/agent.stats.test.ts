import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import type * as NodeOs from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ProviderCommand } from "../../provider-launch-config.js";
import { assertBundledOmpHost } from "../../../bundled-omp-host.js";
import type * as BundledHost from "../../../bundled-omp-host.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { spawnProcess } from "../../../../utils/spawn.js";
import type * as SpawnUtilities from "../../../../utils/spawn.js";
import * as treeKill from "../../../../utils/tree-kill.js";
import { OmpAgentClient } from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

vi.mock("node:os", async (importOriginal) => {
  const native = await importOriginal<typeof NodeOs>();
  return { ...native, homedir: vi.fn(native.homedir) };
});
vi.mock("../../../../utils/spawn.js", async (importOriginal) => {
  const native = await importOriginal<typeof SpawnUtilities>();
  return { ...native, spawnProcess: vi.fn() };
});
vi.mock("../../../bundled-omp-host.js", async (importOriginal) => {
  const native = await importOriginal<typeof BundledHost>();
  return { ...native, assertBundledOmpHost: vi.fn() };
});

interface FixtureDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: (string | number)[]): void };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => FixtureDatabase;
};
const directories: string[] = [];
const controlledChildren: ControlledStatsProcess[] = [];
const realChildren: ChildProcess[] = [];
const descendantPids: number[] = [];

class ControlledStatsProcess extends EventEmitter {
  pid: number | undefined = 31_337;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn().mockReturnValue(true);

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function controlledRefresh() {
  const child = new ControlledStatsProcess();
  controlledChildren.push(child);
  const { promise: started, resolve: markStarted } =
    Promise.withResolvers<void>();
  vi.mocked(spawnProcess).mockImplementationOnce(() => {
    markStarted();
    return child as unknown as ChildProcess;
  });
  return { child, started };
}

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "omp-stats-refresh-"));
  directories.push(home);
  vi.mocked(homedir).mockReturnValue(home);
  return home;
}

async function index(home: string, profile?: string): Promise<FixtureDatabase> {
  const root = profile
    ? join(home, ".omp", "profiles", profile)
    : join(home, ".omp");
  await mkdir(root, { recursive: true });
  const database = new DatabaseSync(join(root, "stats.db"));
  // These are the native numeric reader's required columns, not a mocked RPC result.
  database.exec(`CREATE TABLE messages (
    session_file TEXT, provider TEXT, model TEXT, agent_type TEXT,
    timestamp INTEGER, stop_reason TEXT, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    total_tokens INTEGER, cost_total REAL, cost_unpriced INTEGER
  ); CREATE TABLE user_messages (prose TEXT);
  INSERT INTO user_messages VALUES ('private conversation must not cross the RPC');`);
  return database;
}

function addRequest(database: FixtureDatabase, total = 100): void {
  database
    .prepare(
      `INSERT INTO messages VALUES (
      '/private/session.jsonl', 'fixture-provider', 'fixture-model', 'main', ?, 'stop',
      10, 20, 30, 40, ?, 1.25, 0
    )`,
    )
    .run(Date.now(), total);
}

function client(
  home: string,
  options: { command?: ProviderCommand; env?: Record<string, string> } = {},
): OmpAgentClient {
  return new OmpAgentClient({
    logger: createTestLogger(),
    runtime: new FakeOmp(),
    runtimeSettings: {
      command: options.command ?? {
        mode: "replace",
        argv: [join(home, "omp.exe")],
      },
      env: { HOME: home, USERPROFILE: home, ...options.env },
    },
  });
}

beforeEach(() => {
  vi.mocked(spawnProcess).mockReset();
  vi.mocked(assertBundledOmpHost).mockReset().mockResolvedValue(undefined);
  for (const key of [
    "PI_CONFIG_DIR",
    "OMP_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "OMP_CODING_AGENT_DIR",
    "XDG_DATA_HOME",
    "OMP_PROFILE",
    "PI_PROFILE",
  ]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(async () => {
  vi.useRealTimers();
  for (const child of controlledChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.exit(1);
  }
  vi.restoreAllMocks();
  await Promise.all(
    realChildren
      .splice(0)
      .map((child) =>
        treeKill.terminateWithTreeKill(child, {
          gracefulTimeoutMs: 100,
          forceTimeoutMs: 1_000,
        }),
      ),
  );
  for (const pid of descendantPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The timeout test should already have terminated this descendant.
    }
  }
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OmpAgentClient native stats refresh", () => {
  it("awaits native indexing before reading the real numeric index on every request", async () => {
    const home = await fixtureHome();
    const database = await index(home, "work");
    addRequest(database, 100);
    const agent = client(home, {
      command: {
        mode: "replace",
        argv: [join(home, "omp.exe"), "--profile", "work"],
      },
      env: {
        OMP_PROFILE: "other",
        OMP_STATS_FIXTURE_SECRET: "private-launch-secret",
      },
    });
    const first = controlledRefresh();
    let settled = false;
    const pending = agent.getOmpStats("24h").then((result) => {
      settled = true;
      return result;
    });
    await first.started;
    expect(settled).toBe(false);
    expect(spawnProcess).toHaveBeenCalledWith(
      join(home, "omp.exe"),
      ["--profile", "work", "stats", "--summary"],
      expect.objectContaining({
        cwd: home,
        env: expect.objectContaining({
          OMP_PROFILE: "other",
          OMP_STATS_FIXTURE_SECRET: "private-launch-secret",
        }),
        shell: false,
        stdio: "ignore",
      }),
    );
    expect(assertBundledOmpHost).toHaveBeenCalledWith(
      join(home, "omp.exe"),
      expect.objectContaining({ USERPROFILE: home }),
    );
    addRequest(database, 200);
    first.child.exit();
    const result = await pending;
    expect(result).toMatchObject({
      status: "available",
      scope: { profile: "work" },
      overall: { totalRequests: 2, totalTokens: 300 },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|launch-secret/);

    const second = controlledRefresh();
    const refreshed = agent.getOmpStats("all");
    await second.started;
    addRequest(database, 300);
    database.close();
    second.child.exit();
    expect(await refreshed).toMatchObject({
      status: "available",
      overall: { totalRequests: 3, totalTokens: 600 },
    });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it.each([
    "nonzero",
    "signal",
    "spawn-error",
    "spawn-throw",
    "verification",
  ] as const)(
    "never reports the old index as refreshed after %s failure, and permits a retry",
    async (failure) => {
      const home = await fixtureHome();
      const database = await index(home);
      addRequest(database);
      database.close();
      const agent = client(home);
      if (failure === "verification") {
        vi.mocked(assertBundledOmpHost).mockRejectedValueOnce(
          new Error(`${home}/private host`),
        );
      } else if (failure === "spawn-throw") {
        vi.mocked(spawnProcess).mockImplementationOnce(() => {
          throw new Error(`${home}/private executable ENOENT`);
        });
      } else {
        const refresh = controlledRefresh();
        const pending = agent.getOmpStats("all");
        await refresh.started;
        if (failure === "spawn-error") {
          refresh.child.pid = undefined;
          refresh.child.emit("error", new Error(`${home}/private startup`));
        } else {
          refresh.child.exit(
            failure === "nonzero" ? 1 : null,
            failure === "signal" ? "SIGTERM" : null,
          );
        }
        const result = await pending;
        expect(result).toMatchObject({
          status: "error",
          reason: "index_refresh_failed",
        });
        expect(JSON.stringify(result)).not.toContain(home);
      }
      if (failure === "verification" || failure === "spawn-throw") {
        const result = await agent.getOmpStats("all");
        expect(result).toMatchObject({
          status: "error",
          reason: "index_refresh_failed",
        });
        expect(JSON.stringify(result)).not.toContain(home);
      }
      if (failure === "verification") {
        expect(spawnProcess).not.toHaveBeenCalled();
      } else {
        expect(spawnProcess).toHaveBeenCalledTimes(1);
        expect(vi.mocked(spawnProcess).mock.calls[0]![0]).toBe(
          join(home, "omp.exe"),
        );
      }
      const retry = controlledRefresh();
      const pendingRetry = agent.getOmpStats("all");
      await retry.started;
      retry.child.exit();
      expect(await pendingRetry).toMatchObject({
        status: "available",
        overall: { totalRequests: 1 },
      });
    },
  );

  it("shares only simultaneous refreshes with the same scope and invocation", async () => {
    const home = await fixtureHome();
    const agent = client(home);
    const shared = controlledRefresh();
    const first = agent.getOmpStats("all");
    const second = agent.getOmpStats("24h");
    await shared.started;
    // This failure avoids SQL workers, while still testing per-range metadata.
    shared.child.exit(1);
    expect(await first).toMatchObject({
      range: "all",
      reason: "index_refresh_failed",
    });
    expect(await second).toMatchObject({
      range: "24h",
      reason: "index_refresh_failed",
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    const retry = controlledRefresh();
    const third = agent.getOmpStats("all");
    await retry.started;
    retry.child.exit(1);
    await third;
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it.each([
    "profile",
    "executable",
    "environment",
    "session-directory",
  ] as const)(
    "does not merge concurrent refreshes with different %s",
    async (difference) => {
      const home = await fixtureHome();
      const firstAgent = client(home);
      const env: NodeJS.ProcessEnv = {};
      if (difference === "profile") env.OMP_PROFILE = "work";
      else if (difference === "session-directory")
        env.PI_CODING_AGENT_DIR = join(home, "other-agent");
      else if (difference === "environment")
        env.OMP_STATS_FIXTURE_VARIANT = "other";
      const secondAgent = client(home, {
        ...(difference === "executable"
          ? {
              command: {
                mode: "replace" as const,
                argv: [join(home, "other-runtime", "omp.exe")],
              },
            }
          : {}),
        env,
      });
      const firstRefresh = controlledRefresh();
      const secondRefresh = controlledRefresh();
      const first = firstAgent.getOmpStats("all");
      const second = secondAgent.getOmpStats("all");
      await Promise.all([firstRefresh.started, secondRefresh.started]);
      firstRefresh.child.exit(1);
      secondRefresh.child.exit(1);
      expect(await first).toMatchObject({ reason: "index_refresh_failed" });
      expect(await second).toMatchObject({ reason: "index_refresh_failed" });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    },
  );

  it("does not release a timed-out flight until its child tree cleanup finishes", async () => {
    const home = await fixtureHome();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const refresh = controlledRefresh();
    const { promise: cleanupStarted, resolve: markCleanupStarted } =
      Promise.withResolvers<void>();
    const { promise: cleanupReleased, resolve: releaseCleanup } =
      Promise.withResolvers<void>();
    const terminator = vi
      .spyOn(treeKill, "terminateWithTreeKill")
      .mockImplementationOnce(async () => {
        markCleanupStarted();
        await cleanupReleased;
        refresh.child.exit(null, "SIGKILL");
        return "killed";
      });
    const agent = client(home);
    let settled = false;
    const first = agent.getOmpStats("all").then((result) => {
      settled = true;
      return result;
    });
    await refresh.started;
    await vi.advanceTimersByTimeAsync(40_000);
    await cleanupStarted;
    expect(terminator).toHaveBeenCalledWith(
      refresh.child,
      expect.objectContaining({ forceTimeoutMs: 1_000 }),
    );
    expect(settled).toBe(false);
    const concurrent = agent.getOmpStats("24h");
    await vi.advanceTimersByTimeAsync(0);
    releaseCleanup();
    expect(await first).toMatchObject({
      status: "error",
      reason: "index_refresh_timeout",
    });
    expect(await concurrent).toMatchObject({
      status: "error",
      reason: "index_refresh_timeout",
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    const retry = controlledRefresh();
    const retried = agent.getOmpStats("all");
    await retry.started;
    retry.child.exit(1);
    expect(await retried).toMatchObject({ reason: "index_refresh_failed" });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("returns a bounded timeout but blocks another writer until failed cleanup observes exit", async () => {
    const home = await fixtureHome();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const refresh = controlledRefresh();
    vi.spyOn(treeKill, "terminateWithTreeKill").mockResolvedValueOnce(
      "kill-timeout",
    );
    const agent = client(home);
    const pending = agent.getOmpStats("all");
    await refresh.started;
    await vi.advanceTimersByTimeAsync(42_000);
    expect(await pending).toMatchObject({
      status: "error",
      reason: "index_refresh_timeout",
    });
    expect(await agent.getOmpStats("24h")).toMatchObject({
      status: "error",
      reason: "index_refresh_timeout",
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    refresh.child.exit(null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(0);
    const retry = controlledRefresh();
    const retried = agent.getOmpStats("all");
    await retry.started;
    retry.child.exit(1);
    expect(await retried).toMatchObject({ reason: "index_refresh_failed" });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("never starts a late process after host verification exceeded the refresh deadline", async () => {
    const home = await fixtureHome();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { promise: verified, resolve: finishVerification } =
      Promise.withResolvers<void>();
    vi.mocked(assertBundledOmpHost).mockReturnValueOnce(verified);
    const pending = client(home).getOmpStats("all");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await pending).toMatchObject({ reason: "index_refresh_timeout" });
    finishVerification();
    await verified;
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "terminates a real timed-out native child and its descendant before returning",
    async () => {
      const home = await fixtureHome();
      let owner!: ChildProcess;
      let ready!: Promise<unknown[]>;
      const { promise: started, resolve: markStarted } =
        Promise.withResolvers<void>();
      const terminator = vi.spyOn(treeKill, "terminateWithTreeKill");
      vi.mocked(spawnProcess).mockImplementationOnce(() => {
        owner = spawn(
          process.execPath,
          [
            "-e",
            `const { spawn } = require('node:child_process');
            const child = spawn(process.execPath,
              ['-e', "require('node:net').createServer().listen(0, '127.0.0.1')"],
              { stdio: 'ignore' });
            child.once('spawn', () => process.send({ childPid: child.pid }));
            process.on('message', () => {});`,
          ],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        realChildren.push(owner);
        ready = once(owner, "message");
        markStarted();
        return owner;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = client(home).getOmpStats("all");
      await started;
      const [message] = await ready;
      const { childPid: descendantPid } = z
        .object({ childPid: z.number().int().positive() })
        .parse(message);
      descendantPids.push(descendantPid);
      const probeDescendant = process.kill.bind(process, descendantPid, 0);
      expect(probeDescendant).not.toThrow();
      await vi.advanceTimersByTimeAsync(40_000);
      vi.useRealTimers();
      expect(await pending).toMatchObject({ reason: "index_refresh_timeout" });
      expect(terminator).toHaveBeenCalledWith(owner, expect.any(Object));
      expect(owner.exitCode !== null || owner.signalCode !== null).toBe(true);
      await vi.waitFor(() => expect(probeDescendant).toThrow(), {
        timeout: 5_000,
      });
    },
    10_000,
  );

  const unsafeCommands: ProviderCommand[] = [
    ...[
      ["--print"],
      ["--mode", "rpc"],
      ["--alias", "work"],
      ["--cwd", "/private/workspace"],
      ["--profile", "work", "--print"],
      ["stats"],
      ["hello model"],
      ["--"],
      ["--profile"],
      ["--profile="],
    ].map((args) => ({ mode: "append" as const, args })),
    { mode: "replace", argv: ["node", "omp.js"] },
    { mode: "replace", argv: ["bun", "run", "omp"] },
    { mode: "replace", argv: ["omp.cmd"] },
    { mode: "replace", argv: ["omp.bat"] },
    { mode: "replace", argv: ["omp", "--mode=rpc"] },
  ];
  it.each(unsafeCommands)(
    "refuses unsafe executable prefixes before launch: %j",
    async (command) => {
      const home = await fixtureHome();
      expect(await client(home, { command }).getOmpStats("all")).toMatchObject({
        status: "unavailable",
        reason: "scope_unavailable",
      });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(assertBundledOmpHost).not.toHaveBeenCalled();
    },
  );

  it("refuses an invalid profile scope before host verification or spawning", async () => {
    const home = await fixtureHome();
    expect(
      await client(home, { env: { OMP_PROFILE: "../other" } }).getOmpStats(
        "all",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "scope_unavailable",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(assertBundledOmpHost).not.toHaveBeenCalled();
  });
});
