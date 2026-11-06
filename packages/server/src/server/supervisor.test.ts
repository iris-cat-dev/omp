import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSupervisor } from "../../scripts/supervisor.js";
import { acquirePidLock, getPidLockInfo, releasePidLock, updatePidLock } from "./pid-lock.js";

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("child_process", () => ({ fork: mocks.fork, spawn: vi.fn() }));

function createWorker() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    connected: true,
    kill: vi.fn(() => true),
    send: vi.fn(),
  });
}

describe("supervisor PID readiness lifecycle", () => {
  let home: string;
  let initialSigintListeners: NodeJS.SignalsListener[];
  let initialSigtermListeners: NodeJS.SignalsListener[];

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "omp-supervisor-ready-"));
    initialSigintListeners = process.listeners("SIGINT");
    initialSigtermListeners = process.listeners("SIGTERM");
    mocks.fork.mockReset();
    vi.useFakeTimers();
    await acquirePidLock(home, null, { ready: false });
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const listener of process.listeners("SIGINT")) {
      if (!initialSigintListeners.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!initialSigtermListeners.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    await rm(home, { recursive: true, force: true });
  });

  it("stays unready until ready IPC and persists recovery false before spawning a replacement", async () => {
    const firstWorker = createWorker();
    const replacementWorker = createWorker();
    const readyWritten = Promise.withResolvers<void>();
    const notReadyWritten = Promise.withResolvers<void>();
    const allowReplacement = Promise.withResolvers<void>();
    const replacementSpawned = Promise.withResolvers<void>();
    mocks.fork
      .mockReturnValueOnce(firstWorker as unknown as ChildProcess)
      .mockImplementationOnce(() => {
        replacementSpawned.resolve();
        return replacementWorker as unknown as ChildProcess;
      });
    runSupervisor({
      name: "ReadinessTest",
      startupMessage: "test startup",
      resolveWorkerEntry: () => "test-worker.js",
      workerArgs: [],
      workerEnv: {},
      workerExecArgv: [],
      restartOnCrash: true,
      onWorkerReady: async ({ listen }) => {
        await updatePidLock(home, { listen, ready: true });
        readyWritten.resolve();
      },
      onWorkerNotReady: async () => {
        await updatePidLock(home, { ready: false });
        notReadyWritten.resolve();
        await allowReplacement.promise;
      },
    });

    expect((await getPidLockInfo(home))?.ready).toBe(false);
    firstWorker.stdout.emit("data", Buffer.from("HTTP server listening\n"));
    expect((await getPidLockInfo(home))?.ready).toBe(false);

    firstWorker.emit("message", { type: "paseo:ready", listen: "127.0.0.1:12345" });
    await readyWritten.promise;
    expect(await getPidLockInfo(home)).toMatchObject({
      ready: true,
      listen: "127.0.0.1:12345",
    });

    firstWorker.emit("exit", 1, null);
    await notReadyWritten.promise;
    expect((await getPidLockInfo(home))?.ready).toBe(false);
    expect(mocks.fork).toHaveBeenCalledTimes(1);
    allowReplacement.resolve();
    await replacementSpawned.promise;
    expect((await getPidLockInfo(home))?.ready).toBe(false);
    expect(mocks.fork).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "a crash", restart: false, shutdownDuringReset: false },
    { name: "an explicit restart", restart: true, shutdownDuringReset: false },
    { name: "shutdown during a pending reset", restart: false, shutdownDuringReset: true },
  ])("fails closed after $name when readiness cannot be reset", async (scenario) => {
    const worker = createWorker();
    const replacementWorker = createWorker();
    const readyWritten = Promise.withResolvers<void>();
    const resetStarted = Promise.withResolvers<void>();
    const allowReset = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const allowCleanup = Promise.withResolvers<void>();
    const replacementSpawned = Promise.withResolvers<void>();
    const exitCalled = Promise.withResolvers<void>();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      exitCalled.resolve();
      return undefined as never;
    });
    const cleanup = vi.fn(async () => {
      cleanupStarted.resolve();
      await allowCleanup.promise;
      await releasePidLock(home, { ownerPid: process.pid });
    });
    mocks.fork.mockReturnValueOnce(worker as unknown as ChildProcess).mockImplementationOnce(() => {
      replacementSpawned.resolve();
      return replacementWorker as unknown as ChildProcess;
    });

    try {
      const supervisor = runSupervisor({
        name: "ReadinessTest",
        startupMessage: "test startup",
        resolveWorkerEntry: () => "test-worker.js",
        workerArgs: [],
        workerEnv: {},
        workerExecArgv: [],
        restartOnCrash: true,
        onWorkerReady: async ({ listen }) => {
          await updatePidLock(home, { listen, ready: true });
          readyWritten.resolve();
        },
        onWorkerNotReady: async () => {
          resetStarted.resolve();
          await allowReset.promise;
          throw Object.assign(new Error("PID lock is not writable"), { code: "EACCES" });
        },
        onSupervisorExit: cleanup,
      });

      worker.emit("message", { type: "paseo:ready", listen: "127.0.0.1:12345" });
      await readyWritten.promise;
      if (scenario.restart) worker.emit("message", { type: "paseo:restart" });
      worker.emit("exit", 1, null);
      await resetStarted.promise;
      if (scenario.shutdownDuringReset) supervisor.requestShutdown("shutdown_during_reset");
      allowReset.resolve();

      await Promise.race([cleanupStarted.promise, replacementSpawned.promise]);
      expect(mocks.fork).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      expect(await getPidLockInfo(home)).toMatchObject({ pid: process.pid, ready: true });

      allowCleanup.resolve();
      await exitCalled.promise;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(await getPidLockInfo(home)).toBeNull();
    } finally {
      allowReset.resolve();
      allowCleanup.resolve();
      await Promise.race([exitCalled.promise, replacementSpawned.promise]);
      exit.mockRestore();
    }
  });

  it("serializes a late ready write ahead of restart false and ignores ready IPC during restart", async () => {
    const worker = createWorker();
    const readyStarted = Promise.withResolvers<void>();
    const allowReadyWrite = Promise.withResolvers<void>();
    const notReadyWritten = Promise.withResolvers<void>();
    const onWorkerReady = vi.fn(async ({ listen }: { listen: string }) => {
      readyStarted.resolve();
      await allowReadyWrite.promise;
      await updatePidLock(home, { listen, ready: true });
    });
    mocks.fork.mockReturnValue(worker as unknown as ChildProcess);
    runSupervisor({
      name: "ReadinessTest",
      startupMessage: "test startup",
      resolveWorkerEntry: () => "test-worker.js",
      workerArgs: [],
      workerEnv: {},
      workerExecArgv: [],
      onWorkerReady,
      onWorkerNotReady: async () => {
        await updatePidLock(home, { ready: false });
        notReadyWritten.resolve();
      },
    });

    worker.emit("message", { type: "paseo:ready", listen: "127.0.0.1:12345" });
    await readyStarted.promise;
    worker.emit("message", { type: "paseo:restart" });
    worker.emit("message", { type: "paseo:ready", listen: "127.0.0.1:54321" });
    allowReadyWrite.resolve();
    await notReadyWritten.promise;

    expect(await getPidLockInfo(home)).toMatchObject({
      ready: false,
      listen: "127.0.0.1:12345",
    });
    expect(onWorkerReady).toHaveBeenCalledTimes(1);
    expect(worker.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.fork).toHaveBeenCalledTimes(1);
  });
});
