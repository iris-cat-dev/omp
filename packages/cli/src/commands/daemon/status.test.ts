import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type * as Server from "@omp-desktop/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runStatusCommand, selectRelayStatus } from "./status.js";
import { stopLocalDaemon } from "./local-daemon.js";

const mocks = vi.hoisted(() => ({
  connectToDaemon: vi.fn(),
  tryConnectToDaemon: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: mocks.connectToDaemon,
  tryConnectToDaemon: mocks.tryConnectToDaemon,
}));

vi.mock("@omp-desktop/server", async (importOriginal) => ({
  ...(await importOriginal<typeof Server>()),
  getOrCreateServerId: () => "test-server",
  findExecutable: async () => null,
  execCommand: vi.fn(),
  killProcessTree: mocks.killProcessTree,
}));

vi.mock("./runtime-toolchain.js", () => ({
  resolveNodePathFromPid: async () => ({ nodePath: process.execPath }),
}));

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  mocks.connectToDaemon.mockReset();
  mocks.tryConnectToDaemon.mockReset();
  mocks.killProcessTree.mockReset();
  vi.restoreAllMocks();
});

describe("managed supervisor startup status", () => {
  test.each([
    { ready: false, desktopManaged: true, expected: "starting", probed: false },
    { ready: undefined, desktopManaged: true, expected: "unresponsive", probed: true },
    { ready: true, desktopManaged: true, expected: "unresponsive", probed: true },
    { ready: "false", desktopManaged: true, expected: "unresponsive", probed: true },
    { ready: false, desktopManaged: false, expected: "unresponsive", probed: true },
  ])(
    "reports $expected for managed=$desktopManaged and ready=$ready",
    async ({ ready, desktopManaged, expected, probed }) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-status-"));
      homes.push(home);
      await writeFile(
        path.join(home, "omp-desktop.pid"),
        JSON.stringify({
          pid: process.pid,
          listen: "127.0.0.1:1",
          desktopManaged,
          ...(ready !== undefined ? { ready } : {}),
        }),
      );
      mocks.connectToDaemon.mockRejectedValue(new Error("not ready"));

      const result = await runStatusCommand({ home }, new Command());
      expect(result.schema.serialize?.(result.data[0]!)).toMatchObject({
        localDaemon: expected,
        connectedDaemon: probed ? "unreachable" : "not_probed",
        pid: process.pid,
      });
      expect(mocks.connectToDaemon).toHaveBeenCalledTimes(probed ? 1 : 0);
      const row = result.data.find((entry) => entry.key === "Local Daemon")!;
      expect(row.value).toBe(expected);
      expect(result.schema.columns[1]!.color?.(row.value, row)).toBe("yellow");
    },
  );

  test("probes normally once a managed worker publishes ready metadata", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-status-ready-"));
    homes.push(home);
    const lock = { pid: process.pid, listen: "127.0.0.1:1", desktopManaged: true };
    const pidPath = path.join(home, "omp-desktop.pid");
    await writeFile(pidPath, JSON.stringify({ ...lock, ready: false }));
    const warming = await runStatusCommand({ home }, new Command());
    expect(warming.schema.serialize?.(warming.data[0]!)).toMatchObject({
      localDaemon: "starting",
      connectedDaemon: "not_probed",
    });
    expect(mocks.connectToDaemon).not.toHaveBeenCalled();

    const close = vi.fn().mockResolvedValue(undefined);
    mocks.connectToDaemon.mockResolvedValue({
      getLastServerInfoMessage: () => ({ version: "1.2.3" }),
      getDaemonStatus: async () => ({
        version: "1.2.3",
        nodePath: process.execPath,
        desktopDistributionIdentity: "public",
        providers: [],
      }),
      close,
    });
    await writeFile(pidPath, JSON.stringify({ ...lock, ready: true }));
    const ready = await runStatusCommand({ home }, new Command());
    expect(ready.schema.serialize?.(ready.data[0]!)).toMatchObject({
      localDaemon: "running",
      connectedDaemon: "reachable",
      daemonVersion: "1.2.3",
      desktopDistributionIdentity: "public",
    });
    expect(mocks.connectToDaemon).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("does not report a dead managed supervisor as starting", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-status-dead-"));
    homes.push(home);
    const pid = process.pid + 10_000;
    await writeFile(
      path.join(home, "omp-desktop.pid"),
      JSON.stringify({ pid, listen: "127.0.0.1:1", desktopManaged: true, ready: false }),
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("process missing"), { code: "ESRCH" });
    });
    mocks.connectToDaemon.mockRejectedValue(new Error("unreachable"));

    const result = await runStatusCommand({ home }, new Command());
    expect(result.schema.serialize?.(result.data[0]!)).toMatchObject({
      localDaemon: "stale_pid",
      connectedDaemon: "unreachable",
    });
    expect(mocks.connectToDaemon).toHaveBeenCalledTimes(1);
  });

  test("explicitly stops a starting supervisor by owner signal without a websocket probe", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-stop-starting-"));
    homes.push(home);
    const pid = process.pid + 10_000;
    await writeFile(
      path.join(home, "omp-desktop.pid"),
      JSON.stringify({ pid, listen: "127.0.0.1:1", desktopManaged: true, ready: false }),
    );
    let alive = true;
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      expect(target).toBe(pid);
      expect(signal).toBe(0);
      if (!alive) throw Object.assign(new Error("process missing"), { code: "ESRCH" });
      return true;
    });
    mocks.killProcessTree.mockImplementation(async () => {
      alive = false;
    });

    await expect(stopLocalDaemon({ home })).resolves.toMatchObject({
      action: "stopped",
      pid,
      forced: false,
      usedLifecycleRpc: false,
      reason: "owner_pid_signal",
    });
    expect(mocks.killProcessTree).toHaveBeenCalledWith(pid, "SIGTERM");
    expect(mocks.tryConnectToDaemon).not.toHaveBeenCalled();
  });
});

describe("selectRelayStatus", () => {
  const persisted = {
    enabled: false,
    endpoint: "persisted.internal:443",
    publicEndpoint: "persisted.example.com:443",
    useTls: true,
    publicUseTls: true,
  };

  test("uses the running daemon relay state over persisted config", () => {
    expect(
      selectRelayStatus({
        persisted,
        live: {
          enabled: true,
          endpoint: "live.internal:443",
          publicEndpoint: "live.example.com:443",
          useTls: true,
          publicUseTls: true,
        },
      }),
    ).toBe("wss://live.example.com:443");
  });

  test("falls back to persisted config when the daemon cannot report live state", () => {
    expect(selectRelayStatus({ persisted })).toBe("disabled");
  });
});
