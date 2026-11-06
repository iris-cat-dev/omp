import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSupervisor } from "../../scripts/supervisor.js";
import { acquirePidLock, getPidLockInfo, updatePidLock } from "./pid-lock.js";

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
