import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { OmpBackgroundDaemons } from "./background-daemons.js";

let root: string;
let runtime: string;
let daemonDir: string;
let env: NodeJS.ProcessEnv;
let adapter: OmpBackgroundDaemons;
let server: net.Server | undefined;
const sockets = new Set<net.Socket>();
const scopeKey = "0123456789abcdef";
let snapshot: Record<string, unknown>;

async function persist() {
  await fs.mkdir(daemonDir, { recursive: true });
  await fs.writeFile(
    path.join(daemonDir, "meta.json"),
    JSON.stringify({
      daemon: snapshot,
      spec: {
        application: "node",
        args: ["server.js"],
        cwd: root,
        env: { SECRET: "never-expose-me" },
      },
      completionPending: true,
      pendingCompletion: { id: "unconsumed" },
    }),
  );
}

async function broker(reply: (request: Record<string, unknown>, socket: net.Socket) => void) {
  await fs.writeFile(path.join(runtime, "broker.token"), "private-token\n");
  await fs.writeFile(path.join(runtime, "broker.pid"), JSON.stringify({ pid: process.pid }));
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) reply(JSON.parse(buffer.slice(0, newline)), socket);
    });
  });
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-daemon-${scopeKey}`
      : path.join(runtime, "broker.sock");
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(endpoint, resolve);
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(fileURLToPath(new URL("../../../../../../../.bg-", import.meta.url)));
  root = await fs.realpath(root);
  env = {
    HOME: root,
    USERPROFILE: root,
    PI_CONFIG_DIR: ".omp",
    OMP_PROFILE: "",
    PI_PROFILE: "",
    PI_CODING_AGENT_DIR: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    XDG_DATA_HOME: undefined,
  };
  runtime = path.join(root, ".omp", "run", "daemons", scopeKey);
  daemonDir = path.join(runtime, "daemons", "web");
  snapshot = {
    id: "daemon-id",
    name: "web",
    state: "ready",
    owner: "provider-session:exact",
    startedAt: 100,
    createdAt: 90,
    restartCount: 0,
    outputBytes: 0,
  };
  await persist();
  await fs.writeFile(path.join(runtime, "scope.json"), JSON.stringify({ projectDir: root }));
  adapter = new OmpBackgroundDaemons({ cwd: root, env });
});

afterEach(async () => {
  adapter.dispose();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

describe("OMP passive daemon inspection", () => {
  test("uses authenticated list without completion subscriptions, and never exposes spec env", async () => {
    const requests: Record<string, unknown>[] = [];
    const before = await fs.readFile(path.join(daemonDir, "meta.json"), "utf8");
    await broker((request, socket) => {
      requests.push(request);
      const response = JSON.stringify({
        id: request.id,
        ok: true,
        result: { op: "list", daemons: [snapshot] },
      });
      socket.write(response.slice(0, 12));
      socket.write(`${response.slice(12)}\n`);
    });
    expect(await adapter.list()).toEqual([
      {
        id: "daemon-id",
        name: "web",
        command: "node server.js",
        cwd: root,
        providerOwnerId: "provider-session:exact",
        ownerAgentId: null,
        scope: "agent",
        source: "omp-daemon",
        status: "ready",
        startedAt: 100,
        endedAt: null,
        exitCode: null,
        terminalId: null,
      },
    ]);
    expect(Object.keys(requests[0]!).sort()).toEqual(["id", "operation", "token"]);
    expect(requests[0]).toMatchObject({ token: "private-token", operation: { op: "list" } });
    expect(await fs.readFile(path.join(daemonDir, "meta.json"), "utf8")).toBe(before);
  });

  test("retains offline terminal logs without inventing exits for unsupervised active daemons", async () => {
    expect((await adapter.list())[0]).toMatchObject({
      status: "unknown",
      endedAt: null,
      exitCode: null,
    });
    snapshot.state = "failed";
    snapshot.exitedAt = 200;
    snapshot.exitCode = 2;
    delete snapshot.owner;
    await persist();
    await fs.writeFile(path.join(daemonDir, "output.log"), "failure\r\n");
    expect((await adapter.list())[0]).toMatchObject({
      status: "failed",
      endedAt: 200,
      exitCode: 2,
      scope: "workspace",
    });
    expect(await adapter.output("daemon-id")).toMatchObject({
      text: "failure\r\n",
      reset: true,
      truncated: false,
    });
    await expect(fs.access(path.join(runtime, "broker.token"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(path.join(runtime, "broker.pid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not confuse a live broker transport failure with an empty scope", async () => {
    await broker((_request, socket) => socket.end());
    await expect(adapter.list()).rejects.toThrow("closed before responding");
  });

  test("surfaces rejected authentication without returning broker error secrets", async () => {
    await broker((request, socket) =>
      socket.end(
        `${JSON.stringify({ id: request.id, ok: false, error: "private-token never-expose-me" })}\n`,
      ),
    );
    await expect(adapter.list()).rejects.toThrow("Invalid or rejected OMP daemon broker response");
  });

  test("finds a scope created after an empty initial inspection and isolates other projects", async () => {
    await fs.writeFile(
      path.join(runtime, "scope.json"),
      JSON.stringify({ projectDir: path.dirname(root) }),
    );
    expect(await adapter.list()).toEqual([]);
    await fs.writeFile(path.join(runtime, "scope.json"), JSON.stringify({ projectDir: root }));
    expect((await adapter.list()).map((row) => row.id)).toEqual(["daemon-id"]);
  });

  test("honors launch profile flags over environment without executing the launch command", async () => {
    adapter.dispose();
    const profileRoot = path.join(root, ".omp", "profiles", "work", "run", "daemons");
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.rename(runtime, path.join(profileRoot, scopeKey));
    adapter = new OmpBackgroundDaemons({
      cwd: root,
      env: { ...env, OMP_PROFILE: "wrong" },
      command: ["must-not-be-executed", "--profile", "work"],
    });
    expect((await adapter.list()).map((row) => row.id)).toEqual(["daemon-id"]);
  });

  test("stops a known daemon through the configured OMP command", async () => {
    const requests: Record<string, unknown>[] = [];
    await broker((request, socket) => {
      requests.push(request);
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: { op: "list", daemons: [snapshot] },
        })}\n`,
      );
    });
    const marker = path.join(root, "stop-args.json");
    adapter.dispose();
    adapter = new OmpBackgroundDaemons({
      cwd: root,
      env,
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
        marker,
      ],
    });
    await adapter.list();

    await expect(adapter.stop("daemon-id")).resolves.toBe(true);

    expect(JSON.parse(await fs.readFile(marker, "utf8"))).toEqual([
      "ps",
      "stop",
      "web",
      "--dir",
      root,
      "--timeout",
      "2",
    ]);
    expect(requests).toHaveLength(2);
  });

  test("uses the SDK stop controller instead of a CLI command", async () => {
    await broker((request, socket) => {
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: { op: "list", daemons: [snapshot] },
        })}\n`,
      );
    });
    const stopped: string[] = [];
    adapter.dispose();
    adapter = new OmpBackgroundDaemons({
      cwd: root,
      env,
      command: ["must-not-be-executed"],
      stopDaemon: async (name) => {
        stopped.push(name);
        snapshot.state = "exited";
      },
    });

    await expect(adapter.stop("daemon-id")).resolves.toBe(true);
    expect(stopped).toEqual(["web"]);
    expect((await adapter.list())[0]?.status).toBe("exited");
    await expect(adapter.stop("unknown-id")).rejects.toThrow("Unknown OMP background process");
    expect(stopped).toEqual(["web"]);
  });

  test("rejects arbitrary paths, unknown IDs, replacement IDs, and symlinked logs", async () => {
    await adapter.list();
    await expect(adapter.output("../../scope.json")).rejects.toThrow(
      "Unknown OMP background process",
    );
    await fs.writeFile(path.join(root, "secret"), "secret");
    await fs.symlink(path.join(root, "secret"), path.join(daemonDir, "output.log"));
    await expect(adapter.output("daemon-id")).rejects.toThrow("Invalid OMP daemon log file");
    snapshot.id = "replacement";
    await persist();
    await expect(adapter.output("daemon-id")).rejects.toThrow("was replaced");
  });

  test("returns raw incremental bytes without replay, synthetic newlines, or split UTF-8 corruption", async () => {
    await fs.writeFile(path.join(daemonDir, "output.previous.log"), "previous");
    await fs.writeFile(path.join(daemonDir, "output.log"), "\r\u001b[32mcurrent");
    await adapter.list();
    const first = await adapter.output("daemon-id");
    expect(first.text).toBe("previous\r\u001b[32mcurrent");
    expect(await adapter.output("daemon-id", first.cursor)).toEqual({
      text: "",
      cursor: first.cursor,
      reset: false,
      truncated: false,
      format: "text",
    });
    const unicode = Buffer.from("界");
    await fs.appendFile(path.join(daemonDir, "output.log"), unicode.subarray(0, 2));
    const partial = await adapter.output("daemon-id", first.cursor);
    expect(partial.text).toBe("");
    await fs.appendFile(path.join(daemonDir, "output.log"), unicode.subarray(2));
    expect(await adapter.output("daemon-id", partial.cursor)).toMatchObject({
      text: "界",
      reset: false,
      truncated: false,
    });
  });

  test("continues through rotation and resets when a cursor loses retained history", async () => {
    const current = path.join(daemonDir, "output.log");
    const previous = path.join(daemonDir, "output.previous.log");
    await fs.writeFile(current, "first");
    await adapter.list();
    const first = await adapter.output("daemon-id");
    await fs.rename(current, previous);
    await fs.writeFile(current, "second");
    const second = await adapter.output("daemon-id", first.cursor);
    expect(second).toMatchObject({ text: "second", reset: false, truncated: false });
    await fs.rm(previous);
    await fs.rename(current, previous);
    await fs.writeFile(current, "third");
    await fs.rm(previous);
    await fs.rename(current, previous);
    await fs.writeFile(current, "fourth");
    expect(await adapter.output("daemon-id", second.cursor)).toMatchObject({
      text: "thirdfourth",
      reset: true,
    });
  });

  test("resets same-ID restarts and truncate/regrow rather than skipping replacement bytes", async () => {
    const current = path.join(daemonDir, "output.log");
    await fs.writeFile(current, "old");
    await adapter.list();
    const first = await adapter.output("daemon-id");
    await fs.writeFile(current, "new-longer");
    const rewritten = await adapter.output("daemon-id", first.cursor);
    expect(rewritten).toMatchObject({ text: "new-longer", reset: true });
    snapshot.startedAt = 300;
    snapshot.restartCount = 1;
    await persist();
    expect(await adapter.output("daemon-id", rewritten.cursor)).toMatchObject({
      text: "new-longer",
      reset: true,
    });
  });

  test("bounds large backlogs and resets stale or invalid cursors", async () => {
    await fs.writeFile(path.join(daemonDir, "output.log"), "a".repeat(300 * 1024));
    await adapter.list();
    const first = await adapter.output("daemon-id");
    expect(first).toMatchObject({ text: "a".repeat(256 * 1024), reset: true, truncated: true });
    expect(await adapter.output("daemon-id", first.cursor + 50)).toMatchObject({
      reset: true,
      truncated: true,
    });
    await expect(adapter.output("daemon-id", -1)).rejects.toThrow(
      "Invalid background output cursor",
    );
    adapter.dispose();
    await expect(adapter.list()).rejects.toThrow("disposed");
    await expect(adapter.output("daemon-id")).rejects.toThrow("disposed");
  });
});
